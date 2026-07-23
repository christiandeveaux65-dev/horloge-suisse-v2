import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { STRATEGIST_PARAM_MIN_FACTOR, STRATEGIST_PARAM_MAX_FACTOR } from '../constants';

/**
 * Strategist — méta-stratégiste (LLM) qui analyse la performance récente et propose
 * des ajustements de paramètres BORNÉS ([0.5x, 1.5x], cf. constants). Toute suggestion
 * hors bornes est écrêtée. Le parsing LLM est défensif : si l'appel ou le JSON échoue,
 * on retombe sur une analyse déterministe. Le Strategist NE TOUCHE JAMAIS aux limites
 * de risque hardcodées (Risk Manager, MR $75/$300/$600) ni au cœur DCA.
 * Cron toutes les 4 heures.
 */
@Injectable()
export class StrategistService {
  private readonly logger = new Logger(StrategistService.name);
  private enabled = true;

  constructor(private readonly prisma: PrismaService) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /** Appelé séquentiellement par le PipelineOrchestrator (plus de @Cron individuel). */
  async tick(): Promise<any> {
    if (!this.enabled) return { skipped: true, reason: 'disabled' };
    try {
      return await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle Strategist échoué: ${err.message}`);
      return { error: err.message };
    }
  }

  /** Borne dure d'un facteur d'ajustement. */
  private clampFactor(f: number): number {
    if (!Number.isFinite(f)) return 1;
    return Math.max(STRATEGIST_PARAM_MIN_FACTOR, Math.min(STRATEGIST_PARAM_MAX_FACTOR, f));
  }

  async executeCycle(): Promise<any> {
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      return { success: false, reason: 'pause_globale' };
    }

    // 1. Rassembler la performance récente (7 jours)
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const trades = await this.prisma.trade.findMany({
      where: { executed_at: { gte: since } },
      orderBy: { executed_at: 'desc' },
      take: 500,
    });
    const snapshots = await this.prisma.portfolio_snapshot.findMany({
      orderBy: { snapshot_at: 'desc' }, take: 300,
    });
    const regimes = await this.prisma.market_regime.findMany({
      orderBy: { recorded_at: 'desc' }, take: 20,
    });

    const perf = this.summarize(trades, snapshots);

    // 2. Recommandation (LLM défensif -> fallback déterministe enrichi)
    let recommendation = await this.askLlm(perf, regimes).catch((e) => {
      this.logger.warn(`LLM indisponible, fallback déterministe: ${e.message}`);
      return null;
    });
    if (!recommendation) {
      recommendation = this.deterministic(perf, trades, regimes, riskCfg);
    }

    // 3. Appliquer les ajustements BORNÉS (aucune limite de risque hardcodée touchée)
    const applied = await this.applyAdjustments(recommendation);

    // 4. Journaliser la décision
    await this.prisma.leverage_event.create({
      data: {
        protocol: 'strategist',
        kind: 'adjust',
        detail: recommendation.summary?.slice(0, 500) ?? 'ajustement',
        payload: JSON.stringify({ perf, recommendation, applied }).slice(0, 4000),
      },
    }).catch(() => undefined);

    return { success: true, perf, recommendation, applied };
  }

  private summarize(trades: any[], snapshots: any[]): any {
    const total = trades.length;
    const completed = trades.filter((t) => t.status === 'completed' || t.status === 'simulated');
    const bySource: Record<string, number> = {};
    for (const t of trades) bySource[t.source] = (bySource[t.source] || 0) + 1;

    // Les snapshots sont 1 ligne par token ; on regroupe par horodatage pour obtenir la valeur totale.
    const byTs = new Map<string, number>();
    for (const s of snapshots) {
      const ts = new Date(s.snapshot_at).toISOString();
      byTs.set(ts, (byTs.get(ts) || 0) + parseFloat(s.value_usd ?? '0'));
    }
    const tsSorted = [...byTs.keys()].sort(); // ascendant
    let equityChangePct = 0;
    if (tsSorted.length >= 2) {
      const oldest = byTs.get(tsSorted[0]) || 0;
      const latest = byTs.get(tsSorted[tsSorted.length - 1]) || 0;
      if (oldest > 0) equityChangePct = ((latest - oldest) / oldest) * 100;
    }
    return { totalTrades: total, completedTrades: completed.length, bySource, equityChangePct };
  }

  private deterministic(perf: any, trades: any[], regimes: any[], riskCfg: any): any {
    const total = trades.length || 1;
    const wins = trades.filter((t: any) => t.side === 'sell' && parseFloat(t.amount_out || '0') > parseFloat(t.amount_in || '0'));
    const winRate = wins.length / total;
    const regimeCounts: Record<string, number> = {};
    for (const r of regimes) regimeCounts[r.regime] = (regimeCounts[r.regime] || 0) + 1;
    const dominant = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'range';
    let momentumFactor = 1; let mrFactor = 1; let gridFactor = 1; let arbFactor = 1; let dcaFactor = 1;
    if (perf.equityChangePct < -5) { momentumFactor *= 0.7; mrFactor *= 0.8; gridFactor *= 0.9; arbFactor *= 0.8; dcaFactor *= 0.9; }
    else if (perf.equityChangePct < 0) { momentumFactor *= 0.85; mrFactor *= 0.9; dcaFactor *= 0.95; }
    else if (perf.equityChangePct > 5) { momentumFactor *= 1.15; arbFactor *= 1.1; dcaFactor *= 1.05; }
    if (winRate < 0.3) { momentumFactor *= 0.8; mrFactor *= 0.85; dcaFactor *= 0.95; }
    else if (winRate > 0.6) { momentumFactor *= 1.1; mrFactor *= 1.1; dcaFactor *= 1.05; }
    if (dominant === 'bear') { momentumFactor *= 0.7; gridFactor *= 1.1; mrFactor *= 1.1; dcaFactor *= 1.1; }
    else if (dominant === 'bull') { momentumFactor *= 1.15; mrFactor *= 0.9; dcaFactor *= 0.95; }
    else if (dominant === 'high_vol') { gridFactor *= 1.15; arbFactor *= 1.1; momentumFactor *= 0.9; dcaFactor *= 0.9; }
    if (riskCfg?.recovery_mode) { momentumFactor *= 0.7; mrFactor *= 0.8; gridFactor *= 0.8; arbFactor *= 0.8; dcaFactor *= 0.9; }
    momentumFactor = this.clampFactor(momentumFactor);
    mrFactor = this.clampFactor(mrFactor);
    gridFactor = this.clampFactor(gridFactor);
    arbFactor = this.clampFactor(arbFactor);
    dcaFactor = this.clampFactor(dcaFactor);
    return {
      source: 'deterministic',
      summary: `Equity 7j ${perf.equityChangePct.toFixed(2)}%, winRate ${(winRate*100).toFixed(0)}%, regime ${dominant} => mom=${momentumFactor} mr=${mrFactor} dca=${dcaFactor} grid=${gridFactor} arb=${arbFactor}`,
      momentumSizeFactor: momentumFactor,
      meanReversionSizeFactor: mrFactor,
      dcaSizeFactor: dcaFactor,
      gridSizeFactor: gridFactor,
      arbitrageSizeFactor: arbFactor,
    };
  }

  /** Appel LLM défensif : renvoie null en cas d'échec ou de JSON invalide. */
  private async askLlm(perf: any, regimes: any[]): Promise<any | null> {
    const key = process.env.ABACUSAI_API_KEY;
    if (!key) return null;

    const prompt = `Tu es un méta-stratégiste de trading crypto prudent. Voici la performance des 7 derniers jours:\n`
      + `${JSON.stringify(perf)}\nRégimes de marché récents: ${JSON.stringify(regimes.slice(0, 5).map((r) => ({ token: r.token, regime: r.regime })))}\n`
      + `Propose des FACTEURS d'ajustement de taille de position pour les stratégies momentum, mean_reversion et dca, `
      + `STRICTEMENT entre ${STRATEGIST_PARAM_MIN_FACTOR} et ${STRATEGIST_PARAM_MAX_FACTOR}. `
      + `Ne propose JAMAIS de modifier les limites de risque. Réponds en JSON pur avec ce schéma:\n`
      + `{"summary": "...", "momentumSizeFactor": 1.0, "meanReversionSizeFactor": 1.0, "dcaSizeFactor": 1.0}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const resp = await fetch('https://apps.abacus.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: any = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;
      const parsed = JSON.parse(content);
      return {
        source: 'llm',
        summary: typeof parsed.summary === 'string' ? parsed.summary : 'ajustement LLM',
        momentumSizeFactor: this.clampFactor(parseFloat(parsed.momentumSizeFactor)),
        meanReversionSizeFactor: this.clampFactor(parseFloat(parsed.meanReversionSizeFactor)),
        dcaSizeFactor: this.clampFactor(parseFloat(parsed.dcaSizeFactor)),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Applique les facteurs bornés. Par prudence, le Strategist n'ajuste PAS directement les
   * budgets hardcodés ; il enregistre son intention dans app_config (clés consultables par
   * les modules). Les limites de risque restent intouchables.
   */
  private async applyAdjustments(rec: any): Promise<any> {
    const momentum = this.clampFactor(rec.momentumSizeFactor ?? 1);
    const mr = this.clampFactor(rec.meanReversionSizeFactor ?? 1);
    const dca = this.clampFactor(rec.dcaSizeFactor ?? 1);
    const upsert = async (key: string, value: string) => {
      await this.prisma.app_config.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      }).catch(() => undefined);
    };
    const grid = this.clampFactor(rec.gridSizeFactor ?? 1);
    const arb = this.clampFactor(rec.arbitrageSizeFactor ?? 1);
    await upsert('strategist.momentumSizeFactor', String(momentum));
    await upsert('strategist.meanReversionSizeFactor', String(mr));
    await upsert('strategist.dcaSizeFactor', String(dca));
    await upsert('strategist.gridSizeFactor', String(grid));
    await upsert('strategist.arbitrageSizeFactor', String(arb));
    await upsert('strategist.updatedAt', new Date().toISOString());
    return {
      momentumSizeFactor: momentum,
      meanReversionSizeFactor: mr,
      dcaSizeFactor: dca,
      gridSizeFactor: grid,
      arbitrageSizeFactor: arb,
    };
  }

  async getStatus(): Promise<any> {
    const cfgs = await this.prisma.app_config.findMany({
      where: { key: { startsWith: 'strategist.' } },
    });
    const lastEvent = await this.prisma.leverage_event.findFirst({
      where: { protocol: 'strategist' }, orderBy: { created_at: 'desc' },
    });
    return {
      enabled: this.enabled,
      schedule: '0 0 */4 * * * (toutes les 4 h)',
      bounds: { min: STRATEGIST_PARAM_MIN_FACTOR, max: STRATEGIST_PARAM_MAX_FACTOR },
      llmEnabled: !!process.env.ABACUSAI_API_KEY,
      currentFactors: Object.fromEntries(cfgs.map((c: any) => [c.key, c.value])),
      lastDecision: lastEvent,
    };
  }
}
