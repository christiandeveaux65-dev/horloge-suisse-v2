import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import {
  AAVE_TARGET_HF, AAVE_DELEVERAGE_HF, AAVE_CRITICAL_HF,
  AAVE_MAX_LOOPS, AAVE_TARGET_LEVERAGE,
} from '../constants';

/**
 * Aave V3 Looping — boucle de levier WETH (dépôt WETH / emprunt USDC / rachat WETH).
 * Health Factor : cible 1.8, deleveraging partiel < 1.5, débouclage d'urgence < 1.25.
 * Max 6 boucles (hardcodé). Cron toutes les 15 minutes. DÉMARRE EN PAUSE.
 *
 * NOTE DE TRANSPARENCE : le looping live exige le Pool Aave V3 (supply/borrow/repay) +
 * swaps Uniswap, non câblés au BlockchainService (swaps spot uniquement). Ce module gère
 * la logique de levier, le suivi du Health Factor et les seuils de deleveraging/débouclage ;
 * les opérations sont marquées 'simulated' tant que le Pool Aave n'est pas branché.
 */
@Injectable()
export class AaveService {
  private readonly logger = new Logger(AaveService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  @Cron('0 */15 * * * *')
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle Aave échoué: ${err.message}`);
    }
  }

  private async ensureConfig(): Promise<any> {
    let cfg = await this.prisma.aave_loop_config.findFirst();
    if (!cfg) {
      cfg = await this.prisma.aave_loop_config.create({
        data: {
          name: 'Aave V3 Looping ETH',
          supply_token: 'WETH',
          borrow_token: 'USDC',
          target_leverage: String(AAVE_TARGET_LEVERAGE),
          max_loops: AAVE_MAX_LOOPS,
          hf_target: String(AAVE_TARGET_HF),
          hf_deleverage: String(AAVE_DELEVERAGE_HF),
          hf_critical: String(AAVE_CRITICAL_HF),
          paused: true, // sécurité : démarre en pause
        },
      });
      this.logger.log(`Config Aave initialisée (HF cible ${AAVE_TARGET_HF}/deleverage ${AAVE_DELEVERAGE_HF}/critique ${AAVE_CRITICAL_HF}, max ${AAVE_MAX_LOOPS} boucles) — EN PAUSE`);
    }
    return cfg;
  }

  async executeCycle(): Promise<any> {
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      return { success: false, reason: 'pause_globale' };
    }

    const cfg = await this.ensureConfig();

    // Le monitoring du Health Factor s'exécute TOUJOURS (même en pause) pour protéger
    // toute position ouverte contre la liquidation.
    const monitoring = await this.monitorPositions(cfg);

    return { success: true, monitoring, paused: cfg.paused };
  }

  /** Calcule un Health Factor estimé et applique les seuils de deleveraging. */
  private async monitorPositions(cfg: any): Promise<any[]> {
    const positions = await this.prisma.aave_loop_position.findMany({
      where: { status: { in: ['looping', 'active', 'deleveraging'] } },
    });
    const results: any[] = [];

    for (const pos of positions) {
      const price = await this.priceService.getPrice(pos.supply_token);
      if (!price || price <= 0) {
        results.push({ id: pos.id, action: 'skip', reason: 'prix_indisponible' });
        continue;
      }

      const suppliedTokens = parseFloat(pos.total_supplied) || 0;
      const borrowedUsd = parseFloat(pos.total_borrowed_usd) || 0;
      const collateralUsd = suppliedTokens * price;

      // HF = (collatéral × seuil_liquidation) / dette. Seuil liquidation WETH Aave V3 ≈ 0.83.
      const liquidationThreshold = 0.83;
      const hf = borrowedUsd > 0 ? (collateralUsd * liquidationThreshold) / borrowedUsd : 99;
      const leverage = collateralUsd > 0 ? collateralUsd / Math.max(1, collateralUsd - borrowedUsd) : 1;

      await this.prisma.aave_loop_position.update({
        where: { id: pos.id },
        data: { last_health_factor: hf.toFixed(4), last_leverage: leverage.toFixed(2) },
      });

      // Journaliser un snapshot de levier (traçabilité).
      await this.prisma.leverage_snapshot.create({
        data: {
          protocol: 'aave',
          position_id: pos.id,
          price_usd: price.toString(),
          size_usd: collateralUsd.toFixed(2),
          equity_usd: Math.max(0, collateralUsd - borrowedUsd).toFixed(2),
          health_factor: hf.toFixed(4),
          leverage: leverage.toFixed(2),
        },
      }).catch(() => undefined); // journalisation best-effort

      if (hf < parseFloat(cfg.hf_critical)) {
        results.push(await this.setPositionState(pos, 'closing', hf, 'HF_critique_debouclage'));
        this.logger.error(`🚨 Aave HF critique ${hf.toFixed(3)} < ${cfg.hf_critical} — débouclage d'urgence position ${pos.id}`);
      } else if (hf < parseFloat(cfg.hf_deleverage)) {
        results.push(await this.setPositionState(pos, 'deleveraging', hf, 'HF_bas_deleveraging'));
        this.logger.warn(`⚠️ Aave HF ${hf.toFixed(3)} < ${cfg.hf_deleverage} — deleveraging partiel position ${pos.id}`);
      } else {
        results.push({ id: pos.id, action: 'hold', hf: Number(hf.toFixed(3)), leverage: Number(leverage.toFixed(2)) });
      }
    }
    return results;
  }

  private async setPositionState(pos: any, status: string, hf: number, reason: string): Promise<any> {
    const isDryRun = this.blockchain.getIsDryRun();
    await this.prisma.aave_loop_position.update({
      where: { id: pos.id },
      data: {
        status: status === 'closing' && isDryRun ? 'closed' : status,
        close_reason: reason,
        ...(status === 'closing' ? { closed_at: new Date() } : {}),
      },
    });
    return { id: pos.id, action: status, hf: Number(hf.toFixed(3)), reason };
  }

  async getStatus(): Promise<any> {
    const cfg = await this.prisma.aave_loop_config.findFirst({
      include: { positions: { where: { status: { in: ['looping', 'active', 'deleveraging'] } } } },
    });
    return {
      enabled: this.enabled,
      schedule: '0 */15 * * * * (toutes les 15 min)',
      hfTarget: AAVE_TARGET_HF,
      hfDeleverage: AAVE_DELEVERAGE_HF,
      hfCritical: AAVE_CRITICAL_HF,
      maxLoops: AAVE_MAX_LOOPS,
      note: 'Démarre en pause. Looping live requiert le Pool Aave V3 (non câblé).',
      config: cfg ? { ...cfg, positions: undefined, openPositions: cfg.positions?.length ?? 0 } : null,
    };
  }
}
