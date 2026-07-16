import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
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
 * CÂBLAGE BLOCKCHAIN : le Health Factor est lu on-chain via Pool.getUserAccountData
 * (BlockchainService.aaveGetAccountData) en mode live ; le deleveraging appelle
 * Pool.repay et le débouclage repay + withdraw (BlockchainService.aaveRepay/aaveWithdraw).
 * En mode DRY-RUN (WALLET_PRIVATE_KEY absente), le HF est estimé à partir du prix et les
 * opérations restent 'simulated' (DB uniquement, aucune transaction).
 */
@Injectable()
export class AaveService implements OnModuleInit {
  private readonly logger = new Logger(AaveService.name);
  private static readonly ENABLED_KEY = 'module_aave_enabled';
  // KILL-SWITCH PERSISTANT : désactivé par défaut. L'état réel est lu/écrit en base
  // (app_config) pour survivre aux redéploiements (les toggles en mémoire étaient reset).
  private enabled = false;
  private adoptionDone = false; // adoption de la position Aave préexistante (une fois/boot)

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
  ) {}

  /** Au boot : lit l'état persistant. Si la clé n'existe pas → crée à 'false' (DÉSACTIVÉ). */
  async onModuleInit(): Promise<void> {
    try {
      const row = await this.prisma.app_config.findUnique({ where: { key: AaveService.ENABLED_KEY } });
      if (!row) {
        await this.prisma.app_config.create({ data: { key: AaveService.ENABLED_KEY, value: 'false' } });
        this.enabled = false;
      } else {
        this.enabled = row.value === 'true';
      }
      this.logger.log(`Module Aave ${this.enabled ? 'ACTIVÉ' : 'DÉSACTIVÉ (kill-switch persistant)'} au démarrage.`);
    } catch (err: any) {
      this.enabled = false;
      this.logger.error(`Lecture état Aave échouée, sécurité → DÉSACTIVÉ: ${err.message}`);
    }
  }

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void {
    this.enabled = val;
    // Persiste l'état pour survivre aux redéploiements (fire-and-forget).
    this.prisma.app_config
      .upsert({
        where: { key: AaveService.ENABLED_KEY },
        create: { key: AaveService.ENABLED_KEY, value: val ? 'true' : 'false' },
        update: { value: val ? 'true' : 'false' },
      })
      .catch((err: any) => this.logger.error(`Persistance état Aave échouée: ${err.message}`));
  }

  /** Appelé séquentiellement par le PipelineOrchestrator (plus de @Cron individuel). */
  async tick(): Promise<any> {
    if (!this.enabled) return { skipped: true, reason: 'disabled' };
    try {
      return await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle Aave échoué: ${err.message}`);
      return { error: err.message };
    }
  }

  private async ensureConfig(): Promise<any> {
    let cfg = await this.prisma.aave_loop_config.findFirst();
    if (!cfg) {
      cfg = await this.prisma.aave_loop_config.create({
        data: {
          name: 'Aave V3 Looping USDC',
          supply_token: 'USDC',
          borrow_token: 'USDC',
          target_leverage: String(AAVE_TARGET_LEVERAGE),
          max_loops: AAVE_MAX_LOOPS,
          hf_target: String(AAVE_TARGET_HF),
          hf_deleverage: String(AAVE_DELEVERAGE_HF),
          hf_critical: String(AAVE_CRITICAL_HF),
          paused: false, // Phase 3 : gestion active
        },
      });
      this.logger.log(`Config Aave initialisée USDC/USDC (HF cible ${AAVE_TARGET_HF}, levier ${AAVE_TARGET_LEVERAGE}x, max ${AAVE_MAX_LOOPS} boucles) — ACTIVE`);
    }

    // Phase 3 : aligner les paramètres existants sur la stratégie USDC leveraged yield.
    const updates: any = {};
    if (cfg.supply_token !== 'USDC') updates.supply_token = 'USDC';
    if (cfg.borrow_token !== 'USDC') updates.borrow_token = 'USDC';
    if (parseFloat(cfg.target_leverage) !== AAVE_TARGET_LEVERAGE) updates.target_leverage = String(AAVE_TARGET_LEVERAGE);
    if (parseFloat(cfg.hf_target) !== AAVE_TARGET_HF) updates.hf_target = String(AAVE_TARGET_HF);
    if (parseFloat(cfg.hf_deleverage) !== AAVE_DELEVERAGE_HF) updates.hf_deleverage = String(AAVE_DELEVERAGE_HF);
    if (parseFloat(cfg.hf_critical) !== AAVE_CRITICAL_HF) updates.hf_critical = String(AAVE_CRITICAL_HF);
    if (cfg.paused) updates.paused = false;
    if (Object.keys(updates).length > 0) {
      cfg = await this.prisma.aave_loop_config.update({ where: { id: cfg.id }, data: updates });
      this.logger.log(`Config Aave alignée Phase 3: ${JSON.stringify(updates)}`);
    }
    return cfg;
  }

  async executeCycle(): Promise<any> {
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      return { success: false, reason: 'pause_globale' };
    }

    const cfg = await this.ensureConfig();

    // ── Adoption de la position Aave préexistante on-chain ──
    // Le wallet peut déjà détenir une position de looping (collatéral WETH + dette USDC)
    // ouverte par un bot précédent. On la lit via getUserAccountData et on l'importe en
    // base (une seule fois par boot) afin que le module puisse la surveiller (HF, deleverage).
    // Ne s'exécute qu'en live (hors dry-run) et quand le module est actif et non en pause.
    let adopted: any = null;
    if (cfg.active && !cfg.paused && !this.blockchain.getIsDryRun() && !this.adoptionDone) {
      adopted = await this.adoptOnChainPosition(cfg);
      this.adoptionDone = true;
    }

    // Le monitoring du Health Factor s'exécute TOUJOURS (même en pause) pour protéger
    // toute position ouverte contre la liquidation.
    const monitoring = await this.monitorPositions(cfg);

    return { success: true, adopted, monitoring, paused: cfg.paused };
  }

  /**
   * Adopte la position Aave déjà ouverte on-chain par un bot précédent.
   * Lit getUserAccountData (HF réel + collatéral/dette en USD) et importe/actualise
   * une aave_loop_position en base (statut 'active'). Le collatéral WETH est déduit de
   * totalCollateralUsd / prix ETH. Crée un wallet_ledger (kind='adopted') + un
   * leverage_event (kind='adopt') pour la traçabilité. Idempotent : si une position
   * active existe déjà, on met simplement à jour ses métriques.
   */
  private async adoptOnChainPosition(cfg: any): Promise<any> {
    let acct: any = null;
    try {
      acct = await this.blockchain.aaveGetAccountData();
    } catch (err: any) {
      this.logger.warn(`Adoption Aave: lecture on-chain impossible (${err.message})`);
      return null;
    }
    // Aucune position Aave réelle (pas de collatéral) → rien à adopter.
    if (!acct || acct.totalCollateralUsd <= 0) {
      return { action: 'skip', reason: 'aucune_position_onchain' };
    }

    const price = await this.priceService.getPrice(cfg.supply_token).catch(() => 0);
    const suppliedTokens = price > 0 ? acct.totalCollateralUsd / price : 0;
    const borrowedUsd = acct.totalDebtUsd;
    const equityUsd = Math.max(0, acct.totalCollateralUsd - borrowedUsd);
    const hf = Number.isFinite(acct.healthFactor) ? acct.healthFactor
      : acct.healthFactor === Infinity ? 99 : 0;
    const leverage = equityUsd > 0 ? acct.totalCollateralUsd / equityUsd : 1;

    // Idempotence : une position active est-elle déjà suivie ?
    const existing = await this.prisma.aave_loop_position.findFirst({
      where: { status: { in: ['looping', 'active', 'deleveraging'] } },
    });

    if (existing) {
      await this.prisma.aave_loop_position.update({
        where: { id: existing.id },
        data: {
          total_supplied: suppliedTokens.toString(),
          total_borrowed_usd: borrowedUsd.toFixed(2),
          last_health_factor: hf.toFixed(4),
          last_leverage: leverage.toFixed(2),
        },
      });
      return { action: 'update', id: existing.id, hf: Number(hf.toFixed(3)), collateralUsd: acct.totalCollateralUsd, borrowedUsd, leverage: Number(leverage.toFixed(2)) };
    }

    const pos = await this.prisma.aave_loop_position.create({
      data: {
        config_id: cfg.id,
        supply_token: cfg.supply_token,
        borrow_token: cfg.borrow_token,
        initial_supply: suppliedTokens.toString(),
        initial_equity_usd: equityUsd.toFixed(2),
        total_supplied: suppliedTokens.toString(),
        total_borrowed_usd: borrowedUsd.toFixed(2),
        target_leverage: cfg.target_leverage,
        entry_price: price.toString(),
        last_health_factor: hf.toFixed(4),
        last_leverage: leverage.toFixed(2),
        status: 'active',
      },
    });

    // Ledger : mouvement 'adopted' (PAS un dépôt/retrait externe).
    await this.prisma.wallet_ledger.create({
      data: {
        chain: 'arbitrum',
        token: cfg.supply_token,
        kind: 'adopted',
        amount: suppliedTokens.toString(),
        value_usd: equityUsd.toFixed(2),
        source: 'adopted',
        note: `Position Aave looping adoptée (collatéral $${acct.totalCollateralUsd.toFixed(2)}, dette $${borrowedUsd.toFixed(2)}, HF ${hf.toFixed(3)}, levier ${leverage.toFixed(2)}x)`,
      },
    }).catch(() => undefined);

    await this.prisma.leverage_event.create({
      data: {
        protocol: 'aave', kind: 'adopt', detail: 'position looping adoptée',
        payload: JSON.stringify({
          positionId: pos.id, collateralUsd: acct.totalCollateralUsd, borrowedUsd,
          equityUsd, healthFactor: hf, leverage, suppliedTokens, entryPrice: price,
        }),
      },
    }).catch(() => undefined);

    this.logger.log(`Aave position adoptée: collatéral $${acct.totalCollateralUsd.toFixed(2)}, dette $${borrowedUsd.toFixed(2)}, HF ${hf.toFixed(3)}, levier ${leverage.toFixed(2)}x (equity nette $${equityUsd.toFixed(2)})`);
    return { action: 'adopted', id: pos.id, hf: Number(hf.toFixed(3)), collateralUsd: acct.totalCollateralUsd, borrowedUsd, equityUsd, leverage: Number(leverage.toFixed(2)) };
  }

  /** Calcule un Health Factor estimé et applique les seuils de deleveraging. */
  private async monitorPositions(cfg: any): Promise<any[]> {
    const positions = await this.prisma.aave_loop_position.findMany({
      where: { status: { in: ['looping', 'active', 'deleveraging'] } },
    });
    const results: any[] = [];

    // En mode live, on lit le Health Factor réel du compte on-chain (source de vérité).
    // En dry-run (ou si l'appel échoue) → null, on retombe sur l'estimation par le prix.
    const acct = await this.blockchain.aaveGetAccountData();

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
      const estimatedHf = borrowedUsd > 0 ? (collateralUsd * liquidationThreshold) / borrowedUsd : 99;
      // Priorité au HF on-chain réel s'il est disponible (live), sinon estimation par prix.
      const hf = acct && Number.isFinite(acct.healthFactor) ? acct.healthFactor
        : acct && acct.healthFactor === Infinity ? 99
        : estimatedHf;
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
    const borrowedUsd = parseFloat(pos.total_borrowed_usd) || 0;
    const suppliedTokens = parseFloat(pos.total_supplied) || 0;
    let chainTxs: any[] = [];

    // Exécution on-chain best-effort (live uniquement). En dry-run, DB seulement.
    if (!isDryRun) {
      try {
        if (status === 'deleveraging') {
          // Deleveraging partiel : rembourser ~30 % de la dette pour remonter le HF.
          const repayUsd = borrowedUsd * 0.3;
          if (repayUsd > 0) {
            const r = await this.blockchain.aaveRepay(pos.borrow_token, repayUsd);
            chainTxs.push({ op: 'repay', usd: Number(repayUsd.toFixed(2)), txHash: r.txHash, ok: r.success });
          }
        } else if (status === 'closing') {
          // Débouclage total : rembourser toute la dette puis retirer le collatéral.
          if (borrowedUsd > 0) {
            const r = await this.blockchain.aaveRepay(pos.borrow_token, borrowedUsd);
            chainTxs.push({ op: 'repay', usd: Number(borrowedUsd.toFixed(2)), txHash: r.txHash, ok: r.success });
          }
          if (suppliedTokens > 0) {
            const w = await this.blockchain.aaveWithdraw(pos.supply_token, suppliedTokens);
            chainTxs.push({ op: 'withdraw', tokens: suppliedTokens, txHash: w.txHash, ok: w.success });
          }
        }
      } catch (err: any) {
        this.logger.error(`Aave ${status} on-chain échoué position ${pos.id} : ${err.message}`);
        chainTxs.push({ op: status, error: err.message });
      }
    }

    // Statut final : en dry-run un débouclage passe directement 'closed' ;
    // en live il reste 'closing' (transactions asynchrones/keeper) sauf si aucune dette.
    const finalStatus = status === 'closing' && (isDryRun || borrowedUsd === 0) ? 'closed' : status;

    await this.prisma.aave_loop_position.update({
      where: { id: pos.id },
      data: {
        status: finalStatus,
        close_reason: reason,
        ...(status === 'closing' ? { closed_at: new Date() } : {}),
      },
    });

    await this.prisma.leverage_event.create({
      data: {
        protocol: 'aave',
        kind: status === 'closing' ? 'close' : 'deleverage',
        detail: `${status} position ${pos.id} (HF ${hf.toFixed(3)}, ${reason})`,
        payload: JSON.stringify({ positionId: pos.id, hf: Number(hf.toFixed(3)), reason, chainTxs, simulated: isDryRun }),
      },
    }).catch(() => undefined);

    return { id: pos.id, action: status, hf: Number(hf.toFixed(3)), reason, chainTxs, simulated: isDryRun };
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
      note: 'Démarre en pause. HF lu on-chain (Pool.getUserAccountData) et deleveraging/débouclage câblés (repay/withdraw) en live ; sinon HF estimé + simulé.',
      config: cfg ? { ...cfg, positions: undefined, openPositions: cfg.positions?.length ?? 0 } : null,
    };
  }
}
