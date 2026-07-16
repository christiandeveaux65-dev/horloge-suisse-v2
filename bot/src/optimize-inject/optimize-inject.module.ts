import { Module } from '@nestjs/common';
import { OptimizeInjectController } from './optimize-inject.controller';
import { OptimizeInjectService } from './optimize-inject.service';
import { BacktestModule } from '../backtest/backtest.module';

@Module({
  imports: [BacktestModule],
  controllers: [OptimizeInjectController],
  providers: [OptimizeInjectService],
  exports: [OptimizeInjectService],
})
export class OptimizeInjectModule {}
