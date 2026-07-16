import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import { rsi, bollingerBands } from '../indicators';
import {
  CHAIN, MAX_TRADE_SIZE_MR, MAX_EXPOSURE_PER_TOKEN, MAX_TOTAL_EXPOSURE_MR,
} from '../constants';

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
            tokens: 'ARB,PENDLE,GMX',
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
        this.logger.log('MR config créée : ARB/PENDLE/GMX, budget $1000, BB 20/2.5, RSI 25/75, SL 6%, TP 8%');
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
      const tokens = cfg.tokens.split(',').map((t: string) => t.trim().toUpperCase());
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

    if (!longSignal) {
      return { token, action: 'hold', rsi: rsiVal, price: currentPrice };
    }

    // Coupling surchauffe → mult=0 → coupe les entrées MR.
    if (couplingMult <= 0) {
      return { token, action: 'skip', reason: 'coupling_surchauffe' };
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

    // Calculer la taille du trade
    let sizeUsd = Math.min(
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
    // Re-plafonnement dur après boost coupling (aucune borne ne peut être dépassée).
    sizeUsd = Math.min(sizeUsd, MAX_TRADE_SIZE_MR);

    sizeUsd = Math.floor(sizeUsd * 100) / 100;
    if (sizeUsd < 5) {
      return { token, action: 'skip', reason: 'taille trop faible' };
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
      const stopLoss = currentPrice * (1 - cfg.stop_loss_pct / 100);
      const takeProfit = currentPrice * (1 + cfg.take_profit_pct / 100);

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

    return {
      enabled: this.enabled,
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
