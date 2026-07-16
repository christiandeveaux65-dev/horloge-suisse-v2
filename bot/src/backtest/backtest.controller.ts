import {
  Controller, Post, Get, Body, Param, Query, UseGuards, Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { OhlcvService } from './ohlcv.service';
import { BacktestEngineService } from './engine.service';
import { OptimizerService } from './optimizer.service';
import { FetchDataDto, RunBacktestDto } from './dto/backtest.dto';
import { OptimizeDto } from './dto/optimize.dto';

@ApiTags('Backtesting')
@ApiHeader({ name: 'x-api-key', required: false, description: 'Clé API (optionnelle en mode dev)' })
@UseGuards(ApiKeyGuard)
@Controller('api/backtest')
export class BacktestController {
  private readonly logger = new Logger(BacktestController.name);

  constructor(
    private readonly ohlcv: OhlcvService,
    private readonly engine: BacktestEngineService,
    private readonly optimizer: OptimizerService,
  ) {}

  @Post('fetch-data')
  @ApiOperation({
    summary: 'Télécharger les données OHLCV historiques (KuCoin) et les stocker en base',
  })
  async fetchData(@Body() dto: FetchDataDto): Promise<any> {
    this.logger.log(
      `fetch-data : tokens=${dto.tokens?.join(',') || 'tous'} tf=${dto.timeframes?.join(',') || '1h,4h'} months=${dto.months ?? 12}`,
    );
    const result = await this.ohlcv.fetchAndStore(dto);
    return { success: true, ...result };
  }

  @Get('coverage')
  @ApiOperation({ summary: 'Couverture des données OHLCV disponibles en base' })
  async coverage(): Promise<any> {
    return { coverage: await this.ohlcv.coverage() };
  }

  @Post('run')
  @ApiOperation({ summary: 'Lancer un backtest sur une stratégie' })
  async run(@Body() dto: RunBacktestDto): Promise<any> {
    const result = await this.engine.run(dto);
    return { success: true, result };
  }

  @Get('history')
  @ApiOperation({ summary: 'Liste des backtests passés (métriques résumées)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Nombre max de runs (défaut 50)' })
  async history(@Query('limit') limit?: string): Promise<any> {
    return this.engine.history(limit ? parseInt(limit, 10) : 50);
  }

  @Get('results/:id')
  @ApiOperation({ summary: 'Récupérer un backtest complet (courbe d\'équité + trades)' })
  @ApiParam({ name: 'id', description: 'Identifiant du backtest' })
  async result(@Param('id') id: string): Promise<any> {
    return { result: await this.engine.getResult(id) };
  }

  @Post('optimize')
  @ApiOperation({
    summary: 'Optimiser les paramètres d\'une stratégie (grid / random / bayesian TPE, '
      + 'parallélisé sur worker_threads, walk-forward anti-overfitting, courbe de convergence)',
  })
  async optimize(@Body() dto: OptimizeDto): Promise<any> {
    this.logger.log(
      `optimize : strat=${dto.strategy} method=${dto.searchMethod ?? 'auto'} `
      + `loss=${dto.lossFunction ?? 'Balanced'} maxIter=${dto.maxIterations ?? 200}`,
    );
    const result = await this.optimizer.optimize(dto);
    return { success: true, result };
  }

  @Get('optimize/history')
  @ApiOperation({ summary: 'Liste des optimisations passées' })
  @ApiQuery({ name: 'limit', required: false, description: 'Nombre max (défaut 50)' })
  async optimizeHistory(@Query('limit') limit?: string): Promise<any> {
    return this.optimizer.history(limit ? parseInt(limit, 10) : 50);
  }

  @Get('optimize/:id')
  @ApiOperation({
    summary: 'Résultats d\'une optimisation (meilleurs params, WFE, top 10 combinaisons, in-sample vs out-of-sample)',
  })
  @ApiParam({ name: 'id', description: 'Identifiant de l\'optimisation' })
  async optimizeResult(@Param('id') id: string): Promise<any> {
    return { result: await this.optimizer.getResult(id) };
  }
}
