import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { ApiModule } from './api/api.module';
import { TelegramModule } from './telegram/telegram.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { SupervisionModule } from './supervision/supervision.module';
import { StrategyEvaluatorModule } from './strategy-evaluator/strategy-evaluator.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    TelegramModule,
    ApiModule,
    PipelineModule,
    SupervisionModule,
    StrategyEvaluatorModule,
  ],
})
export class AppModule {}
