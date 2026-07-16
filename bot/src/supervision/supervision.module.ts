import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RiskModule } from '../risk/risk.module';
import { TelegramModule } from '../telegram/telegram.module';
import { MarketModule } from '../market/market.module';
import { SupervisionService } from './supervision.service';
import { SupervisionController } from './supervision.controller';

@Module({
  imports: [PrismaModule, RiskModule, TelegramModule, MarketModule],
  controllers: [SupervisionController],
  providers: [SupervisionService],
  exports: [SupervisionService],
})
export class SupervisionModule {}
