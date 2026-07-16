import { Module } from '@nestjs/common';
import { MeanReversionService } from './mean-reversion.service';
import { TradeModule } from '../trade/trade.module';
import { PriceModule } from '../price/price.module';

@Module({
  imports: [TradeModule, PriceModule],
  providers: [MeanReversionService],
  exports: [MeanReversionService],
})
export class MeanReversionModule {}
