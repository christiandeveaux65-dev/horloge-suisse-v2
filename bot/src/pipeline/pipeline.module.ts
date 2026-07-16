import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MarketModule } from '../market/market.module';
import { CouplingModule } from '../coupling/coupling.module';
import { RiskModule } from '../risk/risk.module';
import { GridModule } from '../grid/grid.module';
import { FlashLoanModule } from '../flash-loan/flash-loan.module';
import { MomentumModule } from '../momentum/momentum.module';
import { ArbitrageModule } from '../arbitrage/arbitrage.module';
import { GmxModule } from '../gmx/gmx.module';
import { MeanReversionModule } from '../mean-reversion/mean-reversion.module';
import { BasisTradingModule } from '../basis-trading/basis-trading.module';
import { DcaModule } from '../dca/dca.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { AaveModule } from '../aave/aave.module';
import { StablecoinYieldModule } from '../stablecoin-yield/stablecoin-yield.module';
import { StrategistModule } from '../strategist/strategist.module';
import { TelegramModule } from '../telegram/telegram.module';
import { OptimizeInjectModule } from '../optimize-inject/optimize-inject.module';
import { SupervisionModule } from '../supervision/supervision.module';
import { StrategyEvaluatorModule } from '../strategy-evaluator/strategy-evaluator.module';
import { PipelineOrchestrator } from './pipeline.orchestrator';
import { PipelineController } from './pipeline.controller';

@Module({
  imports: [
    PrismaModule,
    MarketModule,
    CouplingModule,
    RiskModule,
    GridModule,
    FlashLoanModule,
    MomentumModule,
    ArbitrageModule,
    GmxModule,
    MeanReversionModule,
    BasisTradingModule,
    DcaModule,
    PortfolioModule,
    AaveModule,
    StablecoinYieldModule,
    StrategistModule,
    TelegramModule,
    OptimizeInjectModule,
    SupervisionModule,
    StrategyEvaluatorModule,
  ],
  controllers: [PipelineController],
  providers: [PipelineOrchestrator],
  exports: [PipelineOrchestrator],
})
export class PipelineModule {}
