import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import { GRID_BUDGET_USD, GRID_LEVELS, GRID_PER_LEVEL_USD, SHORT_ALLOWED_TOKENS } from '../constants';
import { GmxService } from '../gmx/gmx.service';
import { getStrategyModulation } from '../common/strategy-modulation';
import { estimateRoundTripCost, getMinProfitPct, passesProfitability } from '../common/profitability';

/**
 * Grid Trading — WETH/USDC
 * Place une grille de N niveaux (défaut 10) autour du prix courant.
 * Achète quand le prix franchit un niveau vers le bas, vend vers le haut.
 * Budget hardcodé : $1000 total, $100/niveau (constants.ts).
 * Cron toutes les 3 minutes.
 */
@Injectable()
export class GridService {
  private readonly logger = new Logger(GridService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tradeExecution: TradeExecutionService,
    private readonly priceService: PriceService,
    private readonly gmx: GmxService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /** Appelé séquentiellement par le PipelineOrchestrator (plus de @Cron individuel). */
  async tick(): Promise<any> {
    if (!this.enabled) return { skipped: true, reason: 'disabled' };
    try {
      return await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle grid échoué: ${err.message}`);
      return { error: err.message };
    }
  }

  /** Garantit qu'une config existe (bornes hardcodées appliquées). */
  private async ensureConfig(): Promise<any> {
    let cfg = await this.prisma.grid_config.findFirst();
    if (!cfg) {
      cfg = await this.prisma.grid_config.create({
        data: {
          name: 'Grid WETH/USDC',
          token_base: 'USDC',
          token_quote: 'WETH',
          budget_usd: String(GRID_BUDGET_USD),
          grid_levels: GRID_LEVELS,
          auto_range: true,
          active: true,
          paused: false,
        },
      });
      this.logger.log(`Config grid initialisée (budget $${GRID_BUDGET_USD}, ${GRID_LEVELS} niveaux)`);
    }
    return cfg;
  }

  async executeCycle(): Promise<any> {
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      return { success: false, reason: 'pause_globale' };
    }

    const cfg = await this.ensureConfig();
    if (!cfg.active || cfg.paused) {
      return { success: false, reason: 'config_inactive' };
    }

    const token = (cfg.token_quote || 'WETH').toUpperCase();
    const prices = await this.priceService.getPriceSeries(token, 50);
    if (prices.length < 20) {
      return { success: false, reason: 'données insuffisantes', have: prices.length };
    }
    const currentPrice = prices[prices.length - 1];

    // Fourchette : lit range_pct (param optimisé par l'optimiseur), borné [1%, 10%]
    // pour la sécurité. Fallback 3.5% si non renseigné.
    const cfgRange = Number(cfg.range_pct);
    const rangePct = Number.isFinite(cfgRange) && cfgRange > 0
      ? Math.max(1, Math.min(10, cfgRange))
      : 3.5;
    let lower = parseFloat(cfg.price_lower);
    let upper = parseFloat(cfg.price_upper);

    // Détection drift > 5% => rebalancing
    if (lower > 0 && upper > 0) {
      const center = (lower + upper) / 2;
      const driftPct = Math.abs(currentPrice - center) / center;
      if (driftPct > 0.05) {
        this.logger.warn(`Rebalancing grille : prix $${currentPrice.toFixed(2)} dévié de ${(driftPct * 100).toFixed(1)}% du centre $${center.toFixed(2)}`);
        await this.prisma.grid_order.updateMany({ where: { config_id: cfg.id, status: 'pending' }, data: { status: 'cancelled' } });
        lower = currentPrice * (1 - rangePct / 100);
        upper = currentPrice * (1 + rangePct / 100);
        await this.prisma.grid_config.update({ where: { id: cfg.id }, data: { price_lower: lower.toString(), price_upper: upper.toString() } });
      }
    }

    if (cfg.auto_range || lower <= 0 || upper <= 0) {
      lower = currentPrice * (1 - rangePct / 100);
      upper = currentPrice * (1 + rangePct / 100);
      await this.prisma.grid_config.update({
        where: { id: cfg.id },
        data: { price_lower: lower.toString(), price_upper: upper.toString() },
      });
    }

    const levels = cfg.grid_levels || GRID_LEVELS;
    const step = (upper - lower) / levels;
    if (step <= 0) return { success: false, reason: 'fourchette_invalide' };

    // Budget déployé = somme des ordres achetés non vendus
    const filledBuys = await this.prisma.grid_order.findMany({
      where: { config_id: cfg.id, side: 'buy', status: 'filled' },
    });
    const deployedUsd = filledBuys.reduce(
      (s: number, o: any) => s + parseFloat(o.amount) * parseFloat(o.price), 0,
    );
    const budget = Math.min(parseFloat(cfg.budget_usd), GRID_BUDGET_USD);
    // Pilotage adaptatif (Strategist × Strategy Evaluator) : gate + facteur de taille.
    const modulation = await getStrategyModulation(this.prisma, 'grid');
    let perLevelUsd = Math.min(GRID_PER_LEVEL_USD, budget / levels);
    if (modulation.sizeFactor !== 1) {
      perLevelUsd = Math.min(GRID_PER_LEVEL_USD, perLevelUsd * modulation.sizeFactor);
    }

    // Niveau courant
    const currentLevel = Math.floor((currentPrice - lower) / step);
    const results: any[] = [];

    // Filtre de rentabilité minimum : le profit d'un cycle de grille = un pas (step).
    // Si l'écart entre deux niveaux ne couvre pas le coût de l'aller-retour DEX + marge,
    // les NOUVEAUX achats sont refusés (les ventes de liquidation restent autorisées).
    const stepPct = currentPrice > 0 ? (step / currentPrice) * 100 : 0;
    const minPP = await getMinProfitPct(this.prisma, 'grid');
    const est = estimateRoundTripCost(perLevelUsd, minPP);
    const gridProfitable = passesProfitability(stepPct, est);
    if (!gridProfitable) {
      this.logger.log(
        `[RENTABILITÉ] Grid ${token} achats REFUSÉS : pas de grille ${stepPct.toFixed(2)}% < seuil ${est.breakevenPct.toFixed(2)}% (coût ${est.costPct.toFixed(2)}% + marge ${minPP.toFixed(2)}%)`,
      );
    }

    // Achat : le prix est dans le bas de la grille et budget disponible.
    // La directive du Strategy Evaluator peut couper les NOUVEAUX achats (les ventes
    // de liquidation restent autorisées pour dénouer les positions existantes).
    if (gridProfitable && modulation.active && currentPrice <= lower + step * Math.floor(levels / 2) && deployedUsd + perLevelUsd <= budget) {
      // Éviter les doublons au même niveau
      const existingAtLevel = await this.prisma.grid_order.findFirst({
        where: { config_id: cfg.id, side: 'buy', status: 'filled', price: currentPrice.toString() },
      });
      if (!existingAtLevel) {
        const trade = await this.tradeExecution.executeTrade({
          source: 'grid',
          sourceToken: 'USDC',
          targetToken: token,
          amountIn: perLevelUsd.toFixed(2),
          side: 'buy',
        });
        if (trade.success) {
          await this.prisma.grid_order.create({
            data: {
              config_id: cfg.id,
              side: 'buy',
              price: currentPrice.toString(),
              amount: trade.amountOut,
              status: 'filled',
              tx_hash: trade.txHash,
              filled_at: new Date(),
            },
          });
        }
        results.push({ action: 'buy', level: currentLevel, price: currentPrice, perLevelUsd, trade });
      }
    }

    // Vente : prix dans le haut de la grille et positions à liquider avec profit
    if (currentPrice >= lower + step * Math.ceil(levels / 2) && filledBuys.length > 0) {
      // Vendre le lot acheté au prix le plus bas si profit
      const cheapest = filledBuys.reduce(
        (min: any, o: any) => (parseFloat(o.price) < parseFloat(min.price) ? o : min), filledBuys[0],
      );
      if (currentPrice > parseFloat(cheapest.price) * 1.005) {
        const trade = await this.tradeExecution.executeTrade({
          source: 'grid',
          sourceToken: token,
          targetToken: 'USDC',
          amountIn: parseFloat(cheapest.amount).toFixed(8),
          side: 'sell',
        });
        if (trade.success) {
          await this.prisma.grid_order.update({
            where: { id: cheapest.id },
            data: { status: 'cancelled' },
          });
          await this.prisma.grid_order.create({
            data: {
              config_id: cfg.id,
              side: 'sell',
              price: currentPrice.toString(),
              amount: cheapest.amount,
              status: 'filled',
              tx_hash: trade.txHash,
              filled_at: new Date(),
            },
          });
        }
        results.push({ action: 'sell', price: currentPrice, boughtAt: cheapest.price, trade });
      }
    }

    // Phase 2 : overlay SHORT via GMX quand le prix atteint le HAUT de la fourchette.
    // Symétrique de l'achat spot en bas de grille : au lieu de subir la poussée vers le
    // haut, on ouvre un short pour capter un éventuel retour dans la fourchette.
    // Une seule short overlay par cycle ; cappé par openShortForStrategy (max 3 globaux).
    if (SHORT_ALLOWED_TOKENS.includes(token) && currentPrice >= upper && modulation.active) {
      // Éviter les doublons : ne pas ouvrir un short si une short grid_overlay est déjà vivante.
      const existingOverlay = await this.prisma.leverage_event.findFirst({
        where: { protocol: 'gmx', kind: 'open', detail: { contains: 'SHORT ' + token + ' depuis grid' } },
        orderBy: { created_at: 'desc' },
      }).catch(() => null);
      let overlayActive = false;
      if (existingOverlay) {
        try {
          const p = JSON.parse(existingOverlay.payload);
          if (p?.positionId) {
            const pos = await this.prisma.gmx_position.findUnique({ where: { id: p.positionId } });
            overlayActive = pos ? ['open', 'pending_open', 'simulated'].includes(pos.status) : false;
          }
        } catch {}
      }
      if (!overlayActive) {
        const shortRes = await this.gmx.openShortForStrategy({
          source: 'grid',
          indexToken: token,
          entryPrice: currentPrice,
          reasonNote: `prix $${currentPrice.toFixed(4)} ≥ haut de grille $${upper.toFixed(4)}`,
        });
        results.push({ action: 'grid_short_overlay', price: currentPrice, upper, short: shortRes });
      }
    }

    if (results.length === 0) {
      results.push({ action: 'hold', currentPrice, lower, upper, currentLevel, deployedUsd });
    }
    return { success: true, currentPrice, lower, upper, deployedUsd, budget, results };
  }

  async getStatus(): Promise<any> {
    const cfg = await this.prisma.grid_config.findFirst({ include: { orders: true } });
    const filledBuys = (cfg?.orders || []).filter((o: any) => o.side === 'buy' && o.status === 'filled');
    const deployedUsd = filledBuys.reduce(
      (s: number, o: any) => s + parseFloat(o.amount) * parseFloat(o.price), 0,
    );
    const minPP = await getMinProfitPct(this.prisma, 'grid');
    const estRef = estimateRoundTripCost(GRID_PER_LEVEL_USD, minPP);
    return {
      enabled: this.enabled,
      schedule: '0 */3 * * * * (toutes les 3 min)',
      budgetUsd: GRID_BUDGET_USD,
      perLevelUsd: GRID_PER_LEVEL_USD,
      levels: GRID_LEVELS,
      profitability: {
        min_profit_pct: minPP,
        round_trip_cost_pct_estimate: Number(estRef.costPct.toFixed(3)),
        breakeven_move_pct_estimate: Number(estRef.breakevenPct.toFixed(3)),
        note: 'Les achats de grille sont refusés si le pas de grille (%) ne dépasse pas le seuil de breakeven. Ajustable via app_config: profitability.grid.minProfitPct ou profitability.minProfitPct.',
      },
      deployedUsd,
      config: cfg ? { ...cfg, orders: undefined, openBuys: filledBuys.length } : null,
    };
  }
}
