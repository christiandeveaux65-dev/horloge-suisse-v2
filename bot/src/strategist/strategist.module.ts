import { Module } from '@nestjs/common';
import { StrategistService } from './strategist.service';

@Module({
  providers: [StrategistService],
  exports: [StrategistService],
})
export class StrategistModule {}
