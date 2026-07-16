import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';

/**
 * Flash Loan Arbitrage — Détection d'arbitrage triangulaire on-chain via Aave V3 flash loans.
 * Route testée : USDC → WETH → ARB → USDC (et symétriques).
 * MVP : SCAN + LOG des opportunités. L'exécution réelle nécessite un contrat exécuteur
 * on-chain déployé (Aave flashLoan callback) — hors périmètre de cette itération.
 * Le module respecte le Risk Manager (skip si global_paused).
 * Cron : toutes les 3 minutes.
 */
@Injectable()
export class FlashLoanService {
  private readonly logger = new Logger(FlashLoanService.name);
  private enabled = true;

  // Paramètres MVP hardcodés (constants Phase 4)
  private readonly GAS_COST_USD = 0.60;          // estimation gas 3 swaps Arbitrum
  private readonly MIN_PROFIT_USD = 0.50;        // profit net minimum pour exécuter
  private readonly NOTIONAL_USD = 300;           // ticket réel borné (capital wallet, pas de flash loan)
  private readonly SWAP_SLIPPAGE_BPS = 50;       // slippage max par swap réel (0.5%)
  private readonly RESERVE_USDC = 100;           // réserve USDC gardée hors arbitrage
  private readonly TRIANGLES: [string, string, string][] = [
    ['USDC', 'WETH', 'ARB'],
    ['USDC', 'WETH', 'LINK'],
    ['USDC', 'WBTC', 'WETH'],
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(v: boolean): void { this.enabled = v; }

  @Cron('0 */3 * * * *', { timeZone: 'Europe/Paris', name: 'flash_loan' })
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    if (!(await acquireCronRun(this.prisma, 'flash_loan', 180000))) return;
    try { await this.executeCycle(); }
    catch (err: any) { this.logger.error(`Flash-loan cycle échoué: ${err.message}`); }
  }

  async executeCycle(): Promise<any> {
    // Respect du Risk Manager (gardien critique)
    const risk = await this.prisma.risk_config.findFirst();
    if (risk?.global_paused) return { skipped: true, reason: 'risk_global_paused' };

    const opportunities: any[] = [];
    for (const [a, b, c] of this.TRIANGLES) {
      const opp = await this.scanTriangle(a, b, c).catch((e: any) => {
        this.logger.debug(`scanTriangle ${a}→${b}→${c} échoué: ${e?.message}`);
        return null;
      });
      if (opp) opportunities.push(opp);
    }

    const profitable = opportunities.filter(o => o.netProfitUsd >= this.MIN_PROFIT_USD);
    let executed: any = null;

    if (profitable.length > 0) {
      // On exécute la MEILLEURE opportunité seulement (une par cycle, capital borné).
      profitable.sort((x, y) => y.netProfitUsd - x.netProfitUsd);
      for (const p of profitable) {
        await this.prisma.leverage_event.create({
          data: {
            protocol: 'flash_loan', kind: 'opportunity',
            detail: `Triangle ${p.path.join('→')} net $${p.netProfitUsd.toFixed(2)}`,
            payload: JSON.stringify(p),
          },
        }).catch(() => undefined);
        this.logger.log(`Arbitrage triangulaire opportunité: ${p.path.join('→')} netProfit=$${p.netProfitUsd.toFixed(2)}`);
      }
      executed = await this.executeTriangle(profitable[0]).catch((e: any) => {
        this.logger.error(`Exécution triangle échouée: ${e?.message}`);
        return { executed: false, error: e?.message };
      });
    }

    return { scanned: opportunities.length, profitable: profitable.length, opportunities, executed };
  }

  /**
   * Scanne un triangle A → B → C → A avec des QUOTES DEX RÉELLES (Uniswap Quoter V2).
   * Chaque hop reflète la profondeur de pool réelle + les frais → détection fiable.
   */
  private async scanTriangle(a: string, b: string, c: string): Promise<any> {
    const N = this.NOTIONAL_USD; // en USDC (A est toujours USDC dans nos triangles)

    // Hop 1 : A → B
    const q1 = await this.blockchain.getQuote(a, b, N.toString());
    const bTokens = parseFloat(q1.amountOut);
    if (!isFinite(bTokens) || bTokens <= 0) return null;

    // Hop 2 : B → C
    const q2 = await this.blockchain.getQuote(b, c, bTokens.toString());
    const cTokens = parseFloat(q2.amountOut);
    if (!isFinite(cTokens) || cTokens <= 0) return null;

    // Hop 3 : C → A (USDC)
    const q3 = await this.blockchain.getQuote(c, a, cTokens.toString());
    const aReceivedUsd = parseFloat(q3.amountOut);
    if (!isFinite(aReceivedUsd) || aReceivedUsd <= 0) return null;

    const grossProfit = aReceivedUsd - N;
    const netProfit = grossProfit - this.GAS_COST_USD;

    return {
      path: [a, b, c, a],
      notionalUsd: N,
      hops: { [`${a}->${b}`]: bTokens, [`${b}->${c}`]: cTokens, [`${c}->${a}`]: aReceivedUsd },
      grossProfitUsd: Number(grossProfit.toFixed(4)),
      gasCostUsd: this.GAS_COST_USD,
      netProfitUsd: Number(netProfit.toFixed(4)),
      executable: netProfit >= this.MIN_PROFIT_USD,
      note: 'Quotes DEX réelles (Uniswap Quoter V2) — arbitrage spot capital wallet, pas de flash loan',
    };
  }

  /**
   * Exécute le triangle via 3 swaps réels séquentiels (capital du wallet, borné).
   * Garde-fous : Risk Manager (re-vérifié), USDC disponible ≥ ticket + réserve,
   * re-quote juste avant exécution pour confirmer que c'est toujours profitable.
   */
  private async executeTriangle(opp: any): Promise<any> {
    const [a, b, c] = opp.path; // a = USDC
    const N = this.NOTIONAL_USD;

    // Garde 1 : Risk Manager toujours actif ?
    const risk = await this.prisma.risk_config.findFirst();
    if (risk?.global_paused) return { executed: false, reason: 'risk_global_paused' };

    // Garde 2 : USDC disponible suffisant (ticket + réserve) ?
    const balances = await this.blockchain.getAllBalances().catch(() => ({} as Record<string, string>));
    const usdc = parseFloat(balances['USDC'] || '0');
    if (usdc < N + this.RESERVE_USDC) {
      return { executed: false, reason: 'usdc_insuffisant', usdc, requis: N + this.RESERVE_USDC };
    }

    // Garde 3 : re-quote juste avant → toujours profitable ?
    const recheck = await this.scanTriangle(a, b, c).catch(() => null);
    if (!recheck || recheck.netProfitUsd < this.MIN_PROFIT_USD) {
      return { executed: false, reason: 'plus_profitable_au_recheck', recheck: recheck?.netProfitUsd ?? null };
    }

    this.logger.log(`Arbitrage triangulaire EXÉCUTION ${opp.path.join('→')} ticket $${N} (net attendu $${recheck.netProfitUsd.toFixed(2)})`);

    // Hop 1 : USDC → B
    const s1 = await this.blockchain.executeSwap(a, b, N.toString(), this.SWAP_SLIPPAGE_BPS);
    if (!s1.success) {
      await this.logExec(opp, false, `hop1 ${a}→${b} échoué`, { s1 });
      return { executed: false, reason: 'hop1_echec', error: (s1 as any).error };
    }
    const bAmt = parseFloat((s1 as any).amountOut || recheck.hops[`${a}->${b}`]);

    // Hop 2 : B → C
    const s2 = await this.blockchain.executeSwap(b, c, bAmt.toString(), this.SWAP_SLIPPAGE_BPS);
    if (!s2.success) {
      await this.logExec(opp, false, `hop2 ${b}→${c} échoué (capital en ${b})`, { s1, s2 });
      return { executed: false, reason: 'hop2_echec', error: (s2 as any).error, stuckIn: b, amount: bAmt };
    }
    const cAmt = parseFloat((s2 as any).amountOut || recheck.hops[`${b}->${c}`]);

    // Hop 3 : C → USDC
    const s3 = await this.blockchain.executeSwap(c, a, cAmt.toString(), this.SWAP_SLIPPAGE_BPS);
    if (!s3.success) {
      await this.logExec(opp, false, `hop3 ${c}→${a} échoué (capital en ${c})`, { s1, s2, s3 });
      return { executed: false, reason: 'hop3_echec', error: (s3 as any).error, stuckIn: c, amount: cAmt };
    }
    const usdcOut = parseFloat((s3 as any).amountOut || String(recheck.hops[`${c}->${a}`]));
    const realizedProfit = usdcOut - N;

    await this.logExec(opp, true, `réalisé $${realizedProfit.toFixed(2)} (out $${usdcOut.toFixed(2)})`, {
      usdcOut, realizedProfit, simulated: (s3 as any).simulated,
      tx: { s1: (s1 as any).txHash, s2: (s2 as any).txHash, s3: (s3 as any).txHash },
    });
    this.logger.log(`Arbitrage triangulaire terminé ${opp.path.join('→')} : réalisé $${realizedProfit.toFixed(2)}`);
    return { executed: true, usdcOut, realizedProfitUsd: Number(realizedProfit.toFixed(4)), simulated: (s3 as any).simulated };
  }

  private async logExec(opp: any, ok: boolean, detail: string, extra: any): Promise<void> {
    await this.prisma.leverage_event.create({
      data: {
        protocol: 'flash_loan',
        kind: ok ? 'execute' : 'error',
        detail: `${opp.path.join('→')} ${detail}`,
        payload: JSON.stringify({ opp, ...extra }),
      },
    }).catch(() => undefined);
  }

  async getStatus(): Promise<any> {
    const recent = await this.prisma.leverage_event.findMany({
      where: { protocol: 'flash_loan', kind: 'opportunity' },
      orderBy: { created_at: 'desc' }, take: 5,
    });
    return {
      enabled: this.enabled,
      schedule: '0 */3 * * * * (toutes les 3 min)',
      minProfitUsd: this.MIN_PROFIT_USD,
      notionalUsd: this.NOTIONAL_USD,
      swapSlippageBps: this.SWAP_SLIPPAGE_BPS,
      reserveUsdc: this.RESERVE_USDC,
      triangles: this.TRIANGLES.map(t => t.join('→')),
      note: 'Exécution ACTIVE : quotes DEX réelles (Uniswap Quoter V2) + 3 swaps réels séquentiels (capital wallet borné, PAS de flash loan) si net-profitable. Respecte le Risk Manager.',
      recentOpportunities: recent.map(e => ({ detail: e.detail, at: e.created_at, payload: JSON.parse(e.payload) })),
    };
  }
}
