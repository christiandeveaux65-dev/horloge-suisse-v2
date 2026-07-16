import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { PriceService } from '../price/price.service';
import { realizedVolatility, rsi, sma } from '../indicators';
import { CHAIN, TOKENS, STABLECOINS } from '../constants';

/**
 * Market Intelligence — Détection régime de marché par token
 * Volatilité, tendance, régime (bull/bear/range)
 * Cron toutes les 10 minutes
 */
@Injectable()
export class MarketIntelligenceService {
  private readonly logger = new Logger(MarketIntelligenceService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceService: PriceService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /** Appelé séquentiellement par le PipelineOrchestrator (plus de @Cron individuel). */
  async tick(): Promise<any> {
    if (!this.enabled) return { skipped: true, reason: 'disabled' };
    try {
      return await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle Market Intelligence échoué: ${err.message}`);
      return { error: err.message };
    }
  }

  async executeCycle(): Promise<any> {
    // Enregistrer les prix de tous les tokens
    await this.priceService.recordAllPrices();

    const results: any[] = [];
    const tokenSymbols = Object.keys(TOKENS).filter((t) => !STABLECOINS.has(t));

    for (const token of tokenSymbols) {
      try {
        const prices = await this.priceService.getPriceSeries(token, 100);
        if (prices.length < 20) {
          results.push({ token, action: 'skip', reason: 'données insuffisantes' });
          continue;
        }

        const vol = realizedVolatility(prices, 20);
        const rsiVal = rsi(prices, 14);
        const smaShort = sma(prices, 10);
        const smaLong = sma(prices, 30);
        const currentPrice = prices[prices.length - 1];

        // Déterminer le régime
        let regime = 'range';
        let trendStrength = 0;

        if (smaShort !== null && smaLong !== null && smaLong > 0) {
          const spread = (smaShort - smaLong) / smaLong;
          trendStrength = Math.abs(spread);

          if (spread > 0.02 && rsiVal > 50) regime = 'bull';
          else if (spread < -0.02 && rsiVal < 50) regime = 'bear';
        }

        if (vol !== null) {
          if (vol > 0.05) regime = 'high_vol';
          else if (vol < 0.01 && regime === 'range') regime = 'low_vol';
        }

        // Enregistrer le régime
        await this.prisma.market_regime.create({
          data: {
            chain: CHAIN,
            token,
            timeframe: '1H',
            regime,
            score: rsiVal.toFixed(1),
            volatility: vol?.toFixed(6) ?? '0',
            trend_strength: trendStrength.toFixed(6),
          },
        });

        results.push({ token, regime, rsi: rsiVal, volatility: vol, trendStrength });
      } catch (err: any) {
        results.push({ token, error: err.message });
      }
    }

    return { results };
  }

  /** Récupérer le régime de marché pour un token */
  async getRegime(token: string): Promise<any> {
    return this.prisma.market_regime.findFirst({
      where: { token: token.toUpperCase(), chain: CHAIN },
      orderBy: { recorded_at: 'desc' },
    });
  }

  async getStatus(): Promise<any> {
    const latestRegimes: any[] = [];
    const tokenSymbols = Object.keys(TOKENS).filter((t) => !STABLECOINS.has(t));

    for (const token of tokenSymbols) {
      const regime = await this.getRegime(token);
      if (regime) latestRegimes.push(regime);
    }

    return { enabled: this.enabled, regimes: latestRegimes };
  }
}
