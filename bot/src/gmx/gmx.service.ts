import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { computeSignal } from '../indicators';
import {
  GMX_BUDGET_USD, GMX_TARGET_LEVERAGE, GMX_MAX_LEVERAGE,
  GMX_STOP_LOSS_PCT, GMX_COLLATERAL_USD,
} from '../constants';

/**
 * GMX V2 — Longs à levier modéré (2x, max 5x) sur WETH.
 * Budget collatéral hardcodé : $1500 ; $300/position ; stop-loss 10% du collatéral.
 * Cron toutes les 5 minutes. DÉMARRE EN PAUSE (sécurité, cf. schema paused=true).
 *
 * NOTE DE TRANSPARENCE : l'ouverture/fermeture live d'un perp GMX V2 exige le routeur
 * d'échange GMX (ExchangeRouter + oracles Chainlink), non câblé au BlockchainService
 * (qui ne gère que les swaps Uniswap spot). Ce module gère donc la logique de décision,
 * le suivi du levier, le stop-loss/trailing et la comptabilité des positions ; les
 * ouvertures/fermetures sont marquées 'simulated' tant que le routeur GMX n'est pas branché.
 */
@Injectable()
export class GmxService {
  private readonly logger = new Logger(GmxService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  @Cron('0 */5 * * * *')
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle GMX échoué: ${err.message}`);
    }
  }

  private async ensureConfig(): Promise<any> {
    let cfg = await this.prisma.gmx_config.findFirst();
    if (!cfg) {
      cfg = await this.prisma.gmx_config.create({
        data: {
          name: 'GMX V2 Longs',
          index_token: 'WETH',
          collateral_token: 'USDC',
          budget_usd: String(GMX_BUDGET_USD),
          collateral_per_trade_usd: String(GMX_COLLATERAL_USD),
          default_leverage: String(GMX_TARGET_LEVERAGE),
          max_leverage: String(GMX_MAX_LEVERAGE),
          stop_loss_pct: GMX_STOP_LOSS_PCT,
          auto_open: false,
          paused: true, // sécurité : démarre en pause
        },
      });
      this.logger.log(`Config GMX initialisée (budget $${GMX_BUDGET_USD}, levier ${GMX_TARGET_LEVERAGE}x/max ${GMX_MAX_LEVERAGE}x, SL ${GMX_STOP_LOSS_PCT}%) — EN PAUSE`);
    }
    return cfg;
  }

  async executeCycle(): Promise<any> {
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      return { success: false, reason: 'pause_globale' };
    }

    const cfg = await this.ensureConfig();

    // Le monitoring des stop-loss s'exécute MÊME si la config est en pause,
    // afin de protéger toute position ouverte (le pause bloque seulement les ouvertures).
    const monitoring = await this.monitorPositions(cfg);

    if (!cfg.active || cfg.paused) {
      return { success: true, reason: 'ouvertures_en_pause', monitoring };
    }

    let opened: any = null;
    if (cfg.auto_open) {
      opened = await this.maybeOpen(cfg);
    }

    return { success: true, monitoring, opened };
  }

  /** Surveille les positions ouvertes : stop-loss (10% collatéral) + trailing stop. */
  private async monitorPositions(cfg: any): Promise<any[]> {
    const positions = await this.prisma.gmx_position.findMany({
      where: { status: 'open' },
    });
    const results: any[] = [];

    for (const pos of positions) {
      const price = await this.priceService.getPrice(pos.index_token);
      if (!price || price <= 0) {
        results.push({ id: pos.id, action: 'skip', reason: 'prix_indisponible' });
        continue;
      }
      const entry = parseFloat(pos.entry_price) || price;
      const leverage = parseFloat(pos.leverage) || GMX_TARGET_LEVERAGE;
      const collateral = parseFloat(pos.collateral_usd) || GMX_COLLATERAL_USD;

      // PnL sur le collatéral = variation prix × levier (long).
      const priceChangePct = ((price - entry) / entry) * 100;
      const collateralPnlPct = priceChangePct * leverage;

      // Trailing : mettre à jour le plus haut.
      const highest = Math.max(parseFloat(pos.highest_price) || entry, price);
      if (price > (parseFloat(pos.highest_price) || 0)) {
        await this.prisma.gmx_position.update({
          where: { id: pos.id }, data: { highest_price: price.toString() },
        });
      }

      // Stop-loss dur : perte du collatéral >= stop_loss_pct.
      if (collateralPnlPct <= -cfg.stop_loss_pct) {
        results.push(await this.closePosition(pos, price, 'stop_loss', collateralPnlPct));
        continue;
      }

      // Trailing stop : activé après trailing_activation_pct de gain PRIX, ferme si repli.
      const gainPricePct = priceChangePct;
      if (cfg.trailing_enabled && gainPricePct >= cfg.trailing_activation_pct) {
        const trailStop = highest * (1 - cfg.trailing_distance_pct / 100);
        if (price <= trailStop) {
          results.push(await this.closePosition(pos, price, 'trailing_stop', collateralPnlPct));
          continue;
        }
      }

      results.push({
        id: pos.id, action: 'hold', price, entry, leverage,
        collateralPnlPct: Number(collateralPnlPct.toFixed(2)),
      });
    }
    return results;
  }

  private async closePosition(pos: any, price: number, reason: string, pnlPct: number): Promise<any> {
    const collateral = parseFloat(pos.collateral_usd) || 0;
    const realized = (collateral * pnlPct) / 100;
    const isDryRun = this.blockchain.getIsDryRun();
    await this.prisma.$transaction(async (tx: any) => {
      await tx.gmx_position.update({
        where: { id: pos.id },
        data: {
          status: isDryRun ? 'closed' : 'pending_close',
          close_reason: reason,
          realized_pnl_usd: realized.toFixed(2),
          closed_at: new Date(),
        },
      });
      const cfg = await tx.gmx_config.findFirst();
      if (cfg) {
        const deployed = parseFloat(cfg.deployed_usd) || 0;
        await tx.gmx_config.update({
          where: { id: cfg.id },
          data: { deployed_usd: Math.max(0, deployed - collateral).toFixed(2) },
        });
      }
    });
    this.logger.warn(`GMX position ${pos.index_token} fermée (${reason}) PnL ${pnlPct.toFixed(2)}% = $${realized.toFixed(2)}`);
    return { id: pos.id, action: 'close', reason, pnlPct: Number(pnlPct.toFixed(2)), realized };
  }

  /** Ouverture auto sur signal momentum haussier (respecte budget + levier borné). */
  private async maybeOpen(cfg: any): Promise<any> {
    const deployed = parseFloat(cfg.deployed_usd) || 0;
    const budget = Math.min(parseFloat(cfg.budget_usd), GMX_BUDGET_USD);
    const collateral = Math.min(parseFloat(cfg.collateral_per_trade_usd), GMX_COLLATERAL_USD);
    if (deployed + collateral > budget) {
      return { action: 'skip', reason: 'budget_epuise', deployed, budget };
    }

    const prices = await this.priceService.getPriceSeries(cfg.index_token, 100);
    if (prices.length < cfg.ma_long + 1) {
      return { action: 'skip', reason: 'donnees_insuffisantes' };
    }
    const snap = computeSignal(prices, {
      maShort: cfg.ma_short, maLong: cfg.ma_long, rsiPeriod: cfg.rsi_period,
      rsiOversold: cfg.rsi_oversold, rsiOverbought: cfg.rsi_overbought,
    });
    if (snap.signal !== 'buy' || !snap.latestPrice) {
      return { action: 'skip', reason: 'pas_de_signal', signal: snap.signal };
    }

    // Levier borné dur : jamais > max_leverage.
    const leverage = Math.min(parseFloat(cfg.default_leverage) || GMX_TARGET_LEVERAGE,
      parseFloat(cfg.max_leverage) || GMX_MAX_LEVERAGE);
    const sizeUsd = collateral * leverage;
    const isDryRun = this.blockchain.getIsDryRun();

    const pos = await this.prisma.gmx_position.create({
      data: {
        config_id: cfg.id,
        market: 'GMX-WETH-USD',
        index_token: cfg.index_token,
        collateral_token: cfg.collateral_token,
        is_long: true,
        collateral_usd: collateral.toFixed(2),
        size_usd: sizeUsd.toFixed(2),
        leverage: leverage.toString(),
        entry_price: snap.latestPrice.toString(),
        highest_price: snap.latestPrice.toString(),
        status: isDryRun ? 'simulated' : 'pending_open',
      },
    });
    await this.prisma.gmx_config.update({
      where: { id: cfg.id },
      data: { deployed_usd: (deployed + collateral).toFixed(2) },
    });
    this.logger.log(`GMX long ouvert ${cfg.index_token} collat $${collateral} levier ${leverage}x (taille $${sizeUsd}) [${isDryRun ? 'dry-run' : 'pending'}]`);
    return { action: 'open', positionId: pos.id, collateral, leverage, sizeUsd, entry: snap.latestPrice };
  }

  async getStatus(): Promise<any> {
    const cfg = await this.prisma.gmx_config.findFirst({
      include: { positions: { where: { status: 'open' } } },
    });
    return {
      enabled: this.enabled,
      schedule: '0 */5 * * * * (toutes les 5 min)',
      budgetUsd: GMX_BUDGET_USD,
      targetLeverage: GMX_TARGET_LEVERAGE,
      maxLeverage: GMX_MAX_LEVERAGE,
      stopLossPct: GMX_STOP_LOSS_PCT,
      note: 'Ouvertures en pause par défaut. Exécution live perp requiert le routeur GMX (non câblé).',
      config: cfg ? { ...cfg, positions: undefined, openPositions: cfg.positions?.length ?? 0 } : null,
    };
  }
}
