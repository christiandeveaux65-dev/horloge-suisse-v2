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

// ─── Mean Reversion — LIMITES HARDCODÉES (leçon #4, rééchelonnées Phase 2 — juillet 2026) ───
export const MAX_TRADE_SIZE_MR = 100;   // $100 max par trade
export const MAX_EXPOSURE_PER_TOKEN = 400; // $400 max par token
export const MAX_TOTAL_EXPOSURE_MR = 800; // $800 total MR

// ─── DCA (optimisé Phase 1 — juillet 2026) ───
// Ancien réglage : $0.50 / achat toutes les 15 min (~96 achats/jour) → le gas (~$0.10-0.30)
// dépassait le gain sur ces micro-achats. Nouveau réglage : $7 / achat toutes les 3 h
// (~8 achats/jour), soit un ticket suffisant pour amortir le gas.
export const DCA_BASE_AMOUNT_USD = 7; // ~$7 par cycle (plage cible $5-10)
export const DCA_MAX_PER_TRADE_USD = 10; // plafond dur par achat DCA (total panier)
// Montant minimum par leg (jambe) du panier — LIMITE INTOUCHABLE ($0.50).
export const DCA_MIN_LEG_USD = 0.5;
// Panier DCA diversifié (recommandation analyste) : WETH 50 %, WBTC 30 %, ARB 20 %.
// La somme des poids = 1. Chaque cycle répartit le montant total selon ces poids.
export const DCA_BASKET: { token: string; weight: number }[] = [
  { token: 'WETH', weight: 0.5 },
  { token: 'WBTC', weight: 0.3 },
  { token: 'ARB', weight: 0.2 },
];

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
// Frais gas EIP-1559 : maxFeePerGas = baseFee courant × ce pourcentage + tip.
// 300 % (=3×) donne une marge confortable pour survivre aux hausses de base fee
// d'Arbitrum entre la lecture et l'inclusion (cause des "max fee per gas < block base fee").
export const GAS_FEE_MULTIPLIER_PCT = 300;
// Tip prioritaire par défaut si le RPC n'en fournit pas (0.01 gwei = 10_000_000 wei).
export const GAS_PRIORITY_FEE_WEI = 10_000_000n;
// Plancher absolu du maxFeePerGas (0.15 gwei = 150_000_000 wei).
// Cause racine résiduelle des "max fee per gas less than block base fee" :
// sur Arbitrum le base fee lu peut être minuscule (~0.003 gwei) ; baseFee × 3 reste
// alors absolument trop bas pour survivre à un pic de base fee entre lecture et inclusion.
// On force donc un plancher confortable (reste négligeable en coût sur Arbitrum).
export const GAS_MAX_FEE_FLOOR_WEI = 150_000_000n;
// Erreurs nonce sur lesquelles on retry avec resync
export const NONCE_RETRY_ERRORS = [
  'nonce too low',
  'replacement transaction underpriced',
  'replacement underpriced',
  'already known',
  'nonce has already been used',
];
// Erreurs de gas (sous-évaluation du fee) sur lesquelles on retry en re-lisant
// le base fee courant et en le majorant.
export const GAS_RETRY_ERRORS = [
  'max fee per gas less than block base fee',
  'transaction underpriced',
  'fee cap less than block base fee',
  'intrinsic gas too low',
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

// ─── GMX V2 (perps) — Phase 3 ───
export const GMX_BUDGET_USD = 1500;
export const GMX_TARGET_LEVERAGE = 2;
export const GMX_MAX_LEVERAGE = 3;         // borne dure (Phase 3 : 2-3x)
export const GMX_STOP_LOSS_PCT = 15;       // SL 15% du collatéral (Phase 3)
export const GMX_COLLATERAL_USD = 300;
export const GMX_TAKE_PROFIT_LEVELS = [25, 50, 100]; // % de gain PRIX → TP échelonnés
export const GMX_FUNDING_LONG_THRESHOLD = -0.05; // funding < -0.05% → long biais
export const GMX_FUNDING_SHORT_THRESHOLD = 0.05; // funding > +0.05% → short biais

// ─── GMX V2 — contrats officiels Arbitrum One (chain 42161) ───
// Router = cible des approbations ERC20 (les tokens transitent par ce Router).
export const GMX_ROUTER = '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6';
// ExchangeRouter = point d'entrée createOrder/multicall (GMX V2.1+).
export const GMX_EXCHANGE_ROUTER = '0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41';
// Reader V2 = lecture des positions/comptes.
export const GMX_READER = '0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789';
// DataStore = registre central de l'état du protocole.
export const GMX_DATASTORE = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';
// OrderVault = reçoit collatéral + frais d'exécution avant createOrder.
export const GMX_ORDER_VAULT = '0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5';
// Marché GM ETH/USD (WETH-USDC).
export const GMX_WETH_USD_MARKET = '0x70d95587d40a2caf56bd97485ab3eec10bee6336';
// Frais d'exécution keeper (ETH natif, envoyé via sendWnt).
export const GMX_EXECUTION_FEE_ETH = '0.0012';
// OrderType (enum GMX) : MarketIncrease=2 (ouvrir), MarketDecrease=4 (fermer).
export const GMX_ORDER_TYPE_MARKET_INCREASE = 2;
export const GMX_ORDER_TYPE_MARKET_DECREASE = 4;
// Précision USD GMX : toutes les valeurs USD sont en 30 décimales.
export const GMX_USD_DECIMALS = 30;
// callbackGasLimit par défaut (aucun callback contract).
export const GMX_CALLBACK_GAS_LIMIT = 0;

// ─── Aave V3 (looping) — Phase 3 : USDC/USDC loop ───
export const AAVE_TARGET_HF = 2.0;         // HF cible (Phase 3 : > 2.0)
export const AAVE_DELEVERAGE_HF = 1.7;     // deleveraging partiel
export const AAVE_CRITICAL_HF = 1.3;       // débouclage d'urgence
export const AAVE_MAX_LOOPS = 6;
export const AAVE_TARGET_LEVERAGE = 3;     // levier cible 3x (Phase 3)
export const AAVE_BUDGET_USD = 2000;       // capital max alloué

// ─── Aave V3 — contrats officiels Arbitrum One (chain 42161) ───
// Pool (proxy EIP-1967) = supply/borrow/repay/withdraw + getUserAccountData.
export const AAVE_POOL = '0x794a61358d6845594f94dc1db02a252b5b4814ad';
// Protocol Data Provider = lecture réserves/positions détaillées.
export const AAVE_DATA_PROVIDER = '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654';
// interestRateMode : 2 = taux variable (stable quasi déprécié).
export const AAVE_VARIABLE_RATE_MODE = 2;
// referralCode Aave (0 = aucun).
export const AAVE_REFERRAL_CODE = 0;
// getUserAccountData renvoie les montants en base 8 décimales, HF en 18 décimales.
export const AAVE_BASE_DECIMALS = 8;
export const AAVE_HF_DECIMALS = 18;

// ─── Grid Trading ───
export const GRID_BUDGET_USD = 1000;
export const GRID_LEVELS = 15;
export const GRID_PER_LEVEL_USD = 100;

// ─── Arbitrage (réactivé Phase finale — paramètres conservateurs, reco analyste) ───
// Ancien réglage agressif (50 bps, $500, cron 2 min) non rentable → refonte prudente :
// spread min relevé à 100 bps (couvre largement gas + slippage), ticket réduit à $200,
// cron ralenti à 5 min. Le net profit après gas est toujours vérifié avant exécution.
export const ARB_MIN_SPREAD_BPS = 100;   // min 100 bps (1 %) — conservateur
export const ARB_MAX_SPREAD_BPS = 500;   // rejet si > 500 bps (anomalie)
export const ARB_MAX_TRADE_USD = 200;    // ticket réduit à $200
export const UNISWAP_POOL_FEES = [500, 3000, 10000]; // pools 0.05% / 0.3% / 1%

// ─── Momentum budgets ───
export const MOMENTUM_ALTS_BUDGET_USD = 2000;
export const MOMENTUM_BC_BUDGET_USD = 1200;
export const MOMENTUM_MAX_POSITIONS = 5;

// ─── Strategist ───
export const STRATEGIST_PARAM_MIN_FACTOR = 0.5; // bornes sûres d'ajustement
export const STRATEGIST_PARAM_MAX_FACTOR = 1.5;
