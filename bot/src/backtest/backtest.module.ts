import { Module } from '@nestjs/common';
import { BacktestController } from './backtest.controller';
import { OhlcvService } from './ohlcv.service';
import { BacktestEngineService } from './engine.service';
import { OptimizerService } from './optimizer.service';

@Module({
  controllers: [BacktestController],
  providers: [OhlcvService, BacktestEngineService, OptimizerService],
  exports: [OhlcvService, BacktestEngineService, OptimizerService],
})
export class BacktestModule {}
