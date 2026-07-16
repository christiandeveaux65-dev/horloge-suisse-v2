import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import {
  ARB_MIN_SPREAD_BPS, ARB_MAX_SPREAD_BPS, ARB_MAX_TRADE_USD,
} from '../constants';

/**
 * Arbitrage DEX — détecte une divergence entre le prix exécutable on-chain (quote Uniswap)
 * et le prix de référence KuCoin. Exécute uniquement si l'écart couvre gas+slippage
 * (>= 50 bps) et reste < 500 bps (au-delà = anomalie rejetée).
 * Montant max par arbitrage : $500 (hardcodé). Cron toutes les 2 minutes.
 */
@Injectable()
export class ArbitrageService {
  private readonly logger = new Logger(ArbitrageService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tradeExecution: TradeExecutionService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  @Cron('0 */2 * * * *')
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle arbitrage échoué: ${err.message}`);
    }
  }

  private async ensureConfig(): Promise<any> {
    let cfg = await this.prisma.arbitrage_config.findFirst();
    if (!cfg) {
      cfg = await this.prisma.arbitrage_config.create({
        data: {
          name: 'Arbitrage DEX',
          tokens: 'WETH,WBTC,ARB',
          min_spread_bps: ARB_MIN_SPREAD_BPS,
          max_amount_per_arb: String(ARB_MAX_TRADE_USD),
          active: true,
          paused: false,
        },
      });
      this.logger.log(`Config arbitrage initialisée (spread ${ARB_MIN_SPREAD_BPS}-${ARB_MAX_SPREAD_BPS} bps, max $${ARB_MAX_TRADE_USD})`);
    }
    return cfg;
  }

  async executeCycle(): Promise<any> {
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      return { success: false, reason: 'pause_globale' };
    }

    const cfg = await this.ensureConfig();
    if (!cfg.active || cfg.paused) {
      return { success: false, reason: 'config_inactive' };
    }

    const tokens = cfg.tokens.split(',').map((t: string) => t.trim().toUpperCase());
    const results: any[] = [];

    for (const token of tokens) {
      try {
        results.push(await this.scanToken(cfg, token));
      } catch (err: any) {
        results.push({ token, error: err.message });
      }
    }

    return { success: true, results };
  }

  /**
   * Détecte une divergence entre le prix exécutable on-chain (quote Uniswap) et le prix
   * de référence KuCoin. Si le token est sous-évalué sur le DEX (DEX < référence) d'un
   * écart >= seuil, on achète (réversion attendue). L'écart doit rester < 500 bps.
   * Chaque leg passe par TradeExecutionService → tout swap est journalisé.
   */
  private async scanToken(cfg: any, token: string): Promise<any> {
    const refPrice = await this.priceService.getPrice(token);
    if (!refPrice || refPrice <= 0) {
      return { token, action: 'skip', reason: 'prix_reference_indisponible' };
    }

    let dexPrice = 0;
    try {
      const q = await this.blockchain.getQuote(token, 'USDC', '1');
      dexPrice = parseFloat(q.amountOut);
    } catch (err: any) {
      return { token, action: 'skip', reason: 'quote_onchain_indisponible', detail: err.message };
    }
    if (dexPrice <= 0) {
      return { token, action: 'skip', reason: 'quote_onchain_nulle' };
    }

    // Écart signé : positif = DEX plus cher que la référence, négatif = DEX moins cher.
    const spreadBps = Math.round(((dexPrice - refPrice) / refPrice) * 10000);
    const absSpread = Math.abs(spreadBps);

    if (absSpread < ARB_MIN_SPREAD_BPS) {
      return { token, action: 'skip', reason: 'spread_insuffisant', spreadBps };
    }
    if (absSpread > ARB_MAX_SPREAD_BPS) {
      this.logger.warn(`⚠️ Spread anormal ${token}: ${spreadBps} bps — rejet (anomalie)`);
      return { token, action: 'reject', reason: 'spread_anormal', spreadBps };
    }

    const tradeUsd = Math.min(ARB_MAX_TRADE_USD, parseFloat(cfg.max_amount_per_arb));
    const profitEstimate = (tradeUsd * absSpread) / 10000;

    // Estimation coût gas Arbitrum (2 swaps buy+sell)
    const gasCostUsd = 0.30;
    const netProfit = profitEstimate - gasCostUsd;
    if (netProfit <= 0) {
      this.logger.log(`Arbitrage ${token}: spread ${absSpread} bps mais profit net $${netProfit.toFixed(2)} <= 0 (gas $${gasCostUsd}) — skip`);
      return { token, action: 'skip', reason: 'profit_net_negatif', spreadBps, profitEstimate, gasCostUsd, netProfit };
    }

    const dexCheaper = dexPrice < refPrice;

    const opp = await this.prisma.arbitrage_opportunity.create({
      data: {
        config_id: cfg.id,
        token,
        dex_buy: dexCheaper ? 'uniswap' : 'kucoin-ref',
        dex_sell: dexCheaper ? 'kucoin-ref' : 'uniswap',
        price_buy: Math.min(dexPrice, refPrice).toString(),
        price_sell: Math.max(dexPrice, refPrice).toString(),
        spread_bps: absSpread,
        profit_estimate: profitEstimate.toFixed(2),
        status: 'detected',
      },
    });

    // On n'exécute que le cas où le token est sous-évalué sur le DEX (achat spot possible).
    if (!dexCheaper) {
      await this.prisma.arbitrage_opportunity.update({
        where: { id: opp.id }, data: { status: 'expired', executed_at: new Date() },
      });
      return { token, action: 'skip', reason: 'dex_surevalue_non_executable', spreadBps };
    }

    const buyLeg = await this.tradeExecution.executeTrade({
      source: 'arbitrage',
      sourceToken: 'USDC',
      targetToken: token,
      amountIn: tradeUsd.toFixed(2),
      side: 'buy',
    });
    let sellLeg: any = null;
    if (buyLeg.success && parseFloat(buyLeg.amountOut) > 0) {
      sellLeg = await this.tradeExecution.executeTrade({
        source: 'arbitrage',
        sourceToken: token,
        targetToken: 'USDC',
        amountIn: parseFloat(buyLeg.amountOut).toFixed(8),
        side: 'sell',
      });
    }

    await this.prisma.arbitrage_opportunity.update({
      where: { id: opp.id },
      data: {
        status: sellLeg?.success ? 'executed' : 'expired',
        tx_hash: sellLeg?.txHash ?? buyLeg.txHash ?? '',
        executed_at: new Date(),
      },
    });

    this.logger.log(`Arbitrage ${token}: écart ${absSpread} bps (DEX ${dexPrice} / ref ${refPrice}), profit estimé $${profitEstimate.toFixed(2)}`);
    return { token, action: 'arbitrage', spreadBps, dexPrice, refPrice, profitEstimate, buyLeg, sellLeg };
  }

  async getStatus(): Promise<any> {
    const cfg = await this.prisma.arbitrage_config.findFirst();
    const recent = await this.prisma.arbitrage_opportunity.findMany({
      orderBy: { detected_at: 'desc' }, take: 20,
    });
    return {
      enabled: this.enabled,
      schedule: '0 */2 * * * * (toutes les 2 min)',
      minSpreadBps: ARB_MIN_SPREAD_BPS,
      maxSpreadBps: ARB_MAX_SPREAD_BPS,
      maxTradeUsd: ARB_MAX_TRADE_USD,
      config: cfg,
      recentOpportunities: recent,
    };
  }
}
