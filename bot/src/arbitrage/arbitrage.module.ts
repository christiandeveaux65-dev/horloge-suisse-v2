import { Module } from '@nestjs/common';
import { ArbitrageService } from './arbitrage.service';
import { TradeModule } from '../trade/trade.module';
import { PriceModule } from '../price/price.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [TradeModule, PriceModule, BlockchainModule],
  providers: [ArbitrageService],
  exports: [ArbitrageService],
})
export class ArbitrageModule {}
