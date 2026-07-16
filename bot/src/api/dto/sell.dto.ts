import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsInt, Min, Max, Matches } from 'class-validator';

/**
 * DTO de vente manuelle d'urgence (POST /api/sell)
 * Validation stricte : token requis, montant "all" ou nombre > 0, slippage borné [1..1000] bps.
 */
export class SellDto {
  @ApiProperty({ example: 'WETH', description: 'Symbole du token à vendre' })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @ApiProperty({ example: 'all', required: false, description: "Montant à vendre, ou 'all' pour tout liquider" })
  @IsOptional()
  @IsString()
  // 'all' OU un nombre décimal positif
  @Matches(/^(all|\d+(\.\d+)?)$/, { message: "amount doit être 'all' ou un nombre positif" })
  amount?: string;

  @ApiProperty({ example: 100, required: false, description: 'Slippage en bps (1..1000)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  slippage?: number;
}
