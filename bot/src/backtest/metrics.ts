/**
 * Calcul des métriques de performance professionnelles à partir
 * d'une courbe d'équité et de la liste des trades simulés.
 *
 * Aucune dépendance externe : tout est calculé à la main pour rester
 * transparent et vérifiable.
 */
import { EquityPoint, SimTrade, BacktestMetrics } from './backtest.types';
import { PERIODS_PER_YEAR } from './backtest.constants';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function std(xs: number[], sample = true): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const denom = sample ? xs.length - 1 : xs.length;
  const variance = xs.reduce((s, v) => s + (v - m) ** 2, 0) / denom;
  return Math.sqrt(Math.max(variance, 0));
}

/** Rendements périodiques (variation relative de l'équité entre deux points). */
export function periodReturns(curve: EquityPoint[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    const cur = curve[i].equity;
    if (prev > 0) rets.push(cur / prev - 1);
  }
  return rets;
}

/** Max drawdown (fraction, ex 0.25 = -25 %) + durée max sous l'eau (jours). */
export function maxDrawdown(curve: EquityPoint[]): { maxDd: number; durationDays: number } {
  if (curve.length === 0) return { maxDd: 0, durationDays: 0 };
  let peak = curve[0].equity;
  let peakTime = curve[0].t;
  let maxDd = 0;
  let maxDurMs = 0;

  for (const p of curve) {
    if (p.equity >= peak) {
      // Nouveau sommet : la période sous l'eau précédente est terminée.
      peak = p.equity;
      peakTime = p.t;
    } else {
      const dd = (peak - p.equity) / peak;
      if (dd > maxDd) maxDd = dd;
      const dur = p.t - peakTime;
      if (dur > maxDurMs) maxDurMs = dur;
    }
  }
  return { maxDd, durationDays: maxDurMs / MS_PER_DAY };
}

/**
 * Ratios Sharpe / Sortino annualisés (taux sans risque = 0).
 * `periodsPerYear` dépend du timeframe.
 */
export function sharpeSortino(
  rets: number[],
  periodsPerYear: number,
): { sharpe: number; sortino: number } {
  if (rets.length < 2) return { sharpe: 0, sortino: 0 };
  const m = mean(rets);
  const sd = std(rets, true);
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(periodsPerYear) : 0;

  // Déviation à la baisse : écart-type des rendements négatifs vs 0.
  const downside = rets.filter((r) => r < 0);
  let downsideDev = 0;
  if (downside.length > 0) {
    downsideDev = Math.sqrt(downside.reduce((s, v) => s + v * v, 0) / downside.length);
  }
  const sortino = downsideDev > 0 ? (m / downsideDev) * Math.sqrt(periodsPerYear) : 0;
  return { sharpe, sortino };
}

/** Win rate & profit factor à partir des ventes réalisées (pnlUsd renseigné). */
export function tradeStats(trades: SimTrade[]): {
  winRatePct: number;
  profitFactor: number;
  closedCount: number;
} {
  const closed = trades.filter((t) => typeof t.pnlUsd === 'number');
  if (closed.length === 0) return { winRatePct: 0, profitFactor: 0, closedCount: 0 };
  const wins = closed.filter((t) => (t.pnlUsd as number) > 0);
  const grossProfit = wins.reduce((s, t) => s + (t.pnlUsd as number), 0);
  const grossLoss = closed
    .filter((t) => (t.pnlUsd as number) < 0)
    .reduce((s, t) => s + Math.abs(t.pnlUsd as number), 0);
  const winRatePct = (wins.length / closed.length) * 100;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { winRatePct, profitFactor, closedCount: closed.length };
}

/**
 * Assemble toutes les métriques.
 * `buyHoldFinal` = équité finale d'une stratégie buy&hold équipondérée (référence).
 */
export function computeMetrics(params: {
  curve: EquityPoint[];
  trades: SimTrade[];
  initialCapital: number;
  timeframe: string;
  buyHoldFinal?: number;
}): BacktestMetrics {
  const { curve, trades, initialCapital, timeframe } = params;
  const finalEquity = curve.length ? curve[curve.length - 1].equity : initialCapital;
  const totalReturnPct = initialCapital > 0 ? (finalEquity / initialCapital - 1) * 100 : 0;

  const spanMs = curve.length >= 2 ? curve[curve.length - 1].t - curve[0].t : 0;
  const years = spanMs / (365 * MS_PER_DAY);
  const annualizedPct =
    years > 0 && finalEquity > 0 && initialCapital > 0
      ? (Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100
      : 0;

  const rets = periodReturns(curve);
  const ppy = PERIODS_PER_YEAR[timeframe] ?? 8760;
  const { sharpe, sortino } = sharpeSortino(rets, ppy);
  const { maxDd, durationDays } = maxDrawdown(curve);
  const calmar = maxDd > 0 ? annualizedPct / 100 / maxDd : 0;
  const { winRatePct, profitFactor } = tradeStats(trades);

  const buyHoldPct =
    params.buyHoldFinal && initialCapital > 0
      ? (params.buyHoldFinal / initialCapital - 1) * 100
      : 0;

  return {
    initialCapital,
    finalEquity,
    totalReturnPct,
    annualizedPct,
    sharpeRatio: sharpe,
    sortinoRatio: sortino,
    calmarRatio: calmar,
    maxDrawdownPct: maxDd * 100,
    maxDrawdownDurationDays: durationDays,
    winRatePct,
    profitFactor,
    tradesCount: trades.length,
    buyHoldPct,
  };
}

/** Indicateur EMA (moyenne mobile exponentielle) sur une série complète. */
export function emaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length === 0 || period <= 0) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
