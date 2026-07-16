/**
 * Constantes du module de backtesting.
 * Mapping token interne -> symbole KuCoin (paires /USDT).
 */

export const BACKTEST_TOKENS: Record<string, string> = {
  WETH: 'ETH',
  WBTC: 'BTC',
  ARB: 'ARB',
  LINK: 'LINK',
  PENDLE: 'PENDLE',
  GMX: 'GMX',
  UNI: 'UNI',
};

export const SUPPORTED_TOKENS = Object.keys(BACKTEST_TOKENS);

export const SUPPORTED_TIMEFRAMES = ['1h', '4h'] as const;
export type Timeframe = (typeof SUPPORTED_TIMEFRAMES)[number];

/** Correspondance timeframe interne -> paramètre KuCoin `type`. */
export const KUCOIN_TYPE: Record<string, string> = {
  '1h': '1hour',
  '4h': '4hour',
};

/** Durée d'une bougie en millisecondes. */
export const TIMEFRAME_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

/** Nombre de périodes par an (pour l'annualisation des métriques). */
export const PERIODS_PER_YEAR: Record<string, number> = {
  '1h': 24 * 365,
  '4h': 6 * 365,
};

/** Frictions par défaut (%). */
export const DEFAULT_FEES_PCT = 0.3; // Uniswap ~0.3 %
export const DEFAULT_SLIPPAGE_PCT = 0.1;

/** Limite KuCoin : max ~1500 bougies par requête. */
export const KUCOIN_MAX_CANDLES = 1500;
