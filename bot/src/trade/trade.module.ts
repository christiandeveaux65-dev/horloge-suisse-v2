import { Module } from '@nestjs/common';
import { TradeExecutionService } from './trade-execution.service';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { PriceModule } from '../price/price.module';

@Module({
  imports: [BlockchainModule, PriceModule],
  providers: [TradeExecutionService],
  exports: [TradeExecutionService],
})
export class TradeModule {}
