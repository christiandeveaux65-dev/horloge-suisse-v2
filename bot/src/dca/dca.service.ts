import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import {
  DCA_BASE_AMOUNT_USD, DCA_MAX_PER_TRADE_USD, DCA_MIN_LEG_USD, DCA_BASKET, CHAIN,
} from '../constants';

/**
 * DCA Smart — Achats récurrents diversifiés avec USDC.
 * Optimisé Phase 1 (juillet 2026) : ~$7/cycle toutes les 3 h (~8 cycles/jour).
 * Phase finale : panier DIVERSIFIÉ (reco analyste) — WETH 50 %, WBTC 30 %, ARB 20 %.
 * Le montant total du cycle est réparti selon ces poids ; chaque jambe (leg) respecte
 * un plancher intouchable de $0.50 (DCA_MIN_LEG_USD). Fréquence 3 h inchangée.
 * L'ancien réglage ($0.50 toutes les 15 min, ~96/jour) était non rentable car le gas
 * (~$0.10-0.30/tx) dépassait souvent le gain. Modulation par coupling (régime de marché).
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

  /** Cron DCA : toutes les 3 heures (~8 achats/jour) */
  @Cron('0 0 */3 * * *', { timeZone: 'Europe/Paris', name: 'dca' })
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    if (!(await acquireCronRun(this.prisma, 'dca', 10800000))) return;
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
          amount_per_buy: String(DCA_BASE_AMOUNT_USD),
          frequency: '3h',
          slippage_bps: 50,
          max_per_trade: String(DCA_MAX_PER_TRADE_USD),
          smart_dca: true,
          active: true,
        },
      });
    } else if (strategy.frequency !== '3h' || parseFloat(strategy.max_per_trade) < DCA_MAX_PER_TRADE_USD) {
      // Normalisation : mettre à jour une stratégie existante encore sur l'ancien réglage.
      strategy = await this.prisma.strategy.update({
        where: { id: strategy.id },
        data: {
          frequency: '3h',
          amount_per_buy: String(DCA_BASE_AMOUNT_USD),
          max_per_trade: String(DCA_MAX_PER_TRADE_USD),
        },
      });
      this.logger.log(`DCA : stratégie normalisée (achat ~$${DCA_BASE_AMOUNT_USD}, plafond $${DCA_MAX_PER_TRADE_USD}, fréquence 3h)`);
    }

    // Calculer le montant de base
    let buyAmount = DCA_BASE_AMOUNT_USD; // ~$7

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

    // 4. Plafonnement max_per_trade (borne dure $10 via constante)
    const maxPerTrade = Math.min(
      DCA_MAX_PER_TRADE_USD,
      parseFloat(strategy.max_per_trade) || DCA_MAX_PER_TRADE_USD,
    );
    if (buyAmount > maxPerTrade) buyAmount = maxPerTrade;

    // 5. Normalisation au centime
    buyAmount = Math.floor(buyAmount * 100) / 100;

    if (buyAmount < DCA_MIN_LEG_USD) {
      this.logger.warn(`DCA : montant total trop faible ($${buyAmount} < $${DCA_MIN_LEG_USD}), skip`);
      return { success: false, reason: 'montant_trop_faible', amount: buyAmount };
    }

    // ─── Répartition sur le panier diversifié (WETH 50 %, WBTC 30 %, ARB 20 %) ───
    // Les jambes sous le plancher $0.50 sont ignorées, et leur poids est redistribué
    // aux jambes retenues afin de dépenser le montant total prévu.
    const eligible = DCA_BASKET.filter((b) => buyAmount * b.weight >= DCA_MIN_LEG_USD);
    if (eligible.length === 0) {
      // Aucune jambe ne passe le plancher → tout sur la première (WETH) si possible.
      eligible.push(DCA_BASKET[0]);
    }
    const totalWeight = eligible.reduce((s, b) => s + b.weight, 0);

    const legResults: any[] = [];
    let anySuccess = false;
    let spent = 0;

    for (const leg of eligible) {
      let legAmount = (buyAmount * leg.weight) / totalWeight;
      legAmount = Math.floor(legAmount * 100) / 100;

      if (legAmount < DCA_MIN_LEG_USD) {
        legResults.push({ token: leg.token, action: 'skip', reason: 'leg_sous_plancher', legAmount });
        continue;
      }

      const result = await this.tradeExecution.executeTrade({
        source: 'dca',
        sourceToken: 'USDC',
        targetToken: leg.token,
        amountIn: legAmount.toFixed(2),
        side: 'buy',
        slippageBps: strategy.slippage_bps,
        strategyId: strategy.id,
      });

      if (result.success) { anySuccess = true; spent += legAmount; }
      this.logger.log(
        `DCA ${result.success ? '✅' : '❌'} : $${legAmount} USDC → ${result.amountOut} ${leg.token} ` +
        `(poids ${(leg.weight * 100).toFixed(0)}%, coupling ×${couplingMult.toFixed(2)})`,
      );
      legResults.push({ token: leg.token, weightPct: leg.weight * 100, legAmount, result });
    }

    return {
      success: anySuccess,
      totalAmount: buyAmount,
      spent: Math.round(spent * 100) / 100,
      couplingMultiplier: couplingMult,
      basket: DCA_BASKET.map((b) => ({ token: b.token, weightPct: b.weight * 100 })),
      legs: legResults,
    };
  }

  /** Smart DCA : ajuste le montant selon les trades récents.
   *  Ancré sur un seul token (WETH) pour éviter de mélanger des prix hétérogènes
   *  (WETH ~$1900, WBTC ~$65000, ARB ~$0.09) qui fausseraient le ratio. */
  private async applySmartDca(strategyId: string, baseAmount: number): Promise<number> {
    const recentTrades = await this.prisma.trade.findMany({
      where: {
        strategy_id: strategyId,
        source: 'dca',
        target_token: 'WETH',
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
      minLegUsd: DCA_MIN_LEG_USD,
      frequency: '3h',
      diversified: true,
      basket: DCA_BASKET.map((b) => ({ token: b.token, weightPct: b.weight * 100 })),
    };
  }
}
