import { Module } from '@nestjs/common';
import { BasisTradingService } from './basis-trading.service';
import { PriceModule } from '../price/price.module';

@Module({
  imports: [PriceModule],
  providers: [BasisTradingService],
  exports: [BasisTradingService],
})
export class BasisTradingModule {}
