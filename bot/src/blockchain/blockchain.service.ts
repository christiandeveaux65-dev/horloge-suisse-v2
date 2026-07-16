import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import { PriceService } from '../price/price.service';
import {
  TOKENS, TokenInfo, WALLET_ADDRESS, ARBITRUM_CHAIN_ID,
  UNISWAP_QUOTER_V2, UNISWAP_SWAP_ROUTER_02, DEFAULT_POOL_FEE,
  MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS,
  MAX_SWAP_DEADLINE_SEC, DEFAULT_TX_CONFIRM_TIMEOUT_MS,
  DEFAULT_TX_SEND_MAX_ATTEMPTS, GAS_LIMIT_BUFFER_PCT, NONCE_RETRY_ERRORS,
} from '../constants';

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

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);
  private provider: ethers.JsonRpcProvider | null = null;
  private wallet: ethers.Wallet | null = null;
  private readonly isDryRun: boolean;

  // Mutex TX global : sérialise les envois pour éviter les collisions de nonce
  private txLock: Promise<void> = Promise.resolve();
  // High-water mark du nonce : garantit qu'on ne réutilise jamais un nonce en dessous
  private nonceHighWater = -1;

  constructor(
    private readonly config: ConfigService,
    private readonly priceService: PriceService,
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

  /** Frais gas EIP-1559 avec fallback legacy */
  private async getFeeOverrides(): Promise<Record<string, bigint>> {
    try {
      const fee = await this.getProvider().getFeeData();
      if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
        return { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas };
      }
      if (fee.gasPrice) return { gasPrice: fee.gasPrice };
    } catch (err: any) {
      this.logger.warn(`getFeeData échoué, fallback legacy: ${err.message}`);
    }
    return {};
  }

  getIsDryRun(): boolean {
    return this.isDryRun;
  }

  private getProvider(): ethers.JsonRpcProvider {
    if (!this.provider) {
      const rpcUrl = this.config.get<string>('ARBITRUM_RPC_URL') || 'https://arb1.arbitrum.io/rpc';
      this.provider = new ethers.JsonRpcProvider(rpcUrl, ARBITRUM_CHAIN_ID);
    }
    return this.provider;
  }

  private getWallet(): ethers.Wallet {
    if (!this.wallet) {
      const pk = this.config.get<string>('WALLET_PRIVATE_KEY');
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

  /** Obtenir les soldes de tous les tokens */
  async getAllBalances(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [symbol] of Object.entries(TOKENS)) {
      try {
        const { formatted } = await this.getBalance(symbol);
        result[symbol] = formatted;
      } catch (err: any) {
        this.logger.warn(`Solde ${symbol} indisponible: ${err.message}`);
        result[symbol] = '0';
      }
    }
    return result;
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
    for (let attempt = 1; attempt <= this.txSendMaxAttempts; attempt++) {
      try {
        const nonce = await this.nextNonce(wallet);
        const fees = await this.getFeeOverrides();
        const tx: ethers.TransactionResponse = await router.multicall(deadline, [swapData], {
          gasLimit, nonce, ...fees,
        });
        this.logger.log(`TX envoyée ${tx.hash} (nonce=${nonce}, tentative ${attempt})`);
        return await this.waitWithTimeout(tx);
      } catch (err: any) {
        lastErr = err;
        const msg = (err.message || '').toLowerCase();
        const isNonceErr = NONCE_RETRY_ERRORS.some((e) => msg.includes(e));
        if (isNonceErr && attempt < this.txSendMaxAttempts) {
          this.logger.warn(`Erreur nonce (tentative ${attempt}), resync et retry: ${err.message}`);
          // Resync : forcer relecture du nonce pending au prochain tour
          this.nonceHighWater = (await wallet.getNonce('pending')) - 1;
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
        amountOut = (amountInNum * srcPrice) / tgtPrice;
      } catch (kuErr: any) {
        // Fallback : quote on-chain Uniswap
        this.logger.warn(`[DRY-RUN] KuCoin indisponible (${kuErr.message}), fallback quote on-chain`);
        const quote = await this.getQuote(sourceToken, targetToken, amountIn);
        amountOut = parseFloat(quote.amountOut);
      }

      if (!(amountOut > 0)) throw new Error('amountOut simulé nul (fail-closed)');

      this.logger.log(
        `[DRY-RUN] Swap simulé : ${amountIn} ${sourceToken} → ${amountOut} ${targetToken}`,
      );
      return {
        success: true,
        amountIn,
        amountOut: amountOut.toString(),
        effectivePrice: (amountInNum / amountOut).toString(),
        gasPaid: '0',
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
}
