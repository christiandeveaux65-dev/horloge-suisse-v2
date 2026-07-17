import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OptimizerService } from '../backtest/optimizer.service';

type StrategyName = 'dca' | 'grid' | 'mean_reversion' | 'momentum';

/**
 * Mapping camelCase (search space) -> snake_case (DB column) par stratégie.
 * Types indiqués : 'int' | 'str' pour la conversion Prisma.
 */
const PARAM_MAPPING: Record<StrategyName, Record<string, { col: string; type: 'int' | 'str' }>> = {
  dca: {
    intervalHours:    { col: 'interval_hours',    type: 'int' },
    amountPerBuy:     { col: 'amount_per_buy',    type: 'str' },
    buyThresholdPct:  { col: 'buy_threshold_pct', type: 'int' },
  },
  grid: {
    rangePct:  { col: 'range_pct',   type: 'int' },
    levels:    { col: 'grid_levels', type: 'int' },
    // budgetUsd VOLONTAIREMENT retiré : le budget du grid est gouverné STRICTEMENT par
    // la directive du Strategy Evaluator (applyEvaluatorDirectives). L'optimiseur ne doit
    // plus réinjecter budget_usd (il écrasait la directive avec 5000 → hémorragie USDC).
  },
  mean_reversion: {
    rsiPeriod:     { col: 'rsi_period',     type: 'int' },
    rsiOversold:   { col: 'rsi_oversold',   type: 'int' },
    rsiOverbought: { col: 'rsi_overbought', type: 'int' },
    tradeSizeUsd:  { col: 'trade_size_usd', type: 'str' },
  },
  momentum: {
    emaShort:        { col: 'ma_short',          type: 'int' },
    emaLong:         { col: 'ma_long',           type: 'int' },
    stopLossPct:     { col: 'stop_loss_pct',     type: 'int' },
    trailingStopPct: { col: 'trailing_stop_pct', type: 'int' },
  },
};

@Injectable()
export class OptimizeInjectService {
  private readonly logger = new Logger(OptimizeInjectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly optimizer: OptimizerService,
  ) {}

  private cfgDelegate(strategy: StrategyName): any {
    switch (strategy) {
      case 'dca':            return (this.prisma as any).strategy;
      case 'grid':           return (this.prisma as any).grid_config;
      case 'mean_reversion': return (this.prisma as any).mean_reversion_config;
      case 'momentum':       return (this.prisma as any).momentum_config;
      default: throw new BadRequestException(`Stratégie inconnue : ${strategy}`);
    }
  }

  private async findActiveCfg(strategy: StrategyName): Promise<any> {
    const delegate = this.cfgDelegate(strategy);
    const row = await delegate.findFirst({
      where: { active: true },
      orderBy: { created_at: 'desc' },
    });
    if (!row) throw new NotFoundException(`Aucune config active pour '${strategy}'`);
    return row;
  }

  private extractCurrentParams(strategy: StrategyName, cfg: any): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [camel, { col }] of Object.entries(PARAM_MAPPING[strategy])) {
      out[camel] = cfg[col];
    }
    return out;
  }

  private buildUpdate(strategy: StrategyName, params: Record<string, any>): Record<string, any> {
    const mapping = PARAM_MAPPING[strategy];
    const update: Record<string, any> = {};
    for (const [camel, val] of Object.entries(params ?? {})) {
      const spec = mapping[camel];
      if (!spec) continue; // clé inconnue -> ignorée
      if (val === null || val === undefined) continue;
      update[spec.col] = spec.type === 'int' ? Math.round(Number(val)) : String(val);
    }
    return update;
  }

  /** Applique les meilleurs paramètres d'une optimisation à la config active. */
  async apply(optimizationId: string, strategyOverride?: StrategyName): Promise<any> {
    const opt = await (this.prisma as any).backtest_optimization.findUnique({ where: { id: optimizationId } });
    if (!opt) throw new NotFoundException(`Optimisation introuvable : ${optimizationId}`);

    const strategy: StrategyName = (strategyOverride ?? opt.strategy_type) as StrategyName;
    if (!PARAM_MAPPING[strategy]) throw new BadRequestException(`Stratégie invalide : ${strategy}`);

    const bestParams = JSON.parse(opt.best_params || '{}');
    if (!bestParams || Object.keys(bestParams).length === 0) {
      throw new BadRequestException(`Optimisation ${optimizationId} n'a pas de best_params`);
    }

    const wfe = String(opt.wfe ?? '0');
    const cfg = await this.findActiveCfg(strategy);
    const oldParams = this.extractCurrentParams(strategy, cfg);
    const updateData = this.buildUpdate(strategy, bestParams);

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException(`Aucun paramètre applicable pour '${strategy}' dans best_params`);
    }

    // Désactive les injections précédentes actives pour cette stratégie
    await (this.prisma as any).optimize_injection.updateMany({
      where: { strategy, active: true },
      data: { active: false },
    });

    // Applique les nouveaux params
    const delegate = this.cfgDelegate(strategy);
    await delegate.update({ where: { id: cfg.id }, data: updateData });

    // Log injection
    const injection = await (this.prisma as any).optimize_injection.create({
      data: {
        strategy,
        optimization_id: optimizationId,
        old_params: JSON.stringify(oldParams),
        new_params: JSON.stringify(bestParams),
        wfe,
        action: 'apply',
        active: true,
      },
    });

    const ts = new Date().toISOString();
    this.logger.log(`[${ts}] INJECTION strat=${strategy} opt=${optimizationId} wfe=${wfe} old=${JSON.stringify(oldParams)} new=${JSON.stringify(bestParams)}`);

    return {
      success: true,
      injection_id: injection.id,
      strategy,
      optimization_id: optimizationId,
      old_params: oldParams,
      new_params: bestParams,
      wfe,
      applied_at: ts,
    };
  }

  /** Lance une optimisation bayésienne sur la strat active et applique si WFE >= minWfe. */
  async autoReoptimize(
    strategy: StrategyName,
    minWfe = 1.0,
    maxIterations = 5000,
    patience = 200,
  ): Promise<any> {
    if (!PARAM_MAPPING[strategy]) throw new BadRequestException(`Stratégie invalide : ${strategy}`);
    const ts = new Date().toISOString();
    this.logger.log(`[${ts}] AUTO-REOPT start strat=${strategy} maxIter=${maxIterations} patience=${patience} minWfe=${minWfe}`);

    const dto: any = { strategy, searchMethod: 'bayesian', maxIterations, patience };
    const result = await this.optimizer.optimize(dto);
    const optId: string = result?.id ?? result?.optimizationId;
    const wfe = Number(result?.walkForward?.wfe ?? result?.wfe ?? 0);
    const iterationsUsed = Number(result?.iterationsTested ?? 0);
    const notes = result?.notes ?? '';

    if (!optId) {
      throw new BadRequestException('Optimisation exécutée mais aucun ID retourné');
    }

    this.logger.log(`[${new Date().toISOString()}] AUTO-REOPT done strat=${strategy} wfe=${wfe} iter=${iterationsUsed}/${maxIterations} notes="${notes}"`);

    if (wfe >= minWfe) {
      const applied = await this.apply(optId, strategy);
      return {
        success: true, applied: true, wfe,
        iterations_used: iterationsUsed, max_iterations: maxIterations, patience,
        optimization_id: optId, notes, injection: applied,
      };
    }

    // Log skip
    await (this.prisma as any).optimize_injection.create({
      data: {
        strategy,
        optimization_id: optId,
        old_params: '{}',
        new_params: JSON.stringify(result?.bestParams ?? result?.best_params ?? {}),
        wfe: String(wfe),
        action: 'auto',
        active: false,
        note: `Skipped: WFE ${wfe} < ${minWfe}`,
      },
    });
    this.logger.warn(`[${new Date().toISOString()}] AUTO-REOPT skip apply strat=${strategy} wfe=${wfe} < ${minWfe} iter=${iterationsUsed}/${maxIterations}`);
    return {
      success: true, applied: false, wfe,
      iterations_used: iterationsUsed, max_iterations: maxIterations, patience,
      optimization_id: optId, notes,
      reason: `WFE ${wfe} < ${minWfe}`,
    };
  }

  /** Historique des injections. */
  async injectionHistory(limit = 50, strategy?: string): Promise<any> {
    const where: any = {};
    if (strategy) where.strategy = strategy;
    const rows = await (this.prisma as any).optimize_injection.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: Math.min(Math.max(1, limit), 500),
    });
    return {
      count: rows.length,
      injections: rows.map((r: any) => ({
        id: r.id,
        strategy: r.strategy,
        optimization_id: r.optimization_id || null,
        old_params: JSON.parse(r.old_params || '{}'),
        new_params: JSON.parse(r.new_params || '{}'),
        wfe: r.wfe,
        action: r.action,
        active: r.active,
        note: r.note || null,
        created_at: r.created_at,
      })),
    };
  }

  /** Restaure les paramètres précédents pour une stratégie. */
  async rollback(strategy: StrategyName): Promise<any> {
    if (!PARAM_MAPPING[strategy]) throw new BadRequestException(`Stratégie invalide : ${strategy}`);

    const last = await (this.prisma as any).optimize_injection.findFirst({
      where: { strategy, active: true, action: { in: ['apply', 'auto'] } },
      orderBy: { created_at: 'desc' },
    });
    if (!last) throw new NotFoundException(`Aucune injection active à rollback pour '${strategy}'`);

    const oldParams = JSON.parse(last.old_params || '{}');
    const cfg = await this.findActiveCfg(strategy);
    const currentParams = this.extractCurrentParams(strategy, cfg);
    const updateData = this.buildUpdate(strategy, oldParams);

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException('Anciens paramètres vides ou non mappables');
    }

    const delegate = this.cfgDelegate(strategy);
    await delegate.update({ where: { id: cfg.id }, data: updateData });

    // Marque l'injection précédente comme inactive
    await (this.prisma as any).optimize_injection.update({
      where: { id: last.id },
      data: { active: false },
    });

    // Log rollback
    const rollback = await (this.prisma as any).optimize_injection.create({
      data: {
        strategy,
        optimization_id: last.optimization_id ?? '',
        old_params: JSON.stringify(currentParams),
        new_params: JSON.stringify(oldParams),
        wfe: last.wfe ?? '0',
        action: 'rollback',
        active: false,
        note: `Rollback of injection ${last.id}`,
      },
    });

    const ts = new Date().toISOString();
    this.logger.log(`[${ts}] ROLLBACK strat=${strategy} restored=${JSON.stringify(oldParams)} was=${JSON.stringify(currentParams)}`);

    return {
      success: true,
      rollback_id: rollback.id,
      strategy,
      restored_params: oldParams,
      previous_params: currentParams,
      original_injection_id: last.id,
      rolled_back_at: ts,
    };
  }

  /**
   * Capital total estimé (USD) à partir du dernier lot de snapshots portefeuille.
   * Repli sur $7800 si aucun snapshot n'est disponible.
   */
  private async estimateTotalCapitalUsd(): Promise<number> {
    try {
      const latest = await (this.prisma as any).portfolio_snapshot.findFirst({
        orderBy: { snapshot_at: 'desc' },
        select: { snapshot_at: true },
      });
      if (latest?.snapshot_at) {
        // Fenêtre de 2 min autour du dernier snapshot pour capter tout le lot.
        const from = new Date(new Date(latest.snapshot_at).getTime() - 120000);
        const rows = await (this.prisma as any).portfolio_snapshot.findMany({
          where: { snapshot_at: { gte: from } },
        });
        const total = rows.reduce((s: number, r: any) => s + (parseFloat(r.value_usd) || 0), 0);
        if (total > 0) return total;
      }
    } catch {
      /* snapshots indisponibles : repli */
    }
    return 7800;
  }

  /**
   * FIX 1 — Reconnexion « cerveau → bras ».
   *
   * Lit les directives du Strategy Evaluator (table strategy_directive) et les APPLIQUE
   * réellement aux configs des modules traders :
   *   - active/inactif  → bascule le flag `paused` de la config du module
   *                       (paused=true coupe totalement le module au prochain cycle),
   *   - allocation %    → ajuste `budget_usd` = allocation_pct/100 × capital total
   *                       (pour grid / mean_reversion ; momentum réparti au prorata ;
   *                        dca et arbitrage : bascule paused uniquement).
   *
   * Chaque changement effectif est journalisé « [DIRECTIVE APPLIQUÉE] … ».
   * Idempotent : n'écrit en base que si l'état diffère de la directive.
   */
  async applyEvaluatorDirectives(): Promise<any> {
    const directives = await (this.prisma as any).strategy_directive.findMany();
    if (!directives || directives.length === 0) {
      this.logger.warn('[DIRECTIVE] Aucune directive du Strategy Evaluator à appliquer (table vide).');
      return { applied: [], skipped: [], totalCapitalUsd: 0 };
    }
    const totalCapitalUsd = await this.estimateTotalCapitalUsd();
    const byName = new Map<string, any>(directives.map((d: any) => [d.strategy, d]));

    const applied: any[] = [];
    const unchanged: string[] = [];

    // Délégué + capacité budget par stratégie pilotée.
    const targets: { name: string; delegate: any; hasBudget: boolean; multi?: boolean }[] = [
      { name: 'grid',           delegate: (this.prisma as any).grid_config,           hasBudget: true },
      { name: 'mean_reversion', delegate: (this.prisma as any).mean_reversion_config, hasBudget: true },
      { name: 'momentum',       delegate: (this.prisma as any).momentum_config,       hasBudget: true, multi: true },
      { name: 'dca',            delegate: (this.prisma as any).strategy,              hasBudget: false },
      { name: 'arbitrage',      delegate: (this.prisma as any).arbitrage_config,      hasBudget: false },
    ];

    for (const t of targets) {
      const dir = byName.get(t.name);
      if (!dir) { unchanged.push(`${t.name}(pas de directive)`); continue; }
      const desiredPaused = !dir.recommended_active;
      const allocUsd = Math.round((dir.recommended_allocation_pct / 100) * totalCapitalUsd);

      try {
        const rows = await t.delegate.findMany({ where: { active: true } });
        if (!rows || rows.length === 0) { unchanged.push(`${t.name}(pas de config active)`); continue; }

        // Répartition du budget : configs mono = budget total ; multi = au prorata de
        // l'ancien budget_usd (préserve la ventilation interne, ex. momentum alts vs blue-chips).
        const oldBudgetSum = t.hasBudget
          ? rows.reduce((s: number, r: any) => s + (parseFloat(r.budget_usd) || 0), 0)
          : 0;

        for (const cfg of rows) {
          const data: any = {};
          let changeParts: string[] = [];

          if (cfg.paused !== desiredPaused) {
            data.paused = desiredPaused;
            changeParts.push(`paused ${cfg.paused}→${desiredPaused}`);
          }

          if (t.hasBudget) {
            let target = allocUsd;
            if (t.multi && oldBudgetSum > 0) {
              const share = (parseFloat(cfg.budget_usd) || 0) / oldBudgetSum;
              target = Math.round(allocUsd * share);
            }
            const current = Math.round(parseFloat(cfg.budget_usd) || 0);
            // Seuil de 1 % pour éviter des écritures pour des variations négligeables.
            if (target > 0 && Math.abs(target - current) > Math.max(1, current * 0.01)) {
              data.budget_usd = String(target);
              changeParts.push(`budget $${current}→$${target}`);
            }
          }

          if (Object.keys(data).length > 0) {
            await t.delegate.update({ where: { id: cfg.id }, data });
            const msg = `[DIRECTIVE APPLIQUÉE] ${t.name}${t.multi ? ` (${cfg.name})` : ''}: ` +
              `active=${dir.recommended_active} alloc=${dir.recommended_allocation_pct.toFixed(1)}% ` +
              `(score ${dir.score.toFixed(2)}, régime ${dir.regime}) — ${changeParts.join(', ')}`;
            this.logger.log(msg);
            applied.push({ strategy: t.name, configId: cfg.id, changes: changeParts, reason: dir.reason });
          } else {
            unchanged.push(`${t.name}(déjà conforme)`);
          }
        }
      } catch (e: any) {
        this.logger.error(`[DIRECTIVE] Échec application ${t.name}: ${e.message}`);
      }
    }

    this.logger.log(
      `[DIRECTIVE] Application terminée : ${applied.length} changement(s), ` +
      `${unchanged.length} inchangé(s), capital estimé $${totalCapitalUsd.toFixed(0)}.`,
    );
    return { applied, unchanged, totalCapitalUsd };
  }
}
