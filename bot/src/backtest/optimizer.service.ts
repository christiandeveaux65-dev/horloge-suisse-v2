import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OhlcvService } from './ohlcv.service';
import { simulate, buyHoldFinal, SimConfig } from './strategies';
import { computeMetrics } from './metrics';
import { Candle, BacktestMetrics } from './backtest.types';
import {
  DEFAULT_FEES_PCT, DEFAULT_SLIPPAGE_PCT, SUPPORTED_TOKENS, KUCOIN_TYPE,
} from './backtest.constants';
import {
  SEARCH_SPACES, LOSS_FUNCTIONS, LossFunction, StrategyName, isValidCombo,
  IN_SAMPLE_RATIO, DEFAULT_MAX_ITERATIONS, HARD_MAX_ITERATIONS, TOP_N,
} from './optimizer.constants';
import { OptimizeDto } from './dto/optimize.dto';

/** Tokens par défaut selon la stratégie (miroir du bot réel). */
const DEFAULT_STRATEGY_TOKENS: Record<string, string[]> = {
  dca: ['WETH', 'WBTC', 'ARB'],
  grid: ['WETH'],
  mean_reversion: ['ARB', 'PENDLE', 'GMX'],
  momentum: ['WETH', 'WBTC', 'ARB', 'LINK'],
};

interface ComboResult {
  params: Record<string, any>;
  timeframe: string;
  isMetrics: BacktestMetrics;
  score: number;
}

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

    // Timeframes nécessaires (le param "timeframe" peut faire partie de l'espace).
    const timeframes: string[] = Array.isArray(space.timeframe)
      ? (space.timeframe as string[])
      : [requestTf];

    // Pré-chargement des bougies par timeframe + découpe in-sample / out-of-sample.
    const isData = new Map<string, Map<string, Candle[]>>();
    const oosData = new Map<string, Map<string, Candle[]>>();
    const periods = new Map<string, { is: any; oos: any }>();
    for (const tf of timeframes) {
      const full = new Map<string, Candle[]>();
      for (const token of tokens) {
        const candles = await this.ohlcv.getCandles(token, tf, undefined, undefined);
        if (candles.length > 0) full.set(token, candles);
      }
      if (full.size === 0) continue;
      const { splitMs, minMs, maxMs } = this.splitPoint(full);
      const isMap = new Map<string, Candle[]>();
      const oosMap = new Map<string, Candle[]>();
      for (const [tk, arr] of full.entries()) {
        isMap.set(tk, arr.filter((c) => c.t <= splitMs));
        oosMap.set(tk, arr.filter((c) => c.t > splitMs));
      }
      isData.set(tf, isMap);
      oosData.set(tf, oosMap);
      periods.set(tf, {
        is: { start: new Date(minMs).toISOString(), end: new Date(splitMs).toISOString() },
        oos: { start: new Date(splitMs).toISOString(), end: new Date(maxMs).toISOString() },
      });
    }
    if (isData.size === 0) {
      throw new BadRequestException(
        `Aucune donnée OHLCV pour ${tokens.join(', ')}. Lancez d'abord POST /api/backtest/fetch-data.`,
      );
    }

    // Énumération des combinaisons valides.
    const allCombos = this.cartesian(space).filter((c) => isValidCombo(strategy, c));
    const gridSize = allCombos.length;

    // Choix grid vs random : grid complet si l'espace tient dans le budget, sinon random.
    let combos = allCombos;
    let searchMethod: 'grid' | 'random' | 'hybrid' = 'grid';
    if (gridSize > maxIterations) {
      combos = this.sample(allCombos, maxIterations);
      searchMethod = 'random';
    }

    const t0 = Date.now();
    const results: ComboResult[] = [];
    for (const combo of combos) {
      const tf = (combo.timeframe as string) ?? requestTf;
      const isMap = isData.get(tf);
      if (!isMap || isMap.size === 0) continue;
      const params = this.buildParams(strategy, combo, tokens);
      const m = this.runSim(isMap, strategy, tokens, params, feePct, slipPct, initialCapital, tf);
      if (!m) continue;
      results.push({ params: combo, timeframe: tf, isMetrics: m, score: this.objective(lossFunction, m) });
    }
    if (results.length === 0) {
      throw new BadRequestException('Aucune combinaison n\'a pu être évaluée (données insuffisantes).');
    }

    // Classement in-sample décroissant.
    results.sort((a, b) => b.score - a.score);
    const topRaw = results.slice(0, TOP_N);

    // Évaluation out-of-sample des meilleures combinaisons.
    const top = topRaw.map((r) => {
      const oosMap = oosData.get(r.timeframe);
      const params = this.buildParams(strategy, r.params, tokens);
      const oosM = oosMap && oosMap.size
        ? this.runSim(oosMap, strategy, tokens, params, feePct, slipPct, initialCapital, r.timeframe)
        : null;
      return {
        params: r.params,
        timeframe: r.timeframe,
        score: this.round(r.score),
        inSample: this.metricsView(r.isMetrics),
        outOfSample: oosM ? this.metricsView(oosM) : null,
      };
    });

    const best = top[0];
    const bestIs = topRaw[0].isMetrics;
    const bestOosMetrics = best.outOfSample;
    // Walk-Forward Efficiency = perf out-of-sample / perf in-sample (rendement annualisé).
    const wfe = this.computeWfe(bestIs.annualizedPct, bestOosMetrics?.annualizedPct ?? null);

    const period = periods.get(best.timeframe)!;
    const notes = `${strategy} | loss=${lossFunction} | ${searchMethod} | ${results.length}/${gridSize} combos | ${Date.now() - t0}ms`;
    this.logger.log(notes);

    const saved = await this.prisma.backtest_optimization.create({
      data: {
        strategy_type: strategy,
        loss_function: lossFunction,
        timeframe: best.timeframe,
        tokens: JSON.stringify(tokens),
        search_method: searchMethod,
        grid_size: gridSize,
        iterations_tested: results.length,
        best_params: JSON.stringify(best.params),
        best_metrics: JSON.stringify(best.inSample),
        oos_metrics: JSON.stringify(bestOosMetrics ?? {}),
        wfe: wfe === null ? '' : String(wfe),
        top_results: JSON.stringify(top),
        in_sample_period: JSON.stringify(period.is),
        out_sample_period: JSON.stringify(period.oos),
        status: 'completed',
        notes,
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
    return { count: rows.length, optimizations: rows.map((r) => this.format(r)) };
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

  /** Produit cartésien de l'espace de recherche. */
  private cartesian(space: Record<string, any[]>): Record<string, any>[] {
    const keys = Object.keys(space);
    let out: Record<string, any>[] = [{}];
    for (const key of keys) {
      const next: Record<string, any>[] = [];
      for (const partial of out) {
        for (const val of space[key]) {
          next.push({ ...partial, [key]: val });
        }
      }
      out = next;
    }
    return out;
  }

  /** Échantillonnage aléatoire sans doublon (random search). */
  private sample(combos: Record<string, any>[], n: number): Record<string, any>[] {
    if (combos.length <= n) return combos;
    const idx = new Set<number>();
    while (idx.size < n) idx.add(Math.floor(Math.random() * combos.length));
    return Array.from(idx).map((i) => combos[i]);
  }

  /** Construit les params de simulation à partir d'une combinaison. */
  private buildParams(
    strategy: StrategyName, combo: Record<string, any>, tokens: string[],
  ): Record<string, any> {
    const p: Record<string, any> = { ...combo };
    delete p.timeframe; // géré séparément (sélection du jeu de bougies)
    if (strategy === 'grid') p.token = tokens[0];
    return p;
  }

  /** Exécute une simulation et renvoie les métriques (ou null si pas de données). */
  private runSim(
    candlesByToken: Map<string, Candle[]>, strategy: StrategyName, tokens: string[],
    params: Record<string, any>, feePct: number, slipPct: number,
    initialCapital: number, timeframe: string,
  ): BacktestMetrics | null {
    const active = new Map<string, Candle[]>();
    for (const [tk, arr] of candlesByToken.entries()) if (arr.length > 1) active.set(tk, arr);
    if (active.size === 0) return null;
    const cfg: SimConfig = {
      strategy, tokens: Array.from(active.keys()), initialCapital, feePct, slipPct, params,
    };
    const { trades, equityCurve } = simulate(active, cfg);
    if (equityCurve.length < 2) return null;
    const bhFinal = buyHoldFinal(active, initialCapital);
    return computeMetrics({ curve: equityCurve, trades, initialCapital, timeframe, buyHoldFinal: bhFinal });
  }

  /** Fonction objectif (plus élevé = meilleur) selon la loss function choisie. */
  private objective(loss: LossFunction, m: BacktestMetrics): number {
    switch (loss) {
      case 'SharpeOptimize': return this.finite(m.sharpeRatio);
      case 'SortinoOptimize': return this.finite(m.sortinoRatio);
      case 'ProfitMaximize': return this.finite(m.totalReturnPct);
      case 'MinDrawdown': return -this.finite(m.maxDrawdownPct);
      case 'Balanced':
        return this.finite(m.totalReturnPct) * 0.4
          + this.finite(m.sharpeRatio) * 0.3
          - this.finite(m.maxDrawdownPct) * 0.3;
      default: return this.finite(m.sharpeRatio);
    }
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

  private finite(v: number): number {
    return Number.isFinite(v) ? v : 0;
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
      notes: r.notes,
      createdAt: r.created_at,
    };
  }

  private parseJson(s: string, fallback: any): any {
    try { return JSON.parse(s); } catch { return fallback; }
  }
}
