import { Module } from '@nestjs/common';
import { DcaService } from './dca.service';
import { TradeModule } from '../trade/trade.module';
import { PriceModule } from '../price/price.module';

@Module({
  imports: [TradeModule, PriceModule],
  providers: [DcaService],
  exports: [DcaService],
})
export class DcaModule {}
