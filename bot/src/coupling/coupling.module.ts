import { Module } from '@nestjs/common';
import { CouplingService } from './coupling.service';
import { PriceModule } from '../price/price.module';

@Module({
  imports: [PriceModule],
  providers: [CouplingService],
  exports: [CouplingService],
})
export class CouplingModule {}
