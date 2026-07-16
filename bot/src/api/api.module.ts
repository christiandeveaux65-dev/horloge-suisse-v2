import { Module } from '@nestjs/common';
import { ApiController } from './api.controller';
import { TradeModule } from '../trade/trade.module';
import { DcaModule } from '../dca/dca.module';
import { MomentumModule } from '../momentum/momentum.module';
import { MeanReversionModule } from '../mean-reversion/mean-reversion.module';
import { RiskModule } from '../risk/risk.module';
import { CouplingModule } from '../coupling/coupling.module';
import { MarketModule } from '../market/market.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { PriceModule } from '../price/price.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { GridModule } from '../grid/grid.module';
import { ArbitrageModule } from '../arbitrage/arbitrage.module';
import { GmxModule } from '../gmx/gmx.module';
import { AaveModule } from '../aave/aave.module';
import { StrategistModule } from '../strategist/strategist.module';

@Module({
  imports: [
    TradeModule,
    DcaModule,
    MomentumModule,
    MeanReversionModule,
    RiskModule,
    CouplingModule,
    MarketModule,
    PortfolioModule,
    PriceModule,
    BlockchainModule,
    GridModule,
    ArbitrageModule,
    GmxModule,
    AaveModule,
    StrategistModule,
  ],
  controllers: [ApiController],
})
export class ApiModule {}
