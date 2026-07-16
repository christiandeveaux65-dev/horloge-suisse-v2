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
    budgetUsd: { col: 'budget_usd',  type: 'str' },
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
}
