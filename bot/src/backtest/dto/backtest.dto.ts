import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class FetchDataDto {
  @ApiPropertyOptional({
    description: 'Tokens à télécharger (défaut : tous les supportés)',
    example: ['WETH', 'WBTC', 'ARB'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tokens?: string[];

  @ApiPropertyOptional({
    description: 'Timeframes (défaut : 1h et 4h)',
    example: ['1h', '4h'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  timeframes?: string[];

  @ApiPropertyOptional({ description: 'Nombre de mois d\'historique (défaut 12)', example: 12 })
  @IsOptional()
  @IsNumber()
  months?: number;
}

export class RunBacktestDto {
  @ApiProperty({
    description: 'Stratégie à simuler',
    enum: ['dca', 'grid', 'mean_reversion', 'momentum'],
    example: 'mean_reversion',
  })
  @IsIn(['dca', 'grid', 'mean_reversion', 'momentum'])
  strategy!: 'dca' | 'grid' | 'mean_reversion' | 'momentum';

  @ApiPropertyOptional({
    description: 'Tokens concernés (dépend de la stratégie)',
    example: ['ARB', 'PENDLE', 'GMX'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tokens?: string[];

  @ApiPropertyOptional({ description: 'Timeframe (1h ou 4h, défaut 1h)', example: '1h' })
  @IsOptional()
  @IsString()
  timeframe?: string;

  @ApiPropertyOptional({ description: 'Capital initial USD (défaut 10000)', example: 10000 })
  @IsOptional()
  @IsNumber()
  initialCapital?: number;

  @ApiPropertyOptional({ description: 'Frais % par trade (défaut 0.3)', example: 0.3 })
  @IsOptional()
  @IsNumber()
  feesPct?: number;

  @ApiPropertyOptional({ description: 'Slippage % par trade (défaut 0.1)', example: 0.1 })
  @IsOptional()
  @IsNumber()
  slippagePct?: number;

  @ApiPropertyOptional({ description: 'Date de début ISO (défaut : début des données)' })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Date de fin ISO (défaut : fin des données)' })
  @IsOptional()
  @IsString()
  endDate?: string;

  @ApiPropertyOptional({
    description:
      'Paramètres spécifiques à la stratégie. Ex DCA: {amountPerBuy, intervalHours}. '
      + 'Grid: {token, budgetUsd, levels, rangePct}. MR: {rsiPeriod, rsiOversold, rsiOverbought, '
      + 'bbPeriod, bbStdDev, tradeSizeUsd, maxPerToken, maxTotal}. Momentum: {emaShort, emaLong, positionSizeUsd}.',
    example: { rsiOversold: 35, tradeSizeUsd: 100, maxTotal: 800 },
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, any>;
}
