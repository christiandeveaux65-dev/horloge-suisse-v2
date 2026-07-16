import { Module } from '@nestjs/common';
import { MomentumService } from './momentum.service';
import { TradeModule } from '../trade/trade.module';
import { PriceModule } from '../price/price.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [TradeModule, PriceModule, BlockchainModule],
  providers: [MomentumService],
  exports: [MomentumService],
})
export class MomentumModule {}
