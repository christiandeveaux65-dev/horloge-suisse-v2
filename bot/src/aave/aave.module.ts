import { Module } from '@nestjs/common';
import { AaveService } from './aave.service';
import { PriceModule } from '../price/price.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [PriceModule, BlockchainModule],
  providers: [AaveService],
  exports: [AaveService],
})
export class AaveModule {}
