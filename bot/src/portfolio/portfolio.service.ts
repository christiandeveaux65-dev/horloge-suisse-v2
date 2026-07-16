import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { CHAIN, TOKENS, STABLECOINS } from '../constants';

/**
 * Portfolio & Snapshot — Suivi du portefeuille et PnL
 * Snapshots horaires automatiques
 * PnL par token (excluant stablecoins)
 */
@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /** Cron snapshot : toutes les 15 minutes */
  @Cron('0 */15 * * * *')
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.takeSnapshot();
    } catch (err: any) {
      this.logger.error(`Snapshot portefeuille échoué: ${err.message}`);
    }
  }

  /** Prendre un snapshot du portefeuille */
  async takeSnapshot(): Promise<any> {
    // Horodatage du snapshot pr\u00e9c\u00e9dent (pour la r\u00e9conciliation des mouvements de fonds)
    const prevSnap = await this.prisma.portfolio_snapshot.findFirst({
      orderBy: { snapshot_at: 'desc' },
    });
    const prevTime: Date | null = prevSnap ? new Date(prevSnap.snapshot_at) : null;

    const balances = await this.blockchain.getAllBalances();
    const snapshots: any[] = [];

    for (const [token, balStr] of Object.entries(balances)) {
      const balance = parseFloat(balStr);
      if (balance <= 0) continue;

      let priceUsd = 0;
      try {
        priceUsd = await this.priceService.getPrice(token);
      } catch {}

      const valueUsd = balance * priceUsd;

      const snap = await this.prisma.portfolio_snapshot.create({
        data: {
          chain: CHAIN,
          token,
          balance: balStr,
          price_usd: priceUsd.toString(),
          value_usd: valueUsd.toFixed(2),
        },
      });

      snapshots.push(snap);
    }

    // R\u00e9conciliation wallet ledger (le\u00e7on #7) : d\u00e9tecter les mouvements de fonds externes.
    let ledger: any[] = [];
    try {
      ledger = await this.reconcileLedger(prevTime, balances);
    } catch (err: any) {
      this.logger.warn(`R\u00e9conciliation ledger \u00e9chou\u00e9e: ${err.message}`);
    }

    this.logger.log(`Snapshot portefeuille : ${snapshots.length} tokens, ${ledger.length} mouvement(s) externe(s) d\u00e9tect\u00e9(s)`);
    return { snapshots, ledger };
  }

  /**
   * R\u00e9conciliation (le\u00e7on #7) : compare la variation de solde de chaque token depuis le
   * snapshot pr\u00e9c\u00e9dent au flux net induit par les trades du bot sur l'intervalle. Tout
   * \u00e9cart inexpliqu\u00e9 est journalis\u00e9 dans wallet_ledger (deposit/withdrawal) et alert\u00e9.
   */
  private async reconcileLedger(prevTime: Date | null, currentBalances: Record<string, string>): Promise<any[]> {
    if (!prevTime) return []; // premier snapshot : rien \u00e0 comparer
    const entries: any[] = [];

    // Soldes du snapshot pr\u00e9c\u00e9dent, par token
    const prevSnaps = await this.prisma.portfolio_snapshot.findMany({
      where: { snapshot_at: prevTime },
    });
    const prevBal: Record<string, number> = {};
    for (const s of prevSnaps) prevBal[s.token] = parseFloat(s.balance);

    // Trades du bot sur l'intervalle (prevTime, maintenant]
    const trades = await this.prisma.trade.findMany({
      where: { executed_at: { gt: prevTime }, status: { in: ['completed', 'simulated'] } },
      select: { source_token: true, target_token: true, amount_in: true, amount_out: true },
    });

    // Flux net par token induit par le bot
    const botFlow: Record<string, number> = {};
    for (const t of trades) {
      botFlow[t.target_token] = (botFlow[t.target_token] || 0) + parseFloat(t.amount_out || '0');
      botFlow[t.source_token] = (botFlow[t.source_token] || 0) - parseFloat(t.amount_in || '0');
    }

    const allTokens = new Set([...Object.keys(currentBalances), ...Object.keys(prevBal)]);
    for (const token of allTokens) {
      const cur = parseFloat(currentBalances[token] || '0');
      const prev = prevBal[token] || 0;
      const delta = cur - prev;
      const flow = botFlow[token] || 0;
      const unexplained = delta - flow;

      // Tol\u00e9rance relative (gas, arrondis) : 0.5% du solde ou 1e-6 minimum
      const tolerance = Math.max(Math.abs(cur) * 0.005, 1e-6);
      if (Math.abs(unexplained) <= tolerance) continue;

      let priceUsd = 0;
      try { priceUsd = await this.priceService.getPrice(token); } catch {}
      const kind = unexplained > 0 ? 'deposit' : 'withdrawal';
      const entry = await this.prisma.wallet_ledger.create({
        data: {
          chain: CHAIN,
          token,
          kind,
          amount: Math.abs(unexplained).toString(),
          value_usd: (Math.abs(unexplained) * priceUsd).toFixed(2),
          source: 'auto',
          note: `Mouvement externe d\u00e9tect\u00e9 par r\u00e9conciliation (\u0394solde ${delta.toFixed(6)} vs flux bot ${flow.toFixed(6)})`,
        },
      });
      entries.push(entry);
      this.logger.warn(`\u26a0\ufe0f Mouvement de fonds externe: ${kind} ${Math.abs(unexplained)} ${token} (non initi\u00e9 par le bot)`);
    }
    return entries;
  }

  /** Historique du wallet ledger (mouvements de fonds externes). */
  async getWalletLedger(limit = 100): Promise<any> {
    const entries = await this.prisma.wallet_ledger.findMany({
      orderBy: { detected_at: 'desc' }, take: Math.min(limit, 500),
    });
    return { entries, total: entries.length };
  }

  /** Obtenir le portefeuille complet avec PnL */
  async getPortfolio(): Promise<any> {
    const balances = await this.blockchain.getAllBalances();
    const tokens: any[] = [];
    let totalValue = 0;

    for (const [symbol, balStr] of Object.entries(balances)) {
      const balance = parseFloat(balStr);
      if (balance <= 0) continue;

      let priceUsd = 0;
      try {
        priceUsd = await this.priceService.getPrice(symbol);
      } catch {}

      const valueUsd = balance * priceUsd;
      totalValue += valueUsd;

      // Calculer le PnL (excluant stablecoins)
      let pnl: any = null;
      if (!STABLECOINS.has(symbol)) {
        pnl = await this.calculatePnL(symbol);
      }

      tokens.push({
        symbol,
        balance: balStr,
        priceUsd,
        valueUsd,
        pnl,
      });
    }

    return {
      totalValue,
      chain: CHAIN,
      tokens,
      timestamp: new Date(),
    };
  }

  /** Calculer le PnL pour un token */
  private async calculatePnL(token: string): Promise<any> {
    // Total acheté
    const buys = await this.prisma.trade.findMany({
      where: {
        target_token: token,
        side: 'buy',
        status: { in: ['completed', 'simulated'] },
      },
      select: { amount_in: true, amount_out: true },
    });

    // Total vendu
    const sells = await this.prisma.trade.findMany({
      where: {
        source_token: token,
        side: 'sell',
        status: { in: ['completed', 'simulated'] },
      },
      select: { amount_in: true, amount_out: true },
    });

    const totalBoughtUsd = buys.reduce((s, t) => s + parseFloat(t.amount_in), 0);
    const totalSoldUsd = sells.reduce((s, t) => s + parseFloat(t.amount_out), 0);

    // Valeur actuelle du solde
    let currentValue = 0;
    try {
      const { formatted } = await this.blockchain.getBalance(token);
      const price = await this.priceService.getPrice(token);
      currentValue = parseFloat(formatted) * price;
    } catch {}

    const realizedPnl = totalSoldUsd - totalBoughtUsd;
    const unrealizedPnl = currentValue; // valeur actuelle restante
    const totalPnl = realizedPnl + unrealizedPnl - (totalBoughtUsd - totalSoldUsd);

    return {
      totalBoughtUsd,
      totalSoldUsd,
      currentValue,
      realizedPnl,
      totalPnl,
    };
  }

  async getStatus(): Promise<any> {
    const lastSnapshot = await this.prisma.portfolio_snapshot.findFirst({
      orderBy: { snapshot_at: 'desc' },
    });

    return {
      enabled: this.enabled,
      lastSnapshot,
    };
  }
}
