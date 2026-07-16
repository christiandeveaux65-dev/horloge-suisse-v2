import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { PriceService } from '../price/price.service';

/**
 * Basis Trading — Exploite l'écart funding rate GMX V2 spot↔perp.
 * Funding > +THRESHOLD  ⇒ opportunité: long spot + short perp (les longs paient)
 * Funding < -THRESHOLD  ⇒ opportunité: short spot + long perp (les shorts paient)
 * MVP : DÉTECTION + LOG (l'exécution requiert la coordination GMX perp + spot Uniswap
 * avec sizing symétrique — délégué à une itération ultérieure).
 * Respecte le Risk Manager (skip si global_paused).
 * Cron : toutes les 10 minutes.
 */
@Injectable()
export class BasisTradingService {
  private readonly logger = new Logger(BasisTradingService.name);
  private enabled = true;

  private readonly FUNDING_THRESHOLD = 0.05;   // en % par heure (seuil d'entrée)
  private readonly MAX_POSITION_USD = 500;      // taille symétrique max
  private readonly STOP_LOSS_SPREAD_PCT = 2;    // stop-loss si le spread bouge >2% contre nous
  private readonly MARKETS = ['WETH', 'WBTC', 'ARB'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceService: PriceService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(v: boolean): void { this.enabled = v; }

  @Cron('0 */10 * * * *', { timeZone: 'Europe/Paris', name: 'basis_trading' })
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    if (!(await acquireCronRun(this.prisma, 'basis_trading', 600000))) return;
    try { await this.executeCycle(); }
    catch (err: any) { this.logger.error(`Basis cycle échoué: ${err.message}`); }
  }

  async executeCycle(): Promise<any> {
    const risk = await this.prisma.risk_config.findFirst();
    if (risk?.global_paused) return { skipped: true, reason: 'risk_global_paused' };

    const fundingByMarket = await this.fetchFundingRates();
    const opportunities: any[] = [];

    for (const symbol of this.MARKETS) {
      const funding = fundingByMarket[symbol];
      if (funding === undefined) continue;

      let direction: 'long_spot_short_perp' | 'short_spot_long_perp' | 'none' = 'none';
      if (funding > this.FUNDING_THRESHOLD) direction = 'long_spot_short_perp';
      else if (funding < -this.FUNDING_THRESHOLD) direction = 'short_spot_long_perp';

      const spot = await this.priceService.getPrice(symbol).catch(() => null);
      const basisSpread = spot ? funding : 0; // MVP: funding = proxy du basis annualisé
      const annualizedYieldPct = funding * 24 * 365; // conversion horaire → annuel

      const opp = {
        symbol, funding, direction,
        spotPriceUsd: spot,
        maxPositionUsd: this.MAX_POSITION_USD,
        stopLossSpreadPct: this.STOP_LOSS_SPREAD_PCT,
        estimatedAnnualYieldPct: Number(annualizedYieldPct.toFixed(2)),
        basisSpread: Number(basisSpread.toFixed(4)),
      };
      opportunities.push(opp);

      if (direction !== 'none') {
        await this.prisma.leverage_event.create({
          data: {
            protocol: 'basis_trading', kind: 'opportunity',
            detail: `${symbol} funding ${funding.toFixed(4)}% → ${direction}`,
            payload: JSON.stringify(opp),
          },
        }).catch(() => undefined);
        this.logger.log(`Basis opportunity ${symbol}: funding=${funding.toFixed(4)}% ⇒ ${direction} (est ${annualizedYieldPct.toFixed(1)}%/an)`);
      }
    }

    return { markets: this.MARKETS, opportunities };
  }

  private async fetchFundingRates(): Promise<Record<string, number>> {
    try {
      const res = await fetch('https://arbitrum-api.gmxinfra.io/prices/tickers');
      if (!res.ok) return {};
      const data: any = await res.json();
      const rows = Array.isArray(data) ? data : (data.tickers ?? []);
      const out: Record<string, number> = {};
      for (const t of rows) {
        const rate = t.fundingRate ?? t.funding_rate ?? t.longFundingRatePerHour ?? null;
        const symbol = t.tokenSymbol ?? t.symbol ?? '';
        if (!symbol || rate === null || rate === undefined) continue;
        const rateNum = typeof rate === 'string' ? parseFloat(rate) : Number(rate);
        if (isFinite(rateNum) && !(symbol in out)) out[symbol] = rateNum;
      }
      return out;
    } catch { return {}; }
  }

  async getStatus(): Promise<any> {
    const recent = await this.prisma.leverage_event.findMany({
      where: { protocol: 'basis_trading', kind: 'opportunity' },
      orderBy: { created_at: 'desc' }, take: 5,
    });
    return {
      enabled: this.enabled,
      schedule: '0 */10 * * * * (toutes les 10 min)',
      fundingThresholdPct: this.FUNDING_THRESHOLD,
      maxPositionUsd: this.MAX_POSITION_USD,
      stopLossSpreadPct: this.STOP_LOSS_SPREAD_PCT,
      markets: this.MARKETS,
      note: 'MVP: détection + log. Exécution différée volontairement : une jambe perp GMX serait adoptée et gérée automatiquement par le module GMX (stop-loss/trailing), cassant le hedge spot↔perp. Une exécution sûre nécessite un module de cycle de vie basis isolé (suivi de position dédié) — à câbler en itération dédiée.',
      recentOpportunities: recent.map(e => ({ detail: e.detail, at: e.created_at, payload: JSON.parse(e.payload) })),
    };
  }
}
