import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as os from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { OhlcvService } from './ohlcv.service';
import { BacktestMetrics, Candle } from './backtest.types';
import {
  DEFAULT_FEES_PCT, DEFAULT_SLIPPAGE_PCT, SUPPORTED_TOKENS, KUCOIN_TYPE,
} from './backtest.constants';
import {
  SEARCH_SPACES, LOSS_FUNCTIONS, LossFunction, StrategyName, SearchMethod,
  SEARCH_METHODS, isValidCombo, IN_SAMPLE_RATIO, DEFAULT_MAX_ITERATIONS,
  HARD_MAX_ITERATIONS, TOP_N, ENUM_CAP, CONVERGENCE_POINTS, MAX_WALL_MS,
  TPE_GAMMA, TPE_N_EI_CANDIDATES, TPE_MIN_STARTUP, POOL_MAX_WORKERS,
} from './optimizer.constants';
import { evaluateComboCore, objective, SharedCtx } from './optimizer.eval';
import { WorkerPool, resolveWorkerPath } from './optimizer.pool';
import { OptimizeDto } from './dto/optimize.dto';

/** Tokens par défaut selon la stratégie (miroir du bot réel). */
const DEFAULT_STRATEGY_TOKENS: Record<string, string[]> = {
  dca: ['WETH', 'WBTC', 'ARB'],
  grid: ['WETH'],
  mean_reversion: ['ARB', 'PENDLE', 'GMX'],
  momentum: ['WETH', 'WBTC', 'ARB', 'LINK'],
};

/** Point de la courbe de convergence : meilleur score atteint à l'itération donnée. */
interface ConvergencePoint { iter: number; bestScore: number; }

/** Résultat brut d'une combinaison évaluée (score in-sample). */
interface ScoredCombo { combo: Record<string, any>; score: number; }

@Injectable()
export class OptimizerService {
  private readonly logger = new Logger(OptimizerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ohlcv: OhlcvService,
  ) {}

  async optimize(dto: OptimizeDto): Promise<any> {
    const strategy = dto.strategy as StrategyName;
    if (!SEARCH_SPACES[strategy]) {
      throw new BadRequestException(`Stratégie inconnue : ${dto.strategy}`);
    }
    const lossFunction = (dto.lossFunction ?? 'Balanced') as LossFunction;
    if (!LOSS_FUNCTIONS.includes(lossFunction)) {
      throw new BadRequestException(
        `Loss function inconnue : ${dto.lossFunction}. Choix : ${LOSS_FUNCTIONS.join(', ')}`,
      );
    }
    const requested = dto.searchMethod as SearchMethod | undefined;
    if (requested && !SEARCH_METHODS.includes(requested)) {
      throw new BadRequestException(
        `Méthode inconnue : ${dto.searchMethod}. Choix : ${SEARCH_METHODS.join(', ')}`,
      );
    }
    const requestTf = dto.timeframe && KUCOIN_TYPE[dto.timeframe] ? dto.timeframe : '1h';
    const maxIterations = Math.min(
      HARD_MAX_ITERATIONS,
      Math.max(1, dto.maxIterations ?? DEFAULT_MAX_ITERATIONS),
    );
    const tokens = (dto.tokens && dto.tokens.length
      ? dto.tokens
      : DEFAULT_STRATEGY_TOKENS[strategy]
    ).map((t) => t.toUpperCase()).filter((t) => SUPPORTED_TOKENS.includes(t));
    if (tokens.length === 0) throw new BadRequestException('Aucun token valide.');

    const initialCapital = dto.initialCapital && dto.initialCapital > 0 ? dto.initialCapital : 10000;
    const feePct = dto.feesPct ?? DEFAULT_FEES_PCT;
    const slipPct = dto.slippagePct ?? DEFAULT_SLIPPAGE_PCT;

    const space = SEARCH_SPACES[strategy];
    const keys = Object.keys(space);

    // Timeframes nécessaires (le param "timeframe" peut faire partie de l'espace).
    const timeframes: string[] = Array.isArray(space.timeframe)
      ? (space.timeframe as string[])
      : [requestTf];

    // Pré-chargement des bougies par timeframe + découpe in-sample / out-of-sample.
    // Structures plain-object (sérialisables) pour transmission aux workers.
    const isDataByTf: Record<string, Record<string, Candle[]>> = {};
    const oosDataByTf: Record<string, Record<string, Candle[]>> = {};
    const periods = new Map<string, { is: any; oos: any }>();
    for (const tf of timeframes) {
      const full = new Map<string, Candle[]>();
      for (const token of tokens) {
        const candles = await this.ohlcv.getCandles(token, tf, undefined, undefined);
        if (candles.length > 0) full.set(token, candles);
      }
      if (full.size === 0) continue;
      const { splitMs, minMs, maxMs } = this.splitPoint(full);
      const isRec: Record<string, Candle[]> = {};
      const oosRec: Record<string, Candle[]> = {};
      for (const [tk, arr] of full.entries()) {
        isRec[tk] = arr.filter((c) => c.t <= splitMs);
        oosRec[tk] = arr.filter((c) => c.t > splitMs);
      }
      isDataByTf[tf] = isRec;
      oosDataByTf[tf] = oosRec;
      periods.set(tf, {
        is: { start: new Date(minMs).toISOString(), end: new Date(splitMs).toISOString() },
        oos: { start: new Date(splitMs).toISOString(), end: new Date(maxMs).toISOString() },
      });
    }
    if (Object.keys(isDataByTf).length === 0) {
      throw new BadRequestException(
        `Aucune donnée OHLCV pour ${tokens.join(', ')}. Lancez d'abord POST /api/backtest/fetch-data.`,
      );
    }

    // Taille brute de l'espace (produit des cardinalités, borne supérieure).
    const rawGridSize = keys.reduce((acc, k) => acc * space[k].length, 1);
    const canEnumerate = rawGridSize <= ENUM_CAP;

    // Résolution de la méthode de recherche.
    let searchMethod: SearchMethod;
    const notesExtra: string[] = [];
    if (requested) {
      searchMethod = requested;
      if (searchMethod === 'grid' && (!canEnumerate || rawGridSize > maxIterations)) {
        searchMethod = 'random';
        notesExtra.push(`grid impossible (${rawGridSize} combos > cap) → random`);
      }
    } else {
      searchMethod = canEnumerate && rawGridSize <= maxIterations ? 'grid' : 'random';
    }

    // Contexte in-sample (transmis aux workers).
    const ctxIS: SharedCtx = {
      strategy, tokens, feePct, slipPct, initialCapital, defaultTf: requestTf, dataByTf: isDataByTf,
    };

    // Pool de workers (fallback synchrone si indisponible).
    const poolSize = Math.min(POOL_MAX_WORKERS, Math.max(1, os.cpus()?.length ?? 1));
    let pool: WorkerPool | null = null;
    let workersUsed = false;
    if (resolveWorkerPath()) {
      try {
        pool = new WorkerPool(poolSize, ctxIS, lossFunction);
        workersUsed = true;
      } catch (e) {
        this.logger.warn(`Workers indisponibles, fallback synchrone : ${(e as Error).message}`);
        pool = null;
      }
    }

    const evalAll = async (combos: Record<string, any>[]): Promise<(number | null)[]> => {
      if (combos.length === 0) return [];
      if (pool) {
        try {
          return await pool.run(combos);
        } catch (e) {
          this.logger.warn(`Erreur worker, fallback synchrone : ${(e as Error).message}`);
          pool = null;
        }
      }
      return combos.map((c) => {
        const m = evaluateComboCore(ctxIS, c);
        return m ? objective(lossFunction, m) : null;
      });
    };

    const t0 = Date.now();
    const scored: ScoredCombo[] = [];
    const convergence: ConvergencePoint[] = [];
    let bestSoFar = -Infinity;
    let iter = 0;
    let status = 'completed';
    let lastImproveIter = 0;
    const patience = Math.max(0, Math.floor(dto.patience ?? 0));
    let earlyStopped = false;

    // Enregistre un score dans la courbe de convergence (best-so-far).
    const record = (score: number | null) => {
      iter++;
      if (score !== null && score > bestSoFar) {
        bestSoFar = score;
        lastImproveIter = iter;
      }
      convergence.push({ iter, bestScore: Number.isFinite(bestSoFar) ? bestSoFar : 0 });
    };
    const shouldEarlyStop = (): boolean => {
      if (patience <= 0) return false;
      if (lastImproveIter === 0) return false; // pas encore de score valide
      return iter - lastImproveIter >= patience;
    };

    try {
      if (searchMethod === 'grid') {
        const combos = this.enumerateByIndex(space).filter((c) => isValidCombo(strategy, c));
        const scores = await evalAll(combos);
        for (let i = 0; i < combos.length; i++) {
          record(scores[i]);
          if (scores[i] !== null) scored.push({ combo: combos[i], score: scores[i] as number });
        }
      } else if (searchMethod === 'random') {
        const target = Math.min(maxIterations, rawGridSize);
        const batch = Math.max(1, workersUsed ? poolSize : 32);
        while (iter < target) {
          if (Date.now() - t0 > MAX_WALL_MS) { status = 'partial'; break; }
          if (shouldEarlyStop()) { earlyStopped = true; break; }
          const remaining = Math.min(batch, target - iter);
          const combos = this.sampleCombos(space, strategy, remaining);
          const scores = await evalAll(combos);
          for (let i = 0; i < combos.length; i++) {
            record(scores[i]);
            if (scores[i] !== null) scored.push({ combo: combos[i], score: scores[i] as number });
          }
        }
      } else {
        // Bayésien (TPE).
        const target = Math.min(maxIterations, rawGridSize);
        const batch = Math.max(1, workersUsed ? poolSize : 8);
        const evaluatedKeys = new Set<string>();
        const history: ScoredCombo[] = [];

        // Démarrage aléatoire.
        const nStartup = Math.min(target, Math.max(TPE_MIN_STARTUP, 2 * batch));
        const startCombos = this.sampleCombos(space, strategy, nStartup);
        for (const c of startCombos) evaluatedKeys.add(this.comboKey(c));
        const startScores = await evalAll(startCombos);
        for (let i = 0; i < startCombos.length; i++) {
          record(startScores[i]);
          if (startScores[i] !== null) {
            const sc = { combo: startCombos[i], score: startScores[i] as number };
            scored.push(sc); history.push(sc);
          }
        }

        // Boucle TPE.
        while (iter < target && evaluatedKeys.size < rawGridSize) {
          if (Date.now() - t0 > MAX_WALL_MS) { status = 'partial'; break; }
          if (shouldEarlyStop()) { earlyStopped = true; break; }
          const remaining = Math.min(batch, target - iter);
          const proposals = this.tpePropose(
            space, strategy, history, remaining, evaluatedKeys,
          );
          if (proposals.length === 0) break;
          for (const c of proposals) evaluatedKeys.add(this.comboKey(c));
          const scores = await evalAll(proposals);
          for (let i = 0; i < proposals.length; i++) {
            record(scores[i]);
            if (scores[i] !== null) {
              const sc = { combo: proposals[i], score: scores[i] as number };
              scored.push(sc); history.push(sc);
            }
          }
        }
      }

      if (Date.now() - t0 > MAX_WALL_MS && status === 'completed') status = 'partial';
    } finally {
      if (pool) await pool.destroy();
    }

    if (scored.length === 0) {
      throw new BadRequestException('Aucune combinaison n\'a pu être évaluée (données insuffisantes).');
    }

    // Classement in-sample décroissant, puis recalcul des métriques du top-N (IS + OOS).
    scored.sort((a, b) => b.score - a.score);
    const topRaw = scored.slice(0, TOP_N);
    const ctxOOSByTf = oosDataByTf;

    const top = topRaw.map((r) => {
      const tf = (r.combo.timeframe as string) ?? requestTf;
      const isM = evaluateComboCore(ctxIS, r.combo);
      const oosCtx: SharedCtx = { ...ctxIS, dataByTf: ctxOOSByTf };
      const oosM = ctxOOSByTf[tf] ? evaluateComboCore(oosCtx, r.combo) : null;
      return {
        params: this.stripTf(r.combo),
        timeframe: tf,
        score: this.round(r.score),
        inSample: isM ? this.metricsView(isM) : null,
        outOfSample: oosM ? this.metricsView(oosM) : null,
        _isM: isM,
      };
    });

    const best = top[0];
    const bestIsAnn = best._isM ? best._isM.annualizedPct : 0;
    const bestOosMetrics = best.outOfSample;
    const wfe = this.computeWfe(bestIsAnn, bestOosMetrics?.annualizedPct ?? null);

    // Nettoyage du champ interne avant persistance.
    const topClean = top.map(({ _isM, ...rest }) => rest);

    const execMs = Date.now() - t0;
    const period = periods.get(best.timeframe) ?? periods.values().next().value!;
    const sampledConv = this.sampleConvergence(convergence, CONVERGENCE_POINTS);
    const notes = [
      `${strategy}`, `loss=${lossFunction}`, `method=${searchMethod}`,
      `${scored.length}/${iter} évalués`, `espace=${rawGridSize}`,
      workersUsed ? `${poolSize} workers` : 'synchrone',
      `${execMs}ms`,
      earlyStopped ? `early-stop@${iter} (patience=${patience}, lastImprove@${lastImproveIter})` : null,
      patience > 0 && !earlyStopped ? `patience=${patience} non déclenché` : null,
      ...notesExtra,
    ].filter(Boolean).join(' | ');
    this.logger.log(`[optimize] ${notes}`);

    const saved = await this.prisma.backtest_optimization.create({
      data: {
        strategy_type: strategy,
        loss_function: lossFunction,
        timeframe: best.timeframe,
        tokens: JSON.stringify(tokens),
        search_method: searchMethod,
        grid_size: rawGridSize,
        iterations_tested: iter,
        best_params: JSON.stringify(best.params),
        best_metrics: JSON.stringify(best.inSample ?? {}),
        oos_metrics: JSON.stringify(bestOosMetrics ?? {}),
        wfe: wfe === null ? '' : String(wfe),
        top_results: JSON.stringify(topClean),
        in_sample_period: JSON.stringify(period.is),
        out_sample_period: JSON.stringify(period.oos),
        status,
        notes,
        exec_ms: execMs,
        convergence: JSON.stringify(sampledConv),
      },
    });

    return this.format(saved);
  }

  async getResult(id: string): Promise<any> {
    const row = await this.prisma.backtest_optimization.findUnique({ where: { id } });
    if (!row) throw new BadRequestException('Optimisation introuvable');
    return this.format(row);
  }

  async history(limit = 50): Promise<any> {
    const rows = await this.prisma.backtest_optimization.findMany({
      orderBy: { created_at: 'desc' },
      take: Math.min(200, Math.max(1, limit)),
    });
    return { count: rows.length, optimizations: rows.map((r: any) => this.format(r)) };
  }

  // ──────────────── helpers ────────────────

  /** Point de coupe temporel in-sample / out-of-sample (70/30 par défaut). */
  private splitPoint(full: Map<string, Candle[]>): { splitMs: number; minMs: number; maxMs: number } {
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const arr of full.values()) {
      if (arr.length === 0) continue;
      minMs = Math.min(minMs, arr[0].t);
      maxMs = Math.max(maxMs, arr[arr.length - 1].t);
    }
    const splitMs = minMs + (maxMs - minMs) * IN_SAMPLE_RATIO;
    return { splitMs, minMs, maxMs };
  }

  /** Retire la clé `timeframe` d'une combinaison (gérée via le jeu de bougies). */
  private stripTf(combo: Record<string, any>): Record<string, any> {
    const p = { ...combo };
    delete p.timeframe;
    return p;
  }

  /** Clé canonique d'une combinaison (pour la déduplication). */
  private comboKey(combo: Record<string, any>): string {
    const keys = Object.keys(combo).sort();
    return keys.map((k) => `${k}=${combo[k]}`).join('&');
  }

  /**
   * Énumère l'intégralité de l'espace par décodage d'index (sans récursion).
   * À n'utiliser que si la taille de l'espace tient sous ENUM_CAP.
   */
  private enumerateByIndex(space: Record<string, any[]>): Record<string, any>[] {
    const keys = Object.keys(space);
    const sizes = keys.map((k) => space[k].length);
    const total = sizes.reduce((a, b) => a * b, 1);
    const out: Record<string, any>[] = [];
    for (let idx = 0; idx < total; idx++) {
      const combo: Record<string, any> = {};
      let rem = idx;
      for (let d = 0; d < keys.length; d++) {
        const size = sizes[d];
        combo[keys[d]] = space[keys[d]][rem % size];
        rem = Math.floor(rem / size);
      }
      out.push(combo);
    }
    return out;
  }

  /** Tire une combinaison aléatoire (une valeur par paramètre). */
  private randomCombo(space: Record<string, any[]>): Record<string, any> {
    const combo: Record<string, any> = {};
    for (const k of Object.keys(space)) {
      const vals = space[k];
      combo[k] = vals[Math.floor(Math.random() * vals.length)];
    }
    return combo;
  }

  /**
   * Échantillonne jusqu'à `n` combinaisons valides et distinctes (random search).
   * Chaque paramètre est tiré indépendamment — pas d'énumération de l'espace.
   */
  private sampleCombos(
    space: Record<string, any[]>, strategy: StrategyName, n: number,
  ): Record<string, any>[] {
    const out: Record<string, any>[] = [];
    const seen = new Set<string>();
    const maxAttempts = n * 20 + 200;
    let attempts = 0;
    while (out.length < n && attempts < maxAttempts) {
      attempts++;
      const c = this.randomCombo(space);
      if (!isValidCombo(strategy, c)) continue;
      const key = this.comboKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  /**
   * Proposition TPE (Tree-structured Parzen Estimator) discret.
   *
   * Sépare l'historique en "bons" (meilleurs scores, fraction GAMMA) et "mauvais",
   * estime pour chaque (param, valeur) les densités l() et g() lissées (Laplace),
   * génère des candidats depuis la distribution "bonne", et retient ceux qui
   * maximisent l'espérance d'amélioration EI = Σ log(l/g).
   */
  private tpePropose(
    space: Record<string, any[]>, strategy: StrategyName,
    history: ScoredCombo[], batch: number, evaluated: Set<string>,
  ): Record<string, any>[] {
    const keys = Object.keys(space);
    // Historique insuffisant → tirage aléatoire.
    if (history.length < Math.max(4, batch)) {
      return this.sampleUnseen(space, strategy, batch, evaluated);
    }
    const sorted = [...history].sort((a, b) => b.score - a.score);
    const nGood = Math.max(1, Math.floor(TPE_GAMMA * sorted.length));
    const good = sorted.slice(0, nGood);
    const bad = sorted.slice(nGood);

    // Comptages par (param, valeur).
    const cntGood: Record<string, Map<any, number>> = {};
    const cntBad: Record<string, Map<any, number>> = {};
    for (const k of keys) { cntGood[k] = new Map(); cntBad[k] = new Map(); }
    for (const h of good) for (const k of keys) {
      cntGood[k].set(h.combo[k], (cntGood[k].get(h.combo[k]) ?? 0) + 1);
    }
    for (const h of bad) for (const k of keys) {
      cntBad[k].set(h.combo[k], (cntBad[k].get(h.combo[k]) ?? 0) + 1);
    }

    // Densités lissées l() (bons) et g() (mauvais).
    const lDensity = (k: string, v: any) =>
      ((cntGood[k].get(v) ?? 0) + 1) / (good.length + space[k].length);
    const gDensity = (k: string, v: any) =>
      ((cntBad[k].get(v) ?? 0) + 1) / (bad.length + space[k].length);

    // Échantillonne une valeur pondérée par la distribution "bonne".
    const sampleGood = (k: string): any => {
      const vals = space[k];
      const weights = vals.map((v) => (cntGood[k].get(v) ?? 0) + 1);
      const tot = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * tot;
      for (let i = 0; i < vals.length; i++) {
        r -= weights[i];
        if (r <= 0) return vals[i];
      }
      return vals[vals.length - 1];
    };

    // Génère des candidats, score EI = Σ log(l/g).
    const candidates: { combo: Record<string, any>; ei: number }[] = [];
    for (let i = 0; i < TPE_N_EI_CANDIDATES; i++) {
      const combo: Record<string, any> = {};
      for (const k of keys) combo[k] = sampleGood(k);
      if (!isValidCombo(strategy, combo)) continue;
      const key = this.comboKey(combo);
      if (evaluated.has(key)) continue;
      let ei = 0;
      for (const k of keys) ei += Math.log(lDensity(k, combo[k]) / gDensity(k, combo[k]));
      candidates.push({ combo, ei });
    }
    candidates.sort((a, b) => b.ei - a.ei);

    // Sélectionne `batch` candidats uniques.
    const out: Record<string, any>[] = [];
    const localSeen = new Set<string>();
    for (const c of candidates) {
      if (out.length >= batch) break;
      const key = this.comboKey(c.combo);
      if (localSeen.has(key)) continue;
      localSeen.add(key);
      out.push(c.combo);
    }
    // Complète avec de l'aléatoire si nécessaire.
    if (out.length < batch) {
      for (const c of this.sampleUnseen(space, strategy, batch - out.length, evaluated, localSeen)) {
        out.push(c);
      }
    }
    return out;
  }

  /** Tire `n` combinaisons valides non encore évaluées (ni déjà retenues localement). */
  private sampleUnseen(
    space: Record<string, any[]>, strategy: StrategyName, n: number,
    evaluated: Set<string>, localSeen?: Set<string>,
  ): Record<string, any>[] {
    const out: Record<string, any>[] = [];
    const seen = localSeen ?? new Set<string>();
    const maxAttempts = n * 30 + 200;
    let attempts = 0;
    while (out.length < n && attempts < maxAttempts) {
      attempts++;
      const c = this.randomCombo(space);
      if (!isValidCombo(strategy, c)) continue;
      const key = this.comboKey(c);
      if (evaluated.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  /** Sous-échantillonne la courbe de convergence à ~`points` points (garde le dernier). */
  private sampleConvergence(conv: ConvergencePoint[], points: number): ConvergencePoint[] {
    if (conv.length <= points) return conv;
    const step = conv.length / points;
    const out: ConvergencePoint[] = [];
    for (let i = 0; i < points; i++) out.push(conv[Math.floor(i * step)]);
    if (out[out.length - 1].iter !== conv[conv.length - 1].iter) out.push(conv[conv.length - 1]);
    return out;
  }

  /** WFE = rendement annualisé out-of-sample / in-sample. */
  private computeWfe(isAnnualized: number, oosAnnualized: number | null): number | null {
    if (oosAnnualized === null) return null;
    if (isAnnualized <= 0) return null; // non significatif si l'in-sample n'est pas rentable
    return this.round(oosAnnualized / isAnnualized);
  }

  private metricsView(m: BacktestMetrics): Record<string, number> {
    return {
      finalEquity: this.round(m.finalEquity, 2),
      totalReturnPct: this.round(m.totalReturnPct),
      annualizedPct: this.round(m.annualizedPct),
      sharpeRatio: this.round(m.sharpeRatio),
      sortinoRatio: this.round(m.sortinoRatio),
      calmarRatio: this.round(m.calmarRatio),
      maxDrawdownPct: this.round(m.maxDrawdownPct),
      maxDrawdownDurationDays: this.round(m.maxDrawdownDurationDays, 2),
      winRatePct: this.round(m.winRatePct, 2),
      profitFactor: Number.isFinite(m.profitFactor) ? this.round(m.profitFactor) : 999.9999,
      tradesCount: m.tradesCount,
      buyHoldPct: this.round(m.buyHoldPct),
    };
  }

  private round(v: number, dp = 4): number {
    if (!Number.isFinite(v)) return 0;
    const f = Math.pow(10, dp);
    return Math.round(v * f) / f;
  }

  private wfeLabel(wfe: number | null): string {
    if (wfe === null) return 'non significatif (in-sample non rentable)';
    if (wfe >= 0.7) return 'excellent';
    if (wfe >= 0.5) return 'viable';
    if (wfe > 0) return 'faible (risque de sur-apprentissage)';
    return 'négatif (sur-apprentissage probable)';
  }

  private format(r: any): any {
    const wfe = r.wfe === '' || r.wfe === null || r.wfe === undefined ? null : parseFloat(r.wfe);
    return {
      id: r.id,
      strategy: r.strategy_type,
      lossFunction: r.loss_function,
      timeframe: r.timeframe,
      tokens: this.parseJson(r.tokens, []),
      searchMethod: r.search_method,
      gridSize: r.grid_size,
      iterationsTested: r.iterations_tested,
      bestParams: this.parseJson(r.best_params, {}),
      bestMetricsInSample: this.parseJson(r.best_metrics, {}),
      bestMetricsOutOfSample: this.parseJson(r.oos_metrics, {}),
      walkForward: {
        wfe,
        interpretation: this.wfeLabel(wfe),
        inSamplePeriod: this.parseJson(r.in_sample_period, {}),
        outOfSamplePeriod: this.parseJson(r.out_sample_period, {}),
      },
      topResults: this.parseJson(r.top_results, []),
      status: r.status,
      executionMs: r.exec_ms ?? 0,
      convergence: this.parseJson(r.convergence, []),
      notes: r.notes,
      createdAt: r.created_at,
    };
  }

  private parseJson(s: string, fallback: any): any {
    try { return JSON.parse(s); } catch { return fallback; }
  }
}
