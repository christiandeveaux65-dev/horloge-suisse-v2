import {
  Controller, Get, Post, Body, Query, Param, UseGuards,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiQuery, ApiParam } from '@nestjs/swagger';
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
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { PrismaService } from '../prisma/prisma.service';
import { TOKENS } from '../constants';

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
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
    private readonly prisma: PrismaService,
  ) {}

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
        dca: { enabled: this.dca.isEnabled(), schedule: '*/15 min' },
        momentum: { enabled: this.momentum.isEnabled(), schedule: '*/5 min' },
        mean_reversion: { enabled: this.meanReversion.isEnabled(), schedule: '*/10 min' },
        risk: { enabled: this.risk.isEnabled(), schedule: '*/5 min (CRITIQUE)' },
        coupling: { enabled: this.coupling.isEnabled(), schedule: '*/30 min' },
        market: { enabled: this.marketIntel.isEnabled(), schedule: '*/10 min' },
        portfolio: { enabled: this.portfolio.isEnabled(), schedule: '*/60 min' },
        grid: { enabled: this.grid.isEnabled(), schedule: '*/3 min' },
        arbitrage: { enabled: this.arbitrage.isEnabled(), schedule: '*/2 min' },
        gmx: { enabled: this.gmx.isEnabled(), schedule: '*/5 min' },
        aave: { enabled: this.aave.isEnabled(), schedule: '*/15 min' },
        strategist: { enabled: this.strategist.isEnabled(), schedule: 'toutes les 4 h' },
      },
    };
  }

  @Post('crons/toggle/:module')
  @ApiOperation({ summary: 'Activer/désactiver un cron' })
  @ApiParam({ name: 'module', enum: ['dca', 'momentum', 'mean_reversion', 'risk', 'coupling', 'market', 'portfolio', 'grid', 'arbitrage', 'gmx', 'aave', 'strategist'] })
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
  @ApiParam({ name: 'module', enum: ['dca', 'momentum', 'mean_reversion', 'risk', 'coupling', 'market', 'portfolio', 'grid', 'arbitrage', 'gmx', 'aave', 'strategist'] })
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
      default:
        throw new HttpException(`Module '${module}' inconnu`, HttpStatus.BAD_REQUEST);
    }
  }

  @Get('module/:module/status')
  @ApiOperation({ summary: 'État d\'un module' })
  @ApiParam({ name: 'module', enum: ['dca', 'momentum', 'mean_reversion', 'risk', 'coupling', 'market', 'portfolio', 'grid', 'arbitrage', 'gmx', 'aave', 'strategist'] })
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
      default:
        throw new HttpException(`Module '${module}' inconnu`, HttpStatus.BAD_REQUEST);
    }
  }
}
