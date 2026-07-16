import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBody } from '@nestjs/swagger';
import { SupervisionService } from './supervision.service';

@ApiTags('Supervision')
@Controller('api/supervision')
export class SupervisionController {
  constructor(private readonly supervision: SupervisionService) {}

  @Get('status')
  @ApiOperation({
    summary: 'État complet de la supervision proactive',
    description:
      'Régime de marché courant (BULL / BEAR / RANGE / HIGH_VOL), drawdown temps réel, état ' +
      "d'auto-pause, taux d'erreur du dernier cycle, seuils configurés et alertes récentes.",
  })
  getStatus() {
    return this.supervision.getStatus();
  }

  @Get('alerts')
  @ApiOperation({
    summary: 'Historique des alertes de supervision',
    description: 'Renvoie les dernières alertes (100 au maximum), les plus récentes en premier.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Nombre max d\'alertes (défaut 100)' })
  getAlerts(@Query('limit') limit?: string) {
    return this.supervision.getAlerts(limit ? parseInt(limit, 10) : 100);
  }

  @Post('config')
  @ApiOperation({
    summary: 'Modifier les seuils de supervision',
    description:
      'Met à jour un ou plusieurs seuils : drawdown_warn_pct, drawdown_max_pct, ' +
      'max_consecutive_failures, kucoin_latency_max_ms, module_error_rate_max (0-1), auto_pause_enabled.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        drawdown_warn_pct: { type: 'number', example: 3 },
        drawdown_max_pct: { type: 'number', example: 5 },
        max_consecutive_failures: { type: 'number', example: 5 },
        kucoin_latency_max_ms: { type: 'number', example: 10000 },
        module_error_rate_max: { type: 'number', example: 0.5 },
        auto_pause_enabled: { type: 'boolean', example: true },
      },
    },
  })
  updateConfig(@Body() body: Record<string, any>) {
    return this.supervision.updateConfig(body ?? {});
  }
}
