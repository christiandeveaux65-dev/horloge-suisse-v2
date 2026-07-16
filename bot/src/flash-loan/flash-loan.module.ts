import { Module } from '@nestjs/common';
import { FlashLoanService } from './flash-loan.service';
import { PriceModule } from '../price/price.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [PriceModule, BlockchainModule],
  providers: [FlashLoanService],
  exports: [FlashLoanService],
})
export class FlashLoanModule {}
