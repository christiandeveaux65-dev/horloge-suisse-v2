import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService, SwapResult } from '../blockchain/blockchain.service';
import { PriceService } from '../price/price.service';
import {
  CHAIN, SPLIT_ORDER_THRESHOLD_USD, SPLIT_TRANCHE_DELAY_MS,
  MAX_SPLIT_TRANCHES, DEFAULT_SLIPPAGE_BPS,
} from '../constants';

export interface TradeRequest {
  source: string;        // 'dca' | 'momentum' | 'mean_reversion' | 'manual' | 'risk' | ...
  sourceToken: string;
  targetToken: string;
  amountIn: string;      // quantité dans le token source
  side: 'buy' | 'sell';
  slippageBps?: number;
  strategyId?: string;   // ID de la stratégie (optionnel)
}

export interface TradeResult {
  success: boolean;
  tradeId?: string;
  amountIn: string;
  amountOut: string;
  effectivePrice: string;
  gasPaid: string;
  txHash: string;
  status: string;
  error?: string;
}

/**
 * TradeExecutionService — Point d'entrée UNIQUE pour tous les swaps.
 * Flux : quote → validate → execute → log → update → emit
 * Leçon #5 : aucun swap ne doit échapper au journal trade.
 */
@Injectable()
export class TradeExecutionService {
  private readonly logger = new Logger(TradeExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blockchain: BlockchainService,
    private readonly priceService: PriceService,
  ) {}

  /**
   * Exécuter un trade (avec split automatique si > seuil)
   */
  async executeTrade(req: TradeRequest): Promise<TradeResult> {
    const slippage = req.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

    // Vérifier si split nécessaire
    const amountNum = parseFloat(req.amountIn);
    let amountUsd = amountNum;
    if (req.sourceToken !== 'USDC' && req.sourceToken !== 'USDT') {
      try {
        const price = await this.priceService.getPrice(req.sourceToken);
        amountUsd = amountNum * price;
      } catch {
        amountUsd = amountNum; // fallback
      }
    }

    if (amountUsd > SPLIT_ORDER_THRESHOLD_USD) {
      return this.executeSplitTrade(req, slippage, amountUsd);
    }

    return this.executeSingleTrade(req, slippage);
  }

  /**
   * Exécuter un trade simple (sans split)
   */
  private async executeSingleTrade(
    req: TradeRequest,
    slippageBps: number,
  ): Promise<TradeResult> {
    this.logger.log(
      `Exécution trade : ${req.amountIn} ${req.sourceToken} → ${req.targetToken} (source: ${req.source})`,
    );

    const swapResult: SwapResult = await this.blockchain.executeSwap(
      req.sourceToken,
      req.targetToken,
      req.amountIn,
      slippageBps,
    );

    // Journaliser le trade — TOUJOURS, même en cas d'échec
    const status = this.blockchain.getIsDryRun()
      ? 'simulated'
      : swapResult.success
        ? 'completed'
        : 'failed';

    const trade = await this.prisma.trade.create({
      data: {
        strategy_id: req.strategyId || null,
        source: req.source,
        chain: CHAIN,
        source_token: req.sourceToken,
        target_token: req.targetToken,
        side: req.side,
        amount_in: swapResult.amountIn,
        amount_out: swapResult.amountOut,
        price: swapResult.effectivePrice,
        gas_paid: swapResult.gasPaid,
        tx_hash: swapResult.txHash,
        status,
        error_message: swapResult.error || null,
      },
    });

    this.logger.log(
      `Trade ${trade.id} journalisé : ${status} | ${req.amountIn} ${req.sourceToken} → ${swapResult.amountOut} ${req.targetToken}`,
    );

    return {
      success: swapResult.success,
      tradeId: trade.id,
      amountIn: swapResult.amountIn,
      amountOut: swapResult.amountOut,
      effectivePrice: swapResult.effectivePrice,
      gasPaid: swapResult.gasPaid,
      txHash: swapResult.txHash,
      status,
      error: swapResult.error,
    };
  }

  /**
   * Split orders > seuil en tranches
   */
  private async executeSplitTrade(
    req: TradeRequest,
    slippageBps: number,
    amountUsd: number,
  ): Promise<TradeResult> {
    const tranches = Math.min(MAX_SPLIT_TRANCHES, Math.ceil(amountUsd / SPLIT_ORDER_THRESHOLD_USD));
    const totalAmount = parseFloat(req.amountIn);
    const trancheAmount = totalAmount / tranches;

    this.logger.log(
      `Split order : ${req.amountIn} ${req.sourceToken} en ${tranches} tranches de ${trancheAmount.toFixed(8)}`,
    );

    let totalAmountOut = 0;
    let totalGas = 0;
    let lastTxHash = '';
    let lastTradeId = '';
    let hasFailure = false;

    for (let i = 0; i < tranches; i++) {
      const isLast = i === tranches - 1;
      const amount = isLast
        ? (totalAmount - trancheAmount * (tranches - 1)).toFixed(8)
        : trancheAmount.toFixed(8);

      const result = await this.executeSingleTrade(
        { ...req, amountIn: amount },
        slippageBps,
      );

      if (!result.success) {
        hasFailure = true;
        this.logger.error(`Tranche ${i + 1}/${tranches} échouée, arrêt du split`);
        break;
      }

      totalAmountOut += parseFloat(result.amountOut);
      totalGas += parseFloat(result.gasPaid);
      lastTxHash = result.txHash;
      lastTradeId = result.tradeId || '';

      // Délai entre tranches (sauf la dernière)
      if (!isLast && tranches > 1) {
        await new Promise((r) => setTimeout(r, SPLIT_TRANCHE_DELAY_MS));
      }
    }

    return {
      success: !hasFailure,
      tradeId: lastTradeId,
      amountIn: req.amountIn,
      amountOut: totalAmountOut.toString(),
      effectivePrice: totalAmountOut > 0
        ? (totalAmount / totalAmountOut).toString()
        : '0',
      gasPaid: totalGas.toString(),
      txHash: lastTxHash,
      status: hasFailure ? 'partial' : (this.blockchain.getIsDryRun() ? 'simulated' : 'completed'),
      error: hasFailure ? 'Split trade partiellement échoué' : undefined,
    };
  }

  /**
   * Vente manuelle d'urgence (endpoint POST /api/sell)
   */
  async manualSell(
    token: string,
    amount: string | 'all',
    slippageBps: number,
  ): Promise<TradeResult> {
    let sellAmount: string;

    if (amount === 'all') {
      const { formatted } = await this.blockchain.getBalance(token);
      sellAmount = formatted;
    } else {
      // Vérifier que le montant ne dépasse pas le solde
      const { balance, formatted } = await this.blockchain.getBalance(token);
      const tokenInfo = this.blockchain.getTokenInfo(token);
      const requestedWei = BigInt(Math.floor(parseFloat(amount) * 10 ** tokenInfo.decimals));

      if (requestedWei > balance) {
        // Tolérance d'arrondi
        const diff = requestedWei - balance;
        const tolerance = BigInt(10 ** Math.max(0, tokenInfo.decimals - 4));
        if (diff <= tolerance) {
          this.logger.warn(
            `Plafonnement au solde exact : demandé ${amount} > solde ${formatted} (arrondi flottant)`,
          );
          sellAmount = formatted;
        } else {
          throw new Error(
            `Solde insuffisant : demandé ${amount} ${token}, disponible ${formatted}`,
          );
        }
      } else {
        sellAmount = amount;
      }
    }

    if (parseFloat(sellAmount) <= 0) {
      throw new Error(`Rien à vendre pour ${token} (solde = 0)`);
    }

    return this.executeTrade({
      source: 'manual',
      sourceToken: token,
      targetToken: 'USDC',
      amountIn: sellAmount,
      side: 'sell',
      slippageBps,
    });
  }
}
