import { Module } from '@nestjs/common';
import { StablecoinYieldService } from './stablecoin-yield.service';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { RiskModule } from '../risk/risk.module';

@Module({
  imports: [BlockchainModule, RiskModule],
  providers: [StablecoinYieldService],
  exports: [StablecoinYieldService],
})
export class StablecoinYieldModule {}
