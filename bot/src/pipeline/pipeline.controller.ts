import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { PipelineOrchestrator } from './pipeline.orchestrator';

@ApiTags('Pipeline')
@Controller('api/pipeline')
export class PipelineController {
  constructor(private readonly orchestrator: PipelineOrchestrator) {}

  @Get('status')
  @ApiOperation({
    summary: 'État du pipeline séquentiel',
    description:
      "Renvoie l'état du pipeline unique : numéro de cycle, durée du dernier cycle, " +
      'horodatage, phase courante, modules exécutés au dernier cycle et fréquences configurées.',
  })
  getStatus() {
    return this.orchestrator.getStatus();
  }

  @Post('run')
  @ApiOperation({
    summary: 'Déclenche manuellement un cycle du pipeline',
    description:
      "Exécute immédiatement un cycle complet (utile pour test/diagnostic). " +
      'force=true ignore le gating de fréquence ; skipReopt=true saute la Phase 7 (optimisation lourde).',
  })
  @ApiQuery({ name: 'force', required: false, type: Boolean })
  @ApiQuery({ name: 'skipReopt', required: false, type: Boolean })
  async run(
    @Query('force') force?: string,
    @Query('skipReopt') skipReopt?: string,
  ) {
    await this.orchestrator.runPipeline({
      force: force === 'true',
      skipReopt: skipReopt === 'true',
    });
    return { triggered: true, ...this.orchestrator.getStatus() };
  }
}
