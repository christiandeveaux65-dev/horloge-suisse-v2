/**
 * Indicateurs techniques — SMA, RSI, Bollinger Bands, volatilité réalisée
 * Repris fidèlement de v1 indicators.ts
 */

/** Moyenne mobile simple */
export function sma(prices: number[], period: number): number | null {
  if (prices.length < period) return null;
  const window = prices.slice(-period);
  return window.reduce((s, v) => s + v, 0) / period;
}

/** RSI (Relative Strength Index) */
export function rsi(prices: number[], period: number): number {
  if (prices.length < period + 1) return 50; // valeur neutre par défaut
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const delta = prices[i] - prices[i - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

/** Bollinger Bands */
export function bollingerBands(
  prices: number[],
  period: number,
  stdDevMult: number,
): { mid: number; upper: number; lower: number } | null {
  if (prices.length < period) return null;
  const window = prices.slice(-period);
  const mean = window.reduce((s, v) => s + v, 0) / period;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(Math.max(variance, 0));
  return {
    mid: mean,
    upper: mean + std * stdDevMult,
    lower: mean - std * stdDevMult,
  };
}

/** Volatilité réalisée (écart-type des rendements logarithmiques) */
export function realizedVolatility(prices: number[], period: number): number | null {
  if (prices.length < Math.max(period, 2)) return null;
  const window = prices.slice(-period);
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1] > 0) {
      returns.push(Math.log(window[i] / window[i - 1]));
    }
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
  return Math.sqrt(Math.max(variance, 0));
}

/**
 * ATR (Average True Range) approximé à partir d'une série de prix de clôture.
 * Faute de high/low intraday, le "true range" est approximé par la variation absolue
 * entre clôtures consécutives |close[i] - close[i-1]|, moyennée sur `period`.
 * Retourne l'ATR en valeur absolue (même unité que le prix), ou null si données insuffisantes.
 */
export function atr(prices: number[], period = 14): number | null {
  if (prices.length < period + 1) return null;
  const window = prices.slice(-(period + 1));
  const trs: number[] = [];
  for (let i = 1; i < window.length; i++) {
    trs.push(Math.abs(window[i] - window[i - 1]));
  }
  if (trs.length === 0) return null;
  return trs.reduce((s, v) => s + v, 0) / trs.length;
}

/** ATR exprimé en % du dernier prix de la série. */
export function atrPct(prices: number[], period = 14): number | null {
  const a = atr(prices, period);
  if (a === null) return null;
  const last = prices[prices.length - 1];
  if (!(last > 0)) return null;
  return (a / last) * 100;
}

export type Signal = 'buy' | 'sell' | 'hold';

export interface IndicatorSnapshot {
  signal: Signal;
  smaShort: number | null;
  smaLong: number | null;
  rsi: number;
  volatility: number | null;
  latestPrice: number | null;
}

/** Calcul complet de signal pour Momentum (fidèle à v1) */
export function computeSignal(
  prices: number[],
  opts: {
    maShort: number;
    maLong: number;
    rsiPeriod: number;
    rsiOversold: number;
    rsiOverbought: number;
  },
): IndicatorSnapshot {
  const { maShort, maLong, rsiPeriod, rsiOversold, rsiOverbought } = opts;

  const smaShort = sma(prices, maShort);
  const smaLongVal = sma(prices, maLong);
  const smaShortPrev = prices.length > maShort ? sma(prices.slice(0, -1), maShort) : null;
  const smaLongPrev = prices.length > maLong ? sma(prices.slice(0, -1), maLong) : null;
  const rsiVal = rsi(prices, rsiPeriod);
  const rsiPrev = prices.length > rsiPeriod + 1 ? rsi(prices.slice(0, -1), rsiPeriod) : null;
  const vol = realizedVolatility(prices, Math.max(maShort, 10));
  const latestPrice = prices.length ? prices[prices.length - 1] : null;

  let signal: Signal = 'hold';

  // Croisement haussier SMA courte/longue
  const crossUp =
    smaShort !== null && smaLongVal !== null &&
    smaShortPrev !== null && smaLongPrev !== null &&
    smaShortPrev <= smaLongPrev && smaShort > smaLongVal;

  // Croisement baissier
  const crossDown =
    smaShort !== null && smaLongVal !== null &&
    smaShortPrev !== null && smaLongPrev !== null &&
    smaShortPrev >= smaLongPrev && smaShort < smaLongVal;

  // RSI se redresse depuis la zone de survente
  const rsiRecovering =
    rsiVal !== null && rsiPrev !== null &&
    rsiPrev < rsiOversold && rsiVal >= rsiOversold;

  const rsiRising = rsiVal !== null && rsiPrev !== null && rsiVal > rsiPrev;
  const rsiHot = rsiVal !== null && rsiVal >= rsiOverbought;

  // Continuation de tendance haussière
  const trendUpEntry =
    smaShort !== null && smaLongVal !== null &&
    smaShort > smaLongVal &&
    rsiVal !== null && rsiVal < rsiOverbought &&
    rsiRising &&
    latestPrice !== null && latestPrice >= smaShort;

  if (crossUp || rsiRecovering || trendUpEntry) {
    signal = 'buy';
  } else if (crossDown || rsiHot) {
    signal = 'sell';
  }

  return {
    signal,
    smaShort,
    smaLong: smaLongVal,
    rsi: rsiVal,
    volatility: vol,
    latestPrice,
  };
}

/** Utilitaire clamp */
export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
