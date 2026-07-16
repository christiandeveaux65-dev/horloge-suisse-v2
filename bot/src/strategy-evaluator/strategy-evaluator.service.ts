import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PriceService } from '../price/price.service';
import { SupervisionService, MarketRegime } from '../supervision/supervision.service';
import { STABLECOINS } from '../constants';

/** Stratégies évaluées (correspond au champ `source` de la table trade). */
export const EVALUATED_STRATEGIES = [
  'grid',
  'momentum',
  'mean_reversion',
  'dca',
  'arbitrage',
  'basis_trading',
  'flash_loan',
] as const;
export type EvaluatedStrategy = (typeof EVALUATED_STRATEGIES)[number];

/**
 * Matrice de pondération régime → stratégie (0 = neutre/défavorable, 1.5 = très favorable).
 * Sert à croiser la performance brute avec le régime de marché courant : une stratégie qui
 * performe historiquement bien dans le régime actuel voit son score amplifié.
 */
const REGIME_WEIGHTS: Record<MarketRegime, Record<EvaluatedStrategy, number>> = {
  BULL: {
    momentum: 1.5, dca: 1.3, grid: 1.0, arbitrage: 1.0,
    mean_reversion: 0.7, basis_trading: 1.0, flash_loan: 1.0,
  },
  BEAR: {
    mean_reversion: 1.4, arbitrage: 1.3, grid: 1.0, basis_trading: 1.1,
    dca: 0.8, momentum: 0.6, flash_loan: 1.0,
  },
  RANGE: {
    grid: 1.5, mean_reversion: 1.4, arbitrage: 1.1, dca: 1.0,
    basis_trading: 1.0, momentum: 0.6, flash_loan: 0.9,
  },
  HIGH_VOL: {
    arbitrage: 1.5, flash_loan: 1.3, momentum: 1.0, basis_trading: 1.1,
    grid: 0.7, mean_reversion: 0.7, dca: 0.6,
  },
};

export interface StrategyScore {
  strategy: EvaluatedStrategy;
  numTrades: number;
  completed: number;
  failed: number;
  successRate: number | null;
  netReturnUsd: number;
  realizedPnlUsd: number;
  gasUsd: number;
  winRate: number | null;
  gainLossRatio: number | null;
  sharpe: number;
  closedLots: number;
  perfScore: number; // score de performance brut (avant régime)
  regimeWeight: number;
  score: number; // score final (perfScore * regimeWeight)
}

interface Lot {
  qty: number; // quantité de token restante dans le lot
  costUsd: number; // coût USD proportionnel restant
}

@Injectable()
export class StrategyEvaluatorService {
  private readonly logger = new Logger('StrategyEvaluatorService');

  // Fenêtre glissante d'analyse (heures). 72h par défaut, 24h calculé en parallèle pour info.
  private readonly WINDOW_HOURS = 72;

  private lastScores: StrategyScore[] = [];
  private lastAllocations: Record<string, number> = {};
  private lastRegime: MarketRegime = 'RANGE';
  private lastEvaluatedAt: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly price: PriceService,
    private readonly supervision: SupervisionService,
  ) {}

  /** Appelé séquentiellement par le PipelineOrchestrator (Phase 5bis, 15 min). */
  async tick(): Promise<any> {
    try {
      return await this.evaluate();
    } catch (e: any) {
      this.logger.error(`Évaluation échouée : ${e?.message}`);
      return { error: e?.message };
    }
  }

  // ─── Évaluation complète ───

  async evaluate(windowHours = this.WINDOW_HOURS): Promise<any> {
    const since = new Date(Date.now() - windowHours * 3600 * 1000);
    const trades = await this.prisma.trade.findMany({
      where: { executed_at: { gte: since } },
      orderBy: { executed_at: 'asc' },
    });

    // Régime de marché courant (croisement) via SupervisionService.
    let regime: MarketRegime = 'RANGE';
    try {
      regime = (await this.supervision.detectRegime()).regime;
    } catch {
      regime = 'RANGE';
    }

    // Prix ETH pour convertir le gas (stocké en ETH) en USD.
    let ethPrice = 0;
    try {
      ethPrice = await this.price.getPrice('WETH');
    } catch {
      ethPrice = 0;
    }

    const scores: StrategyScore[] = [];
    for (const strat of EVALUATED_STRATEGIES) {
      const stratTrades = trades.filter((t) => t.source === strat);
      scores.push(this.scoreStrategy(strat, stratTrades, regime, ethPrice));
    }

    // Allocations : normaliser les scores positifs des stratégies recommandées actives.
    const directives = this.buildDirectives(scores, regime);
    const allocations = this.buildAllocations(scores, directives);

    // Persistance : historique + directives lisibles par le Strategist.
    await this.persist(regime, windowHours, trades.length, scores, allocations, directives);

    this.lastScores = scores;
    this.lastAllocations = allocations;
    this.lastRegime = regime;
    this.lastEvaluatedAt = new Date().toISOString();

    this.logger.log(
      `[STRATEGY-EVAL] Régime ${regime} — ${trades.length} trades/${windowHours}h — ` +
        `top: ${scores.slice().sort((a, b) => b.score - a.score).slice(0, 3).map((s) => `${s.strategy}(${s.score.toFixed(1)})`).join(', ')}`,
    );

    return {
      regime,
      windowHours,
      totalTrades: trades.length,
      scores,
      allocations,
      directives,
      evaluatedAt: this.lastEvaluatedAt,
    };
  }

  // ─── Scoring d'une stratégie ───

  private scoreStrategy(
    strategy: EvaluatedStrategy,
    trades: any[],
    regime: MarketRegime,
    ethPrice: number,
  ): StrategyScore {
    const regimeWeight = REGIME_WEIGHTS[regime][strategy] ?? 1.0;

    if (trades.length === 0) {
      return {
        strategy, numTrades: 0, completed: 0, failed: 0, successRate: null,
        netReturnUsd: 0, realizedPnlUsd: 0, gasUsd: 0, winRate: null,
        gainLossRatio: null, sharpe: 0, closedLots: 0,
        perfScore: 0, regimeWeight, score: 0,
      };
    }

    let completed = 0;
    let failed = 0;
    let gasUsd = 0;

    // FIFO par token cible pour apparier achats/ventes et calculer un P&L réalisé.
    const inventory: Record<string, Lot[]> = {};
    const lotReturns: number[] = [];
    let realizedPnlUsd = 0;

    for (const t of trades) {
      const status = String(t.status);
      if (status === 'failed') { failed++; continue; }
      completed++;

      const gasEth = parseFloat(t.gas_paid ?? '0') || 0;
      gasUsd += gasEth * ethPrice;

      const amountIn = parseFloat(t.amount_in ?? '0') || 0;
      const amountOut = parseFloat(t.amount_out ?? '0') || 0;
      const srcStable = STABLECOINS.has(String(t.source_token));
      const tgtStable = STABLECOINS.has(String(t.target_token));

      if (t.side === 'buy' && srcStable && !tgtStable) {
        // Achat stable → token : lot de coût = amountIn (USD), quantité = amountOut (token).
        const token = String(t.target_token);
        if (amountOut > 0 && amountIn > 0) {
          (inventory[token] ??= []).push({ qty: amountOut, costUsd: amountIn });
        }
      } else if (t.side === 'sell' && !srcStable && tgtStable) {
        // Vente token → stable : apparier FIFO contre les lots d'achat du token.
        const token = String(t.source_token);
        const proceedsUsd = amountOut;
        let qtyToSell = amountIn;
        const lots = inventory[token] ??= [];
        let matchedCost = 0;
        let matchedQty = 0;
        while (qtyToSell > 1e-12 && lots.length > 0) {
          const lot = lots[0];
          const take = Math.min(lot.qty, qtyToSell);
          const costPart = lot.costUsd * (take / lot.qty);
          matchedCost += costPart;
          matchedQty += take;
          lot.qty -= take;
          lot.costUsd -= costPart;
          qtyToSell -= take;
          if (lot.qty <= 1e-12) lots.shift();
        }
        if (matchedQty > 0 && matchedCost > 0) {
          const proceedsForMatched = proceedsUsd * (matchedQty / amountIn);
          const pnl = proceedsForMatched - matchedCost;
          realizedPnlUsd += pnl;
          lotReturns.push(pnl / matchedCost);
        }
      }
    }

    const numTrades = trades.length;
    const successRate = completed + failed > 0 ? completed / (completed + failed) : null;
    const netReturnUsd = realizedPnlUsd - gasUsd;

    const wins = lotReturns.filter((r) => r > 0);
    const losses = lotReturns.filter((r) => r < 0);
    const winRate = lotReturns.length > 0 ? wins.length / lotReturns.length : null;
    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
    const gainLossRatio = avgLoss > 0 ? avgWin / avgLoss : wins.length > 0 ? null : null;
    const sharpe = this.simplifiedSharpe(lotReturns);

    const perfScore = this.performanceScore({
      successRate, netReturnUsd, winRate, gainLossRatio, sharpe,
      closedLots: lotReturns.length, numTrades,
    });
    const score = perfScore * regimeWeight;

    return {
      strategy, numTrades, completed, failed, successRate,
      netReturnUsd: round(netReturnUsd), realizedPnlUsd: round(realizedPnlUsd), gasUsd: round(gasUsd),
      winRate, gainLossRatio: gainLossRatio === null ? null : round(gainLossRatio),
      sharpe: round(sharpe), closedLots: lotReturns.length,
      perfScore: round(perfScore), regimeWeight, score: round(score),
    };
  }

  /** Sharpe simplifié : moyenne / écart-type des rendements par lot (non annualisé). */
  private simplifiedSharpe(returns: number[]): number {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    return mean / std;
  }

  /**
   * Score de performance brut (échelle ~0-100) combinant : rendement net, Sharpe,
   * taux de réussite, ratio gain/perte et activité. Base neutre à 50.
   */
  private performanceScore(m: {
    successRate: number | null;
    netReturnUsd: number;
    winRate: number | null;
    gainLossRatio: number | null;
    sharpe: number;
    closedLots: number;
    numTrades: number;
  }): number {
    let s = 50;

    // Rendement net (borné ±25 pts) : +2.5 pts par $1 net, saturé.
    s += clamp(m.netReturnUsd * 2.5, -25, 25);

    // Sharpe simplifié (borné ±15 pts).
    s += clamp(m.sharpe * 15, -15, 15);

    // Taux de réussite d'exécution (échec blockchain pénalisant, ±10 pts).
    if (m.successRate !== null) s += (m.successRate - 0.85) * 40; // 0.85 = neutre

    // Ratio gain/perte (±10 pts) si des lots clôturés existent.
    if (m.gainLossRatio !== null && m.closedLots > 0) {
      s += clamp((m.gainLossRatio - 1) * 10, -10, 10);
    }

    // Win rate (±8 pts).
    if (m.winRate !== null) s += (m.winRate - 0.5) * 16;

    // Bonus d'activité léger (une stratégie qui trade est plus informative).
    if (m.numTrades > 0) s += clamp(Math.log10(1 + m.numTrades) * 3, 0, 6);

    return clamp(s, 0, 100);
  }

  // ─── Directives (activation/désactivation) ───

  private buildDirectives(
    scores: StrategyScore[],
    regime: MarketRegime,
  ): Array<{ strategy: EvaluatedStrategy; recommended_active: boolean; reason: string }> {
    return scores.map((s) => {
      let active = true;
      let reason = 'Conservée active (données insuffisantes ou performance acceptable)';

      // Désactivation recommandée uniquement sur preuve claire de sous-performance
      // ET régime défavorable — conservateur pour éviter les faux positifs.
      const enoughData = s.completed + s.failed >= 5;
      const badSuccess = s.successRate !== null && s.successRate < 0.35;
      const negativeReturn = s.netReturnUsd < 0 && s.closedLots >= 3;
      const badSharpe = s.sharpe < -0.5 && s.closedLots >= 3;
      const unfavorableRegime = (REGIME_WEIGHTS[regime][s.strategy] ?? 1) <= 0.7;

      if (enoughData && badSuccess) {
        active = false;
        reason = `Taux de réussite trop faible (${(s.successRate! * 100).toFixed(0)}%)`;
      } else if (enoughData && (negativeReturn || badSharpe) && unfavorableRegime) {
        active = false;
        reason = `Sous-performance (net $${s.netReturnUsd}, Sharpe ${s.sharpe}) en régime ${regime} défavorable`;
      } else if (s.score > 0) {
        reason = `Performance ${s.score >= 55 ? 'favorable' : 'neutre'} en régime ${regime} (score ${s.score})`;
      }

      return { strategy: s.strategy, recommended_active: active, reason };
    });
  }

  private buildAllocations(
    scores: StrategyScore[],
    directives: Array<{ strategy: EvaluatedStrategy; recommended_active: boolean }>,
  ): Record<string, number> {
    const activeSet = new Set(directives.filter((d) => d.recommended_active).map((d) => d.strategy));
    // Poids = score des stratégies actives (plancher à 1 pour éviter 0 partout).
    const weights = scores
      .filter((s) => activeSet.has(s.strategy))
      .map((s) => ({ strategy: s.strategy, w: Math.max(s.score, 1) }));
    const total = weights.reduce((a, b) => a + b.w, 0);
    const out: Record<string, number> = {};
    for (const s of scores) out[s.strategy] = 0;
    if (total > 0) {
      for (const w of weights) out[w.strategy] = round((w.w / total) * 100);
    }
    return out;
  }

  // ─── Persistance ───

  private async persist(
    regime: MarketRegime,
    windowHours: number,
    totalTrades: number,
    scores: StrategyScore[],
    allocations: Record<string, number>,
    directives: Array<{ strategy: EvaluatedStrategy; recommended_active: boolean; reason: string }>,
  ): Promise<void> {
    const recommendations = directives.map((d) => ({
      strategy: d.strategy,
      action: d.recommended_active ? 'activate' : 'deactivate',
      reason: d.reason,
    }));

    try {
      await this.prisma.strategy_evaluation.create({
        data: {
          regime,
          window_hours: windowHours,
          total_trades: totalTrades,
          scores: JSON.stringify(scores),
          allocations: JSON.stringify(allocations),
          recommendations: JSON.stringify(recommendations),
        },
      });
    } catch (e: any) {
      this.logger.warn(`Persistance évaluation échouée : ${e.message}`);
    }

    // Directives courantes (upsert par stratégie) — lisibles par le Strategist.
    for (const s of scores) {
      const dir = directives.find((d) => d.strategy === s.strategy)!;
      try {
        await this.prisma.strategy_directive.upsert({
          where: { strategy: s.strategy },
          create: {
            strategy: s.strategy,
            recommended_active: dir.recommended_active,
            recommended_allocation_pct: allocations[s.strategy] ?? 0,
            score: s.score,
            regime,
            reason: dir.reason,
          },
          update: {
            recommended_active: dir.recommended_active,
            recommended_allocation_pct: allocations[s.strategy] ?? 0,
            score: s.score,
            regime,
            reason: dir.reason,
          },
        });
      } catch (e: any) {
        this.logger.warn(`Upsert directive ${s.strategy} échoué : ${e.message}`);
      }
    }
  }

  // ─── Endpoints ───

  async getScores(): Promise<any> {
    if (this.lastScores.length === 0) {
      // Aucun cycle encore exécuté : évaluer à la volée.
      return this.evaluate();
    }
    return {
      regime: this.lastRegime,
      windowHours: this.WINDOW_HOURS,
      evaluatedAt: this.lastEvaluatedAt,
      scores: this.lastScores,
    };
  }

  async getAllocations(): Promise<any> {
    const directives = await this.prisma.strategy_directive
      .findMany({ orderBy: { score: 'desc' } })
      .catch(() => []);
    return {
      regime: this.lastRegime,
      evaluatedAt: this.lastEvaluatedAt,
      allocations: this.lastAllocations,
      directives: directives.map((d: any) => ({
        strategy: d.strategy,
        recommendedActive: d.recommended_active,
        recommendedAllocationPct: d.recommended_allocation_pct,
        score: d.score,
        regime: d.regime,
        reason: d.reason,
        updatedAt: d.updated_at,
      })),
    };
  }

  async getHistory(limit = 50): Promise<any> {
    const take = Math.max(1, Math.min(limit, 200));
    const rows = await this.prisma.strategy_evaluation
      .findMany({ orderBy: { created_at: 'desc' }, take })
      .catch(() => []);
    return {
      count: rows.length,
      evaluations: rows.map((r: any) => ({
        id: r.id,
        regime: r.regime,
        windowHours: r.window_hours,
        totalTrades: r.total_trades,
        scores: safeParse(r.scores, []),
        allocations: safeParse(r.allocations, {}),
        recommendations: safeParse(r.recommendations, []),
        createdAt: r.created_at,
      })),
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function safeParse(s: string, fallback: any): any {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
