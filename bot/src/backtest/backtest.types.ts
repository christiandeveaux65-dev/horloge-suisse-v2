/** Types partagés du moteur de backtesting. */

export interface Candle {
  t: number; // open_time en ms (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SimTrade {
  token: string;
  side: 'buy' | 'sell';
  time: number; // ms
  price: number; // prix d'exécution (friction incluse)
  amountUsd: number; // notionnel en USD
  amountToken: number;
  feeUsd: number;
  pnlUsd?: number; // renseigné uniquement sur les ventes (réalisé)
  reason?: string;
}

export interface EquityPoint {
  t: number;
  equity: number;
}

export interface SimResult {
  trades: SimTrade[];
  equityCurve: EquityPoint[];
}

export interface BacktestMetrics {
  initialCapital: number;
  finalEquity: number;
  totalReturnPct: number;
  annualizedPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  maxDrawdownPct: number;
  maxDrawdownDurationDays: number;
  winRatePct: number;
  profitFactor: number;
  tradesCount: number;
  buyHoldPct: number;
}
