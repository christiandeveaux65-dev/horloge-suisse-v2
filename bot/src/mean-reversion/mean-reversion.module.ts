import { Module } from '@nestjs/common';
import { MeanReversionService } from './mean-reversion.service';
import { TradeModule } from '../trade/trade.module';
import { PriceModule } from '../price/price.module';
import { GmxModule } from '../gmx/gmx.module';

@Module({
  imports: [TradeModule, PriceModule, GmxModule],
  providers: [MeanReversionService],
  exports: [MeanReversionService],
})
export class MeanReversionModule {}
