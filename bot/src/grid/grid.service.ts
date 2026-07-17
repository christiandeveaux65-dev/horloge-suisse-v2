import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import { GRID_BUDGET_USD, GRID_LEVELS, GRID_PER_LEVEL_USD, GRID_DEFAULT_RANGE_PCT, GRID_MAX_MARGIN_PCT, GRID_TARGET_STEP_PCT, SHORT_ALLOWED_TOKENS, GRID_MAX_OPEN_POSITIONS, GRID_BUY_COOLDOWN_MIN, GRID_SELL_TARGET_PCT, GRID_MIN_BUY_GAP_PCT, GRID_MAX_SELLS_PER_CYCLE } from '../constants';
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
      : GRID_DEFAULT_RANGE_PCT;
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

    // FIX 4 — Resserrement automatique : les configs héritées avaient des pas trop larges
    // (ex. range ±10 % / 4 niveaux → pas 5 %) qui ne se déclenchaient que sur de gros
    // mouvements → grille quasi inactive. On vise un pas ≈ GRID_TARGET_STEP_PCT (~2 %),
    // au-dessus du breakeven (~1.5 %) mais assez serré pour trader souvent. Si le pas natif
    // dépasse largement la cible, on augmente le nombre EFFECTIF de niveaux (borné à 30).
    const baseLevels = cfg.grid_levels || GRID_LEVELS;
    const widthPct = currentPrice > 0 ? ((upper - lower) / currentPrice) * 100 : 0;
    const nativeStepPct = baseLevels > 0 ? widthPct / baseLevels : 0;
    let levels = baseLevels;
    if (nativeStepPct > GRID_TARGET_STEP_PCT * 1.3 && widthPct > 0) {
      levels = Math.min(30, Math.max(baseLevels, Math.ceil(widthPct / GRID_TARGET_STEP_PCT)));
      this.logger.log(
        `[GRID-EVAL] ${token} resserrement : pas natif ${nativeStepPct.toFixed(2)}% → ` +
        `${levels} niveaux effectifs (pas cible ~${GRID_TARGET_STEP_PCT}%, largeur ${widthPct.toFixed(1)}%)`,
      );
    }
    const step = (upper - lower) / levels;
    if (step <= 0) return { success: false, reason: 'fourchette_invalide' };

    // ─── FIX URGENT hémorragie USDC (juillet 2026) ───────────────────────────
    // Positions ouvertes = achats remplis non encore soldés (triées par ancienneté).
    const filledBuys = await this.prisma.grid_order.findMany({
      where: { config_id: cfg.id, side: 'buy', status: 'filled' },
      orderBy: { filled_at: 'asc' },
    });
    const deployedUsd = filledBuys.reduce(
      (s: number, o: any) => s + parseFloat(o.amount) * parseFloat(o.price), 0,
    );

    // Budget STRICT : gouverné par la directive du Strategy Evaluator (allocation %
    // × capital), plus par l'optimiseur. Renvoie 0 si le grid est mis en pause par le
    // Strategy Evaluator → aucun nouvel achat (les ventes de dénouement restent OK).
    const budget = await this.getStrictBudgetUsd(cfg);

    // Pilotage adaptatif (Strategist × Strategy Evaluator) : gate + facteur de taille.
    const modulation = await getStrategyModulation(this.prisma, 'grid');
    let perLevelUsd = Math.min(GRID_PER_LEVEL_USD, budget > 0 ? budget / levels : GRID_PER_LEVEL_USD);
    if (modulation.sizeFactor !== 1) {
      perLevelUsd = Math.min(GRID_PER_LEVEL_USD, perLevelUsd * modulation.sizeFactor);
    }

    const currentLevel = Math.floor((currentPrice - lower) / step);
    const results: any[] = [];

    // ── VENTES D'ABORD : chaque position a sa cible = prix d'achat × (1 + cible %). ──
    // On solde TOUTES les positions gagnantes (cap GRID_MAX_SELLS_PER_CYCLE) pour
    // recycler le USDC et empêcher l'accumulation de WETH. C'était le cœur du bug :
    // l'ancien code ne vendait que la position la moins chère, une seule fois par cycle.
    const soldIds = new Set<string>();
    for (const buyOrder of filledBuys) {
      if (soldIds.size >= GRID_MAX_SELLS_PER_CYCLE) break;
      const buyPrice = parseFloat(buyOrder.price);
      const target = buyPrice * (1 + GRID_SELL_TARGET_PCT / 100);
      if (currentPrice >= target) {
        const trade = await this.tradeExecution.executeTrade({
          source: 'grid',
          sourceToken: token,
          targetToken: 'USDC',
          amountIn: parseFloat(buyOrder.amount).toFixed(8),
          side: 'sell',
        });
        if (trade.success) {
          await this.prisma.grid_order.update({
            where: { id: buyOrder.id },
            data: { status: 'cancelled' },
          });
          await this.prisma.grid_order.create({
            data: {
              config_id: cfg.id,
              side: 'sell',
              price: currentPrice.toString(),
              amount: buyOrder.amount,
              status: 'filled',
              tx_hash: trade.txHash,
              filled_at: new Date(),
            },
          });
          soldIds.add(buyOrder.id);
          const gainPct = ((currentPrice - buyPrice) / buyPrice) * 100;
          this.logger.log(
            `[GRID-SELL] ${token} position clôturée : achat $${buyPrice.toFixed(2)} → vente ` +
            `$${currentPrice.toFixed(2)} (+${gainPct.toFixed(2)}%, cible +${GRID_SELL_TARGET_PCT}%)`,
          );
          results.push({ action: 'sell', price: currentPrice, boughtAt: buyPrice, gainPct: Number(gainPct.toFixed(3)), trade });
        }
      }
    }

    // Positions encore ouvertes après les ventes de ce cycle.
    const openBuys = filledBuys.filter((o: any) => !soldIds.has(o.id));
    const openDeployedUsd = openBuys.reduce(
      (s: number, o: any) => s + parseFloat(o.amount) * parseFloat(o.price), 0,
    );

    // ── ACHAT : au plus UN par cycle, sous garde-fous stricts anti-accumulation. ──
    // Rentabilité du pas de grille (profit d'un cycle = un pas).
    const stepPct = currentPrice > 0 ? (step / currentPrice) * 100 : 0;
    const minPP = Math.min(await getMinProfitPct(this.prisma, 'grid'), GRID_MAX_MARGIN_PCT);
    const est = estimateRoundTripCost(perLevelUsd, minPP);
    const gridProfitable = passesProfitability(stepPct, est);

    // La directive du Strategy Evaluator gouverne l'ouverture : budget=0 (pause) → stop.
    const directiveActive = budget > 0 && modulation.active && !cfg.paused;

    // Garde-fou 1 — plafond de positions ouvertes simultanées.
    const tooManyOpen = openBuys.length >= GRID_MAX_OPEN_POSITIONS;

    // Garde-fou 2 — cooldown : délai minimum depuis le DERNIER achat rempli.
    let cooldownRemainMin = 0;
    if (filledBuys.length > 0) {
      const lastBuy = filledBuys[filledBuys.length - 1];
      if (lastBuy?.filled_at) {
        const minsSince = (Date.now() - new Date(lastBuy.filled_at).getTime()) / 60000;
        if (minsSince < GRID_BUY_COOLDOWN_MIN) cooldownRemainMin = GRID_BUY_COOLDOWN_MIN - minsSince;
      }
    }
    const cooldownActive = cooldownRemainMin > 0;

    // Garde-fou 3 — n'ajoute une position que si le prix a baissé d'au moins
    // GRID_MIN_BUY_GAP_PCT sous la position ouverte la moins chère (grille DCA
    // descendante). S'il n'y a aucune position ouverte, la première entrée est permise.
    let priceGapOk = true;
    if (openBuys.length > 0) {
      const lowestOpen = Math.min(...openBuys.map((o: any) => parseFloat(o.price)));
      priceGapOk = currentPrice <= lowestOpen * (1 - GRID_MIN_BUY_GAP_PCT / 100);
    }

    // Garde-fou 4 — budget STRICT : le capital déployé ne doit jamais dépasser l'allocation.
    const budgetOk = perLevelUsd > 0 && openDeployedUsd + perLevelUsd <= budget;

    if (gridProfitable && directiveActive && !tooManyOpen && !cooldownActive && priceGapOk && budgetOk) {
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
        this.logger.log(
          `[GRID-BUY] ${token} achat $${perLevelUsd.toFixed(2)} @ $${currentPrice.toFixed(2)} — ` +
          `positions ${openBuys.length + 1}/${GRID_MAX_OPEN_POSITIONS}, ` +
          `déployé $${(openDeployedUsd + perLevelUsd).toFixed(0)}/$${budget.toFixed(0)}`,
        );
      }
      results.push({ action: 'buy', level: currentLevel, price: currentPrice, perLevelUsd, trade });
    } else {
      // Traçabilité : pourquoi l'achat a-t-il été bloqué ce cycle ?
      const blocked: string[] = [];
      if (!gridProfitable) blocked.push(`pas ${stepPct.toFixed(2)}% < breakeven ${est.breakevenPct.toFixed(2)}%`);
      if (!directiveActive) blocked.push(budget <= 0 ? 'directive: grid en pause (budget $0)' : 'modulation/pause');
      if (tooManyOpen) blocked.push(`max positions atteint (${openBuys.length}/${GRID_MAX_OPEN_POSITIONS})`);
      if (cooldownActive) blocked.push(`cooldown ${cooldownRemainMin.toFixed(0)}min restants`);
      if (!priceGapOk) blocked.push(`prix pas assez bas (< -${GRID_MIN_BUY_GAP_PCT}% sous position basse)`);
      if (!budgetOk && directiveActive) blocked.push(`budget: $${openDeployedUsd.toFixed(0)}+$${perLevelUsd.toFixed(0)} > $${budget.toFixed(0)}`);
      this.logger.log(
        `[GRID-EVAL] ${token} prix $${currentPrice.toFixed(2)} — positions ${openBuys.length}/${GRID_MAX_OPEN_POSITIONS}, ` +
        `déployé $${openDeployedUsd.toFixed(0)}/$${budget.toFixed(0)}` +
        (blocked.length ? ` — achat bloqué : ${blocked.join(' ; ')}` : ' — achat OK ce cycle'),
      );
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
      results.push({ action: 'hold', currentPrice, lower, upper, currentLevel, deployedUsd: openDeployedUsd });
    }
    return { success: true, currentPrice, lower, upper, deployedUsd: openDeployedUsd, budget, openPositions: openBuys.length, results };
  }

  /**
   * Budget STRICT du grid, gouverné par la directive du Strategy Evaluator (et non plus
   * par l'optimiseur). = allocation recommandée (%) × capital total du portefeuille,
   * plafonné par GRID_BUDGET_USD (garde-fou de sécurité absolu).
   * Renvoie 0 si la directive met le grid en pause (recommended_active=false) → plus
   * aucun nouvel achat, seules les ventes de dénouement restent possibles.
   */
  private async getStrictBudgetUsd(cfg: any): Promise<number> {
    try {
      const dir = await (this.prisma as any).strategy_directive.findFirst({ where: { strategy: 'grid' } });
      if (dir) {
        if (!dir.recommended_active) return 0;
        const capital = await this.estimateTotalCapitalUsd();
        const allocPct = Number(dir.recommended_allocation_pct);
        if (Number.isFinite(allocPct) && allocPct > 0) {
          const allocUsd = (allocPct / 100) * capital;
          return Math.max(0, Math.min(allocUsd, GRID_BUDGET_USD));
        }
      }
    } catch {
      /* directive indisponible : repli sur budget_usd de la config, plafonné */
    }
    const cfgBudget = parseFloat(cfg.budget_usd);
    const base = Number.isFinite(cfgBudget) && cfgBudget > 0 ? cfgBudget : GRID_BUDGET_USD;
    return Math.min(base, GRID_BUDGET_USD);
  }

  /** Capital total estimé (dernier lot de snapshots portefeuille). Repli $7800. */
  private async estimateTotalCapitalUsd(): Promise<number> {
    try {
      const latest = await (this.prisma as any).portfolio_snapshot.findFirst({
        orderBy: { snapshot_at: 'desc' },
        select: { snapshot_at: true },
      });
      if (latest?.snapshot_at) {
        const from = new Date(new Date(latest.snapshot_at).getTime() - 120000);
        const rows = await (this.prisma as any).portfolio_snapshot.findMany({ where: { snapshot_at: { gte: from } } });
        const total = rows.reduce((s: number, r: any) => s + (parseFloat(r.value_usd) || 0), 0);
        if (total > 0) return total;
      }
    } catch {
      /* snapshots indisponibles : repli */
    }
    return 7800;
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
      budgetUsd_safety_ceiling: GRID_BUDGET_USD,
      strictBudgetUsd: cfg ? await this.getStrictBudgetUsd(cfg) : 0,
      perLevelUsd: GRID_PER_LEVEL_USD,
      levels: GRID_LEVELS,
      guards: {
        max_open_positions: GRID_MAX_OPEN_POSITIONS,
        buy_cooldown_min: GRID_BUY_COOLDOWN_MIN,
        sell_target_pct: GRID_SELL_TARGET_PCT,
        min_buy_gap_pct: GRID_MIN_BUY_GAP_PCT,
      },
      profitability: {
        min_profit_pct: minPP,
        round_trip_cost_pct_estimate: Number(estRef.costPct.toFixed(3)),
        breakeven_move_pct_estimate: Number(estRef.breakevenPct.toFixed(3)),
        note: 'Les achats de grille sont refusés si le pas de grille (%) ne dépasse pas le seuil de breakeven. Ajustable via app_config: profitability.grid.minProfitPct ou profitability.minProfitPct.',
      },
      deployedUsd,
      openPositions: filledBuys.length,
      config: cfg ? { ...cfg, orders: undefined, openBuys: filledBuys.length } : null,
    };
  }
}