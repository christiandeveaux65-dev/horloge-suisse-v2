import { Controller, Post, Get, Body, Query, UseGuards, Logger, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiQuery, ApiBody } from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { OptimizeInjectService } from './optimize-inject.service';

type StrategyName = 'dca' | 'grid' | 'mean_reversion' | 'momentum';

@ApiTags('Optimize Injection')
@ApiHeader({ name: 'x-api-key', required: false, description: 'Clé API (optionnelle en mode dev)' })
@UseGuards(ApiKeyGuard)
@Controller('api/optimize')
export class OptimizeInjectController {
  private readonly logger = new Logger(OptimizeInjectController.name);

  constructor(private readonly svc: OptimizeInjectService) {}

  @Post('apply')
  @ApiOperation({ summary: 'Applique les meilleurs paramètres d\'une optimisation à la config live' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        optimizationId: { type: 'string' },
        strategy: { type: 'string', enum: ['dca', 'grid', 'mean_reversion', 'momentum'], nullable: true },
      },
      required: ['optimizationId'],
    },
  })
  async apply(@Body() body: { optimizationId: string; strategy?: StrategyName }): Promise<any> {
    if (!body?.optimizationId) throw new BadRequestException('optimizationId requis');
    return this.svc.apply(body.optimizationId, body.strategy);
  }

  @Post('auto-reoptimize')
  @ApiOperation({
    summary: 'Lance une optimisation bayésienne à convergence adaptative et applique si WFE >= seuil (défaut 1.0)',
    description: 'Plafond maxIterations=5000 (défaut), arrêt anticipé si le meilleur score n\'a pas progressé '
      + 'pendant `patience` itérations consécutives (défaut 200).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['dca', 'grid', 'mean_reversion', 'momentum'] },
        minWfe: { type: 'number', default: 1.0 },
        maxIterations: { type: 'number', default: 5000 },
        patience: { type: 'number', default: 200 },
      },
      required: ['strategy'],
    },
  })
  async autoReoptimize(
    @Body() body: { strategy: StrategyName; minWfe?: number; maxIterations?: number; patience?: number },
  ): Promise<any> {
    if (!body?.strategy) throw new BadRequestException('strategy requis');
    return this.svc.autoReoptimize(
      body.strategy,
      body.minWfe ?? 1.0,
      body.maxIterations ?? 5000,
      body.patience ?? 200,
    );
  }

  @Get('injection-history')
  @ApiOperation({ summary: 'Historique des injections de paramètres (date, anciens/nouveaux params, wfe...)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'strategy', required: false })
  async history(@Query('limit') limit?: string, @Query('strategy') strategy?: string): Promise<any> {
    return this.svc.injectionHistory(limit ? parseInt(limit, 10) : 50, strategy);
  }

  @Post('rollback')
  @ApiOperation({ summary: 'Restaure les paramètres précédents pour une stratégie' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { strategy: { type: 'string', enum: ['dca', 'grid', 'mean_reversion', 'momentum'] } },
      required: ['strategy'],
    },
  })
  async rollback(@Body() body: { strategy: StrategyName }): Promise<any> {
    if (!body?.strategy) throw new BadRequestException('strategy requis');
    return this.svc.rollback(body.strategy);
  }
}
