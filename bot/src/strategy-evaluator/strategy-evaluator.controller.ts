import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { StrategyEvaluatorService } from './strategy-evaluator.service';

@ApiTags('Strategy Evaluator')
@Controller('api/strategy-evaluator')
export class StrategyEvaluatorController {
  constructor(private readonly evaluator: StrategyEvaluatorService) {}

  @Get('scores')
  @ApiOperation({
    summary: 'Scores actuels par stratégie',
    description:
      'Renvoie le score de chaque stratégie (grid, momentum, mean_reversion, dca, arbitrage, ' +
      'basis_trading, flash_loan) sur la fenêtre glissante : rendement net après gas, ratio ' +
      'gain/perte, nombre de trades, taux de réussite, Sharpe simplifié, croisés avec le régime de marché.',
  })
  getScores() {
    return this.evaluator.getScores();
  }

  @Get('allocations')
  @ApiOperation({
    summary: 'Allocations de capital recommandées',
    description:
      'Renvoie la répartition recommandée du capital entre stratégies (en %) et les directives ' +
      "d'activation/désactivation, lisibles par le Strategist.",
  })
  getAllocations() {
    return this.evaluator.getAllocations();
  }

  @Get('history')
  @ApiOperation({
    summary: 'Historique des évaluations',
    description: 'Renvoie les dernières évaluations enregistrées (50 par défaut, 200 max), les plus récentes en premier.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: "Nombre max d'évaluations (défaut 50)" })
  getHistory(@Query('limit') limit?: string) {
    return this.evaluator.getHistory(limit ? parseInt(limit, 10) : 50);
  }
}
