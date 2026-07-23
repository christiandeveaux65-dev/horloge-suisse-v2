import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import {
  DCA_BASE_AMOUNT_USD, DCA_MAX_PER_TRADE_USD, DCA_MIN_LEG_USD, DCA_BASKET, CHAIN,
} from '../constants';
import { getStrategyModulation } from '../common/strategy-modulation';
import { estimateRoundTripCost, getMinProfitPct, passesProfitability } from '../common/profitability';
import { TelegramService } from '../telegram/telegram.service';

/**
 * DCA Smart — Achats récurrents diversifiés avec USDC.
 * Optimisé Phase 1 (juillet 2026) : ~$7/cycle toutes les 3 h (~8 cycles/jour).
 * Panier DIVERSIFIÉ RÉÉQUILIBRÉ (reco analyste) — WETH 25 %, WBTC 30 %, ARB 15 %,
 * LINK 15 %, GMX 15 % (réduction de la surpondération ETH).
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
    private readonly telegram: TelegramService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /** Cron DCA : toutes les 3 heures (~8 achats/jour) */
  /** Appelé séquentiellement par le PipelineOrchestrator (plus de @Cron individuel). */
  async tick(): Promise<any> {
    if (!this.enabled) return { skipped: true, reason: 'disabled' };
    try {
      return await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle DCA échoué: ${err.message}`);
      return { error: err.message };
    }
  }

  /** Exécuter un cycle DCA.
   * @param opts.force  Si vrai, bypasse les gardes de timing (interval_hours) et de
   *   repli (buy_threshold_pct) ainsi que les réductions adaptatives (smart DCA,
   *   coupling, modulation, recovery) pour exécuter immédiatement un cycle au
   *   montant de base plein. La pause globale reste toujours respectée. */
  async executeCycle(opts?: { force?: boolean }): Promise<any> {
    const force = opts?.force === true;
    if (force) this.logger.warn('DCA : cycle FORCÉ (gardes de timing/repli et réductions bypassées)');
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

    // ─── Pilotage adaptatif (Strategy Evaluator) ───
    const modulation = await getStrategyModulation(this.prisma, 'dca');
    if (!modulation.active && !force) {
      this.logger.warn(`DCA skipé : directive inactive (${modulation.reason})`);
      return { success: false, reason: 'directive_inactive', modulation: modulation.reason };
    }

    // ─── Paramètre optimisé : interval_hours (espacement minimum entre achats) ───
    // Le pipeline appelle DCA toutes les 3 h ; si l'optimisation demande un intervalle
    // plus long, on saute tant que le dernier achat est trop récent.
    const intervalHours = strategy.interval_hours || 0;
    if (!force && intervalHours > 3) {
      const lastBuy = await this.prisma.trade.findFirst({
        where: { source: 'dca', status: { in: ['completed', 'simulated'] } },
        orderBy: { executed_at: 'desc' },
        select: { executed_at: true },
      });
      if (lastBuy?.executed_at) {
        const elapsedH = (Date.now() - new Date(lastBuy.executed_at).getTime()) / 3600000;
        if (elapsedH < intervalHours) {
          this.logger.log(`DCA skipé : intervalle ${elapsedH.toFixed(1)}h < ${intervalHours}h (param optimisé)`);
          return { success: false, reason: 'interval_non_atteint', elapsedH: Math.round(elapsedH * 10) / 10, intervalHours };
        }
      }
    }

    // ─── Paramètre optimisé : buy_threshold_pct (n'acheter que sur repli) ───
    // Compatibilité : accepte aussi l'alias `dca_buy_threshold` si présent.
    // Le backtest peut produire un seuil négatif (ex: -5) pour signifier "-5%".
    // En live, on travaille sur un drawdown positif : on normalise donc en valeur absolue.
    const strategyParams = strategy as any;
    const buyThresholdRaw = Number(
      strategyParams.buy_threshold_pct ?? strategyParams.dca_buy_threshold ?? 0,
    );
    const buyThresholdPct = Number.isFinite(buyThresholdRaw) ? Math.abs(buyThresholdRaw) : 0;
    if (!force && buyThresholdPct > 0) {
      const series = await this.priceService.getPriceSeries('WETH', 100);
      if (series.length >= 5) {
        const recentMax = Math.max(...series);
        const current = series[series.length - 1];
        const dropPct = recentMax > 0 ? ((recentMax - current) / recentMax) * 100 : 0;
        if (dropPct < buyThresholdPct) {
          this.logger.log(`DCA skipé : repli ${dropPct.toFixed(2)}% < seuil ${buyThresholdPct}% (param optimisé)`);
          return { success: false, reason: 'seuil_repli_non_atteint', dropPct: Math.round(dropPct * 100) / 100, buyThresholdPct };
        }
      }
    }

    // ─── Paramètre optimisé : amount_per_buy (montant de base du cycle) ───
    // Compatibilité : accepte aussi l'alias `dca_amount_pct` si présent dans la config
    // (pourcentage du montant de base historique DCA_BASE_AMOUNT_USD).
    // Le plafond dur DCA_MAX_PER_TRADE_USD reste appliqué plus bas.
    const amountPerBuyRaw = Number(strategyParams.amount_per_buy);
    const dcaAmountPctRaw = Number(strategyParams.dca_amount_pct);
    const amountFromPct = Number.isFinite(dcaAmountPctRaw) && dcaAmountPctRaw > 0
      ? (DCA_BASE_AMOUNT_USD * dcaAmountPctRaw) / 100
      : NaN;
    const configuredBase = Number.isFinite(amountPerBuyRaw) && amountPerBuyRaw > 0
      ? amountPerBuyRaw
      : amountFromPct;
    let buyAmount =
      Number.isFinite(configuredBase) && configuredBase > 0
        ? Math.min(configuredBase, DCA_MAX_PER_TRADE_USD)
        : DCA_BASE_AMOUNT_USD;

    // Les ajustements ci-dessous (smart DCA, coupling, modulation, recovery) sont
    // bypassés en mode FORCÉ pour tester un cycle plein au montant de base.
    let couplingMult = 1;
    if (!force) {
      // 1. Smart DCA : ajustement basé sur les trades récents
      if (strategy.smart_dca) {
        buyAmount = await this.applySmartDca(strategy.id, buyAmount);
      }

      // 2. Coupling : multiplicateur régime de marché
      couplingMult = await this.getCouplingMultiplier();
      if (couplingMult !== 1) {
        buyAmount = buyAmount * couplingMult;
      }

      // 2bis. Pilotage adaptatif : facteur de taille Strategist × allocation Evaluator
      if (modulation.sizeFactor !== 1) {
        buyAmount = buyAmount * modulation.sizeFactor;
      }

      // 3. Recovery : facteur de réduction si drawdown modéré
      if (riskCfg?.recovery_mode) {
        const recoveryFactor = parseFloat(riskCfg.recovery_factor) || 0.5;
        buyAmount = buyAmount * recoveryFactor;
      }
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

    // Filtre de rentabilité minimum.
    // En mode achat-de-repli (buy_threshold_pct > 0), l'entrée mise sur un rebond au
    // moins égal au repli exigé : le rebond attendu doit couvrir le coût d'un
    // aller-retour DEX + marge. En mode accumulation pur (seuil = 0), le DCA détient
    // sur le long terme (pas d'aller-retour immédiat) → le filtre est ignoré.
    if (buyThresholdPct > 0) {
      const expectedMovePct = buyThresholdPct;
      const minPP = await getMinProfitPct(this.prisma, 'dca');
      const est = estimateRoundTripCost(buyAmount, minPP);
      if (!passesProfitability(expectedMovePct, est)) {
        this.logger.log(
          `[RENTABILITÉ] DCA REFUSÉ : rebond attendu ${expectedMovePct.toFixed(2)}% < seuil ${est.breakevenPct.toFixed(2)}% (coût ${est.costPct.toFixed(2)}% + marge ${minPP.toFixed(2)}%)`,
        );
        return {
          success: false,
          reason: 'rentabilite_insuffisante',
          expectedMovePct: Number(expectedMovePct.toFixed(2)),
          breakevenPct: Number(est.breakevenPct.toFixed(2)),
        };
      }
    } else {
      this.logger.log('DCA : mode accumulation pur (seuil de repli = 0), filtre de rentabilité ignoré');
    }

    // ─── Répartition sur le panier diversifié (WETH 25 %, WBTC 30 %, ARB 15 %, LINK 15 %, GMX 15 %) ───
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
        // On désactive la notif fire-and-forget (file 1 msg/min qui perd les jambes
        // 2..N en prod) et on envoie à la place une notif individuelle awaitée
        // ci-dessous, garantissant qu'un message part pour CHAQUE achat du panier.
        skipNotify: true,
      });

      if (result.success) { anySuccess = true; spent += legAmount; }
      this.logger.log(
        `DCA ${result.success ? '✅' : '❌'} : $${legAmount} USDC → ${result.amountOut} ${leg.token} ` +
        `(poids ${(leg.weight * 100).toFixed(0)}%, coupling ×${couplingMult.toFixed(2)})`,
      );
      // Notification Telegram INDIVIDUELLE et awaitée pour cette jambe (WETH, WBTC,
      // ARB, LINK, GMX) — chaque achat a son propre message, y compris en prod.
      await this.telegram.notifyTradeNow({
        tradeId: result.tradeId,
        source: 'dca',
        side: 'buy',
        sourceToken: 'USDC',
        targetToken: leg.token,
        amountIn: result.amountIn,
        amountOut: result.amountOut,
        status: result.status,
        txHash: result.txHash,
        error: result.error,
      });
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
    const prices = recentTrades.map((t: any) => parseFloat(t.price)).filter((p: any) => p > 0);
    if (prices.length < 2) return baseAmount;

    const avgRecent = prices.slice(0, 3).reduce((s: any, v: any) => s + v, 0) / 3;
    const avgOlder = prices.slice(-3).reduce((s: any, v: any) => s + v, 0) / Math.min(3, prices.slice(-3).length);

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

    const minPP = await getMinProfitPct(this.prisma, 'dca');
    const estRef = estimateRoundTripCost(DCA_BASE_AMOUNT_USD, minPP);
    return {
      enabled: this.enabled,
      strategy,
      lastTrade,
      todayTradeCount: todayTrades,
      profitability: {
        min_profit_pct: minPP,
        round_trip_cost_pct_estimate: Number(estRef.costPct.toFixed(3)),
        breakeven_move_pct_estimate: Number(estRef.breakevenPct.toFixed(3)),
        note: 'En mode achat-de-repli (buy_threshold_pct > 0), le rebond attendu doit dépasser le seuil de breakeven ; en accumulation pure (seuil = 0) le filtre est ignoré. Ajustable via app_config: profitability.dca.minProfitPct ou profitability.minProfitPct.',
      },
      baseAmount: DCA_BASE_AMOUNT_USD,
      minLegUsd: DCA_MIN_LEG_USD,
      frequency: '3h',
      diversified: true,
      basket: DCA_BASKET.map((b) => ({ token: b.token, weightPct: b.weight * 100 })),
    };
  }
}
