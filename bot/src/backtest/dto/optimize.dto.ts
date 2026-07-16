import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray, IsIn, IsNumber, IsOptional, IsString,
} from 'class-validator';

export class OptimizeDto {
  @ApiProperty({
    description: 'Stratégie à optimiser',
    enum: ['dca', 'grid', 'mean_reversion', 'momentum'],
    example: 'mean_reversion',
  })
  @IsIn(['dca', 'grid', 'mean_reversion', 'momentum'])
  strategy!: 'dca' | 'grid' | 'mean_reversion' | 'momentum';

  @ApiPropertyOptional({
    description: 'Fonction de perte / objectif à optimiser (défaut Balanced)',
    enum: ['SharpeOptimize', 'SortinoOptimize', 'ProfitMaximize', 'MinDrawdown', 'Balanced'],
    example: 'SharpeOptimize',
  })
  @IsOptional()
  @IsIn(['SharpeOptimize', 'SortinoOptimize', 'ProfitMaximize', 'MinDrawdown', 'Balanced'])
  lossFunction?: string;

  @ApiPropertyOptional({
    description: 'Nombre max de combinaisons à tester (défaut 200, max 1500). '
      + 'Si l\'espace de recherche est plus petit, recherche exhaustive (grid) ; sinon random search.',
    example: 200,
  })
  @IsOptional()
  @IsNumber()
  maxIterations?: number;

  @ApiPropertyOptional({
    description: 'Tokens concernés (défaut : panier de la stratégie)',
    example: ['ARB', 'PENDLE', 'GMX'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tokens?: string[];

  @ApiPropertyOptional({
    description: 'Timeframe (1h ou 4h, défaut 1h). Ignoré pour momentum qui optimise aussi le timeframe.',
    example: '1h',
  })
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
}
