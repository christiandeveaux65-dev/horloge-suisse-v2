import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { PriceModule } from '../price/price.module';

@Module({
  imports: [PriceModule],
  providers: [BlockchainService],
  exports: [BlockchainService],
})
export class BlockchainModule {}
