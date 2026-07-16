/**
 * Cœur d'évaluation partagé entre le thread principal et les worker_threads.
 *
 * Ce module ne dépend PAS de NestJS ni de Prisma : il ne manipule que des
 * données pures (bougies déjà chargées) pour pouvoir tourner dans un worker.
 */
import { simulate, buyHoldFinal, SimConfig } from './strategies';
import { computeMetrics } from './metrics';
import { Candle, BacktestMetrics } from './backtest.types';
import { LossFunction, StrategyName } from './optimizer.constants';

/**
 * Contexte sérialisable transmis aux workers.
 * dataByTf : timeframe -> token -> tableau de bougies (déjà découpé in/out-of-sample).
 */
export interface SharedCtx {
  strategy: StrategyName;
  tokens: string[];
  feePct: number;
  slipPct: number;
  initialCapital: number;
  defaultTf: string;
  dataByTf: Record<string, Record<string, Candle[]>>;
}

/**
 * Évalue une combinaison de paramètres et renvoie ses métriques
 * (ou null si les données sont insuffisantes).
 */
export function evaluateComboCore(
  ctx: SharedCtx, combo: Record<string, any>,
): BacktestMetrics | null {
  const tf = (combo.timeframe as string) ?? ctx.defaultTf;
  const byToken = ctx.dataByTf[tf];
  if (!byToken) return null;

  const active = new Map<string, Candle[]>();
  for (const token of Object.keys(byToken)) {
    const arr = byToken[token];
    if (arr && arr.length > 1) active.set(token, arr);
  }
  if (active.size === 0) return null;

  const params: Record<string, any> = { ...combo };
  delete params.timeframe; // géré via la sélection du jeu de bougies
  if (ctx.strategy === 'grid') params.token = ctx.tokens[0];

  const cfg: SimConfig = {
    strategy: ctx.strategy,
    tokens: Array.from(active.keys()),
    initialCapital: ctx.initialCapital,
    feePct: ctx.feePct,
    slipPct: ctx.slipPct,
    params,
  };
  const { trades, equityCurve } = simulate(active, cfg);
  if (equityCurve.length < 2) return null;
  const bhFinal = buyHoldFinal(active, ctx.initialCapital);
  return computeMetrics({
    curve: equityCurve, trades, initialCapital: ctx.initialCapital, timeframe: tf, buyHoldFinal: bhFinal,
  });
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/** Fonction objectif (plus élevé = meilleur) selon la loss function choisie. */
export function objective(loss: LossFunction, m: BacktestMetrics): number {
  switch (loss) {
    case 'SharpeOptimize': return finite(m.sharpeRatio);
    case 'SortinoOptimize': return finite(m.sortinoRatio);
    case 'ProfitMaximize': return finite(m.totalReturnPct);
    case 'MinDrawdown': return -finite(m.maxDrawdownPct);
    case 'Balanced':
      return finite(m.totalReturnPct) * 0.4
        + finite(m.sharpeRatio) * 0.3
        - finite(m.maxDrawdownPct) * 0.3;
    default: return finite(m.sharpeRatio);
  }
}
