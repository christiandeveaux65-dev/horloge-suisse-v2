import { Module } from '@nestjs/common';
import { RiskService } from './risk.service';
import { TradeModule } from '../trade/trade.module';
import { PriceModule } from '../price/price.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [TradeModule, PriceModule, BlockchainModule],
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
