import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import { rsi, bollingerBands } from '../indicators';
import {
  CHAIN, MAX_TRADE_SIZE_MR, MAX_EXPOSURE_PER_TOKEN, MAX_TOTAL_EXPOSURE_MR, MR_ALLOWED_TOKENS,
  SHORT_RSI_THRESHOLD, SHORT_ALLOWED_TOKENS,
} from '../constants';
import { getStrategyModulation } from '../common/strategy-modulation';
import { estimateRoundTripCost, getMinProfitPct, passesProfitability } from '../common/profitability';
import { computeAtrStops } from '../common/dynamic-stops';
import { GmxService } from '../gmx/gmx.service';

/**
 * Mean Reversion — RSI(14) + Bollinger Bands
 * Achat si RSI < 30 ET prix sous bande inférieure
 * Vente si RSI > 70
 * LIMITES HARDCODÉES (Phase 2) : $100/trade, $400/token, $1000 total.
 */
@Injectable()
export class MeanReversionService implements OnModuleInit {
  private readonly logger = new Logger(MeanReversionService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tradeExecution: TradeExecutionService,
    private readonly priceService: PriceService,
    private readonly gmx: GmxService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /**
   * Phase 2 : crée la config Mean Reversion par défaut si absente.
   * ARB/PENDLE/GMX, budget $1000, BB 20/2.5, RSI 25/75, SL 6%, TP 8%.
   */
  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.prisma.mean_reversion_config.findFirst({ where: { name: 'Mean Reversion Principal' } });
      if (!existing) {
        await this.prisma.mean_reversion_config.create({
          data: {
            name: 'Mean Reversion Principal',
            chain: CHAIN,
            tokens: MR_ALLOWED_TOKENS.join(','),
            budget_usd: '1000',
            bb_period: 20,
            bb_std_dev: '2.5',
            rsi_period: 14,
            rsi_oversold: 25,
            rsi_overbought: 75,
            stop_loss_pct: 6,
            take_profit_pct: 8,
            active: true,
            paused: false,
          },
        });
        this.logger.log(`MR config créée : ${MR_ALLOWED_TOKENS.join('/')}, budget $1000, BB 20/2.5, RSI 25/75, SL 6%, TP 8%`);
      }
    } catch (err: any) {
      this.logger.error(`MR onModuleInit: ${err.message}`);
    }
  }

  /** Récupère le multiplicateur MR du coupling. 0 = stratégie coupée (surchauffe). */
  private async getCouplingMultiplier(): Promise<number> {
    const decision = await this.prisma.coupling_decision.findFirst({
      where: { kind: 'mean_reversion_modulation' },
      orderBy: { created_at: 'desc' },
    });
    if (!decision) return 1;
    try {
      const payload = JSON.parse(decision.payload);
      const mult = parseFloat(payload.multiplier);
      if (Number.isFinite(mult) && mult >= 0 && mult <= 2) return mult;
    } catch {}
    return 1;
  }

  /** Appelé séquentiellement par le PipelineOrchestrator (plus de @Cron individuel). */
  async tick(): Promise<any> {
    if (!this.enabled) return { skipped: true, reason: 'disabled' };
    try {
      return await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle MR échoué: ${err.message}`);
      return { error: err.message };
    }
  }

  async executeCycle(): Promise<any> {
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      return { success: false, reason: 'pause_globale' };
    }

    // Coupling : mult MR (0 = surchauffe, coupe les entrées ; gestion positions conservée).
    const couplingMult = await this.getCouplingMultiplier();

    const configs = await this.prisma.mean_reversion_config.findMany({
      where: { active: true, paused: false },
    });

    const results: any[] = [];
    for (const cfg of configs) {
      const rawTokens = cfg.tokens.split(',').map((t: string) => t.trim().toUpperCase());
      // Modif 3 : filtre dur — MR restreint aux paires liquides (WETH/WBTC/ARB),
      // même si la config DB persiste d'anciens tokens illiquides (GMX/PENDLE/UNI…).
      const tokens = rawTokens.filter((t: string) => MR_ALLOWED_TOKENS.includes(t));
      const skipped = rawTokens.filter((t: string) => !MR_ALLOWED_TOKENS.includes(t));
      if (skipped.length > 0) {
        this.logger.log(`[LIQUIDITÉ] MR — tokens illiquides ignorés: ${skipped.join(', ')} (autorisés: ${MR_ALLOWED_TOKENS.join(', ')})`);
      }
      for (const token of tokens) {
        try {
          const result = await this.processToken(cfg, token, riskCfg, couplingMult);
          results.push(result);
        } catch (err: any) {
          results.push({ token, error: err.message });
        }
      }
    }

    return { results, couplingMultiplier: couplingMult };
  }

  private async processToken(cfg: any, token: string, riskCfg: any, couplingMult: number = 1): Promise<any> {
    // Série de prix
    const prices = await this.priceService.getPriceSeries(token, 50);
    if (prices.length < cfg.bb_period) {
      return { token, action: 'skip', reason: 'données insuffisantes' };
    }

    const currentPrice = prices[prices.length - 1];
    const rsiVal = rsi(prices, cfg.rsi_period);
    const bands = bollingerBands(prices, cfg.bb_period, parseFloat(cfg.bb_std_dev));

    // Gérer les positions ouvertes
    const openPositions = await this.prisma.mean_reversion_position.findMany({
      where: { config_id: cfg.id, token, status: 'open' },
    });

    for (const pos of openPositions) {
      const stopLoss = parseFloat(pos.stop_loss);
      const takeProfit = parseFloat(pos.take_profit);

      if (currentPrice <= stopLoss) {
        return this.closePosition(cfg, pos, currentPrice, 'stop_loss');
      }
      if (currentPrice >= takeProfit) {
        return this.closePosition(cfg, pos, currentPrice, 'take_profit');
      }
      if (rsiVal > cfg.rsi_overbought) {
        return this.closePosition(cfg, pos, currentPrice, 'rsi_overbought');
      }
    }

    // Signal d'entrée : RSI < oversold ET prix sous bande inférieure
    const longSignal = bands && currentPrice < bands.lower && rsiVal <= cfg.rsi_oversold;
    // Phase 3 : signal SHORT assoupli — « touch » de la bande supérieure (>=, au lieu d'un
    // breakout strict >) ET RSI >= SHORT_RSI_THRESHOLD (65, au lieu de rsi_overbought=75).
    // Le seuil retenu = min(rsi_overbought, 65) pour que les shorts se déclenchent enfin.
    const shortRsiThreshold = Math.min(cfg.rsi_overbought, SHORT_RSI_THRESHOLD);
    const shortEligibleToken = SHORT_ALLOWED_TOKENS.includes(token);
    const shortSignal = !!bands && currentPrice >= bands.upper && rsiVal >= shortRsiThreshold;
    // Traçabilité : on logge l'évaluation des conditions SHORT à CHAQUE cycle (même refus).
    if (bands && shortEligibleToken) {
      this.logger.log(
        `[SHORT-EVAL] MR ${token} : prix $${currentPrice.toFixed(4)} vs BB upper $${bands.upper.toFixed(4)} ` +
        `(${currentPrice >= bands.upper ? 'TOUCHÉ' : 'sous'}), RSI ${rsiVal.toFixed(1)} vs seuil ${shortRsiThreshold} ` +
        `(${rsiVal >= shortRsiThreshold ? 'OK' : 'insuffisant'}) → ${shortSignal ? 'SIGNAL SHORT' : 'pas de short'}`,
      );
    }

    if (shortSignal && shortEligibleToken && couplingMult > 0) {
      const shortRes = await this.gmx.openShortForStrategy({
        source: 'mean_reversion',
        indexToken: token,
        entryPrice: currentPrice,
        reasonNote: `RSI ${rsiVal.toFixed(1)} ≥ ${shortRsiThreshold} + prix ≥ BB upper $${bands.upper.toFixed(4)}`,
      });
      return { token, action: 'short_signal', rsi: rsiVal, price: currentPrice, short: shortRes };
    }

    if (!longSignal) {
      return { token, action: 'hold', rsi: rsiVal, price: currentPrice };
    }

    // Coupling surchauffe → mult=0 → coupe les entrées MR.
    if (couplingMult <= 0) {
      return { token, action: 'skip', reason: 'coupling_surchauffe' };
    }

    // Pilotage adaptatif (Strategist × Strategy Evaluator).
    const modulation = await getStrategyModulation(this.prisma, 'mean_reversion');
    if (!modulation.active) {
      return { token, action: 'skip', reason: 'directive_inactive', modulation: modulation.reason };
    }

    // Vérifier les limites hardcodées
    const totalExposure = await this.getTotalExposure();
    if (totalExposure >= MAX_TOTAL_EXPOSURE_MR) {
      return { token, action: 'skip', reason: `exposition totale MR max ($${MAX_TOTAL_EXPOSURE_MR})` };
    }

    const tokenExposure = await this.getTokenExposure(token);
    if (tokenExposure >= MAX_EXPOSURE_PER_TOKEN) {
      return { token, action: 'skip', reason: `exposition max token ($${MAX_EXPOSURE_PER_TOKEN})` };
    }

    // Calculer la taille du trade — base = trade_size_usd (param optimisé),
    // bornée par le plafond dur et les expositions restantes.
    const desiredSize = parseFloat(cfg.trade_size_usd);
    const baseSize = Number.isFinite(desiredSize) && desiredSize > 0 ? desiredSize : MAX_TRADE_SIZE_MR;
    let sizeUsd = Math.min(
      baseSize,
      MAX_TRADE_SIZE_MR,
      MAX_TOTAL_EXPOSURE_MR - totalExposure,
      MAX_EXPOSURE_PER_TOKEN - tokenExposure,
    );

    // Recovery mode
    if (riskCfg?.recovery_mode) {
      sizeUsd = sizeUsd * (parseFloat(riskCfg.recovery_factor) || 0.5);
    }

    // Coupling boost (capitulation ×1.5). Le plafond dur MAX_TRADE_SIZE_MR est réappliqué ci-dessous.
    if (couplingMult > 0 && couplingMult !== 1) {
      sizeUsd = sizeUsd * couplingMult;
    }

    // Pilotage adaptatif : facteur de taille Strategist × allocation Evaluator.
    if (modulation.sizeFactor !== 1) {
      sizeUsd = sizeUsd * modulation.sizeFactor;
    }
    // Re-plafonnement dur après boost coupling (aucune borne ne peut être dépassée).
    sizeUsd = Math.min(sizeUsd, MAX_TRADE_SIZE_MR);

    sizeUsd = Math.floor(sizeUsd * 100) / 100;
    if (sizeUsd < 5) {
      return { token, action: 'skip', reason: 'taille trop faible' };
    }

    // Filtre de rentabilité minimum : le retour vers la moyenne (bande médiane de
    // Bollinger) doit dépasser le coût de l'aller-retour DEX + marge.
    // Proxy du mouvement attendu = distance de réversion (mid - prix d'entrée).
    if (bands && currentPrice > 0) {
      const expectedMovePct = ((bands.mid - currentPrice) / currentPrice) * 100;
      const minPP = await getMinProfitPct(this.prisma, 'mean_reversion');
      const est = estimateRoundTripCost(sizeUsd, minPP);
      if (!passesProfitability(expectedMovePct, est)) {
        this.logger.log(
          `[RENTABILITÉ] MR ${token} REFUSÉ : réversion attendue ${expectedMovePct.toFixed(2)}% < seuil ${est.breakevenPct.toFixed(2)}% (coût ${est.costPct.toFixed(2)}% + marge ${minPP.toFixed(2)}%)`,
        );
        return {
          token,
          action: 'skip',
          reason: 'rentabilite_insuffisante',
          expectedMovePct: Number(expectedMovePct.toFixed(2)),
          breakevenPct: Number(est.breakevenPct.toFixed(2)),
        };
      }
    }

    // Exécuter l'achat
    const result = await this.tradeExecution.executeTrade({
      source: 'mean_reversion',
      sourceToken: 'USDC',
      targetToken: token,
      amountIn: sizeUsd.toFixed(2),
      side: 'buy',
    });

    if (result.success) {
      // Stops dynamiques basés sur l'ATR (volatilité réelle) ; repli sur les % fixes de
      // la config si l'ATR n'est pas calculable (série trop courte).
      const atrStops = computeAtrStops(prices, currentPrice);
      const stopLoss = atrStops
        ? atrStops.stopLoss
        : currentPrice * (1 - cfg.stop_loss_pct / 100);
      const takeProfit = atrStops
        ? atrStops.takeProfit
        : currentPrice * (1 + cfg.take_profit_pct / 100);
      if (atrStops) {
        this.logger.log(
          `MR ${token} : stops ATR — SL $${stopLoss.toFixed(6)} (-${atrStops.stopPct.toFixed(2)}%) / TP $${takeProfit.toFixed(6)} (+${atrStops.takePct.toFixed(2)}%) (ATR ${atrStops.atrPct.toFixed(2)}%)`,
        );
      }

      await this.prisma.mean_reversion_position.create({
        data: {
          config_id: cfg.id,
          chain: CHAIN,
          token,
          side: 'long',
          entry_price: currentPrice.toString(),
          amount_token: result.amountOut,
          cost_usd: sizeUsd.toFixed(2),
          stop_loss: stopLoss.toString(),
          take_profit: takeProfit.toString(),
        },
      });

      this.logger.log(
        `MR : position ouverte ${token} $${sizeUsd} @ $${currentPrice} (RSI=${rsiVal.toFixed(1)})`,
      );
    }

    return { token, action: 'buy', sizeUsd, rsi: rsiVal, price: currentPrice, result };
  }

  private async closePosition(cfg: any, pos: any, price: number, reason: string): Promise<any> {
    const amount = parseFloat(pos.amount_token);
    if (amount <= 0) return { action: 'skip', reason: 'position_vide' };

    const result = await this.tradeExecution.executeTrade({
      source: 'mean_reversion',
      sourceToken: pos.token,
      targetToken: 'USDC',
      amountIn: amount.toFixed(8),
      side: 'sell',
    });

    const pnl = parseFloat(result.amountOut) - parseFloat(pos.cost_usd);

    await this.prisma.mean_reversion_position.update({
      where: { id: pos.id },
      data: {
        status: 'closed',
        closed_at: new Date(),
        pnl_usd: pnl.toFixed(2),
      },
    });

    this.logger.log(`MR : position fermée ${pos.token} ${reason} @ $${price} PnL=$${pnl.toFixed(2)}`);
    return { token: pos.token, action: reason, price, pnl, result };
  }

  private async getTotalExposure(): Promise<number> {
    const positions = await this.prisma.mean_reversion_position.findMany({
      where: { status: 'open' },
      select: { cost_usd: true },
    });
    return positions.reduce((sum, p) => sum + parseFloat(p.cost_usd), 0);
  }

  private async getTokenExposure(token: string): Promise<number> {
    const positions = await this.prisma.mean_reversion_position.findMany({
      where: { status: 'open', token },
      select: { cost_usd: true },
    });
    return positions.reduce((sum, p) => sum + parseFloat(p.cost_usd), 0);
  }

  async getStatus(): Promise<any> {
    const configs = await this.prisma.mean_reversion_config.findMany({
      include: { positions: { where: { status: 'open' } } },
    });
    const totalExposure = await this.getTotalExposure();
    const minPP = await getMinProfitPct(this.prisma, 'mean_reversion');
    const estRef = estimateRoundTripCost(MAX_TRADE_SIZE_MR, minPP);

    return {
      enabled: this.enabled,
      profitability: {
        min_profit_pct: minPP,
        round_trip_cost_pct_estimate: Number(estRef.costPct.toFixed(3)),
        breakeven_move_pct_estimate: Number(estRef.breakevenPct.toFixed(3)),
        note: 'Une entrée MR n\'a lieu que si la réversion attendue vers la moyenne dépasse le seuil de breakeven. Ajustable via app_config: profitability.mean_reversion.minProfitPct ou profitability.minProfitPct.',
      },
      limits: {
        maxTradeSize: MAX_TRADE_SIZE_MR,
        maxPerToken: MAX_EXPOSURE_PER_TOKEN,
        maxTotal: MAX_TOTAL_EXPOSURE_MR,
      },
      totalExposure,
      configs,
    };
  }
}
