import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import { DCA_BASE_AMOUNT_USD, CHAIN } from '../constants';

/**
 * DCA Smart — Micro-achats récurrents de WETH avec USDC
 * ~$0.50/achat toutes les 15 min (~96 achats/jour, ~$48-50/jour)
 * Modulation par coupling (régime de marché)
 */
@Injectable()
export class DcaService {
  private readonly logger = new Logger(DcaService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tradeExecution: TradeExecutionService,
    private readonly priceService: PriceService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /** Cron DCA : toutes les 15 minutes */
  @Cron('0 */15 * * * *')
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle DCA échoué: ${err.message}`);
    }
  }

  /** Exécuter un cycle DCA */
  async executeCycle(): Promise<any> {
    // Vérifier pause globale
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      this.logger.warn('DCA skipé : pause globale active');
      return { success: false, reason: 'pause_globale' };
    }

    // Récupérer la stratégie DCA
    let strategy = await this.prisma.strategy.findFirst({
      where: { active: true, paused: false, source_token: 'USDC', target_token: 'WETH' },
    });
    if (!strategy) {
      // Créer la stratégie par défaut si inexistante
      strategy = await this.prisma.strategy.create({
        data: {
          name: 'DCA Principal',
          source_token: 'USDC',
          target_token: 'WETH',
          chain: CHAIN,
          amount_per_buy: '50',
          frequency: '15min',
          slippage_bps: 50,
          max_per_trade: '5',
          smart_dca: true,
          active: true,
        },
      });
    }

    // Calculer le montant de base
    let buyAmount = DCA_BASE_AMOUNT_USD; // $0.50

    // 1. Smart DCA : ajustement basé sur les trades récents
    if (strategy.smart_dca) {
      buyAmount = await this.applySmartDca(strategy.id, buyAmount);
    }

    // 2. Coupling : multiplicateur régime de marché
    const couplingMult = await this.getCouplingMultiplier();
    if (couplingMult !== 1) {
      buyAmount = buyAmount * couplingMult;
    }

    // 3. Recovery : facteur de réduction si drawdown modéré
    if (riskCfg?.recovery_mode) {
      const recoveryFactor = parseFloat(riskCfg.recovery_factor) || 0.5;
      buyAmount = buyAmount * recoveryFactor;
    }

    // 4. Plafonnement max_per_trade
    const maxPerTrade = parseFloat(strategy.max_per_trade);
    if (buyAmount > maxPerTrade) buyAmount = maxPerTrade;

    // 5. Normalisation au centime
    buyAmount = Math.floor(buyAmount * 100) / 100;

    if (buyAmount < 0.01) {
      this.logger.warn(`DCA : montant trop faible ($${buyAmount}), skip`);
      return { success: false, reason: 'montant_trop_faible', amount: buyAmount };
    }

    // Exécuter le trade via TradeExecutionService
    const result = await this.tradeExecution.executeTrade({
      source: 'dca',
      sourceToken: 'USDC',
      targetToken: 'WETH',
      amountIn: buyAmount.toFixed(2),
      side: 'buy',
      slippageBps: strategy.slippage_bps,
      strategyId: strategy.id,
    });

    this.logger.log(
      `DCA ${result.success ? '✅' : '❌'} : $${buyAmount} USDC → ${result.amountOut} WETH (coupling: ×${couplingMult.toFixed(2)})`,
    );

    return {
      success: result.success,
      amount: buyAmount,
      couplingMultiplier: couplingMult,
      tradeResult: result,
    };
  }

  /** Smart DCA : ajuste le montant selon les trades récents */
  private async applySmartDca(strategyId: string, baseAmount: number): Promise<number> {
    const recentTrades = await this.prisma.trade.findMany({
      where: {
        strategy_id: strategyId,
        status: { in: ['completed', 'simulated'] },
      },
      orderBy: { executed_at: 'desc' },
      take: 7,
    });

    if (recentTrades.length < 3) return baseAmount;

    // Calculer le ratio prix moyen récent vs premier prix
    const prices = recentTrades.map((t) => parseFloat(t.price)).filter((p) => p > 0);
    if (prices.length < 2) return baseAmount;

    const avgRecent = prices.slice(0, 3).reduce((s, v) => s + v, 0) / 3;
    const avgOlder = prices.slice(-3).reduce((s, v) => s + v, 0) / Math.min(3, prices.slice(-3).length);

    if (avgOlder === 0) return baseAmount;

    // Si prix baisse → acheter plus, si prix monte → acheter moins
    const ratio = avgOlder / avgRecent;
    const multiplier = Math.max(0.5, Math.min(2.0, ratio));

    return baseAmount * multiplier;
  }

  /** Récupérer le multiplicateur DCA du coupling */
  private async getCouplingMultiplier(): Promise<number> {
    const decision = await this.prisma.coupling_decision.findFirst({
      where: { kind: 'dca_modulation' },
      orderBy: { created_at: 'desc' },
    });

    if (!decision) return 1;

    try {
      const payload = JSON.parse(decision.payload);
      const mult = parseFloat(payload.multiplier);
      if (Number.isFinite(mult) && mult >= 0.3 && mult <= 1.8) {
        return mult;
      }
    } catch {}

    return 1;
  }

  async getStatus(): Promise<any> {
    const strategy = await this.prisma.strategy.findFirst({
      where: { source_token: 'USDC', target_token: 'WETH' },
    });
    const lastTrade = await this.prisma.trade.findFirst({
      where: { source: 'dca' },
      orderBy: { executed_at: 'desc' },
    });
    const todayTrades = await this.prisma.trade.count({
      where: {
        source: 'dca',
        status: { in: ['completed', 'simulated'] },
        executed_at: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    });

    return {
      enabled: this.enabled,
      strategy,
      lastTrade,
      todayTradeCount: todayTrades,
      baseAmount: DCA_BASE_AMOUNT_USD,
    };
  }
}
