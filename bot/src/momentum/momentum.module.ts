import { Module } from '@nestjs/common';
import { MomentumService } from './momentum.service';
import { TradeModule } from '../trade/trade.module';
import { PriceModule } from '../price/price.module';

@Module({
  imports: [TradeModule, PriceModule],
  providers: [MomentumService],
  exports: [MomentumService],
})
export class MomentumModule {}
