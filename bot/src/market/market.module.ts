import { Module } from '@nestjs/common';
import { MarketIntelligenceService } from './market-intelligence.service';
import { PriceModule } from '../price/price.module';

@Module({
  imports: [PriceModule],
  providers: [MarketIntelligenceService],
  exports: [MarketIntelligenceService],
})
export class MarketModule {}
