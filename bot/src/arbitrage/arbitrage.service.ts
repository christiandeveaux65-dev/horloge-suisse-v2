import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import {
  ARB_MIN_SPREAD_BPS, ARB_MAX_SPREAD_BPS, ARB_MAX_TRADE_USD,
  ARB_MIN_NET_PROFIT_USD, ARB_MIN_NET_MARGIN_PCT, ATR_ARB_MARGIN_MULT,
} from '../constants';
import { getStrategyModulation } from '../common/strategy-modulation';
import { estimateRoundTripCost } from '../common/profitability';
import { atrPct } from '../indicators';

/**
 * Arbitrage DEX — détecte une divergence entre le prix exécutable on-chain (quote Uniswap)
 * et le prix de référence KuCoin. Exécute uniquement si l'écart couvre gas+slippage
 * (>= 50 bps) et reste < 500 bps (au-delà = anomalie rejetée).
 * Montant max par arbitrage : $200 (conservateur). Cron toutes les 5 minutes.
 *
 * ✅ RÉACTIVÉ (Phase finale — juillet 2026) avec des paramètres PRUDENTS suite aux
 * recommandations de l'analyste : spread min relevé à 100 bps (au lieu de 50), ticket
 * réduit à $200 (au lieu de $500), fréquence ralentie à 5 min (au lieu de 2 min).
 * Le profit net après gas est systématiquement vérifié avant toute exécution ; seules
 * les opportunités réellement rentables (token sous-évalué sur le DEX) sont exécutées.
 */
@Injectable()
export class ArbitrageService implements OnModuleInit {
  private readonly logger = new Logger(ArbitrageService.name);
  // Réactivé (Phase finale) avec paramètres conservateurs.
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tradeExecution: TradeExecutionService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /** Phase finale : réactive la config arbitrage avec des paramètres conservateurs. */
  async onModuleInit(): Promise<void> {
    try {
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
        this.logger.log('Arbitrage RÉACTIVÉ : config créée (conservatrice)');
      } else {
        // Config déjà présente : on NE réécrit PAS ses paramètres au démarrage afin
        // de respecter tout réglage manuel (spread, ticket, active/paused) persisté en
        // DB. La normalisation conservatrice ne s'applique qu'à la création initiale.
        this.logger.log(
          `Arbitrage : config existante conservée (spread min ${cfg.min_spread_bps} bps, ` +
            `ticket max $${cfg.max_amount_per_arb}, active=${cfg.active}, paused=${cfg.paused})`,
        );
      }
    } catch (err: any) {
      this.logger.error(`Impossible de réactiver l'arbitrage: ${err.message}`);
    }
  }

  /** Appelé séquentiellement par le PipelineOrchestrator (plus de @Cron individuel). */
  async tick(): Promise<any> {
    if (!this.enabled) return { skipped: true, reason: 'disabled' };
    try {
      return await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle arbitrage échoué: ${err.message}`);
      return { error: err.message };
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
          active: false,
          paused: true,
        },
      });
      this.logger.log(`Config arbitrage initialisée (spread ${ARB_MIN_SPREAD_BPS}-${ARB_MAX_SPREAD_BPS} bps, max $${ARB_MAX_TRADE_USD})`);
    }
    return cfg;
  }

  async executeCycle(): Promise<any> {
    // Garde-fou : module arrêté (Phase 1). Bloque aussi l'exécution manuelle.
    if (!this.enabled) {
      return { success: false, reason: 'module_desactive' };
    }

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

    // Pilotage adaptatif (Strategist × Strategy Evaluator).
    const modulation = await getStrategyModulation(this.prisma, 'arbitrage');
    if (!modulation.active) {
      return { token, action: 'skip', reason: 'directive_inactive', modulation: modulation.reason };
    }

    // Taille de ticket réelle (ex. ~$200). On cote CETTE taille en unités de token
    // plutôt que « 1 token entier » : coter 1 WBTC (~$65 000) sur un pool Arbitrum peu
    // profond génère un impact de prix massif (~-640 bps) interprété à tort comme une
    // anomalie. En cotant le notionnel réel, l'écart reflète l'exécution réelle.
    let tradeUsd = Math.min(ARB_MAX_TRADE_USD, parseFloat(cfg.max_amount_per_arb));
    // Facteur de taille Strategist × allocation Evaluator, borné par le plafond dur.
    if (modulation.sizeFactor !== 1) {
      tradeUsd = Math.min(ARB_MAX_TRADE_USD, tradeUsd * modulation.sizeFactor);
    }
    const tokenQty = tradeUsd / refPrice; // quantité de token pour ~tradeUsd
    if (!(tokenQty > 0) || !Number.isFinite(tokenQty)) {
      return { token, action: 'skip', reason: 'quantite_invalide' };
    }

    let dexPrice = 0;
    try {
      // Vend tokenQty token → USDC ; prix effectif = USDC reçus / tokenQty.
      const q = await this.blockchain.getQuote(token, 'USDC', tokenQty.toFixed(8));
      const outUsdc = parseFloat(q.amountOut);
      if (outUsdc > 0) dexPrice = outUsdc / tokenQty;
    } catch (err: any) {
      return { token, action: 'skip', reason: 'quote_onchain_indisponible', detail: err.message };
    }
    if (dexPrice <= 0) {
      return { token, action: 'skip', reason: 'quote_onchain_nulle' };
    }

    // Écart signé : positif = DEX plus cher que la référence, négatif = DEX moins cher.
    const spreadBps = Math.round(((dexPrice - refPrice) / refPrice) * 10000);
    const absSpread = Math.abs(spreadBps);

    // Seuil de spread effectif : plancher dur ARB_MIN_SPREAD_BPS (250 bps) même si une
    // ancienne config persistée en DB porte une valeur plus basse (100 bps).
    const effMinSpread = Math.max(Number(cfg.min_spread_bps) || 0, ARB_MIN_SPREAD_BPS);
    if (absSpread < effMinSpread) {
      return { token, action: 'skip', reason: 'spread_insuffisant', spreadBps, effMinSpread };
    }
    if (absSpread > ARB_MAX_SPREAD_BPS) {
      this.logger.warn(`⚠️ Spread anormal ${token}: ${spreadBps} bps — rejet (anomalie)`);
      return { token, action: 'reject', reason: 'spread_anormal', spreadBps };
    }

    const profitEstimate = (tradeUsd * absSpread) / 10000;
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

    // Coût RÉALISTE de l'aller-retour : frais de pool (0.3 %) + slippage (0.1 %) sur
    // CHAQUE jambe (achat + vente) + gas des 2 swaps. L'ancien calcul ne retirait que le
    // gas ($0.30) et surestimait donc massivement le profit (cause du ratio 0.008).
    const rtCost = estimateRoundTripCost(tradeUsd, 0);
    const gasCostUsd = rtCost.costUsd; // friction + gas, tout compris
    const netProfit = profitEstimate - gasCostUsd;
    const netMarginPct = tradeUsd > 0 ? (netProfit / tradeUsd) * 100 : 0;

    // Garde-fou ATR (volatilité réelle) : en marché agité, on exige une marge nette
    // proportionnellement plus grande pour couvrir le risque d'exécution/slippage.
    // Seuil de marge dynamique = max(seuil fixe, ATR% × multiplicateur).
    let series: number[] = [];
    try {
      series = await this.priceService.getPriceSeries(token, 100);
    } catch {
      /* série indisponible : on retombe sur le seuil fixe */
    }
    const tokenAtrPct = atrPct(series) ?? 0;
    const dynMarginPct = Math.max(ARB_MIN_NET_MARGIN_PCT, tokenAtrPct * ATR_ARB_MARGIN_MULT);

    // Double gate : profit net absolu ET marge nette dynamique (ATR) doivent être atteints,
    // pour viser un gain/loss ratio >= 1.5 (ne garder que les vraies occasions).
    if (netProfit < ARB_MIN_NET_PROFIT_USD || netMarginPct < dynMarginPct) {
      this.logger.log(
        `[RENTABILITÉ] Arbitrage ${token} REFUSÉ : spread ${absSpread} bps, profit brut $${profitEstimate.toFixed(2)} ` +
        `- coût $${gasCostUsd.toFixed(2)} (frais+slippage+gas) = net $${netProfit.toFixed(2)} (${netMarginPct.toFixed(2)}%) ` +
        `< seuils min $${ARB_MIN_NET_PROFIT_USD} / ${dynMarginPct.toFixed(2)}% (ATR ${tokenAtrPct.toFixed(2)}%)`,
      );
      await this.prisma.arbitrage_opportunity.update({ where: { id: opp.id }, data: { status: 'expired' } });
      return { token, action: 'skip', reason: 'profit_net_insuffisant', spreadBps, profitEstimate, gasCostUsd, netProfit, netMarginPct: Number(netMarginPct.toFixed(2)), dynMarginPct: Number(dynMarginPct.toFixed(2)), atrPct: Number(tokenAtrPct.toFixed(2)) };
    }

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

    this.logger.log(`Arbitrage ${token}: écart ${absSpread} bps (DEX ${dexPrice} / ref ${refPrice}), profit brut $${profitEstimate.toFixed(2)} - gas $${gasCostUsd.toFixed(2)} = net $${netProfit.toFixed(2)} → EXÉCUTÉ`);
    return { token, action: 'arbitrage', spreadBps, dexPrice, refPrice, profitEstimate, gasCostUsd, netProfit, buyLeg, sellLeg };
  }

  async getStatus(): Promise<any> {
    const cfg = await this.prisma.arbitrage_config.findFirst();
    const recent = await this.prisma.arbitrage_opportunity.findMany({
      orderBy: { detected_at: 'desc' }, take: 20,
    });
    return {
      enabled: this.enabled,
      schedule: '0 */5 * * * * (toutes les 5 min)',
      minSpreadBps: ARB_MIN_SPREAD_BPS,
      maxSpreadBps: ARB_MAX_SPREAD_BPS,
      maxTradeUsd: ARB_MAX_TRADE_USD,
      profitability: {
        min_net_profit_usd: ARB_MIN_NET_PROFIT_USD,
        min_net_margin_pct: ARB_MIN_NET_MARGIN_PCT,
        round_trip_cost_pct_estimate: Number(estimateRoundTripCost(ARB_MAX_TRADE_USD, 0).costPct.toFixed(3)),
        note: "Un arbitrage n'est exécuté que si le profit NET (après frais de pool + slippage + gas) dépasse le seuil absolu ET la marge minimale, pour viser un gain/loss ratio >= 1.5.",
      },
      config: cfg,
      recentOpportunities: recent,
    };
  }
}
