import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PriceModule } from '../price/price.module';
import { SupervisionModule } from '../supervision/supervision.module';
import { StrategyEvaluatorService } from './strategy-evaluator.service';
import { StrategyEvaluatorController } from './strategy-evaluator.controller';

@Module({
  imports: [PrismaModule, PriceModule, SupervisionModule],
  controllers: [StrategyEvaluatorController],
  providers: [StrategyEvaluatorService],
  exports: [StrategyEvaluatorService],
})
export class StrategyEvaluatorModule {}
