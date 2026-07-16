import { Module } from '@nestjs/common';
import { GridService } from './grid.service';
import { TradeModule } from '../trade/trade.module';
import { PriceModule } from '../price/price.module';

@Module({
  imports: [TradeModule, PriceModule],
  providers: [GridService],
  exports: [GridService],
})
export class GridModule {}
