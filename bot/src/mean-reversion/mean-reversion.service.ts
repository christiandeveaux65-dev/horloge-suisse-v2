import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
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
 * LIMITES HARDCODÉES : $75/trade, $300/token, $600 total
 */
@Injectable()
export class MeanReversionService {
  private readonly logger = new Logger(MeanReversionService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tradeExecution: TradeExecutionService,
    private readonly priceService: PriceService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  @Cron('0 */10 * * * *')
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle MR échoué: ${err.message}`);
    }
  }

  async executeCycle(): Promise<any> {
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      return { success: false, reason: 'pause_globale' };
    }

    const configs = await this.prisma.mean_reversion_config.findMany({
      where: { active: true, paused: false },
    });

    const results: any[] = [];
    for (const cfg of configs) {
      const tokens = cfg.tokens.split(',').map((t: string) => t.trim().toUpperCase());
      for (const token of tokens) {
        try {
          const result = await this.processToken(cfg, token, riskCfg);
          results.push(result);
        } catch (err: any) {
          results.push({ token, error: err.message });
        }
      }
    }

    return { results };
  }

  private async processToken(cfg: any, token: string, riskCfg: any): Promise<any> {
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
