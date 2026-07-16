import { Module } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { PriceModule } from '../price/price.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [PriceModule, BlockchainModule],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
