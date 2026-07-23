import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { acquireCronRun } from '../common/cron-lock';
import { PrismaService } from '../prisma/prisma.service';
import { MarketIntelligenceService } from '../market/market-intelligence.service';
import { CouplingService } from '../coupling/coupling.service';
import { RiskService } from '../risk/risk.service';
import { GridService } from '../grid/grid.service';
import { FlashLoanService } from '../flash-loan/flash-loan.service';
import { MomentumService } from '../momentum/momentum.service';
import { ArbitrageService } from '../arbitrage/arbitrage.service';
import { GmxService } from '../gmx/gmx.service';
import { MeanReversionService } from '../mean-reversion/mean-reversion.service';
import { BasisTradingService } from '../basis-trading/basis-trading.service';
import { DcaService } from '../dca/dca.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { AaveService } from '../aave/aave.service';
import { StablecoinYieldService } from '../stablecoin-yield/stablecoin-yield.service';
import { StrategistService } from '../strategist/strategist.service';
import { TelegramService } from '../telegram/telegram.service';
import { OptimizeInjectService } from '../optimize-inject/optimize-inject.service';
import { SupervisionService } from '../supervision/supervision.service';
import { StrategyEvaluatorService } from '../strategy-evaluator/strategy-evaluator.service';

/**
 * Fréquences (ms) de chaque module, alignées sur des buckets epoch via acquireCronRun.
 * Un module ne s'exécute que lorsque son bucket temporel change (précision au temps réel,
 * pas de modulo sur un compteur — robuste aux redémarrages/suspensions de conteneur).
 */
export const MODULE_INTERVALS_MS: Record<string, number> = {
  market: 180000, // 3 min (toujours)
  coupling: 1800000, // 30 min
  risk: 300000, // 5 min
  grid: 180000, // 3 min (toujours)
  flash_loan: 180000, // 3 min (toujours)
  momentum: 300000, // 5 min
  arbitrage: 300000, // 5 min
  gmx_monitor: 300000, // 5 min
  mean_reversion: 600000, // 10 min
  basis_trading: 600000, // 10 min
  dca: 10800000, // 3 h
  gmx: 14400000, // 4 h
  portfolio: 900000, // 15 min
  portfolio_ledger: 1800000, // 30 min
  aave: 900000, // 15 min
  stablecoin_yield: 1800000, // 30 min
  strategist: 14400000, // 4 h
  telegram_summary: 21600000, // 6 h
  auto_reoptimize: 3600000, // 1 h
  supervision: 300000, // 5 min
  strategy_evaluator: 900000, // 15 min
  apply_directives: 180000, // 3 min (chaque cycle pipeline)
  maintenance: 86400000, // 24 h — purge des tables historiques (anti-croissance illimitée)
};

/**
 * Rétention (en jours) par table historique purgée par le module `maintenance`.
 * price_history : 7 j (déjà borné aussi à 500 entrées/token par PriceService) ;
 * les tables analytiques/décisionnelles : 30 j.
 */
export const RETENTION_DAYS: Record<string, number> = {
  price_history: 7,
  risk_metric: 30,
  arbitrage_opportunity: 30,
  coupling_decision: 30,
  strategy_evaluation: 30,
};

function humanFreq(ms: number): string {
  if (ms % 3600000 === 0) return `${ms / 3600000}h`;
  return `${ms / 60000}min`;
}

@Injectable()
export class PipelineOrchestrator {
  private readonly logger = new Logger('PipelineOrchestrator');

  private running = false;
  private cycleCount = 0;
  private lastCycleMs = 0;
  private lastCycleAt: string | null = null;
  private currentPhase: string | null = null;
  private lastModulesExecuted: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly market: MarketIntelligenceService,
    private readonly coupling: CouplingService,
    private readonly risk: RiskService,
    private readonly grid: GridService,
    private readonly flashLoan: FlashLoanService,
    private readonly momentum: MomentumService,
    private readonly arbitrage: ArbitrageService,
    private readonly gmx: GmxService,
    private readonly meanReversion: MeanReversionService,
    private readonly basisTrading: BasisTradingService,
    private readonly dca: DcaService,
    private readonly portfolio: PortfolioService,
    private readonly aave: AaveService,
    private readonly stablecoinYield: StablecoinYieldService,
    private readonly strategist: StrategistService,
    private readonly telegram: TelegramService,
    private readonly optimizeInject: OptimizeInjectService,
    private readonly supervision: SupervisionService,
    private readonly strategyEvaluator: StrategyEvaluatorService,
  ) {}

  /** UNIQUE @Cron du système : toutes les 3 minutes. Remplace les 18 @Cron individuels. */
  @Cron('0 */3 * * * *', { timeZone: 'Europe/Paris', name: 'pipeline' })
  async cron(): Promise<void> {
    await this.runPipeline();
  }

  /**
   * Exécute UN cycle complet du pipeline, SÉQUENTIELLEMENT (await), dans l'ordre :
   * OBSERVER → ANALYSER → EXÉCUTER → MESURER → STRATÉGIE → RAPPORT → OPTIMISER.
   * @param opts.force   ignore le gating de fréquence (exécute tous les modules dus ou non)
   * @param opts.skipReopt  saute la Phase 7 (optimisation lourde) — utile pour tests
   */
  async runPipeline(opts?: { force?: boolean; skipReopt?: boolean }): Promise<void> {
    const force = opts?.force ?? false;
    const skipReopt = opts?.skipReopt ?? false;

    if (this.running) {
      this.logger.warn('[PIPELINE] ⚠️ Cycle précédent encore en cours — tick ignoré (anti-overlap)');
      return;
    }
    this.running = true;
    const cycleStart = Date.now();
    this.cycleCount++;
    const cycleNo = this.cycleCount;
    const executed: string[] = [];
    const failed: string[] = [];
    this.logger.log(`[PIPELINE] === Cycle #${cycleNo} début ===`);

    const due = async (name: string): Promise<boolean> =>
      force || (await acquireCronRun(this.prisma, name, MODULE_INTERVALS_MS[name]));

    const run = async (name: string, phase: string, fn: () => Promise<any>): Promise<void> => {
      if (!(await due(name))) return;
      this.currentPhase = phase;
      const t0 = Date.now();
      try {
        await fn();
        executed.push(name);
        this.logger.log(`[PIPELINE] ${phase}: ${name} ✅ (${Date.now() - t0}ms)`);
      } catch (e: any) {
        failed.push(name);
        this.logger.error(`[PIPELINE] ${phase}: ${name} ❌ ${e?.message} (${Date.now() - t0}ms)`);
      }
    };

    try {
      // ─── Phase 1 OBSERVER ───
      await run('market', 'Phase 1 OBSERVER', () => this.market.tick());

      // ─── Phase 2 ANALYSER ───
      await run('coupling', 'Phase 2 ANALYSER', () => this.coupling.tick());
      await run('risk', 'Phase 2 ANALYSER', () => this.risk.tick());

      // ─── Phase 3 EXÉCUTER (uniquement si le Risk Manager n'a pas mis en pause) ───
      const paused = await this.risk.isPaused().catch(() => false);
      if (paused) {
        this.currentPhase = 'Phase 3 EXÉCUTER';
        this.logger.warn('[PIPELINE] Phase 3 EXÉCUTER: BLOQUÉ (globalPaused=true)');
      } else {
        await run('grid', 'Phase 3 EXÉCUTER', () => this.grid.tick());
        await run('flash_loan', 'Phase 3 EXÉCUTER', () => this.flashLoan.tick());
        await run('momentum', 'Phase 3 EXÉCUTER', () => this.momentum.tick());
        await run('arbitrage', 'Phase 3 EXÉCUTER', () => this.arbitrage.tick());
        await run('gmx_monitor', 'Phase 3 EXÉCUTER', () => this.gmx.tickMonitor());
        await run('mean_reversion', 'Phase 3 EXÉCUTER', () => this.meanReversion.tick());
        await run('basis_trading', 'Phase 3 EXÉCUTER', () => this.basisTrading.tick());
        await run('dca', 'Phase 3 EXÉCUTER', () => this.dca.tick());
        await run('gmx', 'Phase 3 EXÉCUTER', () => this.gmx.tick());
      }

      // ─── Phase 4 MESURER ───
      await run('portfolio', 'Phase 4 MESURER', () => this.portfolio.tick());

      // Supervision proactive — surveille APRÈS le portfolio (drawdown, latence, trades
      // échoués, taux d'erreur des modules du cycle courant) et déclenche auto-pause/alertes.
      if (await due('supervision')) {
        this.currentPhase = 'Phase 4 MESURER';
        const t0 = Date.now();
        try {
          await this.supervision.tick({ modulesExecuted: [...executed], modulesFailed: [...failed] });
          executed.push('supervision');
          this.logger.log(`[PIPELINE] Phase 4 MESURER: supervision ✅ (${Date.now() - t0}ms)`);
        } catch (e: any) {
          failed.push('supervision');
          this.logger.error(`[PIPELINE] Phase 4 MESURER: supervision ❌ ${e?.message} (${Date.now() - t0}ms)`);
        }
      }

      await run('portfolio_ledger', 'Phase 4 MESURER', () => this.portfolio.tickLedger());
      await run('aave', 'Phase 4 MESURER', () => this.aave.tick());
      await run('stablecoin_yield', 'Phase 4 MESURER', () => this.stablecoinYield.tick());

      // ─── Phase 5bis ÉVALUATION — scoring des stratégies (entre supervision et strategist) ───
      await run('strategy_evaluator', 'Phase 5bis ÉVALUATION', () => this.strategyEvaluator.tick());

      // ─── Phase 5ter DIRECTIVES — FIX 1 : reconnexion « cerveau → bras » ───
      // Applique RÉELLEMENT les directives du Strategy Evaluator aux configs des modules
      // (active/paused + budget_usd). Exécutée à CHAQUE cycle (et non plus reléguée à
      // l'auto-réoptimisation horaire) pour que les bras suivent le cerveau sans délai.
      await run('apply_directives', 'Phase 5ter DIRECTIVES', () => this.optimizeInject.applyEvaluatorDirectives());

      // ─── Phase 5 STRATÉGIE ───
      await run('strategist', 'Phase 5 STRATÉGIE', () => this.strategist.tick());

      // ─── Phase 6 RAPPORT ───
      await run('telegram_summary', 'Phase 6 RAPPORT', () => this.telegram.tickSummary());

      // ─── Maintenance quotidienne : purge des tables historiques ───
      await run('maintenance', 'Phase 6 RAPPORT', () => this.runMaintenance());

      // ─── Phase 7 OPTIMISER ───
      if (!skipReopt && (await due('auto_reoptimize'))) {
        this.currentPhase = 'Phase 7 OPTIMISER';
        for (const strat of ['grid', 'mean_reversion', 'momentum', 'dca'] as const) {
          const t0 = Date.now();
          try {
            await this.optimizeInject.autoReoptimize(strat, 0.5, 5000, 200);
            executed.push(`auto_reoptimize:${strat}`);
            this.logger.log(`[PIPELINE] Phase 7 OPTIMISER: auto_reoptimize(${strat}) ✅ (${Date.now() - t0}ms)`);
          } catch (e: any) {
            this.logger.error(`[PIPELINE] Phase 7 OPTIMISER: auto_reoptimize(${strat}) ❌ ${e?.message} (${Date.now() - t0}ms)`);
          }
        }
      }
    } finally {
      this.lastModulesExecuted = executed;
      this.lastCycleMs = Date.now() - cycleStart;
      this.lastCycleAt = new Date().toISOString();
      this.currentPhase = null;
      this.running = false;
      this.logger.log(`[PIPELINE] === Cycle #${cycleNo} terminé (${this.lastCycleMs}ms total) ===`);
    }
  }

  /**
   * Purge périodique des tables historiques pour éviter leur croissance illimitée.
   * Supprime les enregistrements plus vieux que RETENTION_DAYS[table]. Idempotent et
   * sûr (chaque suppression isolée dans son propre try/catch). Colonnes de date
   * spécifiques à chaque table.
   */
  async runMaintenance(): Promise<void> {
    const now = Date.now();
    const cutoff = (days: number) => new Date(now - days * 86400000);
    const results: string[] = [];

    const purge = async (
      label: string,
      fn: () => Promise<{ count: number }>,
    ): Promise<void> => {
      try {
        const { count } = await fn();
        results.push(`${label}=${count}`);
      } catch (e: any) {
        this.logger.warn(`[MAINTENANCE] purge ${label} échouée: ${e?.message}`);
      }
    };

    await purge('price_history', () =>
      this.prisma.price_history.deleteMany({
        where: { recorded_at: { lt: cutoff(RETENTION_DAYS.price_history) } },
      }),
    );
    await purge('risk_metric', () =>
      this.prisma.risk_metric.deleteMany({
        where: { computed_at: { lt: cutoff(RETENTION_DAYS.risk_metric) } },
      }),
    );
    await purge('arbitrage_opportunity', () =>
      this.prisma.arbitrage_opportunity.deleteMany({
        where: { detected_at: { lt: cutoff(RETENTION_DAYS.arbitrage_opportunity) } },
      }),
    );
    await purge('coupling_decision', () =>
      this.prisma.coupling_decision.deleteMany({
        where: { created_at: { lt: cutoff(RETENTION_DAYS.coupling_decision) } },
      }),
    );
    await purge('strategy_evaluation', () =>
      this.prisma.strategy_evaluation.deleteMany({
        where: { created_at: { lt: cutoff(RETENTION_DAYS.strategy_evaluation) } },
      }),
    );

    this.logger.log(`[MAINTENANCE] Purge tables historiques — supprimés: ${results.join(', ')}`);
  }

  getStatus() {
    return {
      running: this.running,
      cycleCount: this.cycleCount,
      lastCycleMs: this.lastCycleMs,
      lastCycleAt: this.lastCycleAt,
      currentPhase: this.currentPhase,
      modulesExecuted: this.lastModulesExecuted,
      nextModuleFrequencies: Object.fromEntries(
        Object.entries(MODULE_INTERVALS_MS).map(([k, v]) => [k, humanFreq(v)]),
      ),
    };
  }
}
