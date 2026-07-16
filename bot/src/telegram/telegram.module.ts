import { Global, Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';

/**
 * Module Telegram global : TelegramService est injectable partout
 * (TradeExecutionService, RiskService, …) sans import explicite.
 */
@Global()
@Module({
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
