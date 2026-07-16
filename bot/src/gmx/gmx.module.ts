import { Module } from '@nestjs/common';
import { GmxService } from './gmx.service';
import { PriceModule } from '../price/price.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [PriceModule, BlockchainModule],
  providers: [GmxService],
  exports: [GmxService],
})
export class GmxModule {}
