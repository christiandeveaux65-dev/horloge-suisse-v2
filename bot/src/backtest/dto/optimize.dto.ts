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
    description: 'Méthode de recherche : grid (exhaustif), random (échantillonnage), '
      + 'bayesian (TPE, converge plus vite). Si absent, choix automatique (grid si l\'espace est petit, sinon random).',
    enum: ['grid', 'random', 'bayesian'],
    example: 'bayesian',
  })
  @IsOptional()
  @IsIn(['grid', 'random', 'bayesian'])
  searchMethod?: 'grid' | 'random' | 'bayesian';

  @ApiPropertyOptional({
    description: 'Nombre max de combinaisons à tester (défaut 200, max 500000). '
      + 'grid : recherche exhaustive si l\'espace tient dans le budget. '
      + 'random / bayesian : nombre d\'évaluations. La recherche s\'arrête aussi après ~4 min (résultat partiel).',
    example: 2000,
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
    description: 'Timeframe des bougies (1h ou 4h, défaut 1h).',
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

  @ApiPropertyOptional({
    description: 'Arrêt anticipé (bayesian/random) : stoppe si le meilleur score ne s\'améliore pas '
      + 'pendant N itérations consécutives. 0 ou absent = désactivé.',
    example: 200,
  })
  @IsOptional()
  @IsNumber()
  patience?: number;
}
