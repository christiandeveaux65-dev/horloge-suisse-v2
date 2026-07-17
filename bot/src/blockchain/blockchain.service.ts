import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import { RateLimitedProvider } from './rate-limited-provider';
import { PriceService } from '../price/price.service';
import { TelegramService } from '../telegram/telegram.service';
import {
  TOKENS, TokenInfo, WALLET_ADDRESS, ARBITRUM_CHAIN_ID, STABLECOINS,
  UNISWAP_QUOTER_V2, UNISWAP_SWAP_ROUTER_02, DEFAULT_POOL_FEE,
  MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS,
  MAX_SWAP_DEADLINE_SEC, DEFAULT_TX_CONFIRM_TIMEOUT_MS,
  DEFAULT_TX_SEND_MAX_ATTEMPTS, GAS_LIMIT_BUFFER_PCT, NONCE_RETRY_ERRORS,
  GAS_RETRY_ERRORS, GAS_FEE_MULTIPLIER_PCT, GAS_PRIORITY_FEE_WEI, GAS_MAX_FEE_FLOOR_WEI,
  GMX_ROUTER, GMX_EXCHANGE_ROUTER, GMX_READER, GMX_DATASTORE, GMX_ORDER_VAULT,
  GMX_EXECUTION_FEE_ETH, GMX_ORDER_TYPE_MARKET_INCREASE, GMX_ORDER_TYPE_MARKET_DECREASE,
  GMX_USD_DECIMALS, GMX_CALLBACK_GAS_LIMIT, GMX_WETH_USD_MARKET,
  AAVE_POOL, AAVE_VARIABLE_RATE_MODE, AAVE_REFERRAL_CODE, AAVE_BASE_DECIMALS, AAVE_HF_DECIMALS,
} from '../constants';

// Friction de simulation (dry-run) — reflète des coûts d'exécution réalistes.
const SIM_POOL_FEE = 0.003; // frais de pool Uniswap : 0,3 %
const SIM_SLIPPAGE = 0.001; // slippage estimé : 0,1 %
const SIM_GAS_USD = 0.15; // coût de gas estimé par trade (~0,15 $)

// ABI minimaux pour Uniswap V3
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

// ── GMX V2 ExchangeRouter (createOrder via multicall) ──
// La struct CreateOrderParams suit le layout GMX V2.1+ (IBaseOrderUtils) :
// { addresses, numbers, orderType, decreasePositionSwapType, isLong,
//   shouldUnwrapNativeToken, autoCancel, referralCode }.
const GMX_EXCHANGE_ROUTER_ABI = [
  'function sendWnt(address receiver, uint256 amount) external payable',
  'function sendTokens(address token, address receiver, uint256 amount) external payable',
  'function multicall(bytes[] calldata data) external payable returns (bytes[] results)',
  'function createOrder(((address receiver, address cancellationReceiver, address callbackContract, address uiFeeReceiver, address market, address initialCollateralToken, address[] swapPath), (uint256 sizeDeltaUsd, uint256 initialCollateralDeltaAmount, uint256 triggerPrice, uint256 acceptablePrice, uint256 executionFee, uint256 callbackGasLimit, uint256 minOutputAmount, uint256 validFromTime), uint8 orderType, uint8 decreasePositionSwapType, bool isLong, bool shouldUnwrapNativeToken, bool autoCancel, bytes32 referralCode) params) external payable returns (bytes32)',
];

// ── GMX V2 Reader (lecture des positions d'un compte) ──
const GMX_READER_ABI = [
  'function getAccountPositions(address dataStore, address account, uint256 start, uint256 end) external view returns (tuple(tuple(address account, address market, address collateralToken) addresses, tuple(uint256 sizeInUsd, uint256 sizeInTokens, uint256 collateralAmount, int256 pendingImpactAmount, uint256 borrowingFactor, uint256 fundingFeeAmountPerSize, uint256 longTokenClaimableFundingAmountPerSize, uint256 shortTokenClaimableFundingAmountPerSize, uint256 increasedAtTime, uint256 decreasedAtTime) numbers, tuple(bool isLong) flags)[])',
];

// ── Aave V3 Pool ──
const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256)',
  'function withdraw(address asset, uint256 amount, address to) external returns (uint256)',
  'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
];

export interface SwapResult {
  success: boolean;
  amountIn: string;
  amountOut: string;
  effectivePrice: string;
  gasPaid: string;
  txHash: string;
  error?: string;
}

export interface QuoteResult {
  amountOut: string;
  amountOutWei: bigint;
}

/** Résultat générique d'une opération on-chain GMX/Aave. */
export interface ChainOpResult {
  success: boolean;
  simulated: boolean;
  txHash: string;
  orderKey?: string;
  error?: string;
  [key: string]: any;
}

/** Position GMX enrichie (valeurs USD lisibles calculées à partir des données on-chain). */
export interface GmxPositionDetail {
  market: string;
  collateralToken: string;      // adresse
  collateralSymbol: string;
  indexSymbol: string;
  isLong: boolean;
  collateralUsd: number;        // valeur USD du collatéral déposé
  sizeUsd: number;              // taille notionnelle (USD)
  sizeTokens: number;           // taille en tokens indexés
  entryPrice: number;           // prix d'entrée moyen (USD/token)
  markPrice: number;            // prix courant (USD/token)
  unrealizedPnlUsd: number;     // PnL non réalisé (USD)
  positionValueUsd: number;     // collatéral + PnL non réalisé
  leverage: number;
}

/** Valeur agrégée des positions DeFi actives (GMX perp + compte Aave). */
export interface DefiValue {
  gmxUsd: number;               // Σ (collatéral + uPnL) des positions GMX ouvertes
  aaveUsd: number;              // valeur nette du compte Aave (collatéral - dette)
  totalUsd: number;
  gmxPositions: GmxPositionDetail[];
  aave: AaveAccountData | null;
  incomplete?: boolean;         // true si une lecture on-chain (GMX ou Aave) a échoué
}

/** Données de compte Aave V3 lues on-chain (getUserAccountData). */
export interface AaveAccountData {
  healthFactor: number;        // 1e18 → nombre lisible (Infinity si pas de dette)
  totalCollateralUsd: number;  // base 1e8 → USD
  totalDebtUsd: number;        // base 1e8 → USD
  availableBorrowsUsd: number;
  currentLiquidationThreshold: number; // en fraction (ex: 0.83)
  ltv: number;                 // en fraction
}

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);
  private provider: ethers.JsonRpcProvider | null = null;
  private wallet: ethers.Wallet | null = null;
  private isDryRun: boolean;

  // Mutex TX global : sérialise les envois pour éviter les collisions de nonce
  private txLock: Promise<void> = Promise.resolve();
  // High-water mark du nonce : garantit qu'on ne réutilise jamais un nonce en dessous
  private nonceHighWater = -1;

  constructor(
    private readonly config: ConfigService,
    private readonly priceService: PriceService,
    private readonly telegram: TelegramService,
  ) {
    const pk = this.config.get<string>('WALLET_PRIVATE_KEY');
    this.isDryRun = !pk;
    if (this.isDryRun) {
      this.logger.warn('🔧 Mode DRY-RUN actif (WALLET_PRIVATE_KEY absente)');
    }
  }

  private get txConfirmTimeoutMs(): number {
    return parseInt(this.config.get<string>('TX_CONFIRM_TIMEOUT_MS') || '', 10) || DEFAULT_TX_CONFIRM_TIMEOUT_MS;
  }

  private get txSendMaxAttempts(): number {
    return parseInt(this.config.get<string>('TX_SEND_MAX_ATTEMPTS') || '', 10) || DEFAULT_TX_SEND_MAX_ATTEMPTS;
  }

  /** Sérialise une opération TX derrière le mutex global */
  private async withTxLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.txLock;
    this.txLock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Résout le prochain nonce en respectant le high-water mark */
  private async nextNonce(wallet: ethers.Wallet): Promise<number> {
    const pending = await wallet.getNonce('pending');
    const nonce = Math.max(pending, this.nonceHighWater + 1);
    this.nonceHighWater = nonce;
    return nonce;
  }

  /** Attendre la confirmation avec timeout borné */
  private async waitWithTimeout(tx: ethers.TransactionResponse): Promise<ethers.TransactionReceipt> {
    const receipt = await Promise.race([
      tx.wait(1),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout confirmation TX ${tx.hash} (${this.txConfirmTimeoutMs}ms)`)), this.txConfirmTimeoutMs),
      ),
    ]);
    if (!receipt) throw new Error('Receipt TX nul');
    return receipt as ethers.TransactionReceipt;
  }

  /**
   * Frais gas EIP-1559 dynamiques.
   *
   * Cause racine des échecs "max fee per gas less than block base fee" :
   * `getFeeData()` sur ce RPC Arbitrum renvoyait un maxFeePerGas ≈ base fee courant
   * (sans marge). Dès que le base fee montait entre la lecture et l'inclusion, la TX
   * était rejetée.
   *
   * Correctif : on lit le base fee du DERNIER bloc et on applique une marge
   * (GAS_FEE_MULTIPLIER_PCT = 3×) plus un tip prioritaire. Le `bumpPct` optionnel
   * ajoute une majoration supplémentaire lors des retries après une erreur de gas.
   */
  private async getFeeOverrides(bumpPct = 0): Promise<Record<string, bigint>> {
    const multiplier = BigInt(GAS_FEE_MULTIPLIER_PCT + bumpPct);
    const provider = this.getProvider();
    try {
      // 1) Source de vérité : base fee du dernier bloc.
      const block = await provider.getBlock('latest');
      const baseFee = block?.baseFeePerGas ?? null;

      // Tip prioritaire : celui du RPC s'il est > 0, sinon le défaut.
      let priorityFee = GAS_PRIORITY_FEE_WEI;
      try {
        const fd = await provider.getFeeData();
        if (fd.maxPriorityFeePerGas && fd.maxPriorityFeePerGas > 0n) {
          priorityFee = fd.maxPriorityFeePerGas;
        }
      } catch { /* tip par défaut */ }

      // Plancher qui monte aussi avec le bump des retries.
      const floor = GAS_MAX_FEE_FLOOR_WEI * BigInt(100 + bumpPct) / 100n;

      if (baseFee && baseFee > 0n) {
        let maxFeePerGas = (baseFee * multiplier) / 100n + priorityFee;
        if (maxFeePerGas < floor) maxFeePerGas = floor; // plancher absolu anti-spike
        this.logger.debug(
          `Gas EIP-1559 : baseFee=${baseFee} maxFee=${maxFeePerGas} tip=${priorityFee} (×${multiplier}%, floor=${floor})`,
        );
        return { maxFeePerGas, maxPriorityFeePerGas: priorityFee };
      }

      // 2) Fallback : getFeeData avec marge appliquée.
      const fee = await provider.getFeeData();
      if (fee.maxFeePerGas) {
        let maxFeePerGas = (fee.maxFeePerGas * multiplier) / 100n;
        if (maxFeePerGas < floor) maxFeePerGas = floor;
        return { maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? priorityFee };
      }
      if (fee.gasPrice) {
        let gasPrice = (fee.gasPrice * multiplier) / 100n;
        if (gasPrice < floor) gasPrice = floor;
        return { gasPrice };
      }
    } catch (err: any) {
      this.logger.warn(`getFeeOverrides échoué: ${err.message}`);
    }
    return {};
  }

  getIsDryRun(): boolean {
    return this.isDryRun;
  }

  /**
   * Relit WALLET_PRIVATE_KEY / ARBITRUM_RPC_URL depuis process.env et recrée
   * provider + wallet. Utilisé par l'endpoint admin pour sortir du DRY-RUN
   * sans redéploiement. Ne loggue JAMAIS la clé.
   */
  reinitialize(): { isDryRun: boolean; walletConfigured: boolean; rpcConfigured: boolean } {
    // Reset provider/wallet ; ils seront recréés paresseusement à la prochaine utilisation.
    this.provider = null;
    this.wallet = null;
    this.nonceHighWater = -1;
    const pk = process.env.WALLET_PRIVATE_KEY;
    this.isDryRun = !pk;
    const rpc = !!process.env.ARBITRUM_RPC_URL;
    if (this.isDryRun) {
      this.logger.warn('🔧 Réinitialisation : mode DRY-RUN maintenu (WALLET_PRIVATE_KEY absente)');
    } else {
      this.logger.log(`🔓 Réinitialisation : sortie du DRY-RUN (wallet configuré, RPC ${rpc ? 'personnalisé' : 'par défaut'})`);
    }
    return { isDryRun: this.isDryRun, walletConfigured: !!pk, rpcConfigured: rpc };
  }

  private getProvider(): ethers.JsonRpcProvider {
    if (!this.provider) {
      // On lit d'abord process.env (mis à jour par l'endpoint admin), puis ConfigService.
      const rpcUrl = process.env.ARBITRUM_RPC_URL || this.config.get<string>('ARBITRUM_RPC_URL') || 'https://arb1.arbitrum.io/rpc';
      // Provider avec rate limiting (max 5 appels/s) + retry backoff exponentiel sur 429.
      this.provider = new RateLimitedProvider(rpcUrl, ARBITRUM_CHAIN_ID, 5);
    }
    return this.provider;
  }

  private getWallet(): ethers.Wallet {
    if (!this.wallet) {
      const pk = process.env.WALLET_PRIVATE_KEY || this.config.get<string>('WALLET_PRIVATE_KEY');
      if (!pk) throw new Error('WALLET_PRIVATE_KEY non configurée');
      this.wallet = new ethers.Wallet(pk, this.getProvider());
    }
    return this.wallet;
  }

  /** Obtenir le solde ERC20 d'un token pour le wallet */
  async getBalance(token: string): Promise<{ balance: bigint; formatted: string }> {
    const info = this.getTokenInfo(token);
    const provider = this.getProvider();
    const contract = new ethers.Contract(info.address, ERC20_ABI, provider);
    const balance: bigint = await contract.balanceOf(WALLET_ADDRESS);
    return {
      balance,
      formatted: ethers.formatUnits(balance, info.decimals),
    };
  }

  /** Obtenir les soldes de tous les tokens (ERC20 + ETH natif). */
  async getAllBalances(): Promise<Record<string, string>> {
    const { balances } = await this.getAllBalancesDetailed();
    return balances;
  }

  /**
   * Comme getAllBalances mais SANS avaler silencieusement les erreurs RPC :
   * retourne aussi la liste des tokens dont la lecture a échoué (`failed`).
   * Permet aux appelants (Risk) de détecter une valorisation partielle/non fiable.
   */
  async getAllBalancesDetailed(): Promise<{ balances: Record<string, string>; failed: string[] }> {
    const balances: Record<string, string> = {};
    const failed: string[] = [];
    for (const [symbol] of Object.entries(TOKENS)) {
      try {
        const { formatted } = await this.getBalance(symbol);
        balances[symbol] = formatted;
      } catch (err: any) {
        this.logger.warn(`Solde ${symbol} indisponible: ${err.message}`);
        balances[symbol] = '0';
        failed.push(symbol);
      }
    }
    // ETH natif (utilisé pour le gas + peut représenter du capital non wrappé).
    try {
      const nativeWei = await this.getProvider().getBalance(WALLET_ADDRESS);
      balances['ETH'] = ethers.formatEther(nativeWei);
    } catch (err: any) {
      this.logger.warn(`Solde ETH natif indisponible: ${err.message}`);
      balances['ETH'] = '0';
      failed.push('ETH');
    }
    return { balances, failed };
  }

  /** Obtenir une cotation via QuoterV2 */
  async getQuote(
    sourceToken: string,
    targetToken: string,
    amountIn: string,
  ): Promise<QuoteResult> {
    const srcInfo = this.getTokenInfo(sourceToken);
    const tgtInfo = this.getTokenInfo(targetToken);
    const amountInWei = ethers.parseUnits(amountIn, srcInfo.decimals);

    const provider = this.getProvider();
    const quoter = new ethers.Contract(UNISWAP_QUOTER_V2, QUOTER_ABI, provider);

    const result = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: srcInfo.address,
      tokenOut: tgtInfo.address,
      amountIn: amountInWei,
      fee: DEFAULT_POOL_FEE,
      sqrtPriceLimitX96: 0,
    });

    const amountOutWei = result[0] as bigint;
    return {
      amountOut: ethers.formatUnits(amountOutWei, tgtInfo.decimals),
      amountOutWei,
    };
  }

  /** Exécuter un swap via SwapRouter02 */
  async executeSwap(
    sourceToken: string,
    targetToken: string,
    amountIn: string,
    slippageBps: number,
  ): Promise<SwapResult> {
    // Validation
    this.assertSwapInputs(amountIn, slippageBps);

    const srcInfo = this.getTokenInfo(sourceToken);
    const tgtInfo = this.getTokenInfo(targetToken);

    // Mode dry-run
    if (this.isDryRun) {
      return this.simulateSwap(sourceToken, targetToken, amountIn);
    }

    try {
      // ── Quote (FAIL-CLOSED) : si la quote échoue, le swap échoue ──
      const quote = await this.getQuote(sourceToken, targetToken, amountIn);
      const amountInWei = ethers.parseUnits(amountIn, srcInfo.decimals);

      // Fail-closed : amountOut de la quote doit être > 0
      if (quote.amountOutWei <= 0n) {
        throw new Error(`Quote nulle (amountOut=0) — swap refusé (fail-closed)`);
      }
      const minAmountOut = (quote.amountOutWei * BigInt(10000 - slippageBps)) / BigInt(10000);
      // Fail-closed : minAmountOut doit être STRICTEMENT > 0 (jamais 0)
      if (minAmountOut <= 0n) {
        throw new Error(`minAmountOut=0 interdit (slippage trop élevé) — swap refusé (fail-closed)`);
      }

      const wallet = this.getWallet();
      const walletAddress = await wallet.getAddress();

      // ── Approvals ERC20 avec fallback approve(0) → approve(MaxUint256) ──
      await this.ensureAllowance(wallet, srcInfo, amountInWei, sourceToken);

      // ── Construire le swap ──
      const router = new ethers.Contract(UNISWAP_SWAP_ROUTER_02, SWAP_ROUTER_ABI, wallet);
      const swapData = router.interface.encodeFunctionData('exactInputSingle', [{
        tokenIn: srcInfo.address,
        tokenOut: tgtInfo.address,
        fee: DEFAULT_POOL_FEE,
        recipient: walletAddress,
        amountIn: amountInWei,
        amountOutMinimum: minAmountOut,
        sqrtPriceLimitX96: 0,
      }]);

      // Deadline anti-MEV : bornée ≤ 120s
      const deadline = Math.floor(Date.now() / 1000) + MAX_SWAP_DEADLINE_SEC;
      const callData = router.interface.encodeFunctionData('multicall', [deadline, [swapData]]);

      // Estimation gas avec buffer +20%
      const gasEstimate = await wallet.estimateGas({ to: UNISWAP_SWAP_ROUTER_02, data: callData });
      const gasLimit = (gasEstimate * BigInt(100 + GAS_LIMIT_BUFFER_PCT)) / BigInt(100);

      // ── Envoi sérialisé (mutex) avec gestion nonce + retry ──
      const receipt = await this.withTxLock(() =>
        this.sendWithNonceRetry(wallet, router, deadline, swapData, gasLimit),
      );

      const effGasPrice = receipt.gasPrice ?? 0n;
      const gasPaid = ethers.formatEther(receipt.gasUsed * effGasPrice);

      return {
        success: receipt.status === 1,
        amountIn,
        amountOut: quote.amountOut,
        effectivePrice: (parseFloat(amountIn) / parseFloat(quote.amountOut)).toString(),
        gasPaid,
        txHash: receipt.hash,
        error: receipt.status === 1 ? undefined : 'TX revert (status 0)',
      };
    } catch (err: any) {
      this.logger.error(`Swap ${sourceToken}→${targetToken} échoué: ${err.message}`);
      return {
        success: false,
        amountIn,
        amountOut: '0',
        effectivePrice: '0',
        gasPaid: '0',
        txHash: '',
        error: err.message,
      };
    }
  }

  /** Garantir l'allowance avec fallback approve(0)→approve(Max) pour tokens stricts (ex: USDT) */
  private async ensureAllowance(
    wallet: ethers.Wallet,
    srcInfo: TokenInfo,
    amountInWei: bigint,
    sourceToken: string,
  ): Promise<void> {
    const walletAddress = await wallet.getAddress();
    const srcContract = new ethers.Contract(srcInfo.address, ERC20_ABI, wallet);
    const allowance: bigint = await srcContract.allowance(walletAddress, UNISWAP_SWAP_ROUTER_02);
    if (allowance >= amountInWei) return;

    await this.withTxLock(async () => {
      try {
        this.logger.log(`Approbation ${sourceToken} pour SwapRouter02...`);
        const nonce = await this.nextNonce(wallet);
        const tx = await srcContract.approve(UNISWAP_SWAP_ROUTER_02, ethers.MaxUint256, { nonce });
        await this.waitWithTimeout(tx);
      } catch (err: any) {
        // Tokens stricts (USDT-like) : forcer approve(0) puis approve(Max)
        this.logger.warn(`approve direct échoué (${err.message}) — fallback approve(0)→approve(Max)`);
        const n0 = await this.nextNonce(wallet);
        const tx0 = await srcContract.approve(UNISWAP_SWAP_ROUTER_02, 0n, { nonce: n0 });
        await this.waitWithTimeout(tx0);
        const n1 = await this.nextNonce(wallet);
        const tx1 = await srcContract.approve(UNISWAP_SWAP_ROUTER_02, ethers.MaxUint256, { nonce: n1 });
        await this.waitWithTimeout(tx1);
      }
    });
  }

  /** Envoyer la TX avec resync du nonce et retry ciblé sur erreurs nonce */
  private async sendWithNonceRetry(
    wallet: ethers.Wallet,
    router: ethers.Contract,
    deadline: number,
    swapData: string,
    gasLimit: bigint,
  ): Promise<ethers.TransactionReceipt> {
    let lastErr: any;
    let gasBump = 0; // majoration cumulée du fee sur retries gas
    for (let attempt = 1; attempt <= this.txSendMaxAttempts; attempt++) {
      try {
        const nonce = await this.nextNonce(wallet);
        // Fee re-lu à chaque tentative (base fee frais) + bump cumulé si erreur gas.
        const fees = await this.getFeeOverrides(gasBump);
        const tx: ethers.TransactionResponse = await router.multicall(deadline, [swapData], {
          gasLimit, nonce, ...fees,
        });
        this.logger.log(`TX envoyée ${tx.hash} (nonce=${nonce}, tentative ${attempt})`);
        return await this.waitWithTimeout(tx);
      } catch (err: any) {
        lastErr = err;
        const msg = (err.message || '').toLowerCase();
        const isNonceErr = NONCE_RETRY_ERRORS.some((e) => msg.includes(e));
        const isGasErr = GAS_RETRY_ERRORS.some((e) => msg.includes(e));
        if ((isNonceErr || isGasErr) && attempt < this.txSendMaxAttempts) {
          if (isGasErr) {
            gasBump += 150; // +150 % de base fee supplémentaire à chaque retry gas
            this.logger.warn(`Erreur gas (tentative ${attempt}), re-lecture base fee + bump +${gasBump}%: ${err.message}`);
          } else {
            this.logger.warn(`Erreur nonce (tentative ${attempt}), resync et retry: ${err.message}`);
            // Resync : forcer relecture du nonce pending au prochain tour
            this.nonceHighWater = (await wallet.getNonce('pending')) - 1;
          }
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  /** Simulation de swap en dry-run (utilise vrais prix KuCoin via quote) */
  private async simulateSwap(
    sourceToken: string,
    targetToken: string,
    amountIn: string,
  ): Promise<SwapResult> {
    // Prix réels via KuCoin (primaire), fallback quote on-chain Uniswap
    try {
      let amountOut: number;
      const amountInNum = parseFloat(amountIn);
      try {
        const srcPrice = await this.priceService.getPrice(sourceToken);
        const tgtPrice = await this.priceService.getPrice(targetToken);
        if (!(srcPrice > 0) || !(tgtPrice > 0)) throw new Error('prix KuCoin nul');
        // Correctif audit : appliquer la friction réaliste en dry-run.
        //  • frais de pool Uniswap : 0,3 %
        //  • slippage estimé       : 0,1 %
        amountOut =
          (amountInNum * srcPrice) / tgtPrice *
          (1 - SIM_POOL_FEE) *
          (1 - SIM_SLIPPAGE);
      } catch (kuErr: any) {
        // Fallback : quote on-chain Uniswap (les frais de pool sont déjà inclus dans le quote,
        // on n'applique donc que le slippage estimé pour ne pas double-compter les frais).
        this.logger.warn(`[DRY-RUN] KuCoin indisponible (${kuErr.message}), fallback quote on-chain`);
        const quote = await this.getQuote(sourceToken, targetToken, amountIn);
        amountOut = parseFloat(quote.amountOut) * (1 - SIM_SLIPPAGE);
      }

      if (!(amountOut > 0)) throw new Error('amountOut simulé nul (fail-closed)');

      // Gas estimé ~0,15 $/trade, converti en ETH via le prix WETH (cohérent avec le
      // calcul de coût de gas côté portfolio/strategy-evaluator qui fait gasEth × prixWETH).
      let gasPaidEth = '0';
      try {
        const ethPrice = await this.priceService.getPrice('WETH');
        if (ethPrice > 0) gasPaidEth = (SIM_GAS_USD / ethPrice).toString();
      } catch {
        /* prix ETH indisponible : gas laissé à 0 */
      }

      this.logger.log(
        `[DRY-RUN] Swap simulé : ${amountIn} ${sourceToken} → ${amountOut} ${targetToken} ` +
          `(frais ${(SIM_POOL_FEE * 100).toFixed(1)}% + slippage ${(SIM_SLIPPAGE * 100).toFixed(1)}%, gas ~$${SIM_GAS_USD})`,
      );
      return {
        success: true,
        amountIn,
        amountOut: amountOut.toString(),
        effectivePrice: (amountInNum / amountOut).toString(),
        gasPaid: gasPaidEth,
        // Hash simulé via randomUUID (jamais Math.random / collisions)
        txHash: `dry-run-${randomUUID()}`,
      };
    } catch (err: any) {
      // Fail-closed : aucun prix fiable → swap simulé échoue (pas de prix fictif)
      this.logger.warn(`[DRY-RUN] Prix indisponible pour ${sourceToken}→${targetToken}: ${err.message}`);
      return {
        success: false,
        amountIn,
        amountOut: '0',
        effectivePrice: '0',
        gasPaid: '0',
        txHash: '',
        error: `Dry-run: prix indisponible - ${err.message}`,
      };
    }
  }

  private assertSwapInputs(amountIn: string, slippageBps: number): void {
    const amount = Number(amountIn);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Montant de swap invalide: "${amountIn}"`);
    }
    if (!Number.isInteger(slippageBps) || slippageBps < MIN_SLIPPAGE_BPS || slippageBps > MAX_SLIPPAGE_BPS) {
      throw new Error(
        `Slippage invalide: ${slippageBps} bps (attendu: ${MIN_SLIPPAGE_BPS}-${MAX_SLIPPAGE_BPS})`,
      );
    }
  }

  getTokenInfo(token: string): TokenInfo {
    const info = TOKENS[token.toUpperCase()];
    if (!info) throw new Error(`Token non supporté: ${token}`);
    return info;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Helpers TX génériques (réutilisés par GMX & Aave)
  // ═══════════════════════════════════════════════════════════════════

  /** Envoi TX géré (mutex + nonce high-water + retry nonce + timeout confirmation). */
  private async sendManagedTx(
    label: string,
    buildAndSend: (overrides: Record<string, any>) => Promise<ethers.TransactionResponse>,
  ): Promise<ethers.TransactionReceipt> {
    return this.withTxLock(async () => {
      let lastErr: any;
      let gasBump = 0;
      for (let attempt = 1; attempt <= this.txSendMaxAttempts; attempt++) {
        try {
          const wallet = this.getWallet();
          const nonce = await this.nextNonce(wallet);
          const fees = await this.getFeeOverrides(gasBump);
          const tx = await buildAndSend({ nonce, ...fees });
          this.logger.log(`${label} — TX ${tx.hash} (nonce=${nonce}, tentative ${attempt})`);
          return await this.waitWithTimeout(tx);
        } catch (err: any) {
          lastErr = err;
          const msg = (err.message || '').toLowerCase();
          const isNonceErr = NONCE_RETRY_ERRORS.some((e) => msg.includes(e));
          const isGasErr = GAS_RETRY_ERRORS.some((e) => msg.includes(e));
          if ((isNonceErr || isGasErr) && attempt < this.txSendMaxAttempts) {
            if (isGasErr) {
              gasBump += 150;
              this.logger.warn(`${label} : erreur gas (tentative ${attempt}), bump +${gasBump}%: ${err.message}`);
            } else {
              this.logger.warn(`${label} : erreur nonce (tentative ${attempt}), resync: ${err.message}`);
              this.nonceHighWater = (await this.getWallet().getNonce('pending')) - 1;
            }
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    });
  }

  /** Garantit une allowance ERC20 vers un spender arbitraire (GMX Router / Aave Pool). */
  private async ensureAllowanceFor(spender: string, tokenSymbol: string, amountWei: bigint): Promise<void> {
    const wallet = this.getWallet();
    const info = this.getTokenInfo(tokenSymbol);
    const c = new ethers.Contract(info.address, ERC20_ABI, wallet);
    const owner = await wallet.getAddress();
    const allowance: bigint = await c.allowance(owner, spender);
    if (allowance >= amountWei) return;
    await this.sendManagedTx(`Approbation ${tokenSymbol}→${spender.slice(0, 10)}…`, (ov) =>
      c.approve(spender, ethers.MaxUint256, ov),
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  //  GMX V2 — perps (ExchangeRouter + Reader)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Ouvre une position perp GMX V2 (MarketIncrease) via multicall :
   *   sendWnt(execFee) + sendTokens(collatéral) + createOrder.
   * L'exécution GMX est ASYNCHRONE : la TX crée l'ordre, un keeper l'exécute
   * ensuite au prix oracle Chainlink → statut 'pending_open' côté appelant.
   */
  async gmxOpenLong(params: {
    market: string;
    collateralTokenSymbol: string;
    collateralAmountUsd: number;
    sizeDeltaUsd: number;
    acceptablePrice: number;
    indexTokenSymbol: string;
    isLong: boolean;
  }): Promise<ChainOpResult> {
    if (this.isDryRun) {
      this.logger.log(`[DRY-RUN] GMX open ${params.isLong ? 'LONG' : 'SHORT'} ${params.indexTokenSymbol} collat $${params.collateralAmountUsd} taille $${params.sizeDeltaUsd}`);
      return { success: true, simulated: true, txHash: `dry-run-${randomUUID()}`, orderKey: '' };
    }
    try {
      const wallet = this.getWallet();
      const receiver = await wallet.getAddress();
      const collInfo = this.getTokenInfo(params.collateralTokenSymbol);
      const idxInfo = this.getTokenInfo(params.indexTokenSymbol);

      const collateralAmountWei = ethers.parseUnits(params.collateralAmountUsd.toFixed(collInfo.decimals), collInfo.decimals);
      const sizeDeltaUsdWei = ethers.parseUnits(params.sizeDeltaUsd.toFixed(2), GMX_USD_DECIMALS);
      // Prix GMX : précision = 30 - décimales du token indexé.
      const priceDecimals = GMX_USD_DECIMALS - idxInfo.decimals;
      const acceptablePriceWei = ethers.parseUnits(params.acceptablePrice.toFixed(Math.min(priceDecimals, 12)), priceDecimals);
      const execFeeWei = ethers.parseEther(GMX_EXECUTION_FEE_ETH);

      // Approbation du collatéral vers le Router GMX (cible des transferts).
      await this.ensureAllowanceFor(GMX_ROUTER, params.collateralTokenSymbol, collateralAmountWei);

      const router = new ethers.Contract(GMX_EXCHANGE_ROUTER, GMX_EXCHANGE_ROUTER_ABI, wallet);
      const orderParams = this.buildGmxOrderParams({
        receiver, market: params.market, collateralToken: collInfo.address,
        sizeDeltaUsdWei, collateralDeltaWei: collateralAmountWei, acceptablePriceWei,
        execFeeWei, orderType: GMX_ORDER_TYPE_MARKET_INCREASE, isLong: params.isLong,
      });

      const sendWntData = router.interface.encodeFunctionData('sendWnt', [GMX_ORDER_VAULT, execFeeWei]);
      const sendTokensData = router.interface.encodeFunctionData('sendTokens', [collInfo.address, GMX_ORDER_VAULT, collateralAmountWei]);
      const createOrderData = router.interface.encodeFunctionData('createOrder', [orderParams]);
      const calls = [sendWntData, sendTokensData, createOrderData];

      const receipt = await this.sendManagedTx('GMX createOrder (open)', (ov) =>
        router.multicall(calls, { value: execFeeWei, ...ov }),
      );
      return {
        success: receipt.status === 1, simulated: false, txHash: receipt.hash, orderKey: '',
        error: receipt.status === 1 ? undefined : 'TX revert (status 0)',
      };
    } catch (err: any) {
      this.logger.error(`GMX open échoué: ${err.message}`);
      return { success: false, simulated: false, txHash: '', error: err.message };
    }
  }

  /**
   * Ferme (partiellement/totalement) une position perp GMX V2 (MarketDecrease).
   * Pas de sendTokens (on retire du collatéral) : sendWnt(execFee) + createOrder.
   */
  async gmxCloseLong(params: {
    market: string;
    collateralTokenSymbol: string;
    collateralDeltaUsd: number;
    sizeDeltaUsd: number;
    acceptablePrice: number;
    indexTokenSymbol: string;
    isLong: boolean;
  }): Promise<ChainOpResult> {
    if (this.isDryRun) {
      this.logger.log(`[DRY-RUN] GMX close ${params.indexTokenSymbol} taille $${params.sizeDeltaUsd}`);
      return { success: true, simulated: true, txHash: `dry-run-${randomUUID()}`, orderKey: '' };
    }
    try {
      const wallet = this.getWallet();
      const receiver = await wallet.getAddress();
      const collInfo = this.getTokenInfo(params.collateralTokenSymbol);
      const idxInfo = this.getTokenInfo(params.indexTokenSymbol);

      const collateralDeltaWei = ethers.parseUnits(params.collateralDeltaUsd.toFixed(collInfo.decimals), collInfo.decimals);
      const sizeDeltaUsdWei = ethers.parseUnits(params.sizeDeltaUsd.toFixed(2), GMX_USD_DECIMALS);
      const priceDecimals = GMX_USD_DECIMALS - idxInfo.decimals;
      const acceptablePriceWei = ethers.parseUnits(params.acceptablePrice.toFixed(Math.min(priceDecimals, 12)), priceDecimals);
      const execFeeWei = ethers.parseEther(GMX_EXECUTION_FEE_ETH);

      const router = new ethers.Contract(GMX_EXCHANGE_ROUTER, GMX_EXCHANGE_ROUTER_ABI, wallet);
      const orderParams = this.buildGmxOrderParams({
        receiver, market: params.market, collateralToken: collInfo.address,
        sizeDeltaUsdWei, collateralDeltaWei, acceptablePriceWei,
        execFeeWei, orderType: GMX_ORDER_TYPE_MARKET_DECREASE, isLong: params.isLong,
      });

      const sendWntData = router.interface.encodeFunctionData('sendWnt', [GMX_ORDER_VAULT, execFeeWei]);
      const createOrderData = router.interface.encodeFunctionData('createOrder', [orderParams]);
      const calls = [sendWntData, createOrderData];

      const receipt = await this.sendManagedTx('GMX createOrder (close)', (ov) =>
        router.multicall(calls, { value: execFeeWei, ...ov }),
      );
      return {
        success: receipt.status === 1, simulated: false, txHash: receipt.hash, orderKey: '',
        error: receipt.status === 1 ? undefined : 'TX revert (status 0)',
      };
    } catch (err: any) {
      this.logger.error(`GMX close échoué: ${err.message}`);
      return { success: false, simulated: false, txHash: '', error: err.message };
    }
  }

  /** Construit la struct CreateOrderParams GMX V2 (tuple ordonné pour ethers). */
  private buildGmxOrderParams(p: {
    receiver: string; market: string; collateralToken: string;
    sizeDeltaUsdWei: bigint; collateralDeltaWei: bigint; acceptablePriceWei: bigint;
    execFeeWei: bigint; orderType: number; isLong: boolean;
  }): any {
    return {
      addresses: {
        receiver: p.receiver,
        cancellationReceiver: ethers.ZeroAddress,
        callbackContract: ethers.ZeroAddress,
        uiFeeReceiver: ethers.ZeroAddress,
        market: p.market,
        initialCollateralToken: p.collateralToken,
        swapPath: [],
      },
      numbers: {
        sizeDeltaUsd: p.sizeDeltaUsdWei,
        initialCollateralDeltaAmount: p.collateralDeltaWei,
        triggerPrice: 0n,
        acceptablePrice: p.acceptablePriceWei,
        executionFee: p.execFeeWei,
        callbackGasLimit: BigInt(GMX_CALLBACK_GAS_LIMIT),
        minOutputAmount: 0n,
        validFromTime: 0n,
      },
      orderType: p.orderType,
      decreasePositionSwapType: 0, // NoSwap : on garde le collatéral tel quel
      isLong: p.isLong,
      shouldUnwrapNativeToken: false,
      autoCancel: false,
      referralCode: ethers.ZeroHash,
    };
  }

  /** Lit les positions GMX du wallet via le Reader (best-effort ; [] en dry-run/erreur). */
  async gmxGetPositions(): Promise<any[]> {
    if (this.isDryRun) return [];
    try {
      const reader = new ethers.Contract(GMX_READER, GMX_READER_ABI, this.getProvider());
      const raw = await reader.getAccountPositions(GMX_DATASTORE, WALLET_ADDRESS, 0, 50);
      return (raw as any[]).map((pos) => ({
        account: pos.addresses.account,
        market: pos.addresses.market,
        collateralToken: pos.addresses.collateralToken,
        sizeInUsd: pos.numbers.sizeInUsd.toString(),
        sizeInTokens: pos.numbers.sizeInTokens.toString(),
        collateralAmount: pos.numbers.collateralAmount.toString(),
        isLong: pos.flags.isLong,
      }));
    } catch (err: any) {
      this.logger.warn(`GMX getPositions indisponible: ${err.message}`);
      return [];
    }
  }

  /** Résout le symbole d'un token à partir de son adresse (insensible à la casse). */
  private symbolFromAddress(address: string): string | null {
    const addr = address.toLowerCase();
    for (const [symbol, info] of Object.entries(TOKENS)) {
      if (info.address.toLowerCase() === addr) return symbol;
    }
    return null;
  }

  /** Résout le symbole du token indexé d'un marché GMX (seul WETH-USD est câblé). */
  private indexSymbolFromMarket(market: string): string {
    if (market.toLowerCase() === GMX_WETH_USD_MARKET.toLowerCase()) return 'WETH';
    return 'WETH'; // défaut prudent (seul marché supporté)
  }

  /**
   * Positions GMX enrichies : convertit les valeurs brutes on-chain en USD lisibles
   * et calcule le PnL non réalisé à partir du prix courant. Ne renvoie que les
   * positions de taille non nulle.
   */
  async gmxGetPositionsDetailed(): Promise<GmxPositionDetail[]> {
    const raw = await this.gmxGetPositions();
    const out: GmxPositionDetail[] = [];
    for (const p of raw) {
      const sizeUsd = Number(p.sizeInUsd) / 10 ** GMX_USD_DECIMALS;
      if (sizeUsd <= 0) continue;

      const indexSymbol = this.indexSymbolFromMarket(p.market);
      const idxInfo = TOKENS[indexSymbol];
      const sizeTokens = idxInfo ? Number(p.sizeInTokens) / 10 ** idxInfo.decimals : 0;

      const collSymbol = this.symbolFromAddress(p.collateralToken) || 'USDC';
      const collInfo = TOKENS[collSymbol];
      const collAmount = collInfo ? Number(p.collateralAmount) / 10 ** collInfo.decimals : 0;
      let collPrice = 1;
      try { collPrice = STABLECOINS.has(collSymbol) ? 1 : await this.priceService.getPrice(collSymbol); } catch {}
      const collateralUsd = collAmount * collPrice;

      const entryPrice = sizeTokens > 0 ? sizeUsd / sizeTokens : 0;
      let markPrice = entryPrice;
      try { markPrice = await this.priceService.getPrice(indexSymbol); } catch {}

      // PnL long = tokens × (mark - entry) ; short = tokens × (entry - mark).
      const unrealizedPnlUsd = p.isLong
        ? sizeTokens * (markPrice - entryPrice)
        : sizeTokens * (entryPrice - markPrice);
      const positionValueUsd = collateralUsd + unrealizedPnlUsd;
      const leverage = collateralUsd > 0 ? sizeUsd / collateralUsd : 0;

      out.push({
        market: p.market, collateralToken: p.collateralToken, collateralSymbol: collSymbol,
        indexSymbol, isLong: p.isLong, collateralUsd, sizeUsd, sizeTokens,
        entryPrice, markPrice, unrealizedPnlUsd, positionValueUsd, leverage,
      });
    }
    return out;
  }

  /**
   * Valeur agrégée des positions DeFi actives (GMX + Aave). Utilisée par le portfolio
   * et le Risk Manager pour refléter le capital réel (wallet + DeFi).
   * En DRY-RUN → tout à zéro (aucune lecture on-chain).
   */
  async getDefiValueUsd(): Promise<DefiValue> {
    if (this.isDryRun) {
      return { gmxUsd: 0, aaveUsd: 0, totalUsd: 0, gmxPositions: [], aave: null };
    }
    let gmxPositions: GmxPositionDetail[] = [];
    let gmxUsd = 0;
    let incomplete = false;
    try {
      gmxPositions = await this.gmxGetPositionsDetailed();
      gmxUsd = gmxPositions.reduce((s, p) => s + p.positionValueUsd, 0);
    } catch (err: any) {
      this.logger.warn(`Valorisation GMX indisponible: ${err.message}`);
      incomplete = true;
    }

    let aave: AaveAccountData | null = null;
    let aaveUsd = 0;
    try {
      aave = await this.aaveGetAccountData();
      if (aave) aaveUsd = Math.max(0, aave.totalCollateralUsd - aave.totalDebtUsd);
    } catch (err: any) {
      this.logger.warn(`Valorisation Aave indisponible: ${err.message}`);
      incomplete = true;
    }

    return { gmxUsd, aaveUsd, totalUsd: gmxUsd + aaveUsd, gmxPositions, aave, incomplete };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Aave V3 — looping (Pool supply/borrow/repay/withdraw + Health Factor)
  // ═══════════════════════════════════════════════════════════════════

  /** Lit les données de compte Aave V3 on-chain (null en dry-run/erreur → fallback estimé). */
  async aaveGetAccountData(): Promise<AaveAccountData | null> {
    if (this.isDryRun) return null;
    try {
      const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, this.getProvider());
      const d = await pool.getUserAccountData(WALLET_ADDRESS);
      const base = 10 ** AAVE_BASE_DECIMALS;
      const hfRaw = d.healthFactor as bigint;
      // HF = MaxUint256 quand il n'y a aucune dette → Infinity.
      const healthFactor = hfRaw >= ethers.MaxUint256 / 2n
        ? Infinity
        : parseFloat(ethers.formatUnits(hfRaw, AAVE_HF_DECIMALS));
      return {
        healthFactor,
        totalCollateralUsd: Number(d.totalCollateralBase) / base,
        totalDebtUsd: Number(d.totalDebtBase) / base,
        availableBorrowsUsd: Number(d.availableBorrowsBase) / base,
        currentLiquidationThreshold: Number(d.currentLiquidationThreshold) / 10000,
        ltv: Number(d.ltv) / 10000,
      };
    } catch (err: any) {
      this.logger.warn(`Aave getUserAccountData indisponible: ${err.message}`);
      return null;
    }
  }

  /**
   * Notifie Telegram pour TOUTE opération Aave (supply/borrow/withdraw/repay),
   * qu'elle soit simulée (dry-run), réussie ou échouée. Fire-and-forget.
   */
  private notifyAaveOp(
    action: 'supply' | 'borrow' | 'withdraw' | 'repay',
    tokenSymbol: string,
    amountToken: number,
    res: ChainOpResult,
  ): void {
    try {
      this.telegram.notifyDefiOp({
        protocol: 'Aave V3',
        action,
        tokenSymbol,
        amountToken,
        amountUsd: STABLECOINS.has(tokenSymbol) ? amountToken : null,
        success: res.success,
        simulated: res.simulated,
        txHash: res.txHash,
        error: res.error,
      });
    } catch {
      /* la notification ne doit jamais casser l'opération on-chain */
    }
  }

  /** Dépose `amountToken` de collatéral dans Aave V3 (approve + supply). */
  async aaveSupply(tokenSymbol: string, amountToken: number): Promise<ChainOpResult> {
    if (this.isDryRun) {
      this.logger.log(`[DRY-RUN] Aave supply ${amountToken} ${tokenSymbol}`);
      const res: ChainOpResult = { success: true, simulated: true, txHash: `dry-run-${randomUUID()}` };
      this.notifyAaveOp('supply', tokenSymbol, amountToken, res);
      return res;
    }
    let res: ChainOpResult;
    try {
      const wallet = this.getWallet();
      const info = this.getTokenInfo(tokenSymbol);
      const amountWei = ethers.parseUnits(amountToken.toString(), info.decimals);
      await this.ensureAllowanceFor(AAVE_POOL, tokenSymbol, amountWei);
      const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, wallet);
      const receipt = await this.sendManagedTx(`Aave supply ${tokenSymbol}`, (ov) =>
        pool.supply(info.address, amountWei, WALLET_ADDRESS, AAVE_REFERRAL_CODE, ov),
      );
      res = { success: receipt.status === 1, simulated: false, txHash: receipt.hash };
    } catch (err: any) {
      this.logger.error(`Aave supply échoué: ${err.message}`);
      res = { success: false, simulated: false, txHash: '', error: err.message };
    }
    this.notifyAaveOp('supply', tokenSymbol, amountToken, res);
    return res;
  }

  /** Emprunte `amountToken` (taux variable) sur Aave V3. */
  async aaveBorrow(tokenSymbol: string, amountToken: number): Promise<ChainOpResult> {
    if (this.isDryRun) {
      this.logger.log(`[DRY-RUN] Aave borrow ${amountToken} ${tokenSymbol}`);
      const res: ChainOpResult = { success: true, simulated: true, txHash: `dry-run-${randomUUID()}` };
      this.notifyAaveOp('borrow', tokenSymbol, amountToken, res);
      return res;
    }
    let res: ChainOpResult;
    try {
      const wallet = this.getWallet();
      const info = this.getTokenInfo(tokenSymbol);
      const amountWei = ethers.parseUnits(amountToken.toString(), info.decimals);
      const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, wallet);
      const receipt = await this.sendManagedTx(`Aave borrow ${tokenSymbol}`, (ov) =>
        pool.borrow(info.address, amountWei, AAVE_VARIABLE_RATE_MODE, AAVE_REFERRAL_CODE, WALLET_ADDRESS, ov),
      );
      res = { success: receipt.status === 1, simulated: false, txHash: receipt.hash };
    } catch (err: any) {
      this.logger.error(`Aave borrow échoué: ${err.message}`);
      res = { success: false, simulated: false, txHash: '', error: err.message };
    }
    this.notifyAaveOp('borrow', tokenSymbol, amountToken, res);
    return res;
  }

  /** Rembourse `amountToken` de dette (taux variable) sur Aave V3 (approve + repay). */
  async aaveRepay(tokenSymbol: string, amountToken: number): Promise<ChainOpResult> {
    if (this.isDryRun) {
      this.logger.log(`[DRY-RUN] Aave repay ${amountToken} ${tokenSymbol}`);
      const res: ChainOpResult = { success: true, simulated: true, txHash: `dry-run-${randomUUID()}` };
      this.notifyAaveOp('repay', tokenSymbol, amountToken, res);
      return res;
    }
    let res: ChainOpResult;
    try {
      const wallet = this.getWallet();
      const info = this.getTokenInfo(tokenSymbol);
      const amountWei = ethers.parseUnits(amountToken.toString(), info.decimals);
      await this.ensureAllowanceFor(AAVE_POOL, tokenSymbol, amountWei);
      const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, wallet);
      const receipt = await this.sendManagedTx(`Aave repay ${tokenSymbol}`, (ov) =>
        pool.repay(info.address, amountWei, AAVE_VARIABLE_RATE_MODE, WALLET_ADDRESS, ov),
      );
      res = { success: receipt.status === 1, simulated: false, txHash: receipt.hash };
    } catch (err: any) {
      this.logger.error(`Aave repay échoué: ${err.message}`);
      res = { success: false, simulated: false, txHash: '', error: err.message };
    }
    this.notifyAaveOp('repay', tokenSymbol, amountToken, res);
    return res;
  }

  /** Retire `amountToken` de collatéral d'Aave V3 (withdraw). */
  async aaveWithdraw(tokenSymbol: string, amountToken: number): Promise<ChainOpResult> {
    if (this.isDryRun) {
      this.logger.log(`[DRY-RUN] Aave withdraw ${amountToken} ${tokenSymbol}`);
      const res: ChainOpResult = { success: true, simulated: true, txHash: `dry-run-${randomUUID()}` };
      this.notifyAaveOp('withdraw', tokenSymbol, amountToken, res);
      return res;
    }
    let res: ChainOpResult;
    try {
      const wallet = this.getWallet();
      const info = this.getTokenInfo(tokenSymbol);
      const amountWei = ethers.parseUnits(amountToken.toString(), info.decimals);
      const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, wallet);
      const receipt = await this.sendManagedTx(`Aave withdraw ${tokenSymbol}`, (ov) =>
        pool.withdraw(info.address, amountWei, WALLET_ADDRESS, ov),
      );
      res = { success: receipt.status === 1, simulated: false, txHash: receipt.hash };
    } catch (err: any) {
      this.logger.error(`Aave withdraw échoué: ${err.message}`);
      res = { success: false, simulated: false, txHash: '', error: err.message };
    }
    this.notifyAaveOp('withdraw', tokenSymbol, amountToken, res);
    return res;
  }
}
