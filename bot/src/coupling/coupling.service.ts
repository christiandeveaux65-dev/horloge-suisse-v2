import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { PriceService } from '../price/price.service';
import { sma, rsi, realizedVolatility, clamp } from '../indicators';
import { CHAIN } from '../constants';

/**
 * Coupling — Détection régime de marché et modulation DCA
 * Multiplicateur DCA continu entre ×0.3 (surchauffe) et ×1.8 (capitulation)
 * Cron toutes les 30 minutes
 */
@Injectable()
export class CouplingService {
  private readonly logger = new Logger(CouplingService.name);
  private enabled = true;

  // Paramètres par défaut
  private readonly MA_SHORT = 10;
  private readonly MA_LONG = 30;
  private readonly RSI_PERIOD = 14;
  private readonly VOL_DAMP = 0.03;

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceService: PriceService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /** Cron coupling : toutes les 30 minutes */
  /** Appelé séquentiellement par le PipelineOrchestrator (plus de @Cron individuel). */
  async tick(): Promise<any> {
    if (!this.enabled) return { skipped: true, reason: 'disabled' };
    try {
      return await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle coupling échoué: ${err.message}`);
      return { error: err.message };
    }
  }

  /** Exécuter un cycle de détection de régime */
  async executeCycle(): Promise<any> {
    // Récupérer la config coupling
    let config = await this.prisma.coupling_config.findFirst();
    if (!config) {
      config = await this.prisma.coupling_config.create({
        data: {
          modulation_enabled: true,
          boost_max: '1.8',
          brake_min: '0.3',
        },
      });
    }

    if (!config.modulation_enabled) {
      return { regime: 'neutre', multiplier: 1, reason: 'modulation_disabled' };
    }

    const boostMax = parseFloat(config.boost_max) || 1.8;
    const brakeMin = parseFloat(config.brake_min) || 0.3;

    // Récupérer la série de prix ETH
    const prices = await this.priceService.getPriceSeries('WETH', 100);
    if (prices.length < this.MA_LONG + 1) {
      this.logger.warn(`Coupling : données insuffisantes (${prices.length} prix)`);
      return { regime: 'neutre', multiplier: 1, reason: 'data_insufficient' };
    }

    // Calculer les indicateurs
    const smaS = sma(prices, this.MA_SHORT);
    const smaL = sma(prices, this.MA_LONG);
    const rsiVal = rsi(prices, this.RSI_PERIOD);
    const vol = realizedVolatility(prices, Math.max(this.MA_SHORT, 10));

    // Calculer le score composite
    const spread = (smaS !== null && smaL !== null && smaL > 0)
      ? (smaS - smaL) / smaL
      : 0;

    // Composante drawdown (approximée par la baisse depuis le max de la série)
    const maxPrice = Math.max(...prices);
    const currentPrice = prices[prices.length - 1];
    const dd = maxPrice > 0 ? (maxPrice - currentPrice) / maxPrice : 0;

    const trend = clamp((spread / 0.05) * 40, -40, 40);
    const rsiComp = clamp(((rsiVal - 50) / 35) * 35, -35, 35);
    const ddComp = clamp(25 + (dd / 0.2) * 50, -25, 25);
    const score = clamp(trend + rsiComp + ddComp, -100, 100);

    // Classification du régime
    const regime =
      score <= -55 ? 'capitulation'
        : score <= -20 ? 'faiblesse'
          : score < 25 ? 'neutre'
            : score < 60 ? 'tendance_haussiere'
              : 'surchauffe';

    // Multiplicateur continu
    let mult: number;
    if (score <= 0) {
      mult = 1 + (boostMax - 1) * (-score / 100);
    } else {
      mult = 1 - (1 - brakeMin) * (score / 100);
    }

    // Amortissement par volatilité
    if (vol !== null && vol > this.VOL_DAMP) {
      const damp = clamp(this.VOL_DAMP / vol, 0.4, 1);
      mult = 1 + (mult - 1) * damp;
    }

    // Borner le multiplicateur
    mult = clamp(mult, brakeMin, boostMax);
    mult = Math.round(mult * 100) / 100;

    // Enregistrer la décision
    await this.prisma.coupling_decision.create({
      data: {
        kind: 'dca_modulation',
        chain: CHAIN,
        token: 'WETH',
        detail: `Régime ${regime} (score ${score.toFixed(1)}) → DCA ×${mult}`,
        payload: JSON.stringify({
          score: Math.round(score * 10) / 10,
          regime,
          multiplier: mult,
          components: {
            trend: Math.round(trend * 10) / 10,
            rsi: Math.round(rsiComp * 10) / 10,
            drawdown: Math.round(ddComp * 10) / 10,
          },
          indicators: {
            smaShort: smaS,
            smaLong: smaL,
            rsi: Math.round(rsiVal * 10) / 10,
            volatility: vol !== null ? Math.round(vol * 10000) / 10000 : null,
          },
        }),
      },
    });

    // Modulation Momentum : OFF en capitulation, ×1.2 en surchauffe
    const momMult = regime === 'capitulation' ? 0 : regime === 'surchauffe' ? 1.2 : 1;
    await this.prisma.coupling_decision.create({
      data: {
        kind: 'momentum_modulation',
        chain: CHAIN,
        token: 'WETH',
        detail: `Régime ${regime} (score ${score.toFixed(1)}) → Momentum ×${momMult}`,
        payload: JSON.stringify({ score: Math.round(score * 10) / 10, regime, multiplier: momMult }),
      },
    });

    // Modulation Mean Reversion : ×1.5 en capitulation, OFF en surchauffe
    const mrMult = regime === 'surchauffe' ? 0 : regime === 'capitulation' ? 1.5 : 1;
    await this.prisma.coupling_decision.create({
      data: {
        kind: 'mean_reversion_modulation',
        chain: CHAIN,
        token: 'WETH',
        detail: `Régime ${regime} (score ${score.toFixed(1)}) → MR ×${mrMult}`,
        payload: JSON.stringify({ score: Math.round(score * 10) / 10, regime, multiplier: mrMult }),
      },
    });

    // Sauvegarder le régime de marché
    await this.prisma.market_regime.create({
      data: {
        chain: CHAIN,
        token: 'WETH',
        timeframe: '1H',
        regime: this.mapRegimeToMarket(regime),
        score: score.toFixed(1),
        volatility: vol?.toString() ?? '0',
        trend_strength: Math.abs(spread).toString(),
      },
    });

    this.logger.log(
      `Coupling : régime=${regime} score=${score.toFixed(1)} mult=×${mult}`,
    );

    return { regime, score: Math.round(score * 10) / 10, multiplier: mult };
  }

  private mapRegimeToMarket(regime: string): string {
    switch (regime) {
      case 'capitulation':
      case 'faiblesse': return 'bear';
      case 'tendance_haussiere':
      case 'surchauffe': return 'bull';
      default: return 'range';
    }
  }

  async getStatus(): Promise<any> {
    const config = await this.prisma.coupling_config.findFirst();
    const lastDecision = await this.prisma.coupling_decision.findFirst({
      where: { kind: 'dca_modulation' },
      orderBy: { created_at: 'desc' },
    });

    return {
      enabled: this.enabled,
      config,
      lastDecision: lastDecision ? {
        ...lastDecision,
        payload: JSON.parse(lastDecision.payload),
      } : null,
    };
  }
}
