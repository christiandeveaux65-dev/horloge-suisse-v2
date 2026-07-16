import {
  Controller, Get, Post, Put, Delete, Body, Query, Param, UseGuards,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiQuery, ApiParam } from '@nestjs/swagger';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { SellDto } from './dto/sell.dto';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { DcaService } from '../dca/dca.service';
import { MomentumService } from '../momentum/momentum.service';
import { MeanReversionService } from '../mean-reversion/mean-reversion.service';
import { RiskService } from '../risk/risk.service';
import { CouplingService } from '../coupling/coupling.service';
import { MarketIntelligenceService } from '../market/market-intelligence.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { GridService } from '../grid/grid.service';
import { ArbitrageService } from '../arbitrage/arbitrage.service';
import { GmxService } from '../gmx/gmx.service';
import { AaveService } from '../aave/aave.service';
import { StrategistService } from '../strategist/strategist.service';
import { FlashLoanService } from '../flash-loan/flash-loan.service';
import { BasisTradingService } from '../basis-trading/basis-trading.service';
import { StablecoinYieldService } from '../stablecoin-yield/stablecoin-yield.service';
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { PipelineOrchestrator } from '../pipeline/pipeline.orchestrator';
import { TOKENS, STABLECOINS } from '../constants';

@ApiTags('Bot Trading — L\'Horloge Suisse v2')
@ApiHeader({ name: 'x-api-key', required: false, description: 'Clé API (optionnelle en mode dev)' })
@UseGuards(ApiKeyGuard)
@Controller('api')
export class ApiController {
  private readonly logger = new Logger(ApiController.name);

  constructor(
    private readonly tradeExecution: TradeExecutionService,
    private readonly dca: DcaService,
    private readonly momentum: MomentumService,
    private readonly meanReversion: MeanReversionService,
    private readonly risk: RiskService,
    private readonly coupling: CouplingService,
    private readonly marketIntel: MarketIntelligenceService,
    private readonly portfolio: PortfolioService,
    private readonly grid: GridService,
    private readonly arbitrage: ArbitrageService,
    private readonly gmx: GmxService,
    private readonly aave: AaveService,
    private readonly strategist: StrategistService,
    private readonly flashLoan: FlashLoanService,
    private readonly basisTrading: BasisTradingService,
    private readonly stablecoinYield: StablecoinYieldService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly pipeline: PipelineOrchestrator,
  ) {}

  // ─── ADMIN — SECRETS RUNTIME ───

  @Post('admin/secrets')
  @ApiOperation({ summary: 'Injecte WALLET_PRIVATE_KEY (et RPC_URL) à chaud pour sortir du DRY-RUN. Secrets JAMAIS logués ni renvoyés.' })
  async setSecrets(@Body() body: { wallet_private_key?: string; rpc_url?: string }) {
    if (!body?.wallet_private_key || typeof body.wallet_private_key !== 'string' || body.wallet_private_key.length < 32) {
      throw new HttpException('wallet_private_key manquant ou invalide', HttpStatus.BAD_REQUEST);
    }
    // Écriture dans process.env : ne JAMAIS logger la valeur.
    process.env.WALLET_PRIVATE_KEY = body.wallet_private_key;
    if (body.rpc_url && typeof body.rpc_url === 'string') {
      process.env.ARBITRUM_RPC_URL = body.rpc_url;
    }
    const state = this.blockchain.reinitialize();
    this.logger.log(`Secrets admin mis à jour (wallet=${state.walletConfigured ? '✓' : '✗'}, rpc=${state.rpcConfigured ? '✓' : 'default'}, dryRun=${state.isDryRun})`);
    return { success: true, ...state };
  }

  @Get('admin/dry-run-status')
  @ApiOperation({ summary: 'État de configuration des secrets runtime (aucune valeur renvoyée).' })
  async getDryRunStatus() {
    return {
      isDryRun: this.blockchain.getIsDryRun(),
      walletConfigured: !!process.env.WALLET_PRIVATE_KEY,
      rpcConfigured: !!process.env.ARBITRUM_RPC_URL,
    };
  }

  // ─── SANTÉ / HEALTHCHECK ───

  @Get('health')
  @ApiOperation({ summary: 'Healthcheck léger du service (liveness)' })
  async getHealth() {
    let dbOk = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch { /* db indisponible */ }
    return {
      status: dbOk ? 'ok' : 'degraded',
      service: "L'Horloge Suisse v2",
      database: dbOk ? 'connected' : 'unreachable',
      isDryRun: this.blockchain.getIsDryRun(),
      timestamp: new Date().toISOString(),
    };
  }

  // ─── NOTIFICATIONS TELEGRAM ───

  @Post('telegram/test')
  @ApiOperation({ summary: 'Envoie un message de test Telegram (vérifie la configuration)' })
  async telegramTest() {
    if (!this.telegram.enabled) {
      throw new HttpException('Telegram non configuré (token/chat_id manquants)', HttpStatus.SERVICE_UNAVAILABLE);
    }
    await this.telegram.sendMessage(
      `🧪 <b>Test Telegram — L'Horloge Suisse v2</b>\nSi vous recevez ce message, les notifications fonctionnent ✅`,
    );
    return { success: true, message: 'Message de test envoyé' };
  }

  @Post('telegram/summary')
  @ApiOperation({ summary: 'Déclenche manuellement le résumé périodique Telegram (utilisable par un cron externe)' })
  async telegramSummary() {
    await this.telegram.sendSummary();
    return { success: true, message: 'Résumé envoyé' };
  }

  // ─── ÉTAT GLOBAL ───

  @Get('status')
  @ApiOperation({ summary: 'État global du bot' })
  async getStatus() {
    const isDryRun = this.blockchain.getIsDryRun();
    const riskStatus = await this.risk.getStatus();
    const modules = {
      dca: this.dca.isEnabled(),
      momentum: this.momentum.isEnabled(),
      mean_reversion: this.meanReversion.isEnabled(),
      risk: this.risk.isEnabled(),
      coupling: this.coupling.isEnabled(),
      market_intelligence: this.marketIntel.isEnabled(),
      portfolio: this.portfolio.isEnabled(),
      grid: this.grid.isEnabled(),
      arbitrage: this.arbitrage.isEnabled(),
      gmx: this.gmx.isEnabled(),
      aave: this.aave.isEnabled(),
      strategist: this.strategist.isEnabled(),
    };

    return {
      status: 'running',
      version: 'v2.0.0',
      name: "L'Horloge Suisse",
      isDryRun,
      globalPaused: riskStatus.config?.global_paused ?? false,
      modules,
      portfolioValue: riskStatus.portfolioValue,
      drawdownPct: riskStatus.drawdownPct,
      timestamp: new Date(),
    };
  }

  // ─── PORTEFEUILLE ───

  @Get('portfolio')
  @ApiOperation({ summary: 'Portefeuille complet avec PnL' })
  async getPortfolio() {
    return this.portfolio.getPortfolio();
  }

  // ─── TRADES ───

  @Get('trades')
  @ApiOperation({ summary: 'Historique des trades' })
  @ApiQuery({ name: 'source', required: false })
  @ApiQuery({ name: 'token', required: false })
  @ApiQuery({ name: 'dateFrom', required: false })
  @ApiQuery({ name: 'dateTo', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  async getTrades(
    @Query('source') source?: string,
    @Query('token') token?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const where: any = {};
    if (source) where.source = source;
    if (token) {
      where.OR = [
        { source_token: token.toUpperCase() },
        { target_token: token.toUpperCase() },
      ];
    }
    if (dateFrom || dateTo) {
      where.executed_at = {};
      if (dateFrom) where.executed_at.gte = new Date(dateFrom);
      if (dateTo) where.executed_at.lte = new Date(dateTo);
    }

    const trades = await this.prisma.trade.findMany({
      where,
      orderBy: { executed_at: 'desc' },
      take: Math.min(parseInt(limit || '50', 10), 500),
      skip: parseInt(offset || '0', 10),
    });

    const total = await this.prisma.trade.count({ where });

    return { trades, total };
  }

  // ─── VENTE MANUELLE ───

  @Post('sell')
  @ApiOperation({ summary: 'Vente manuelle d\'urgence' })
  async manualSell(@Body() body: SellDto) {
    const token = body.token.toUpperCase();
    const amount = body.amount ?? 'all';
    const slippage = body.slippage ?? 100;

    try {
      return await this.tradeExecution.manualSell(token, amount, slippage);
    } catch (err: any) {
      throw new HttpException(err.message, HttpStatus.BAD_REQUEST);
    }
  }

  // ─── WALLET LEDGER (mouvements de fonds externes — leçon #7) ───

  @Get('wallet-ledger')
  @ApiOperation({ summary: 'Mouvements de fonds externes détectés (dépôts/retraits non initiés par le bot)' })
  @ApiQuery({ name: 'limit', required: false })
  async getWalletLedger(@Query('limit') limit?: string) {
    return this.portfolio.getWalletLedger(parseInt(limit || '100', 10));
  }

  // ─── EXPORT ───

  @Get('export')
  @ApiOperation({ summary: 'Export JSON complet' })
  async exportAll() {
    const [trades, strategies, riskConfig, riskEvents, snapshots, regimes] = await Promise.all([
      this.prisma.trade.findMany({ orderBy: { executed_at: 'desc' }, take: 1000 }),
      this.prisma.strategy.findMany(),
      this.prisma.risk_config.findFirst(),
      this.prisma.risk_event.findMany({ orderBy: { created_at: 'desc' }, take: 100 }),
      this.prisma.portfolio_snapshot.findMany({ orderBy: { snapshot_at: 'desc' }, take: 500 }),
      this.prisma.market_regime.findMany({ orderBy: { recorded_at: 'desc' }, take: 200 }),
    ]);

    return {
      exported_at: new Date(),
      trades,
      strategies,
      riskConfig,
      riskEvents,
      snapshots,
      regimes,
    };
  }



  // ─── PRIX ───

  @Get('prices')
  @ApiOperation({ summary: 'Prix actuels de tous les tokens' })
  async getPrices() {
    const allTokens = Object.keys(TOKENS).filter((t) => t !== 'USDC');
    const prices = await this.priceService.getPrices(allTokens);
    return { prices, timestamp: new Date() };
  }

  // ─── CRONS MANAGEMENT ───

  @Get('crons/status')
  @ApiOperation({ summary: 'État de tous les crons' })
  async getCronsStatus() {
    return {
      crons: {
        dca: { enabled: this.dca.isEnabled(), schedule: 'toutes les 3 h' },
        momentum: { enabled: this.momentum.isEnabled(), schedule: '*/5 min' },
        mean_reversion: { enabled: this.meanReversion.isEnabled(), schedule: '*/10 min' },
        risk: { enabled: this.risk.isEnabled(), schedule: '*/5 min (CRITIQUE)' },
        coupling: { enabled: this.coupling.isEnabled(), schedule: '*/30 min' },
        market: { enabled: this.marketIntel.isEnabled(), schedule: '*/10 min' },
        portfolio: { enabled: this.portfolio.isEnabled(), schedule: '*/15 min (+ ledger */30 min)' },
        grid: { enabled: this.grid.isEnabled(), schedule: '*/3 min' },
        arbitrage: { enabled: this.arbitrage.isEnabled(), schedule: '*/5 min' },
        gmx: { enabled: this.gmx.isEnabled(), schedule: 'toutes les 4 h' },
        aave: { enabled: this.aave.isEnabled(), schedule: '*/15 min' },
        strategist: { enabled: this.strategist.isEnabled(), schedule: 'toutes les 4 h' },
        flash_loan: { enabled: this.flashLoan.isEnabled(), schedule: '*/3 min' },
        basis_trading: { enabled: this.basisTrading.isEnabled(), schedule: '*/10 min' },
        stablecoin_yield: { enabled: this.stablecoinYield.isEnabled(), schedule: '*/30 min' },
      },
    };
  }

  @Get('crons')
  @ApiOperation({
    summary: 'Liste RÉELLE de tous les crons internes (état du planificateur NestJS)',
    description:
      'Interroge directement le SchedulerRegistry de NestJS : indique pour chaque cron s\'il tourne, ' +
      'sa dernière exécution et sa prochaine exécution. Permet de vérifier que le planificateur est bien actif.',
  })
  async getCrons() {
    // Métadonnées lisibles par cron (intervalle + rôle + capacité à trader réellement)
    const meta: Record<string, { schedule: string; role: string; trades: string }> = {
      dca:              { schedule: 'toutes les 3 h',  role: 'Achats programmés (DCA)',                    trades: 'oui' },
      momentum:         { schedule: '*/5 min',         role: 'Suivi de tendance',                          trades: 'oui' },
      mean_reversion:   { schedule: '*/10 min',        role: 'Retour à la moyenne (RSI)',                  trades: 'oui (si RSI extrême)' },
      risk:             { schedule: '*/5 min',         role: 'Risk Manager (CRITIQUE)',                    trades: 'protection (circuit breaker / stop)' },
      coupling:         { schedule: '*/30 min',        role: 'Modulateur de régime de marché',             trades: 'non (ajuste les multiplicateurs)' },
      market:           { schedule: '*/10 min',        role: 'Intelligence de marché',                     trades: 'non (analyse)' },
      portfolio:        { schedule: '*/15 min',        role: 'Snapshot portefeuille',                      trades: 'non (mesure)' },
      portfolio_ledger: { schedule: '*/30 min',        role: 'Détection mouvements wallet',                trades: 'non (journalisation)' },
      grid:             { schedule: '*/3 min',         role: 'Grid trading',                               trades: 'oui (si prix franchit un niveau)' },
      arbitrage:        { schedule: '*/5 min',         role: 'Arbitrage DEX',                              trades: 'oui (si spread rentable & sain)' },
      gmx:              { schedule: 'toutes les 4 h',  role: 'Perp GMX (adoption + ouverture)',            trades: 'oui (ouverture position)' },
      gmx_monitor:      { schedule: '*/5 min',         role: 'Surveillance rapprochée positions GMX',      trades: 'oui (SL/TP/trailing)' },
      aave:             { schedule: '*/15 min',        role: 'Boucle Aave + surveillance Health Factor',   trades: 'oui (rebalancing HF)' },
      strategist:       { schedule: 'toutes les 4 h',  role: 'Stratège global (allocation)',               trades: 'non (recommande)' },
      flash_loan:       { schedule: '*/3 min',         role: 'Flash-loan (MVP détection)',                 trades: 'non (scan+log, exécuteur non branché)' },
      basis_trading:    { schedule: '*/10 min',        role: 'Basis trading (MVP détection)',              trades: 'non (détecte+log, plomberie GMX/spot à venir)' },
      stablecoin_yield: { schedule: '*/30 min',        role: 'Rotation de rendement stablecoin (MVP)',     trades: 'non (compare+log, rotation non branchée)' },
      telegram_summary: { schedule: 'toutes les 6 h',  role: 'Résumé périodique Telegram',                 trades: 'non (notification)' },
      supervision:      { schedule: '*/5 min',         role: 'Supervision proactive (auto-pause + alertes)', trades: 'non (surveillance + auto-pause)' },
    };

    // Depuis la refonte : UN SEUL @Cron interne (« pipeline ») orchestre TOUS les modules
    // séquentiellement toutes les 3 min. On lit son état réel dans le SchedulerRegistry.
    const jobs = this.schedulerRegistry.getCronJobs();
    let pipelineCron: any = { name: 'pipeline', running: false, schedule: '*/3 min', lastRun: null, nextRun: null };
    jobs.forEach((job: any, name: string) => {
      if (name !== 'pipeline') return;
      let nextRun: string | null = null;
      let lastRun: string | null = null;
      try {
        const nd = job.nextDate?.();
        nextRun = nd ? (typeof nd.toISO === 'function' ? nd.toISO() : new Date(nd).toISOString()) : null;
      } catch { /* ignore */ }
      try {
        const ld = job.lastDate?.() ?? job.lastExecution;
        lastRun = ld ? new Date(ld).toISOString() : null;
      } catch { /* ignore */ }
      pipelineCron = { name: 'pipeline', running: job.running ?? true, schedule: '*/3 min', lastRun, nextRun };
    });

    const status = this.pipeline.getStatus();
    const freqs = status.nextModuleFrequencies as Record<string, string>;

    // Détail par module : rôle + fréquence effective (gérée par le pipeline) + état activé.
    const enabledMap: Record<string, boolean> = {
      dca: this.dca.isEnabled(), momentum: this.momentum.isEnabled(),
      mean_reversion: this.meanReversion.isEnabled(), risk: this.risk.isEnabled(),
      coupling: this.coupling.isEnabled(), market: this.marketIntel.isEnabled(),
      portfolio: this.portfolio.isEnabled(), portfolio_ledger: this.portfolio.isEnabled(),
      grid: this.grid.isEnabled(), arbitrage: this.arbitrage.isEnabled(),
      gmx: this.gmx.isEnabled(), gmx_monitor: this.gmx.isEnabled(),
      aave: this.aave.isEnabled(), strategist: this.strategist.isEnabled(),
      flash_loan: this.flashLoan.isEnabled(), basis_trading: this.basisTrading.isEnabled(),
      stablecoin_yield: this.stablecoinYield.isEnabled(),
    };

    const modules = Object.keys(meta).map((name) => ({
      name,
      role: meta[name].role,
      trades: meta[name].trades,
      frequency: freqs[name] ?? meta[name].schedule,
      enabled: enabledMap[name] ?? true,
      lastCycleExecuted: status.modulesExecuted.includes(name),
    })).sort((a, b) => a.name.localeCompare(b.name));

    return {
      architecture: 'pipeline_sequentiel',
      note:
        'Depuis la refonte, un UNIQUE cron interne (« pipeline ») exécute tous les modules ' +
        'SÉQUENTIELLEMENT toutes les 3 min (OBSERVER → ANALYSER → EXÉCUTER → MESURER → STRATÉGIE → ' +
        'RAPPORT → OPTIMISER). La fréquence de chaque module est respectée via des buckets temporels. ' +
        'Voir GET /api/pipeline/status pour le détail du dernier cycle. Un cron externe (keepalive) ' +
        'appelle POST /api/tick toutes les 5 min pour empêcher la mise en veille du conteneur.',
      pipelineCron,
      pipelineStatus: {
        cycleCount: status.cycleCount,
        lastCycleMs: status.lastCycleMs,
        lastCycleAt: status.lastCycleAt,
        currentPhase: status.currentPhase,
        running: status.running,
      },
      moduleCount: modules.length,
      modules,
      timestamp: new Date().toISOString(),
    };
  }

  @Post(['risk/resume', 'resume'])
  @ApiOperation({
    summary: 'Reprise manuelle après une pause protectrice (circuit breaker / drawdown)',
    description:
      'Lève la pause globale UNIQUEMENT si le drawdown réel actuel est sous le seuil max. ' +
      'Le Risk Manager reste actif — cet endpoint ne le désactive jamais. ' +
      'Accessible via /api/risk/resume ou l\'alias /api/resume.',
  })
  async riskResume() {
    const res = await this.risk.manualResume();
    if (!res.resumed) {
      throw new HttpException(
        { message: 'Reprise refusée', ...res },
        res.reason === 'drawdown_reel_dangereux' ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST,
      );
    }
    return { success: true, ...res };
  }

  @Post('tick')
  @ApiOperation({
    summary: 'Keepalive — maintient le conteneur actif (appelé par un cron externe toutes les 5 min)',
    description:
      'Endpoint léger destiné à un cron externe. Empêche la mise en veille automatique du conteneur ' +
      '(après ~1 h d\'inactivité) afin que tous les crons internes continuent de tourner 24/7.',
  })
  async tick() {
    const jobs = this.schedulerRegistry.getCronJobs();
    return {
      alive: true,
      cronsRegistered: jobs.size,
      timestamp: new Date().toISOString(),
    };
  }

  // Le Risk Manager est le gardien critique : toute tentative de suppression ou de
  // modification directe via l'API est REFUSÉE (HTTP 403). Il n'est pilotable que par
  // sa propre logique interne (leçon #3).
  @Delete('risk-manager')
  @ApiOperation({ summary: 'REFUSÉ (403) — le Risk Manager ne peut pas être supprimé' })
  async deleteRiskManager() {
    this.logger.warn('🚫 Tentative de SUPPRESSION du Risk Manager REFUSÉE (403)');
    throw new HttpException(
      'Le Risk Manager est le gardien critique et ne peut pas être supprimé ni désactivé',
      HttpStatus.FORBIDDEN,
    );
  }

  @Put('risk-manager')
  @ApiOperation({ summary: 'REFUSÉ (403) — le Risk Manager ne peut pas être désactivé/reconfiguré via l\'API' })
  async updateRiskManager() {
    this.logger.warn('🚫 Tentative de MODIFICATION directe du Risk Manager REFUSÉE (403)');
    throw new HttpException(
      'Le Risk Manager est le gardien critique et ne peut pas être désactivé ni reconfiguré via l\'API',
      HttpStatus.FORBIDDEN,
    );
  }

  @Post('crons/toggle/:module')
  @ApiOperation({ summary: 'Activer/désactiver un cron' })
  @ApiParam({ name: 'module', enum: ['dca', 'momentum', 'mean_reversion', 'risk', 'coupling', 'market', 'portfolio', 'grid', 'arbitrage', 'gmx', 'aave', 'strategist', 'flash_loan', 'basis_trading', 'stablecoin_yield'] })
  async toggleCron(@Param('module') module: string) {
    let service: { isEnabled: () => boolean; setEnabled: (v: boolean) => void } | null = null;

    // Le Risk Manager NE PEUT JAMAIS être désactivé (gardien critique — leçon #3)
    if (module === 'risk') {
      this.logger.warn('🚫 Tentative de désactivation du Risk Manager REFUSÉE');
      throw new HttpException(
        'Le Risk Manager est le gardien critique et ne peut pas être désactivé',
        HttpStatus.FORBIDDEN,
      );
    }

    switch (module) {
      case 'dca': service = this.dca; break;
      case 'momentum': service = this.momentum; break;
      case 'mean_reversion': service = this.meanReversion; break;
      case 'coupling': service = this.coupling; break;
      case 'market': service = this.marketIntel; break;
      case 'portfolio': service = this.portfolio; break;
      case 'grid': service = this.grid; break;
      case 'arbitrage': service = this.arbitrage; break;
      case 'gmx': service = this.gmx; break;
      case 'aave': service = this.aave; break;
      case 'strategist': service = this.strategist; break;
      case 'flash_loan': service = this.flashLoan; break;
      case 'basis_trading': service = this.basisTrading; break;
      case 'stablecoin_yield': service = this.stablecoinYield; break;
      default:
        throw new HttpException(`Module '${module}' inconnu`, HttpStatus.BAD_REQUEST);
    }

    const newState = !service.isEnabled();
    service.setEnabled(newState);

    return { module, enabled: newState };
  }

  // ─── EXÉCUTION ET STATUT PAR MODULE (routes paramétrées en dernier) ───

  @Post('module/:module/execute')
  @ApiOperation({ summary: 'Exécution manuelle d\'un cycle de module' })
  @ApiParam({ name: 'module', enum: ['dca', 'momentum', 'mean_reversion', 'risk', 'coupling', 'market', 'portfolio', 'grid', 'arbitrage', 'gmx', 'aave', 'strategist', 'flash_loan', 'basis_trading', 'stablecoin_yield'] })
  async executeModule(@Param('module') module: string) {
    switch (module) {
      case 'dca': return this.dca.executeCycle();
      case 'momentum': return this.momentum.executeCycle();
      case 'mean_reversion': return this.meanReversion.executeCycle();
      case 'risk': return this.risk.executeCycle();
      case 'coupling': return this.coupling.executeCycle();
      case 'market': return this.marketIntel.executeCycle();
      case 'portfolio': return this.portfolio.takeSnapshot();
      case 'grid': return this.grid.executeCycle();
      case 'arbitrage': return this.arbitrage.executeCycle();
      case 'gmx': return this.gmx.executeCycle();
      case 'aave': return this.aave.executeCycle();
      case 'strategist': return this.strategist.executeCycle();
      case 'flash_loan': return this.flashLoan.executeCycle();
      case 'basis_trading': return this.basisTrading.executeCycle();
      case 'stablecoin_yield': return this.stablecoinYield.executeCycle();
      default:
        throw new HttpException(`Module '${module}' inconnu`, HttpStatus.BAD_REQUEST);
    }
  }

  @Post('momentum/cleanup-phantoms')
  @ApiOperation({ summary: 'Nettoie les positions Momentum fantômes (aucun solde on-chain correspondant)' })
  async cleanupMomentumPhantoms() {
    return this.momentum.cleanupPhantomPositions();
  }

  @Get('module/:module/status')
  @ApiOperation({ summary: 'État d\'un module' })
  @ApiParam({ name: 'module', enum: ['dca', 'momentum', 'mean_reversion', 'risk', 'coupling', 'market', 'portfolio', 'grid', 'arbitrage', 'gmx', 'aave', 'strategist', 'flash_loan', 'basis_trading', 'stablecoin_yield'] })
  async getModuleStatus(@Param('module') module: string) {
    switch (module) {
      case 'dca': return this.dca.getStatus();
      case 'momentum': return this.momentum.getStatus();
      case 'mean_reversion': return this.meanReversion.getStatus();
      case 'risk': return this.risk.getStatus();
      case 'coupling': return this.coupling.getStatus();
      case 'market': return this.marketIntel.getStatus();
      case 'portfolio': return this.portfolio.getStatus();
      case 'grid': return this.grid.getStatus();
      case 'arbitrage': return this.arbitrage.getStatus();
      case 'gmx': return this.gmx.getStatus();
      case 'aave': return this.aave.getStatus();
      case 'strategist': return this.strategist.getStatus();
      case 'flash_loan': return this.flashLoan.getStatus();
      case 'basis_trading': return this.basisTrading.getStatus();
      case 'stablecoin_yield': return this.stablecoinYield.getStatus();
      default:
        throw new HttpException(`Module '${module}' inconnu`, HttpStatus.BAD_REQUEST);
    }
  }

  // ============ NOUVEAUX ENDPOINTS READ-ONLY ============

  @Get('portfolio/history')
  @ApiOperation({ summary: 'Historique des snapshots de portfolio' })
  @ApiQuery({ name: 'hours', required: false, enum: [24, 168, 720], description: '24=1j, 168=7j, 720=30j' })
  async getPortfolioHistory(@Query('hours') hours?: string) {
    const period = parseInt(hours || '24', 10);
    const validPeriods = [24, 168, 720];
    const periodHours = validPeriods.includes(period) ? period : 24;
    const since = new Date(Date.now() - periodHours * 3600 * 1000);
    const snapshots = await this.prisma.portfolio_snapshot.findMany({
      where: { snapshot_at: { gte: since } },
      orderBy: { snapshot_at: 'asc' },
    });
    return {
      period_hours: periodHours,
      total_snapshots: snapshots.length,
      snapshots: snapshots.map((s: any) => ({
        chain: s.chain,
        token: s.token,
        balance: s.balance?.toString?.() ?? s.balance,
        price_usd: s.price_usd?.toString?.() ?? s.price_usd,
        value_usd: s.value_usd?.toString?.() ?? s.value_usd,
        snapshot_at: s.snapshot_at,
      })),
    };
  }

  @Get('signals')
  @ApiOperation({ summary: 'Signaux techniques actuels par token (RSI, SMA, Bollinger)' })
  async getSignals() {
    // Charger configs
    const momentumCfg: any = await this.prisma.momentum_config.findFirst().catch(() => null);
    const mrCfg: any = await this.prisma.mean_reversion_config.findFirst().catch(() => null);

    const maShort = Number(momentumCfg?.ma_short ?? 10);
    const maLong = Number(momentumCfg?.ma_long ?? 30);
    const rsiPeriod = Number(momentumCfg?.rsi_period ?? mrCfg?.rsi_period ?? 14);
    const bbPeriod = Number(mrCfg?.bb_period ?? 20);
    const rsiOversold = Number(mrCfg?.rsi_oversold ?? 30);
    const rsiOverbought = Number(mrCfg?.rsi_overbought ?? 70);

    const tokens = Object.keys(TOKENS).filter((t) => t !== 'USDC');
    const signals: any[] = [];
    const maxPeriod = Math.max(maLong, bbPeriod, rsiPeriod + 1);

    for (const token of tokens) {
      try {
        const history = await this.prisma.price_history.findMany({
          where: { token },
          orderBy: { recorded_at: 'desc' },
          take: maxPeriod,
        });
        if (history.length < 2) continue;
        const prices = history.reverse().map((h: any) => Number(h.price_usd));
        const current = prices[prices.length - 1];

        // SMA
        const sma = (arr: number[], n: number) => {
          if (arr.length < n) return null;
          const slice = arr.slice(-n);
          return slice.reduce((a, b) => a + b, 0) / n;
        };
        const smaShort = sma(prices, maShort);
        const smaLong = sma(prices, maLong);

        // RSI
        let rsi: number | null = null;
        if (prices.length > rsiPeriod) {
          let gains = 0, losses = 0;
          for (let i = prices.length - rsiPeriod; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1];
            if (diff >= 0) gains += diff; else losses -= diff;
          }
          const avgGain = gains / rsiPeriod;
          const avgLoss = losses / rsiPeriod;
          if (avgLoss === 0) rsi = 100;
          else {
            const rs = avgGain / avgLoss;
            rsi = 100 - 100 / (1 + rs);
          }
        }

        // Bollinger
        let bbMiddle: number | null = null, bbUpper: number | null = null, bbLower: number | null = null;
        if (prices.length >= bbPeriod) {
          const slice = prices.slice(-bbPeriod);
          bbMiddle = slice.reduce((a, b) => a + b, 0) / bbPeriod;
          const variance = slice.reduce((a, b) => a + (b - (bbMiddle as number)) ** 2, 0) / bbPeriod;
          const std = Math.sqrt(variance);
          bbUpper = bbMiddle + 2 * std;
          bbLower = bbMiddle - 2 * std;
        }

        let signal: 'buy' | 'sell' | 'neutral' = 'neutral';
        if (rsi !== null && bbLower !== null && rsi < rsiOversold && current < bbLower) signal = 'buy';
        else if (rsi !== null && bbUpper !== null && rsi > rsiOverbought && current > bbUpper) signal = 'sell';

        signals.push({
          token,
          rsi,
          sma_short: smaShort,
          sma_long: smaLong,
          bb_upper: bbUpper,
          bb_middle: bbMiddle,
          bb_lower: bbLower,
          signal,
          price_current: current,
        });
      } catch (e) {
        // skip token on error
      }
    }

    return { signals, computed_at: new Date().toISOString() };
  }

  // ─── AUTO-ANALYSE / SANTÉ GLOBALE ───

  @Get('analysis/snapshot')
  @ApiOperation({ summary: 'Auto-analyse : état de chaque module vs config cible + score de santé 0-100' })
  async getAnalysisSnapshot() {
    // ── Timestamp ISO avec offset Europe/Paris ──
    const now = new Date();
    const parisIso = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(now).replace(' ', 'T');
    // Détermine offset (+01:00 ou +02:00 selon saison)
    const parisDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offsetMin = Math.round((parisDate.getTime() - utcDate.getTime()) / 60000);
    const sign = offsetMin >= 0 ? '+' : '-';
    const oh = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0');
    const om = String(Math.abs(offsetMin) % 60).padStart(2, '0');
    const timestamp = `${parisIso}${sign}${oh}:${om}`;

    const modules: Array<{ name: string; status: 'OK' | 'ATTENTION' | 'PROBLÈME'; detail: string; suggestion: string | null }> = [];
    let score = 100;
    const penalties: Record<'ATTENTION' | 'PROBLÈME', number> = { ATTENTION: 5, 'PROBLÈME': 15 };
    const push = (name: string, status: 'OK' | 'ATTENTION' | 'PROBLÈME', detail: string, suggestion: string | null = null) => {
      modules.push({ name, status, detail, suggestion });
      if (status !== 'OK') score -= penalties[status];
    };

    // Helper : erreurs récentes 24h par module (source)
    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    const failedByMod: Record<string, number> = {};
    try {
      const failed = await this.prisma.trade.findMany({
        where: { executed_at: { gte: since24h }, status: { in: ['failed', 'expired', 'cancelled'] } },
        select: { source: true },
      });
      for (const t of failed) failedByMod[t.source || 'unknown'] = (failedByMod[t.source || 'unknown'] || 0) + 1;
    } catch { /* ignore */ }

    // ── DCA : panier diversifié ──
    try {
      const s: any = await this.dca.getStatus();
      const basketOk = s.diversified === true && Array.isArray(s.basket) && s.basket.length === 3;
      const activeOk = s.strategy?.active && !s.strategy?.paused && this.dca.isEnabled();
      if (basketOk && activeOk) {
        push('DCA', 'OK', `Panier diversifié actif (${s.basket.map((b: any) => `${b.token} ${b.weightPct}%`).join(' / ')}), fréquence ${s.frequency}`);
      } else if (!basketOk) {
        push('DCA', 'PROBLÈME', 'Panier non diversifié', 'Vérifier DCA_BASKET dans constants.ts');
      } else {
        push('DCA', 'ATTENTION', 'DCA en pause ou désactivé', 'Réactiver le module DCA');
      }
    } catch (e: any) {
      push('DCA', 'PROBLÈME', `Erreur lecture statut: ${e.message}`, 'Vérifier les logs');
    }

    // ── Arbitrage : réactivé, spread 100 bps, ticket $200, cron 5 min ──
    try {
      const s: any = await this.arbitrage.getStatus();
      const cfgOk = s.enabled && s.config?.active && !s.config?.paused
        && s.minSpreadBps >= 100 && Number(s.maxTradeUsd) <= 200;
      if (cfgOk) {
        push('Arbitrage', 'OK', `Réactivé (spread min ${s.minSpreadBps} bps, ticket $${s.maxTradeUsd}, ${s.schedule})`);
      } else if (!s.enabled) {
        push('Arbitrage', 'ATTENTION', 'Arbitrage désactivé', 'Réactiver via /api/crons/toggle/arbitrage');
      } else {
        push('Arbitrage', 'ATTENTION', `Paramètres hors cible (spread=${s.minSpreadBps}, max=$${s.maxTradeUsd})`, 'Vérifier ARB_MIN_SPREAD_BPS / ARB_MAX_TRADE_USD');
      }
    } catch (e: any) {
      push('Arbitrage', 'PROBLÈME', `Erreur: ${e.message}`, null);
    }

    // ── Momentum : positions ouvertes + PnL 24h ──
    try {
      const s: any = await this.momentum.getStatus();
      const openPositions = Array.isArray(s.openPositions) ? s.openPositions.length
        : Array.isArray(s.positions) ? s.positions.filter((p: any) => p.status === 'open' || !p.closed_at).length
        : (s.openCount ?? 0);
      const failedCount = failedByMod['momentum'] || 0;
      if (failedCount >= 3) {
        push('Momentum', 'ATTENTION', `${openPositions} position(s) ouverte(s), ${failedCount} trade(s) en échec sur 24h`, 'Vérifier les logs Momentum et les balances on-chain');
      } else if (openPositions > 0) {
        push('Momentum', 'OK', `${openPositions} position(s) ouverte(s), aucun échec majeur sur 24h`);
      } else {
        push('Momentum', 'OK', 'Aucune position ouverte, en attente de signal');
      }
    } catch (e: any) {
      push('Momentum', 'ATTENTION', `Statut indisponible: ${e.message}`, null);
    }

    // ── Mean-Reversion, Grid, GMX, Aave, Flash-Loan, Basis, Stablecoin, Coupling, Market, Strategist, Portfolio ──
    const otherModules: Array<{ name: string; svc: any; expected: boolean; sourceKey?: string }> = [
      { name: 'Mean-Reversion', svc: this.meanReversion, expected: true, sourceKey: 'mean_reversion' },
      { name: 'Grid', svc: this.grid, expected: true, sourceKey: 'grid' },
      { name: 'GMX', svc: this.gmx, expected: true, sourceKey: 'gmx' },
      { name: 'Aave', svc: this.aave, expected: true, sourceKey: 'aave' },
      { name: 'Flash-Loan', svc: this.flashLoan, expected: true, sourceKey: 'flash_loan' },
      { name: 'Basis-Trading', svc: this.basisTrading, expected: true, sourceKey: 'basis_trading' },
      { name: 'Stablecoin-Yield', svc: this.stablecoinYield, expected: true, sourceKey: 'stablecoin_yield' },
      { name: 'Coupling', svc: this.coupling, expected: true },
      { name: 'Market-Intelligence', svc: this.marketIntel, expected: true },
      { name: 'Strategist', svc: this.strategist, expected: true },
      { name: 'Portfolio', svc: this.portfolio, expected: true },
    ];
    for (const m of otherModules) {
      try {
        const enabled = m.svc.isEnabled();
        const failed = m.sourceKey ? (failedByMod[m.sourceKey] || 0) : 0;
        if (enabled && failed < 3) {
          push(m.name, 'OK', failed > 0 ? `Actif, ${failed} échec(s) sur 24h` : 'Actif');
        } else if (!enabled) {
          push(m.name, 'ATTENTION', 'Module désactivé', `Réactiver via /api/crons/toggle/${(m.sourceKey || m.name.toLowerCase())}`);
        } else {
          push(m.name, 'ATTENTION', `${failed} échec(s) sur 24h`, 'Vérifier les logs');
        }
      } catch (e: any) {
        push(m.name, 'ATTENTION', `Statut indisponible: ${e.message}`, null);
      }
    }

    // ── Risk Manager : jamais désactivable, doit être actif ──
    let riskManagerActive = false;
    let circuitBreakerArmed = false;
    let globalPaused = false;
    try {
      const rs: any = await this.risk.getStatus();
      riskManagerActive = !!(rs.enabled ?? this.risk.isEnabled());
      // "Armé" = seuil configuré (> 0) et bot non en pause globale. Le champ
      // circuit_breaker_active reflète le DÉCLENCHEMENT (tripped), pas l'armement.
      circuitBreakerArmed = !!(rs.config && Number(rs.config.circuit_breaker_threshold_pct) > 0 && !rs.config.global_paused);
      globalPaused = !!rs.config?.global_paused;
      if (riskManagerActive && !globalPaused) {
        push('Risk-Manager', 'OK', `Gardien critique actif, drawdown ${Number(rs.drawdownPct ?? 0).toFixed(2)}%`);
      } else if (globalPaused) {
        push('Risk-Manager', 'PROBLÈME', 'Bot en pause globale', 'Investiguer la cause avant de relancer');
      } else {
        push('Risk-Manager', 'PROBLÈME', 'Risk Manager désactivé', 'Réactiver immédiatement');
      }
    } catch (e: any) {
      push('Risk-Manager', 'PROBLÈME', `Erreur: ${e.message}`, null);
    }

    // ── Global : wallet health, supervision 24/7 ──
    const isDryRun = this.blockchain.getIsDryRun();
    const walletConfigured = !!process.env.WALLET_PRIVATE_KEY;
    const walletHealth: 'OK' | 'DÉGRADÉ' | 'CRITIQUE' = walletConfigured && !isDryRun
      ? 'OK'
      : isDryRun ? 'DÉGRADÉ' : 'CRITIQUE';
    if (walletHealth !== 'OK') score -= walletHealth === 'CRITIQUE' ? 20 : 5;

    // Supervision 24h : au moins un snapshot portfolio dans les dernières 24h
    let supervision24h = false;
    try {
      const lastSnap = await this.prisma.portfolio_snapshot.findFirst({ orderBy: { snapshot_at: 'desc' } });
      supervision24h = !!(lastSnap && new Date(lastSnap.snapshot_at).getTime() > Date.now() - 3600 * 1000);
    } catch { /* ignore */ }
    if (!supervision24h) score -= 5;

    score = Math.max(0, Math.min(100, score));

    return {
      score,
      timestamp,
      modules,
      global: {
        supervision24h,
        riskManagerActive,
        circuitBreakerArmed,
        globalPaused,
        walletHealth,
        isDryRun,
      },
    };
  }

  @Get('analytics')
  @ApiOperation({ summary: 'Métriques de performance globales (Sharpe, win rate, PnL par stratégie)' })
  async getAnalytics() {
    const periodDays = 30;
    const since = new Date(Date.now() - periodDays * 24 * 3600 * 1000);
    const trades: any[] = await this.prisma.trade.findMany({
      where: { executed_at: { gte: since } },
      orderBy: { executed_at: 'asc' },
    });

    // ── Valorisation USD (mark-to-market) ──
    // BUG HISTORIQUE (corrigé) : l'ancien calcul multipliait le montant du stablecoin
    // (USDC) par le RATIO de prix (amount_in/amount_out), transformant chaque achat exécuté
    // en une perte fantôme de ~$1.6M (d'où les -$47.5M arbitrage / -$1.5M grid impossibles).
    // Correctif : chaque jambe est valorisée en USD réel — stablecoin = $1, token = prix courant.
    // Les trades non exécutés (amount_out <= 0, statuts failed/expired) sont ignorés.
    const priceCache: Record<string, number> = {};
    const distinctTokens = new Set<string>();
    for (const t of trades) {
      for (const tok of [t.source_token, t.target_token]) {
        const sym = String(tok || '').toUpperCase();
        if (sym && !STABLECOINS.has(sym)) distinctTokens.add(sym);
      }
    }
    await Promise.all(
      Array.from(distinctTokens).map(async (sym) => {
        try {
          const p = await this.priceService.getPrice(sym);
          if (Number.isFinite(p) && (p as number) > 0) priceCache[sym] = p as number;
        } catch { /* prix indisponible → jambe non valorisable */ }
      }),
    );
    const usdVal = (token: string, amount: number): number | null => {
      const sym = String(token || '').toUpperCase();
      if (STABLECOINS.has(sym)) return amount;
      const p = priceCache[sym];
      return p && p > 0 ? amount * p : null;
    };

    let totalTrades = 0;
    let totalVolumeUsd = 0;
    let wins = 0;
    let losses = 0;
    const pnlBySrc: Record<string, { pnl_usd: number; trades_count: number }> = {};
    const dailyPnl: Record<string, number> = {};

    for (const t of trades) {
      const amountIn = Number(t.amount_in ?? 0);
      const amountOut = Number(t.amount_out ?? 0);
      // Ignorer les trades non exécutés (échec / expiré / quote nulle) : aucune perte réelle.
      const executed = amountOut > 0 && !['failed', 'expired', 'cancelled'].includes(t.status);
      if (!executed) continue;

      totalTrades++;
      const src = t.source || 'unknown';
      if (!pnlBySrc[src]) pnlBySrc[src] = { pnl_usd: 0, trades_count: 0 };
      pnlBySrc[src].trades_count++;

      const valueIn = usdVal(t.source_token, amountIn);
      const valueOut = usdVal(t.target_token, amountOut);
      // Volume = valeur USD engagée (jambe connue).
      totalVolumeUsd += valueIn ?? valueOut ?? 0;

      // PnL mark-to-market : impossible à calculer si un prix token manque → on saute le PnL.
      if (valueIn == null || valueOut == null) continue;
      const pnl = valueOut - valueIn;
      if (pnl > 0) wins++; else if (pnl < 0) losses++;
      pnlBySrc[src].pnl_usd += pnl;
      const day = new Date(t.executed_at).toISOString().slice(0, 10);
      dailyPnl[day] = (dailyPnl[day] || 0) + pnl;
    }

    // Sharpe simplifié sur retours quotidiens
    const returns = Object.values(dailyPnl);
    let sharpe = 0;
    if (returns.length > 1) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      const std = Math.sqrt(variance);
      sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;
    }

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const avgTradeUsd = totalTrades > 0 ? totalVolumeUsd / totalTrades : 0;

    return {
      sharpe_ratio_30d: sharpe,
      win_rate_pct: winRate,
      pnl_by_strategy: Object.entries(pnlBySrc).map(([source, v]) => ({ source, ...v })),
      total_trades: totalTrades,
      total_volume_usd: totalVolumeUsd,
      avg_trade_usd: avgTradeUsd,
      period_days: periodDays,
      computed_at: new Date().toISOString(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Aave V3 — opérations manuelles (admin) + remédiation d'allocation
  // ═══════════════════════════════════════════════════════════════════

  @Get('aave/account')
  @ApiOperation({ summary: 'Lit les données on-chain du compte Aave V3 (collatéral, dette, HF).' })
  async aaveAccount() {
    const acct = await this.blockchain.aaveGetAccountData();
    if (!acct) return { available: false, reason: 'dry-run ou lecture on-chain indisponible' };
    return {
      available: true,
      healthFactor: acct.healthFactor === Infinity ? 'Infinity' : Number(acct.healthFactor.toFixed(4)),
      totalCollateralUsd: Number(acct.totalCollateralUsd.toFixed(2)),
      totalDebtUsd: Number(acct.totalDebtUsd.toFixed(2)),
      netUsd: Number(Math.max(0, acct.totalCollateralUsd - acct.totalDebtUsd).toFixed(2)),
      availableBorrowsUsd: Number(acct.availableBorrowsUsd.toFixed(2)),
      ltv: acct.ltv,
      currentLiquidationThreshold: acct.currentLiquidationThreshold,
    };
  }

  @Post('aave/repay')
  @ApiOperation({ summary: 'Rembourse manuellement une dette Aave V3 (défaut USDC).' })
  async aaveRepay(@Body() body: { token?: string; amountUsd?: number }) {
    const token = (body?.token || 'USDC').toUpperCase();
    const amount = Number(body?.amountUsd);
    if (!amount || amount <= 0) {
      throw new HttpException('amountUsd requis (> 0)', HttpStatus.BAD_REQUEST);
    }
    this.logger.log(`[ADMIN] Aave repay ${amount} ${token}`);
    const res = await this.blockchain.aaveRepay(token, amount);
    return { op: 'repay', token, amount, ...res };
  }

  @Post('aave/withdraw')
  @ApiOperation({ summary: 'Retire manuellement du collatéral Aave V3 (défaut USDC).' })
  async aaveWithdraw(@Body() body: { token?: string; amountUsd?: number }) {
    const token = (body?.token || 'USDC').toUpperCase();
    const amount = Number(body?.amountUsd);
    if (!amount || amount <= 0) {
      throw new HttpException('amountUsd requis (> 0)', HttpStatus.BAD_REQUEST);
    }
    this.logger.log(`[ADMIN] Aave withdraw ${amount} ${token}`);
    const res = await this.blockchain.aaveWithdraw(token, amount);
    return { op: 'withdraw', token, amount, ...res };
  }

  /**
   * Remédiation d'allocation Aave : rembourse TOUTE la dette USDC puis retire le
   * collatéral excédentaire pour ramener la position Aave (net) à `targetNetUsd`
   * (défaut $1500). Chaque opération on-chain déclenche une notification Telegram.
   */
  @Post('aave/remediate')
  @ApiOperation({ summary: 'Ramène la position Aave (net) au niveau cible en remboursant la dette puis en retirant le collatéral excédentaire.' })
  async aaveRemediate(@Body() body: { targetNetUsd?: number }) {
    const targetNetUsd = Number(body?.targetNetUsd) > 0 ? Number(body!.targetNetUsd) : 1500;
    const steps: any[] = [];

    let acct = await this.blockchain.aaveGetAccountData();
    if (!acct) {
      throw new HttpException('Compte Aave illisible (dry-run ou RPC indisponible)', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const before = {
      collateralUsd: Number(acct.totalCollateralUsd.toFixed(2)),
      debtUsd: Number(acct.totalDebtUsd.toFixed(2)),
      netUsd: Number(Math.max(0, acct.totalCollateralUsd - acct.totalDebtUsd).toFixed(2)),
      healthFactor: acct.healthFactor === Infinity ? 'Infinity' : Number(acct.healthFactor.toFixed(4)),
    };
    this.logger.warn(`[ADMIN] Remédiation Aave — cible net $${targetNetUsd}. Avant: ${JSON.stringify(before)}`);

    // 1) Remboursement total de la dette (USDC). On passe dette + petit buffer :
    //    Aave plafonne automatiquement le remboursement au montant réel de la dette.
    if (acct.totalDebtUsd > 0.01) {
      const repayAmount = Math.ceil((acct.totalDebtUsd * 1.02 + 1) * 100) / 100;
      const r = await this.blockchain.aaveRepay('USDC', repayAmount);
      steps.push({ op: 'repay', requestedUsd: repayAmount, ...r });
      if (!r.success) {
        return { ok: false, targetNetUsd, before, steps, message: 'Échec du remboursement — retrait annulé.' };
      }
      // Re-lecture on-chain après remboursement (état à jour).
      acct = await this.blockchain.aaveGetAccountData() || acct;
    } else {
      steps.push({ op: 'repay', skipped: true, reason: 'aucune_dette' });
    }

    // 2) Retrait du collatéral excédentaire pour atteindre le net cible.
    const collateralNow = acct.totalCollateralUsd;
    const debtNow = acct.totalDebtUsd;
    const netNow = Math.max(0, collateralNow - debtNow);
    const withdrawUsd = Math.floor((netNow - targetNetUsd) * 100) / 100;
    if (withdrawUsd >= 1) {
      const w = await this.blockchain.aaveWithdraw('USDC', withdrawUsd);
      steps.push({ op: 'withdraw', requestedUsd: withdrawUsd, ...w });
    } else {
      steps.push({ op: 'withdraw', skipped: true, reason: `net actuel $${netNow.toFixed(2)} déjà ≤ cible $${targetNetUsd}` });
    }

    // 3) État final.
    const finalAcct = await this.blockchain.aaveGetAccountData();
    const after = finalAcct ? {
      collateralUsd: Number(finalAcct.totalCollateralUsd.toFixed(2)),
      debtUsd: Number(finalAcct.totalDebtUsd.toFixed(2)),
      netUsd: Number(Math.max(0, finalAcct.totalCollateralUsd - finalAcct.totalDebtUsd).toFixed(2)),
      healthFactor: finalAcct.healthFactor === Infinity ? 'Infinity' : Number(finalAcct.healthFactor.toFixed(4)),
    } : null;

    return { ok: true, targetNetUsd, before, steps, after };
  }
}
