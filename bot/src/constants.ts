/**
 * Constantes globales — "L'Horloge Suisse" v2
 * LIMITES HARDCODÉES — ne jamais modifier sans validation complète
 */

// ─── Tokens Arbitrum ───
export const ARBITRUM_CHAIN_ID = 42161;
export const CHAIN = 'arbitrum';

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  kuCoinSymbol: string; // symbole pour KuCoin API
}

export const TOKENS: Record<string, TokenInfo> = {
  USDC: {
    symbol: 'USDC',
    address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    decimals: 6,
    kuCoinSymbol: 'USDC',
  },
  WETH: {
    symbol: 'WETH',
    address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    decimals: 18,
    kuCoinSymbol: 'ETH',
  },
  WBTC: {
    symbol: 'WBTC',
    address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    decimals: 8,
    kuCoinSymbol: 'BTC',
  },
  ARB: {
    symbol: 'ARB',
    address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
    decimals: 18,
    kuCoinSymbol: 'ARB',
  },
  LINK: {
    symbol: 'LINK',
    address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    decimals: 18,
    kuCoinSymbol: 'LINK',
  },
  UNI: {
    symbol: 'UNI',
    address: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0',
    decimals: 18,
    kuCoinSymbol: 'UNI',
  },
  PENDLE: {
    symbol: 'PENDLE',
    address: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
    decimals: 18,
    kuCoinSymbol: 'PENDLE',
  },
  GMX: {
    symbol: 'GMX',
    address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
    decimals: 18,
    kuCoinSymbol: 'GMX',
  },
};

export const STABLECOINS = new Set(['USDC', 'USDT']);

// ─── Contrats Uniswap V3 sur Arbitrum ───
export const UNISWAP_QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
export const UNISWAP_SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
export const DEFAULT_POOL_FEE = 3000; // 0.3%

// ─── Wallet ───
export const WALLET_ADDRESS = '0xDd805107C52bc261C6f2507Dd712B54dcd6E96B8';

// ─── Slippage ───
export const MIN_SLIPPAGE_BPS = 1;
export const MAX_SLIPPAGE_BPS = 1000;
export const DEFAULT_SLIPPAGE_BPS = 50;

// ─── Mean Reversion — LIMITES HARDCODÉES (leçon #4) ───
export const MAX_TRADE_SIZE_MR = 75;   // $75 max par trade
export const MAX_EXPOSURE_PER_TOKEN = 300; // $300 max par token
export const MAX_TOTAL_EXPOSURE_MR = 600;  // $600 total MR

// ─── DCA ───
export const DCA_BASE_AMOUNT_USD = 0.50; // ~$0.50 par cycle de 15 min

// ─── Momentum ───
export const MOMENTUM_ALTS_SIZE_USD = 150;  // $150/trade pour alts
export const MOMENTUM_BC_SIZE_USD = 200;    // $200/trade pour blue chips
export const TARGET_VOLATILITY = 0.02;      // volatilité cible pour sizing

// ─── Split orders ───
export const SPLIT_ORDER_THRESHOLD_USD = 500;
export const SPLIT_TRANCHE_DELAY_MS = 2000;
export const MAX_SPLIT_TRANCHES = 10;

// ─── Liquidation ───
export const LIQUIDATION_SLIPPAGE_BPS = 200;

// ─── Sécurité TX (anti-MEV, robustesse) ───
export const MAX_SWAP_DEADLINE_SEC = 120;   // deadline swap ≤ 120s (anti-MEV)
export const DEFAULT_TX_CONFIRM_TIMEOUT_MS = 90_000; // timeout confirmation TX
export const DEFAULT_TX_SEND_MAX_ATTEMPTS = 3;       // tentatives max sur erreur nonce
export const GAS_LIMIT_BUFFER_PCT = 20;     // +20% sur estimation gasLimit
// Erreurs nonce sur lesquelles on retry avec resync
export const NONCE_RETRY_ERRORS = [
  'nonce too low',
  'replacement transaction underpriced',
  'replacement underpriced',
  'already known',
  'nonce has already been used',
];

// ─── Multi-chain (chaînes secondaires) ───
export const CHAIN_IDS: Record<string, number> = {
  arbitrum: 42161,
  base: 8453,
  optimism: 10,
};

// Tokens secondaires — Base (chainId 8453)
export const BASE_TOKENS: Record<string, TokenInfo> = {
  WETH: { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, kuCoinSymbol: 'ETH' },
  cbBTC: { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8, kuCoinSymbol: 'BTC' },
  AERO: { symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18, kuCoinSymbol: 'AERO' },
};

// Tokens secondaires — Optimism (chainId 10)
export const OPTIMISM_TOKENS: Record<string, TokenInfo> = {
  WETH: { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, kuCoinSymbol: 'ETH' },
  WBTC: { symbol: 'WBTC', address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', decimals: 8, kuCoinSymbol: 'BTC' },
  OP: { symbol: 'OP', address: '0x4200000000000000000000000000000000000042', decimals: 18, kuCoinSymbol: 'OP' },
};

// ─── GMX V2 (perps) ───
export const GMX_BUDGET_USD = 1500;
export const GMX_TARGET_LEVERAGE = 2;
export const GMX_MAX_LEVERAGE = 5;
export const GMX_STOP_LOSS_PCT = 10;
export const GMX_COLLATERAL_USD = 300;

// ─── Aave V3 (looping) ───
export const AAVE_TARGET_HF = 1.8;
export const AAVE_DELEVERAGE_HF = 1.5;
export const AAVE_CRITICAL_HF = 1.25;
export const AAVE_MAX_LOOPS = 6;
export const AAVE_TARGET_LEVERAGE = 2;

// ─── Grid Trading ───
export const GRID_BUDGET_USD = 1000;
export const GRID_LEVELS = 10;
export const GRID_PER_LEVEL_USD = 100;

// ─── Arbitrage ───
export const ARB_MIN_SPREAD_BPS = 50;    // min 50 bps pour couvrir gas+slippage
export const ARB_MAX_SPREAD_BPS = 500;   // rejet si > 500 bps (anomalie)
export const ARB_MAX_TRADE_USD = 500;
export const UNISWAP_POOL_FEES = [500, 3000, 10000]; // pools 0.05% / 0.3% / 1%

// ─── Momentum budgets ───
export const MOMENTUM_ALTS_BUDGET_USD = 2000;
export const MOMENTUM_BC_BUDGET_USD = 1200;
export const MOMENTUM_MAX_POSITIONS = 5;

// ─── Strategist ───
export const STRATEGIST_PARAM_MIN_FACTOR = 0.5; // bornes sûres d'ajustement
export const STRATEGIST_PARAM_MAX_FACTOR = 1.5;
