import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { BlockchainService } from '../blockchain/blockchain.service';
import { RiskService } from '../risk/risk.service';

/**
 * Stablecoin Yield Aggregation — Optimise le rendement des USDC dormants.
 * Compare les APR : Aave V3 supply, GMX GLP/GM pools (info), autres protocoles Arbitrum.
 * Rotation seulement si delta net (APR gagné - gas rotation) > MIN_ROTATION_DELTA_PCT.
 * MVP : COMPARAISON + LOG de la meilleure allocation. La rotation on-chain elle-même
 * (deposit/withdraw Aave supply) est câblée sur Aave V3 (aaveSupply/aaveWithdraw)
 * — décision de rotation loggée en base et exécutable manuellement à l'itération suivante.
 * Cron : toutes les 30 minutes.
 */
@Injectable()
export class StablecoinYieldService implements OnModuleInit {
  private readonly logger = new Logger(StablecoinYieldService.name);
  private static readonly ENABLED_KEY = 'module_stablecoin_yield_enabled';
  // KILL-SWITCH PERSISTANT : désactivé par défaut (survit aux redéploiements via app_config).
  private enabled = false;

  private readonly MIN_IDLE_USDC = 10;              // sous ce seuil, rien à faire
  private readonly MIN_ROTATION_DELTA_PCT = 0.5;    // écart APR minimum pour rotationner
  private readonly ROTATION_GAS_COST_USD = 0.30;    // coût gas d'une rotation Arbitrum
  private readonly RESERVE_USDC = 2000;             // réserve liquide gardée (DCA/arbitrage/basis)
  private readonly MAX_SUPPLY_PER_ROTATION = 1500;  // ticket max déployé par cycle vers Aave
  private readonly MAX_ALLOCATION_PCT = 20;         // PLAFOND DUR : Aave ne doit JAMAIS dépasser 20% du portfolio total

  constructor(
    private readonly prisma: PrismaService,
    private readonly blockchain: BlockchainService,
    private readonly risk: RiskService,
  ) {}

  /** Au boot : lit l'état persistant. Si la clé n'existe pas → crée à 'false' (DÉSACTIVÉ). */
  async onModuleInit(): Promise<void> {
    try {
      const row = await this.prisma.app_config.findUnique({ where: { key: StablecoinYieldService.ENABLED_KEY } });
      if (!row) {
        await this.prisma.app_config.create({ data: { key: StablecoinYieldService.ENABLED_KEY, value: 'false' } });
        this.enabled = false;
      } else {
        this.enabled = row.value === 'true';
      }
      this.logger.log(`Module Stablecoin-Yield ${this.enabled ? 'ACTIVÉ' : 'DÉSACTIVÉ (kill-switch persistant)'} au démarrage.`);
    } catch (err: any) {
      this.enabled = false;
      this.logger.error(`Lecture état Stablecoin-Yield échouée, sécurité → DÉSACTIVÉ: ${err.message}`);
    }
  }

  isEnabled(): boolean { return this.enabled; }
  setEnabled(v: boolean): void {
    this.enabled = v;
    this.prisma.app_config
      .upsert({
        where: { key: StablecoinYieldService.ENABLED_KEY },
        create: { key: StablecoinYieldService.ENABLED_KEY, value: v ? 'true' : 'false' },
        update: { value: v ? 'true' : 'false' },
      })
      .catch((err: any) => this.logger.error(`Persistance état Stablecoin-Yield échouée: ${err.message}`));
  }

  @Cron('0 */30 * * * *', { timeZone: 'Europe/Paris', name: 'stablecoin_yield' })
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    if (!(await acquireCronRun(this.prisma, 'stablecoin_yield', 1800000))) return;
    try { await this.executeCycle(); }
    catch (err: any) { this.logger.error(`Stablecoin yield cycle échoué: ${err.message}`); }
  }

  async executeCycle(): Promise<any> {
    const risk = await this.prisma.risk_config.findFirst();
    if (risk?.global_paused) return { skipped: true, reason: 'risk_global_paused' };

    const balances = await this.blockchain.getAllBalances().catch(() => ({} as Record<string, string>));
    const idleUsdc = parseFloat(balances['USDC'] || '0');

    if (idleUsdc < this.MIN_IDLE_USDC) {
      return { idleUsdc, skipped: true, reason: 'below_min_idle' };
    }

    // Fetch des APR (best-effort, sources externes)
    const yields = await this.fetchYields();

    // Choix du meilleur
    const sorted = [...yields].sort((a, b) => b.aprPct - a.aprPct);
    const best = sorted[0];
    const currentAllocation = 'wallet_idle'; // MVP: USDC dormant dans le wallet = 0% APR
    const currentApr = 0;

    // Gain annuel brut estimé - gas amorti sur 30j (rotation) → delta net
    const grossGainUsd = idleUsdc * (best.aprPct / 100) * (30 / 365);
    const netGainUsd = grossGainUsd - this.ROTATION_GAS_COST_USD;
    const shouldRotate = (best.aprPct - currentApr) >= this.MIN_ROTATION_DELTA_PCT && netGainUsd > 0;

    // Meilleure venue RÉELLEMENT exécutable : Aave V3 supply (rotation on-chain câblée).
    const aave = yields.find(y => y.venue === 'aave_v3_supply');
    const deployableUsdc = idleUsdc - this.RESERVE_USDC;

    // ═══ PLAFOND DUR d'allocation Aave (≤ MAX_ALLOCATION_PCT % du portfolio total) ═══
    // On lit la valeur totale du portfolio ET le collatéral Aave DÉJÀ déployé (cumulatif,
    // tous cycles confondus) pour ne JAMAIS dépasser le plafond, même sur plusieurs cycles.
    const totalPortfolioUsd = await this.risk.getPortfolioValue().catch(() => 0);
    const aaveData = await this.blockchain.aaveGetAccountData().catch(() => null);
    const currentAaveUsd = aaveData ? Math.max(0, aaveData.totalCollateralUsd) : 0;
    const maxAaveUsd = totalPortfolioUsd * (this.MAX_ALLOCATION_PCT / 100);
    const remainingCapacityUsd = Math.max(0, maxAaveUsd - currentAaveUsd);

    const decision: any = {
      idleUsdc: Number(idleUsdc.toFixed(2)),
      reserveUsdc: this.RESERVE_USDC,
      deployableUsdc: Number(Math.max(0, deployableUsdc).toFixed(2)),
      currentAllocation, currentApr,
      candidates: yields,
      best: best,
      executableVenue: aave ? 'aave_v3_supply' : null,
      grossGainUsd30d: Number(grossGainUsd.toFixed(4)),
      netGainUsd30d: Number(netGainUsd.toFixed(4)),
      shouldRotate,
      // Traçabilité du plafond d'allocation
      totalPortfolioUsd: Number(totalPortfolioUsd.toFixed(2)),
      maxAllocationPct: this.MAX_ALLOCATION_PCT,
      maxAaveUsd: Number(maxAaveUsd.toFixed(2)),
      currentAaveUsd: Number(currentAaveUsd.toFixed(2)),
      remainingCapacityUsd: Number(remainingCapacityUsd.toFixed(2)),
      executed: false,
    };

    // Si le plafond d'allocation Aave est déjà atteint (ou portfolio illisible), on NE déploie RIEN.
    if (remainingCapacityUsd < this.MIN_IDLE_USDC) {
      decision.note = totalPortfolioUsd <= 0
        ? 'Valeur portfolio illisible — déploiement Aave bloqué par sécurité'
        : `Plafond Aave ${this.MAX_ALLOCATION_PCT}% atteint : collatéral $${currentAaveUsd.toFixed(2)} ≥ max $${maxAaveUsd.toFixed(2)} (portfolio $${totalPortfolioUsd.toFixed(2)})`;
      decision.skippedReason = 'aave_allocation_cap_atteint';
      this.logger.warn(`Stablecoin yield: ${decision.note}`);
      await this.prisma.leverage_event.create({
        data: {
          protocol: 'stablecoin_yield', kind: 'cap_reached',
          detail: decision.note,
          payload: JSON.stringify(decision),
        },
      }).catch(() => undefined);
      return decision;
    }

    // Exécution réelle : rotation vers Aave V3 supply si conditions réunies.
    if (
      shouldRotate &&
      aave &&
      aave.aprPct >= this.MIN_ROTATION_DELTA_PCT &&
      deployableUsdc >= this.MIN_IDLE_USDC
    ) {
      // Montant = min(déployable après réserve, ticket max/cycle, capacité restante sous le plafond 20%)
      const amount = Math.min(deployableUsdc, this.MAX_SUPPLY_PER_ROTATION, remainingCapacityUsd);
      const amountRounded = Math.floor(amount * 100) / 100; // 2 décimales USDC
      this.logger.log(`Stablecoin yield: rotation $${amountRounded} USDC → Aave V3 supply @ ${aave.aprPct}% (réserve gardée $${this.RESERVE_USDC})`);
      const res = await this.blockchain.aaveSupply('USDC', amountRounded).catch((e: any) => ({ success: false, simulated: false, txHash: '', error: e?.message } as any));
      decision.executed = !!res.success;
      decision.execution = { amountUsdc: amountRounded, venue: 'aave_v3_supply', ...res };

      await this.prisma.leverage_event.create({
        data: {
          protocol: 'stablecoin_yield',
          kind: res.success ? 'rotate_exec' : 'error',
          detail: res.success
            ? `Aave supply $${amountRounded} USDC${res.simulated ? ' [dry-run]' : ' ' + String(res.txHash).slice(0, 12)}`
            : `Aave supply échoué $${amountRounded} USDC: ${res.error}`,
          payload: JSON.stringify(decision),
        },
      }).catch(() => undefined);

      if (res.success) {
        this.logger.log(`Stablecoin yield: rotation exécutée $${amountRounded} USDC → Aave V3${res.simulated ? ' [dry-run]' : ` (tx ${String(res.txHash).slice(0, 12)})`}`);
      } else {
        this.logger.error(`Stablecoin yield: rotation Aave échouée: ${res.error}`);
      }
      return decision;
    }

    // Pas de rotation exécutable : log comparatif.
    if (shouldRotate && (!aave || deployableUsdc < this.MIN_IDLE_USDC)) {
      decision.note = !aave
        ? `Meilleure venue ${best.venue} non câblée on-chain — log seulement (Aave indisponible dans les candidats)`
        : `USDC déployable ($${Math.max(0, deployableUsdc).toFixed(2)}) sous le seuil après réserve $${this.RESERVE_USDC}`;
    }

    await this.prisma.leverage_event.create({
      data: {
        protocol: 'stablecoin_yield', kind: shouldRotate ? 'rotate_signal' : 'compare',
        detail: `idle $${idleUsdc.toFixed(2)}, best=${best.venue}@${best.aprPct}%`,
        payload: JSON.stringify(decision),
      },
    }).catch(() => undefined);

    return decision;
  }

  /** Fetch des APR par venue (best-effort). Fallback sur valeurs typiques Arbitrum. */
  private async fetchYields(): Promise<Array<{ venue: string; aprPct: number; source: string }>> {
    const out: Array<{ venue: string; aprPct: number; source: string }> = [];

    // 1) Aave V3 USDC supply sur Arbitrum — tenter defillama yields API
    try {
      const res = await fetch('https://yields.llama.fi/pools');
      if (res.ok) {
        const data: any = await res.json();
        const pools = Array.isArray(data?.data) ? data.data : [];
        const aave = pools.find((p: any) =>
          p.project === 'aave-v3' && p.chain === 'Arbitrum' && p.symbol === 'USDC');
        if (aave && typeof aave.apy === 'number') {
          out.push({ venue: 'aave_v3_supply', aprPct: Number(aave.apy.toFixed(3)), source: 'defillama' });
        }
      }
    } catch { /* ignore */ }

    // 2) GMX GM USDC pool (single-sided) — via defillama
    try {
      const res = await fetch('https://yields.llama.fi/pools');
      if (res.ok) {
        const data: any = await res.json();
        const pools = Array.isArray(data?.data) ? data.data : [];
        const gmx = pools.find((p: any) =>
          p.project === 'gmx-v2' && p.chain === 'Arbitrum' && String(p.symbol).includes('USDC'));
        if (gmx && typeof gmx.apy === 'number') {
          out.push({ venue: 'gmx_gm_usdc', aprPct: Number(gmx.apy.toFixed(3)), source: 'defillama' });
        }
      }
    } catch { /* ignore */ }

    // Fallback: valeurs typiques si aucun fetch n'a réussi
    if (out.length === 0) {
      out.push({ venue: 'aave_v3_supply', aprPct: 3.5, source: 'fallback' });
      out.push({ venue: 'gmx_gm_usdc', aprPct: 8.0, source: 'fallback' });
    }
    return out;
  }

  async getStatus(): Promise<any> {
    const recent = await this.prisma.leverage_event.findMany({
      where: { protocol: 'stablecoin_yield' },
      orderBy: { created_at: 'desc' }, take: 5,
    });
    return {
      enabled: this.enabled,
      schedule: '0 */30 * * * * (toutes les 30 min)',
      minIdleUsdc: this.MIN_IDLE_USDC,
      minRotationDeltaPct: this.MIN_ROTATION_DELTA_PCT,
      rotationGasCostUsd: this.ROTATION_GAS_COST_USD,
      reserveUsdc: this.RESERVE_USDC,
      maxSupplyPerRotationUsd: this.MAX_SUPPLY_PER_ROTATION,
      maxAllocationPct: this.MAX_ALLOCATION_PCT,
      note: `Exécution ACTIVE : rotation réelle vers Aave V3 supply (USDC) au-dessus de la réserve, PLAFONNÉE à ${this.MAX_ALLOCATION_PCT}% du portfolio total (cumul tous cycles). Chaque opération Aave (supply/borrow/withdraw/repay) déclenche une notification Telegram. Autres venues (GMX GM) = comparaison seulement.`,
      recentDecisions: recent.map(e => ({ kind: e.kind, detail: e.detail, at: e.created_at, payload: JSON.parse(e.payload) })),
    };
  }
}
