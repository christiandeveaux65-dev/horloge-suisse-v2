import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { STABLECOINS, LIQUIDATION_SLIPPAGE_BPS, CHAIN, TOKENS } from '../constants';

/**
 * Risk Manager — Gardien central CRITIQUE
 * Vérifie TOUS les stop-loss de TOUTES les stratégies à chaque cycle
 * Drawdown borné 0-100, circuit breaker, portfolio stop-loss absolu
 * Cron toutes les 5 minutes — NE JAMAIS DÉSACTIVER
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tradeExecution: TradeExecutionService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /** Cron Risk Manager : toutes les 5 minutes — CRITIQUE */
  @Cron('0 */5 * * * *')
  async handleCron(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('⚠️ Risk Manager désactivé — DANGER');
      return;
    }
    try {
      await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle Risk Manager échoué: ${err.message}`);
    }
  }

  /** Exécuter toutes les vérifications de protection */
  async executeCycle(): Promise<any> {
    const athCheck = await this.updateATHAndCheck();
    const cb = await this.checkCircuitBreaker();
    const recovery = await this.updateRecoveryMode();
    const stopLoss = await this.checkPortfolioStopLoss();
    const stopsChecked = await this.checkAllStopLosses();

    const paused = await this.isPaused();
    return { paused, ath_check: athCheck, circuit_breaker: cb, recovery, stop_loss: stopLoss, stops_checked: stopsChecked };
  }

  /** Calculer la valeur totale du portefeuille en USD */
  async getPortfolioValue(): Promise<number> {
    let total = 0;
    const balances = await this.blockchain.getAllBalances();

    for (const [token, balStr] of Object.entries(balances)) {
      const bal = parseFloat(balStr);
      if (bal <= 0) continue;
      try {
        const price = await this.priceService.getPrice(token);
        total += bal * price;
      } catch {
        // skip si prix indisponible
      }
    }
    return total;
  }

  /** Mettre à jour l'ATH et vérifier le drawdown */
  private async updateATHAndCheck(): Promise<any> {
    let cfg = await this.getOrCreateConfig();
    const total = await this.getPortfolioValue();
    const ath = parseFloat(cfg.ath_value_usd) || 0;

    // Mettre à jour l'ATH si nouveau max
    if (total > ath) {
      await this.prisma.risk_config.update({
        where: { id: cfg.id },
        data: { ath_value_usd: total.toFixed(2), ath_recorded_at: new Date() },
      });
      cfg = await this.prisma.risk_config.findUnique({ where: { id: cfg.id } }) as any;
    }

    // Calcul drawdown — borné [0, 100] (leçon #8)
    const currentAth = parseFloat(cfg.ath_value_usd) || total;
    const rawDrawdown = currentAth > 0 ? ((currentAth - total) / currentAth) * 100 : 0;
    const drawdownPct = Math.max(0, Math.min(100, rawDrawdown));

    let triggered = false;
    if (!cfg.global_paused && currentAth > 0 && drawdownPct >= cfg.max_drawdown_pct) {
      triggered = true;
      const reason = `Drawdown ${drawdownPct.toFixed(2)}% ≥ seuil ${cfg.max_drawdown_pct}%`;
      await this.prisma.risk_config.update({
        where: { id: cfg.id },
        data: { global_paused: true, paused_reason: reason, paused_at: new Date() },
      });
      await this.logEvent('drawdown_pause', reason);
      this.logger.error(`🚨 ${reason}`);
    }

    return { total, ath: currentAth, drawdownPct, triggered };
  }

  /** Circuit breaker : drawdown > seuil sur fenêtre glissante */
  private async checkCircuitBreaker(): Promise<any> {
    const cfg = await this.getOrCreateConfig();
    const windowHours = cfg.circuit_breaker_window_hours;
    const threshold = cfg.circuit_breaker_threshold_pct;

    // Chercher les snapshots dans la fenêtre
    const windowStart = new Date(Date.now() - windowHours * 3600 * 1000);
    const snapshots = await this.prisma.portfolio_snapshot.findMany({
      where: { snapshot_at: { gte: windowStart } },
      orderBy: { snapshot_at: 'asc' },
    });

    if (snapshots.length === 0) {
      return { checked: false, reason: 'pas de snapshots' };
    }

    // Agréger par timestamp pour obtenir la valeur totale
    const totals = new Map<string, number>();
    for (const snap of snapshots) {
      const key = snap.snapshot_at.toISOString();
      const val = parseFloat(snap.value_usd) || 0;
      totals.set(key, (totals.get(key) || 0) + val);
    }

    const values = Array.from(totals.values());
    const peak = Math.max(...values);
    const total = await this.getPortfolioValue();

    const windowDrawdownPct = Math.max(0, ((peak - total) / peak) * 100);

    let triggered = false;
    if (!cfg.circuit_breaker_active && windowDrawdownPct >= threshold) {
      triggered = true;
      const reason = `Circuit breaker : drawdown ${windowDrawdownPct.toFixed(2)}% en ${windowHours}h ≥ seuil ${threshold}%`;
      await this.prisma.risk_config.update({
        where: { id: cfg.id },
        data: {
          circuit_breaker_active: true,
          circuit_breaker_triggered_at: new Date(),
          global_paused: true,
          paused_reason: reason,
          paused_at: new Date(),
        },
      });
      await this.logEvent('circuit_breaker', reason);
      this.logger.error(`🚨 ${reason}`);
    }

    return { windowDrawdownPct, peak, total, triggered };
  }

  /** Mode recovery : réduction d'exposition si drawdown modéré (5-10%) */
  private async updateRecoveryMode(): Promise<any> {
    const cfg = await this.getOrCreateConfig();
    const total = await this.getPortfolioValue();
    const ath = parseFloat(cfg.ath_value_usd) || total;
    const drawdownPct = ath > 0 ? Math.max(0, Math.min(100, ((ath - total) / ath) * 100)) : 0;

    const shouldRecover = drawdownPct >= 5 && drawdownPct < 10;

    if (shouldRecover !== cfg.recovery_mode) {
      await this.prisma.risk_config.update({
        where: { id: cfg.id },
        data: { recovery_mode: shouldRecover },
      });
      if (shouldRecover) {
        await this.logEvent('recovery_mode', `Recovery activé : drawdown ${drawdownPct.toFixed(2)}%`);
      }
    }

    return { recovery_mode: shouldRecover, drawdownPct };
  }

  /** Portfolio stop-loss absolu : liquidation totale */
  private async checkPortfolioStopLoss(): Promise<any> {
    const cfg = await this.getOrCreateConfig();
    const threshold = parseFloat(cfg.portfolio_stop_loss_usd);
    const total = await this.getPortfolioValue();

    if (threshold <= 0 || total >= threshold) {
      return { breached: false, total, threshold };
    }

    this.logger.error(`🚨 Portfolio stop-loss déclenché : $${total.toFixed(2)} < $${threshold}`);
    await this.logEvent('portfolio_stop_loss', `Valeur $${total.toFixed(2)} < seuil $${threshold}`);

    await this.liquidateAllPositions('portfolio_stop_loss');

    return { breached: true, total, threshold };
  }

  /** Vérifier TOUS les stop-loss (Momentum + Mean Reversion) */
  private async checkAllStopLosses(): Promise<any> {
    let checked = 0;
    let triggered = 0;

    // Mean Reversion positions
    const mrPositions = await this.prisma.mean_reversion_position.findMany({
      where: { status: 'open' },
    });

    for (const pos of mrPositions) {
      checked++;
      try {
        const price = await this.priceService.getPrice(pos.token);
        const stopLoss = parseFloat(pos.stop_loss);
        const takeProfit = parseFloat(pos.take_profit);

        if (price <= stopLoss) {
          triggered++;
          await this.forceCloseMRPosition(pos, price, 'stop_loss');
        } else if (price >= takeProfit) {
          triggered++;
          await this.forceCloseMRPosition(pos, price, 'take_profit');
        }
      } catch (err: any) {
        this.logger.warn(`Stop-loss check MR ${pos.token} échoué: ${err.message}`);
      }
    }

    // Momentum positions
    const momPositions = await this.prisma.position.findMany({
      where: { status: 'open' },
      include: { config: true },
    });

    for (const pos of momPositions) {
      checked++;
      try {
        const price = await this.priceService.getPrice(pos.token);
        const entry = parseFloat(pos.entry_price);
        const highest = Math.max(parseFloat(pos.highest_price), price);
        const stopPct = pos.config?.stop_loss_pct ?? 8;
        const basicStop = entry * (1 - stopPct / 100);
        const trailingStop = highest * (1 - stopPct / 100);
        const stopPrice = Math.max(basicStop, trailingStop);

        if (price <= stopPrice) {
          triggered++;
          await this.forceCloseMomPosition(pos, price, 'stop_loss');
        }
      } catch (err: any) {
        this.logger.warn(`Stop-loss check Momentum ${pos.token} échoué: ${err.message}`);
      }
    }

    if (triggered > 0) {
      this.logger.warn(`Stop-loss déclenchés : ${triggered}/${checked}`);
    }

    return { checked, triggered };
  }

  private async forceCloseMRPosition(pos: any, price: number, reason: string): Promise<void> {
    const amount = parseFloat(pos.amount_token);
    if (amount <= 0) return;

    const result = await this.tradeExecution.executeTrade({
      source: 'risk',
      sourceToken: pos.token,
      targetToken: 'USDC',
      amountIn: amount.toFixed(8),
      side: 'sell',
    });

    const pnl = parseFloat(result.amountOut) - parseFloat(pos.cost_usd);
    await this.prisma.mean_reversion_position.update({
      where: { id: pos.id },
      data: { status: 'closed', closed_at: new Date(), pnl_usd: pnl.toFixed(2) },
    });

    await this.logEvent('stop_loss_mr', `${pos.token} fermée par ${reason} @ $${price}`);
  }

  private async forceCloseMomPosition(pos: any, price: number, reason: string): Promise<void> {
    const amount = parseFloat(pos.amount_token);
    if (amount <= 0) return;

    const result = await this.tradeExecution.executeTrade({
      source: 'risk',
      sourceToken: pos.token,
      targetToken: 'USDC',
      amountIn: amount.toFixed(8),
      side: 'sell',
    });

    await this.prisma.$transaction(async (tx: any) => {
      await tx.position.update({
        where: { id: pos.id },
        data: { status: 'closed', closed_at: new Date(), amount_token: '0' },
      });
      if (pos.config_id) {
        const row = await tx.momentum_config.findUnique({ where: { id: pos.config_id } });
        if (row) {
          const deployed = parseFloat(row.deployed_usd);
          const cost = parseFloat(pos.cost_usd);
          await tx.momentum_config.update({
            where: { id: pos.config_id },
            data: { deployed_usd: Math.max(0, deployed - cost).toFixed(2) },
          });
        }
      }
    });

    await this.logEvent('stop_loss_momentum', `${pos.token} fermée par ${reason} @ $${price}`);
  }

  /** Liquidation totale : vendre tout en USDC */
  private async liquidateAllPositions(reason: string): Promise<void> {
    this.logger.error(`🚨 Liquidation totale : ${reason}`);

    const balances = await this.blockchain.getAllBalances();

    for (const [token, balStr] of Object.entries(balances)) {
      if (STABLECOINS.has(token.toUpperCase()) || token === 'ETH') continue;
      const bal = parseFloat(balStr);
      if (bal <= 0.000001) continue;

      try {
        await this.tradeExecution.executeTrade({
          source: 'risk',
          sourceToken: token,
          targetToken: 'USDC',
          amountIn: bal.toFixed(8),
          side: 'sell',
          slippageBps: LIQUIDATION_SLIPPAGE_BPS,
        });
      } catch (err: any) {
        this.logger.error(`Liquidation ${token} échouée: ${err.message}`);
      }
    }

    // Fermer toutes les positions
    await this.prisma.position.updateMany({
      where: { status: 'open' },
      data: { status: 'closed', closed_at: new Date(), amount_token: '0' },
    });
    await this.prisma.mean_reversion_position.updateMany({
      where: { status: 'open' },
      data: { status: 'closed', closed_at: new Date() },
    });
    await this.prisma.momentum_config.updateMany({
      data: { deployed_usd: '0' },
    });

    // Pause globale
    const cfg = await this.getOrCreateConfig();
    await this.prisma.risk_config.update({
      where: { id: cfg.id },
      data: {
        global_paused: true,
        paused_reason: `Liquidation totale : ${reason}`,
        paused_at: new Date(),
      },
    });
  }

  async isPaused(): Promise<boolean> {
    const cfg = await this.prisma.risk_config.findFirst();
    return cfg?.global_paused ?? false;
  }

  async getSizingFactor(): Promise<number> {
    const cfg = await this.prisma.risk_config.findFirst();
    if (!cfg) return 1;
    if (cfg.recovery_mode) return parseFloat(cfg.recovery_factor) || 0.5;
    return 1;
  }

  private async logEvent(kind: string, detail: string, payload: any = {}): Promise<void> {
    await this.prisma.risk_event.create({
      data: { kind, detail, payload: JSON.stringify(payload) },
    });
  }

  private async getOrCreateConfig(): Promise<any> {
    let cfg = await this.prisma.risk_config.findFirst();
    if (!cfg) {
      cfg = await this.prisma.risk_config.create({ data: {} });
    }
    return cfg;
  }

  async getStatus(): Promise<any> {
    const cfg = await this.getOrCreateConfig();
    const total = await this.getPortfolioValue();
    const ath = parseFloat(cfg.ath_value_usd) || total;
    const drawdownPct = ath > 0 ? Math.max(0, Math.min(100, ((ath - total) / ath) * 100)) : 0;

    const recentEvents = await this.prisma.risk_event.findMany({
      orderBy: { created_at: 'desc' },
      take: 10,
    });

    return {
      enabled: this.enabled,
      config: cfg,
      portfolioValue: total,
      ath,
      drawdownPct,
      recentEvents,
    };
  }
}
