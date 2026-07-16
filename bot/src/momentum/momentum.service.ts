import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import { computeSignal, IndicatorSnapshot } from '../indicators';
import {
  CHAIN, MOMENTUM_ALTS_SIZE_USD, MOMENTUM_BC_SIZE_USD,
  TARGET_VOLATILITY,
} from '../constants';

/**
 * Momentum — Stratégie tactique SMA + RSI
 * 2 configs : "Alts Volatils" ($150/trade) et "Blue Chips" ($200/trade)
 * Cron toutes les 5 minutes
 */
@Injectable()
export class MomentumService {
  private readonly logger = new Logger(MomentumService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tradeExecution: TradeExecutionService,
    private readonly priceService: PriceService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  @Cron('0 */5 * * * *')
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle momentum échoué: ${err.message}`);
    }
  }

  async executeCycle(): Promise<any> {
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      return { success: false, reason: 'pause_globale' };
    }

    const configs = await this.prisma.momentum_config.findMany({
      where: { active: true, paused: false },
    });

    const results: any[] = [];
    for (const cfg of configs) {
      try {
        const result = await this.processConfig(cfg, riskCfg);
        results.push(result);
      } catch (err: any) {
        this.logger.error(`Momentum config ${cfg.name} échoué: ${err.message}`);
        results.push({ configId: cfg.id, error: err.message });
      }
    }

    return { results };
  }

  private async processConfig(cfg: any, riskCfg: any): Promise<any> {
    const tokens = cfg.tokens.split(',').map((t: string) => t.trim().toUpperCase());
    const results: any[] = [];

    for (const token of tokens) {
      // Récupérer la série de prix
      const prices = await this.priceService.getPriceSeries(token, 100);
      if (prices.length < cfg.ma_long + 1) {
        results.push({ token, action: 'skip', reason: 'données insuffisantes' });
        continue;
      }

      // Calculer le signal
      const snap = computeSignal(prices, {
        maShort: cfg.ma_short,
        maLong: cfg.ma_long,
        rsiPeriod: cfg.rsi_period,
        rsiOversold: cfg.rsi_oversold,
        rsiOverbought: cfg.rsi_overbought,
      });

      // Gérer les positions ouvertes
      const openPositions = await this.prisma.position.findMany({
        where: { config_id: cfg.id, token, status: 'open' },
      });

      for (const pos of openPositions) {
        const result = await this.managePosition(cfg, pos, snap);
        if (result) results.push(result);
      }

      // Ouverture de nouvelle position si signal buy
      if (snap.signal === 'buy' && snap.latestPrice) {
        const result = await this.tryOpenPosition(cfg, token, snap, riskCfg);
        results.push(result);
      }
    }

    return { configId: cfg.id, name: cfg.name, results };
  }

  private async managePosition(cfg: any, pos: any, snap: IndicatorSnapshot): Promise<any> {
    if (!snap.latestPrice) return null;
    const price = snap.latestPrice;
    const entry = parseFloat(pos.entry_price);
    const highest = Math.max(parseFloat(pos.highest_price), price);

    // Mettre à jour le plus haut
    if (price > parseFloat(pos.highest_price)) {
      await this.prisma.position.update({
        where: { id: pos.id },
        data: { highest_price: price.toString() },
      });
    }

    // Stop-loss / Trailing stop
    const stopLossPct = cfg.stop_loss_pct;
    const basicStop = entry * (1 - stopLossPct / 100);
    const trailingStop = highest * (1 - stopLossPct / 100);
    const stopPrice = Math.max(basicStop, trailingStop);

    if (price <= stopPrice) {
      const isTrailing = stopPrice > basicStop + 0.0001;
      const reason = isTrailing ? 'trailing_stop' : 'stop_loss';
      return this.closePosition(cfg, pos, price, reason);
    }

    // Signal de vente
    if (snap.signal === 'sell') {
      return this.closePosition(cfg, pos, price, 'signal_sell');
    }

    // Take-profit échelonné
    const levels = cfg.take_profit_levels
      .split(',')
      .map((l: string) => parseInt(l.trim(), 10))
      .filter((n: number) => !isNaN(n));

    const tpHits = (pos.tp_hits || '').split(',').map((s: string) => s.trim()).filter((s: string) => s.length);

    for (let i = 0; i < levels.length; i++) {
      if (tpHits.includes(String(i))) continue;
      const tpPrice = entry * (1 + levels[i] / 100);
      if (price >= tpPrice) {
        return this.partialTakeProfit(cfg, pos, price, i, levels.length);
      }
      break; // pas de saut de niveau
    }

    return null;
  }

  private async partialTakeProfit(
    cfg: any, pos: any, price: number, level: number, numLevels: number,
  ): Promise<any> {
    const currentAmount = parseFloat(pos.amount_token);
    const initialRaw = parseFloat(pos.initial_amount ?? '0');
    const initialAmount = initialRaw > 0 ? initialRaw : currentAmount;
    const fraction = 1 / numLevels;
    let sellAmount = initialAmount * fraction;

    const tpHits = (pos.tp_hits || '').split(',').map((s: string) => s.trim()).filter((s: string) => s.length);
    // Dernier niveau → vendre tout le reste
    if (tpHits.length + 1 >= numLevels) sellAmount = currentAmount;
    if (sellAmount > currentAmount) sellAmount = currentAmount;

    // Exécuter la vente partielle
    const result = await this.tradeExecution.executeTrade({
      source: 'momentum',
      sourceToken: pos.token,
      targetToken: 'USDC',
      amountIn: sellAmount.toFixed(8),
      side: 'sell',
    });

    const newAmount = currentAmount - sellAmount;
    const newTpHits = [...tpHits, String(level)].join(',');

    if (newAmount <= 0 || tpHits.length + 1 >= numLevels) {
      // Fermer complètement
      await this.prisma.$transaction(async (tx: any) => {
        await tx.position.update({
          where: { id: pos.id },
          data: { status: 'closed', closed_at: new Date(), amount_token: '0', tp_hits: newTpHits },
        });
        const row = await tx.momentum_config.findUnique({ where: { id: cfg.id } });
        const deployed = parseFloat(row?.deployed_usd ?? '0');
        const cost = parseFloat(pos.cost_usd);
        await tx.momentum_config.update({
          where: { id: cfg.id },
          data: { deployed_usd: Math.max(0, deployed - cost).toFixed(2) },
        });
      });
    } else {
      await this.prisma.position.update({
        where: { id: pos.id },
        data: { amount_token: newAmount.toFixed(8), tp_hits: newTpHits },
      });
    }

    return { action: 'take_profit', level, price, sellAmount, result };
  }

  private async closePosition(cfg: any, pos: any, price: number, reason: string): Promise<any> {
    const amount = parseFloat(pos.amount_token);
    if (amount <= 0) return { action: 'skip', reason: 'position_vide' };

    const result = await this.tradeExecution.executeTrade({
      source: 'momentum',
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
      const row = await tx.momentum_config.findUnique({ where: { id: cfg.id } });
      const deployed = parseFloat(row?.deployed_usd ?? '0');
      const cost = parseFloat(pos.cost_usd);
      await tx.momentum_config.update({
        where: { id: cfg.id },
        data: { deployed_usd: Math.max(0, deployed - cost).toFixed(2) },
      });
    });

    this.logger.log(`Position ${pos.token} fermée : ${reason} @ $${price}`);
    return { action: reason, token: pos.token, price, result };
  }

  private async tryOpenPosition(
    cfg: any, token: string, snap: IndicatorSnapshot, riskCfg: any,
  ): Promise<any> {
    // Compter les positions ouvertes
    const openCount = await this.prisma.position.count({
      where: { config_id: cfg.id, status: 'open' },
    });
    if (openCount >= 5) {
      return { token, action: 'skip', reason: 'max_positions_atteint' };
    }

    // Déjà une position ouverte sur ce token ?
    const existing = await this.prisma.position.findFirst({
      where: { config_id: cfg.id, token, status: 'open' },
    });
    if (existing) {
      return { token, action: 'skip', reason: 'position_deja_ouverte' };
    }

    // Calculer la taille
    const budget = parseFloat(cfg.budget_usd);
    const freshCfg = await this.prisma.momentum_config.findUnique({ where: { id: cfg.id } });
    const deployed = parseFloat(freshCfg?.deployed_usd ?? cfg.deployed_usd);
    const remaining = budget - deployed;

    // Taille cible selon le type de config
    const isBlueChip = ['WETH', 'WBTC'].includes(token);
    let sizeUsd = isBlueChip ? MOMENTUM_BC_SIZE_USD : MOMENTUM_ALTS_SIZE_USD;

    // Réduction par volatilité
    if (snap.volatility && snap.volatility > 0) {
      const factor = Math.max(0.3, Math.min(1, TARGET_VOLATILITY / snap.volatility));
      sizeUsd = sizeUsd * factor;
    }

    // Recovery mode
    if (riskCfg?.recovery_mode) {
      const recoveryFactor = parseFloat(riskCfg.recovery_factor) || 0.5;
      sizeUsd = sizeUsd * recoveryFactor;
    }

    // Plafonnement par budget restant
    if (remaining <= 1) {
      return { token, action: 'skip', reason: 'budget_epuisé' };
    }
    if (sizeUsd > remaining) sizeUsd = remaining;

    sizeUsd = Math.floor(sizeUsd * 100) / 100;
    if (sizeUsd < 5) {
      return { token, action: 'skip', reason: 'taille_trop_faible', sizeUsd };
    }

    // Exécuter l'achat
    const result = await this.tradeExecution.executeTrade({
      source: 'momentum',
      sourceToken: 'USDC',
      targetToken: token,
      amountIn: sizeUsd.toFixed(2),
      side: 'buy',
    });

    if (result.success) {
      // Créer la position atomiquement
      await this.prisma.$transaction(async (tx: any) => {
        await tx.position.create({
          data: {
            config_id: cfg.id,
            chain: CHAIN,
            token,
            amount_token: result.amountOut,
            initial_amount: result.amountOut,
            entry_price: snap.latestPrice!.toString(),
            cost_usd: sizeUsd.toFixed(2),
            highest_price: snap.latestPrice!.toString(),
          },
        });
        const row = await tx.momentum_config.findUnique({ where: { id: cfg.id } });
        const deployedNow = parseFloat(row?.deployed_usd ?? '0');
        await tx.momentum_config.update({
          where: { id: cfg.id },
          data: { deployed_usd: (deployedNow + sizeUsd).toFixed(2) },
        });
      });

      this.logger.log(`Position ouverte : ${token} $${sizeUsd} @ $${snap.latestPrice}`);
    }

    return { token, action: 'buy', sizeUsd, result };
  }

  async getStatus(): Promise<any> {
    const configs = await this.prisma.momentum_config.findMany({
      include: { positions: { where: { status: 'open' } } },
    });
    return {
      enabled: this.enabled,
      configs: configs.map((c: any) => ({
        ...c,
        openPositions: c.positions?.length ?? 0,
      })),
    };
  }
}
