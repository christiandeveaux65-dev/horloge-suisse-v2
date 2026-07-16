export interface PortfolioToken {
  symbol: string
  balance: string
  price_usd: string
  value_usd: string
}

export interface PortfolioChain {
  chain: string
  tokens: PortfolioToken[]
}

export interface PortfolioPnlEntry {
  token: string
  total_invested_usd: string
  total_acquired: string
  avg_buy_price: string
  current_price: string
  current_value_usd: string
  pnl_usd: string
  pnl_percent: string
}

export interface PnlSummary {
  total_invested_usd?: string
  current_positions_value_usd?: string
  realized_proceeds_usd?: string
  total_pnl_usd?: string
  total_pnl_percent?: string
}

export interface Portfolio {
  wallet: string
  dry_run: boolean
  total_value_usd: string
  reserve_usd?: string
  chains: PortfolioChain[]
  pnl?: PortfolioPnlEntry[]
  pnl_summary?: PnlSummary
  updated_at?: string
}

export interface Trade {
  id: string
  source: string
  side: string
  strategy_name?: string | null
  chain: string
  source_token: string
  target_token: string
  amount_in: string
  amount_out: string
  price: string
  gas_paid: string
  tx_hash: string
  status: string
  error_message?: string | null
  executed_at: string
}

export interface Position {
  id: string
  config_id: string
  chain: string
  token: string
  amount_token: string
  initial_amount: string
  entry_price: string
  cost_usd: string
  highest_price: string
  tp_hits: string
  status: string
  opened_at: string
  updated_at: string
  closed_at?: string | null
  current_price?: number | string | null
  unrealized_pnl_usd?: number | string | null
  unrealized_pnl_pct?: number | string | null
}

export interface Signal {
  config_id: string
  chain: string
  token: string
  data_points: number
  sma_short: number
  sma_long: number
  rsi: number
  volatility: number
  latest_price: number
  signal: string
}

export interface Order {
  id: string
  kind: string
  chain: string
  source_token: string
  target_token: string
  side: string
  total_amount_in: string
  tranche_size: string
  tranches_total: number
  tranches_done: number
  interval_seconds: number
  next_execution_at?: string | null
  target_price: string
  direction: string
  slippage_bps: number
  status: string
  amount_filled: string
  amount_received: string
  last_error: string
  notes: string
  created_at: string
  updated_at: string
  completed_at?: string | null
}

export interface Backtest {
  id: string
  strategy_type: string
  chain: string
  tokens: string[] | string
  params?: any
  start_date: string
  end_date: string
  initial_capital: string
  final_equity: string
  total_return_pct: string
  annualized_pct: string
  max_drawdown_pct: string
  sharpe_ratio: string
  win_rate_pct: string
  trades_count: number
  buy_hold_pct: string
  equity_curve?: { t: number; equity: number }[]
  trades?: any[]
  notes: string
  created_at: string
}

export interface RiskConfig {
  id: string
  max_drawdown_pct: number
  position_limit_pct: number
  trailing_enabled: boolean
  trailing_activation_pct: number
  ath_value_usd: string
  ath_recorded_at?: string | null
  global_paused: boolean
  paused_reason: string
  paused_at?: string | null
}

export interface RiskData {
  config: RiskConfig
  portfolio: {
    total_usd: string
    ath_usd: string
    drawdown_pct: string
  }
}

export interface CouplingDecision {
  id: string
  kind: string
  chain: string
  token: string
  detail: string
  payload: string
  created_at: string
}

export interface LedgerEntry {
  id: string
  chain: string
  token: string
  kind: string
  amount: string
  value_usd: string
  source: string
  note: string
  detected_at: string
}
