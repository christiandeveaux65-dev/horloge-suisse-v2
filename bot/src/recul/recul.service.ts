import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { PriceService } from '../price/price.service';
import {
  STABLECOINS,
  DCA_BASKET,
  GRID_BUDGET_USD,
  MOMENTUM_ALTS_BUDGET_USD,
  MOMENTUM_BC_BUDGET_USD,
  MAX_TOTAL_EXPOSURE_MR,
} from '../constants';

// Plafonds de budget CONFIGURÉS par stratégie à budget dédié (valeurs réellement
// codées/appliquées dans le bot — pas d'invention) :
//  • grid           → GRID_BUDGET_USD (plafond de sécurité absolu du capital grid)
//  • momentum       → somme des budgets configurés alts + blue chips
//  • mean_reversion → MAX_TOTAL_EXPOSURE_MR (plafond dur d'exposition MR)
// C'est CE plafond qui sert de « cible » réaliste dans /recul, et non plus le
// `recommended_allocation_pct` du Strategy Evaluator (normalisation de scores qui,
// lorsque tous les scores non-DCA valent 0, dégénère en ~1,5 % arbitraire).
const BUDGET_CEILING_USD: Record<string, number> = {
  grid: GRID_BUDGET_USD,
  momentum: MOMENTUM_ALTS_BUDGET_USD + MOMENTUM_BC_BUDGET_USD,
  mean_reversion: MAX_TOTAL_EXPOSURE_MR,
};

export interface ReculInput {
  modules: Record<string, boolean>;
  isDryRun: boolean;
  globalPaused: boolean;
  portfolioValue: number;
  drawdownPct: number;
}

interface StratRow {
  strategy: string;
  targetPct: number; // allocation cible (directive)
  active: boolean; // recommandée active
  score: number;
  regime: string;
  reason: string;
  currentUsd: number | null; // budget appliqué (null si non applicable)
  currentPct: number | null; // % du capital
  ceilingUsd: number | null; // plafond de budget CONFIGURÉ ($) — stratégies à budget dédié
  ceilingPct: number | null; // plafond configuré en % du capital
  gapPct: number | null; // currentPct - ceilingPct (positif = dépassement du plafond)
  moduleEnabled: boolean;
  trades30d: number;
  trades24h: number;
  pnlUsd: number | null;
}

/**
 * ReculService — commande « /recul » : prise de conscience complète du bot.
 *
 * Agrège l'état global, l'inventaire des positions (wallet + DeFi GMX/Aave),
 * les écarts entre allocations actuelles et cibles (directives du Strategy
 * Evaluator vs budgets appliqués), la performance par stratégie, détecte les
 * déséquilibres et génère des suggestions d'actions correctives. Retourne un
 * message HTML formaté prêt pour Telegram + les données brutes.
 *
 * Lecture seule : ne modifie AUCUN état de trading.
 */
@Injectable()
export class ReculService {
  private readonly logger = new Logger(ReculService.name);

  // Seuils de détection des déséquilibres.
  private readonly TOKEN_OVERWEIGHT_PCT = 40; // token non-stable > 40 % du portefeuille
  private readonly ALLOC_GAP_PCT = 5; // écart alloc actuelle/cible > 5 pts
  private readonly LOSS_ALERT_USD = 50; // perte stratégie/token > $50

  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolio: PortfolioService,
    private readonly priceService: PriceService,
  ) {}

  async generate(input: ReculInput): Promise<{ message: string; data: any }> {
    const now = new Date();
    const since30d = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const since24h = new Date(now.getTime() - 24 * 3600 * 1000);

    // ── 1. Inventaire portefeuille (wallet + DeFi) ──
    let portfolio: any = { totalValue: 0, walletValue: 0, tokens: [], defi: {} };
    try {
      portfolio = await this.portfolio.getPortfolio();
    } catch (e: any) {
      this.logger.warn(`getPortfolio échoué: ${e.message}`);
    }
    const totalValue = portfolio.totalValue || input.portfolioValue || 0;
    const capital = totalValue > 0 ? totalValue : input.portfolioValue || 0;

    // ── 2. Directives (allocations cibles) + budgets appliqués (allocations actuelles) ──
    const [directives, gridCfgs, mrCfgs, momCfgs] = await Promise.all([
      (this.prisma as any).strategy_directive.findMany().catch(() => []),
      (this.prisma as any).grid_config.findMany().catch(() => []),
      (this.prisma as any).mean_reversion_config.findMany().catch(() => []),
      (this.prisma as any).momentum_config.findMany().catch(() => []),
    ]);
    const sumBudget = (rows: any[]) =>
      rows.reduce((s, r) => s + (parseFloat(r.budget_usd) || 0), 0);
    const budgetByStrat: Record<string, number | null> = {
      grid: sumBudget(gridCfgs),
      mean_reversion: sumBudget(mrCfgs),
      momentum: sumBudget(momCfgs),
      // dca / arbitrage / basis_trading / flash_loan : pas de budget dédié en base
    };

    // ── 3. Trades sur 30 j pour perf + activité par stratégie ──
    const trades30d: any[] = await this.prisma.trade
      .findMany({ where: { executed_at: { gte: since30d } }, orderBy: { executed_at: 'asc' } })
      .catch(() => [] as any[]);

    // Valorisation USD (mark-to-market) — même modèle que /api/analytics.
    const priceCache: Record<string, number> = {};
    const distinct = new Set<string>();
    for (const t of trades30d) {
      for (const tok of [t.source_token, t.target_token]) {
        const sym = String(tok || '').toUpperCase();
        if (sym && !STABLECOINS.has(sym)) distinct.add(sym);
      }
    }
    await Promise.all(
      Array.from(distinct).map(async (sym) => {
        try {
          const p = await this.priceService.getPrice(sym);
          if (Number.isFinite(p) && (p as number) > 0) priceCache[sym] = p as number;
        } catch {}
      }),
    );
    const usdVal = (token: string, amount: number): number | null => {
      const sym = String(token || '').toUpperCase();
      if (STABLECOINS.has(sym)) return amount;
      const p = priceCache[sym];
      return p && p > 0 ? amount * p : null;
    };

    const stats: Record<
      string,
      { trades30d: number; trades24h: number; buys: number; sells: number; pnl: number; pnlKnown: boolean }
    > = {};
    const bump = (src: string) => {
      if (!stats[src])
        stats[src] = { trades30d: 0, trades24h: 0, buys: 0, sells: 0, pnl: 0, pnlKnown: false };
      return stats[src];
    };
    for (const t of trades30d) {
      const amountIn = Number(t.amount_in ?? 0);
      const amountOut = Number(t.amount_out ?? 0);
      const executed = amountOut > 0 && !['failed', 'expired', 'cancelled'].includes(t.status);
      if (!executed) continue;
      const s = bump(t.source || 'unknown');
      s.trades30d++;
      if (new Date(t.executed_at) >= since24h) s.trades24h++;
      if ((t.side || '').toLowerCase() === 'buy') s.buys++;
      else if ((t.side || '').toLowerCase() === 'sell') s.sells++;
      const vIn = usdVal(t.source_token, amountIn);
      const vOut = usdVal(t.target_token, amountOut);
      if (vIn != null && vOut != null) {
        s.pnl += vOut - vIn;
        s.pnlKnown = true;
      }
    }

    // ── 4. Construire le tableau stratégie par stratégie (écarts alloc + perf) ──
    const stratRows: StratRow[] = [];
    const dirByName = new Map<string, any>((directives || []).map((d: any) => [d.strategy, d]));
    const allStrats = new Set<string>([
      ...Array.from(dirByName.keys()),
      ...Object.keys(budgetByStrat),
      ...Object.keys(stats),
    ]);
    // Correspondance stratégie → clé de module (pour l'état activé).
    const moduleKey: Record<string, string> = {
      grid: 'grid',
      momentum: 'momentum',
      mean_reversion: 'mean_reversion',
      dca: 'dca',
      arbitrage: 'arbitrage',
      gmx: 'gmx',
    };
    for (const strat of allStrats) {
      const d = dirByName.get(strat);
      // NB : pour DCA on NE prend PAS la directive `recommended_allocation_pct`
      // (allocation stratégie au niveau capital, ex. 90,8 %) car elle n'a pas de
      // sens comme « cible DCA ». La cible DCA est la répartition du panier
      // (section dédiée ci-dessous). On neutralise donc sa cible ici.
      const targetPct = strat === 'dca' ? 0 : d ? Number(d.recommended_allocation_pct) || 0 : 0;
      const budget = budgetByStrat[strat];
      const currentUsd = budget == null ? null : budget;
      const currentPct =
        currentUsd == null || capital <= 0 ? null : (currentUsd / capital) * 100;
      // Plafond de budget CONFIGURÉ (vraie « cible » réaliste) et son % du capital.
      const ceilingUsd = BUDGET_CEILING_USD[strat] ?? null;
      const ceilingPct =
        ceilingUsd != null && capital > 0 ? (ceilingUsd / capital) * 100 : null;
      // Écart vs plafond configuré (positif = dépassement du plafond).
      const gapPct =
        currentPct == null || ceilingPct == null ? null : currentPct - ceilingPct;
      const st = stats[strat];
      const mk = moduleKey[strat];
      stratRows.push({
        strategy: strat,
        targetPct,
        active: d ? !!d.recommended_active : true,
        score: d ? Number(d.score) || 0 : 0,
        regime: d ? d.regime : '—',
        reason: d ? d.reason : '',
        currentUsd,
        currentPct,
        ceilingUsd,
        ceilingPct,
        gapPct,
        moduleEnabled: mk ? input.modules[mk] !== false : true,
        trades30d: st ? st.trades30d : 0,
        trades24h: st ? st.trades24h : 0,
        pnlUsd: st && st.pnlKnown ? st.pnl : null,
      });
    }
    stratRows.sort((a, b) => b.targetPct - a.targetPct);

    const regime = (directives || [])[0]?.regime || '—';

    // ── 5. Inventaire tokens (poids + PnL) ──
    const tokens = (portfolio.tokens || [])
      .map((t: any) => ({
        symbol: t.symbol,
        valueUsd: Number(t.valueUsd) || 0,
        weightPct: capital > 0 ? ((Number(t.valueUsd) || 0) / capital) * 100 : 0,
        totalPnl: t.pnl ? Number(t.pnl.totalPnl) : null,
        isStable: STABLECOINS.has(String(t.symbol).toUpperCase()),
      }))
      .sort((a: any, b: any) => b.valueUsd - a.valueUsd);

    // ── 5bis. Panier DCA : répartition actuelle vs cible (total 100%) ──
    // Le panier DCA cible une répartition INTERNE (WETH 25%, WBTC 30%, ARB 15%,
    // LINK 15%, GMX 15%). On compare la valeur USD détenue de chaque token du
    // panier à sa cible. ETH natif est agrégé dans le bucket WETH.
    const tokenUsdBySym: Record<string, number> = {};
    for (const t of portfolio.tokens || []) {
      let sym = String(t.symbol || '').toUpperCase();
      if (sym === 'ETH') sym = 'WETH'; // agréger l'ETH natif avec WETH
      tokenUsdBySym[sym] = (tokenUsdBySym[sym] || 0) + (Number(t.valueUsd) || 0);
    }
    const dcaBasketSumUsd = DCA_BASKET.reduce(
      (s, b) => s + (tokenUsdBySym[b.token.toUpperCase()] || 0),
      0,
    );
    const dcaBasket = DCA_BASKET.map((b) => {
      const sym = b.token.toUpperCase();
      const usd = tokenUsdBySym[sym] || 0;
      const targetPct = b.weight * 100;
      const currentPct = dcaBasketSumUsd > 0 ? (usd / dcaBasketSumUsd) * 100 : 0;
      const gapPct = currentPct - targetPct;
      return { token: sym, usd, targetPct, currentPct, gapPct };
    });

    const gmxPositions = portfolio.defi?.gmxPositions || [];
    const aave = portfolio.defi?.aave || null;
    const defiUsd = Number(portfolio.defi?.totalUsd) || 0;

    // ── 6. Alertes récentes ──
    const riskEvents: any[] = await this.prisma.risk_event
      .findMany({ where: { created_at: { gte: since24h } }, orderBy: { created_at: 'desc' }, take: 5 })
      .catch(() => [] as any[]);

    // ── 7. Détection des déséquilibres ──
    const imbalances: string[] = [];
    // Tokens surpondérés (non-stable)
    for (const t of tokens) {
      if (!t.isStable && t.weightPct > this.TOKEN_OVERWEIGHT_PCT) {
        imbalances.push(
          `🔴 <b>${t.symbol}</b> surpondéré : ${t.weightPct.toFixed(1)}% du portefeuille ($${t.valueUsd.toFixed(0)})`,
        );
      }
    }
    // Dépassement du plafond de budget CONFIGURÉ (stratégies à budget dédié)
    for (const r of stratRows) {
      if (r.currentUsd != null && r.ceilingUsd != null && r.currentUsd > r.ceilingUsd * 1.05) {
        const over = r.currentUsd - r.ceilingUsd;
        imbalances.push(
          `🟠 <b>${r.strategy}</b> dépasse son plafond de budget configuré : ${this.fmtUsd(r.currentUsd)} (${r.currentPct!.toFixed(1)}%) > plafond ${this.fmtUsd(r.ceilingUsd)} (${r.ceilingPct!.toFixed(1)}%) — dépassement ${this.fmtUsd(over)}`,
        );
      }
    }
    // Pertes excessives par stratégie
    for (const r of stratRows) {
      if (r.pnlUsd != null && r.pnlUsd < -this.LOSS_ALERT_USD) {
        imbalances.push(
          `🔴 <b>${r.strategy}</b> en perte : ${r.pnlUsd.toFixed(0)}$ sur 30 j (${r.trades30d} trades)`,
        );
      }
    }
    // Pertes excessives par token
    for (const t of tokens) {
      if (t.totalPnl != null && t.totalPnl < -this.LOSS_ALERT_USD) {
        imbalances.push(`🔴 <b>${t.symbol}</b> PnL latent ${t.totalPnl.toFixed(0)}$`);
      }
    }
    // Stratégies inactives (censées être actives mais ne tradent pas, ou module coupé)
    for (const r of stratRows) {
      if (r.active && r.targetPct >= this.ALLOC_GAP_PCT) {
        if (!r.moduleEnabled) {
          imbalances.push(
            `⚫ <b>${r.strategy}</b> DÉSACTIVÉ alors que sa cible est ${r.targetPct.toFixed(1)}% (module coupé)`,
          );
        } else if (r.trades24h === 0) {
          imbalances.push(
            `🟡 <b>${r.strategy}</b> inactif sur 24 h (0 trade) malgré une cible de ${r.targetPct.toFixed(1)}%`,
          );
        }
      }
    }

    // ── 8. Suggestions d'actions correctives ──
    const suggestions: string[] = [];
    for (const t of tokens) {
      if (!t.isStable && t.weightPct > this.TOKEN_OVERWEIGHT_PCT) {
        suggestions.push(
          `Alléger <b>${t.symbol}</b> (vente partielle) pour ramener son poids sous ${this.TOKEN_OVERWEIGHT_PCT}% et reconstituer une réserve USDC.`,
        );
      }
    }
    for (const r of stratRows) {
      if (r.currentUsd != null && r.ceilingUsd != null && r.currentUsd > r.ceilingUsd * 1.05) {
        const over = r.currentUsd - r.ceilingUsd;
        suggestions.push(
          `Réduire le budget de <b>${r.strategy}</b> (~${this.fmtUsd(r.currentUsd)}) vers son plafond configuré ~${this.fmtUsd(r.ceilingUsd)} (dépassement ${this.fmtUsd(over)}).`,
        );
      }
      if (r.active && r.targetPct >= this.ALLOC_GAP_PCT && !r.moduleEnabled) {
        suggestions.push(
          `Envisager de réactiver <b>${r.strategy}</b> (recommandé actif) — ou confirmer le maintien de la coupure.`,
        );
      }
      if (r.pnlUsd != null && r.pnlUsd < -this.LOSS_ALERT_USD) {
        suggestions.push(
          `Auditer <b>${r.strategy}</b> (perte ${r.pnlUsd.toFixed(0)}$ / 30 j) : revoir seuils ou suspendre.`,
        );
      }
    }
    // Suggestions liées au panier DCA (surpondéré / sous-pondéré vs cible interne)
    if (dcaBasketSumUsd > 0) {
      for (const b of dcaBasket) {
        if (b.gapPct > this.ALLOC_GAP_PCT) {
          suggestions.push(
            `Panier DCA : <b>${b.token}</b> surpondéré (${b.currentPct.toFixed(1)}% vs cible ${b.targetPct.toFixed(1)}%) — espacer/suspendre ses achats DCA jusqu'au retour vers la cible.`,
          );
        } else if (b.gapPct < -this.ALLOC_GAP_PCT) {
          suggestions.push(
            `Panier DCA : <b>${b.token}</b> sous sa cible (${b.currentPct.toFixed(1)}% vs ${b.targetPct.toFixed(1)}%) — les prochains achats DCA vont le renforcer (comportement attendu).`,
          );
        }
      }
    }
    if (input.globalPaused) {
      suggestions.push('⚠️ Le bot est en <b>PAUSE GLOBALE</b> — aucune exécution. Lever la pause via /api/resume si voulu.');
    }
    if (input.drawdownPct >= 5) {
      suggestions.push(`Drawdown élevé (${input.drawdownPct.toFixed(1)}%) : réduire l'exposition globale et privilégier les stables.`);
    }
    if (suggestions.length === 0) {
      suggestions.push('Aucune action corrective majeure — le bot est globalement aligné sur ses cibles. ✅');
    }

    const data = {
      capital,
      walletValue: portfolio.walletValue,
      defiUsd,
      regime,
      tokens,
      dcaBasket,
      dcaBasketSumUsd,
      gmxPositions,
      aave,
      strategies: stratRows,
      imbalances,
      suggestions,
      riskEvents,
      generated_at: now.toISOString(),
    };

    const message = this.formatMessage(input, data);
    return { message, data };
  }

  private fmtUsd(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return '—';
    const sign = n < 0 ? '-' : '';
    return `${sign}$${Math.abs(n).toLocaleString('fr-FR', { maximumFractionDigits: 0 })}`;
  }

  private formatMessage(input: ReculInput, d: any): string {
    const L: string[] = [];
    const mode = input.isDryRun ? '🧪 DRY-RUN' : '🔴 LIVE';
    const pause = input.globalPaused ? ' • ⏸ PAUSE GLOBALE' : '';
    L.push(`🧭 <b>PRISE DE RECUL — L'Horloge Suisse v2</b>`);
    L.push(`${mode}${pause} • Régime ${d.regime}`);
    L.push('');

    // Vue d'ensemble
    L.push(`<b>💰 Vue d'ensemble</b>`);
    L.push(`• Capital total : <b>${this.fmtUsd(d.capital)}</b>`);
    L.push(`• Wallet : ${this.fmtUsd(d.walletValue)} • DeFi : ${this.fmtUsd(d.defiUsd)}`);
    L.push(`• Drawdown : ${input.drawdownPct?.toFixed(1) ?? '0.0'}%`);
    L.push('');

    // Inventaire positions
    L.push(`<b>📦 Positions ouvertes</b>`);
    const topTokens = d.tokens.filter((t: any) => t.valueUsd >= 1).slice(0, 8);
    if (topTokens.length === 0) L.push('• Aucun token significatif');
    for (const t of topTokens) {
      const pnl = t.totalPnl != null ? ` • PnL ${this.fmtUsd(t.totalPnl)}` : '';
      L.push(`• ${t.symbol} : ${this.fmtUsd(t.valueUsd)} (${t.weightPct.toFixed(1)}%)${pnl}`);
    }
    if (d.gmxPositions && d.gmxPositions.length > 0) {
      for (const p of d.gmxPositions) {
        const dir = p.isLong ? 'LONG' : 'SHORT';
        const upnl = p.unrealizedPnlUsd != null ? ` • uPnL ${this.fmtUsd(Number(p.unrealizedPnlUsd))}` : '';
        L.push(`• GMX ${p.indexSymbol || p.market || ''} ${dir} : taille ${this.fmtUsd(Number(p.sizeUsd) || 0)} (collat ${this.fmtUsd(Number(p.collateralUsd) || 0)})${upnl}`);
      }
    }
    if (d.aave && (Number(d.aave.totalCollateralUsd) || Number(d.aave.totalDebtUsd))) {
      const hf = Number(d.aave.healthFactor);
      const hfStr = Number.isFinite(hf) ? ` • HF ${hf.toFixed(2)}` : '';
      L.push(`• Aave : collatéral ${this.fmtUsd(Number(d.aave.totalCollateralUsd) || 0)}, dette ${this.fmtUsd(Number(d.aave.totalDebtUsd) || 0)}${hfStr}`);
    }
    L.push('');

    // Allocations actuelles vs cibles — uniquement les stratégies dotées d'un
    // budget dédié en base (grid / mean_reversion / momentum). Les stratégies
    // sans budget (dca, arbitrage…) n'ont pas de « cible d'allocation » au sens
    // capital : leur activité figure dans la section Performance et — pour le
    // DCA — dans la section Panier DCA ci-dessous.
    L.push(`<b>🎯 Budgets stratégies : appliqué vs plafond configuré</b>`);
    const allocRows = d.strategies.filter((r: any) => r.currentPct != null);
    if (allocRows.length === 0) L.push('• Aucune stratégie à budget dédié active');
    for (const r of allocRows) {
      const cur = `${r.currentPct.toFixed(1)}% (${this.fmtUsd(r.currentUsd)})`;
      const ceil =
        r.ceilingUsd != null
          ? `${this.fmtUsd(r.ceilingUsd)} (${r.ceilingPct.toFixed(1)}%)`
          : '—';
      const over =
        r.currentUsd != null && r.ceilingUsd != null && r.currentUsd > r.ceilingUsd * 1.05
          ? ' ⚠️ dépasse le plafond'
          : '';
      const flag = !r.moduleEnabled ? ' ⚫ module coupé' : '';
      L.push(`• <b>${r.strategy}</b> : ${cur} → plafond ${ceil}${over}${flag}`);
    }
    L.push('');

    // Panier DCA : répartition actuelle vs cible (total 100%)
    L.push(`<b>🧺 Panier DCA : répartition actuelle vs cible</b>`);
    if (d.dcaBasketSumUsd > 0) {
      L.push(`<i>(part de chaque token parmi le panier DCA — total 100%)</i>`);
      for (const b of d.dcaBasket) {
        const flag = Math.abs(b.gapPct) > this.ALLOC_GAP_PCT ? (b.gapPct > 0 ? ' ⚠️ surpondéré' : ' ⚠️ sous-cible') : '';
        L.push(
          `• <b>${b.token}</b> : ${b.currentPct.toFixed(1)}% → cible ${b.targetPct.toFixed(1)}% (${this.fmtUsd(b.usd)})${flag}`,
        );
      }
    } else {
      L.push(`<i>(aucun token du panier détenu pour l'instant — cibles visées)</i>`);
      for (const b of d.dcaBasket) {
        L.push(`• <b>${b.token}</b> : cible ${b.targetPct.toFixed(1)}%`);
      }
    }
    L.push('');

    // Performance par stratégie (30 j)
    L.push(`<b>📊 Performance par stratégie (30 j)</b>`);
    const perf = d.strategies
      .filter((r: any) => r.trades30d > 0 || r.pnlUsd != null)
      .sort((a: any, b: any) => (b.pnlUsd ?? -1e9) - (a.pnlUsd ?? -1e9));
    if (perf.length === 0) L.push('• Aucun trade exécuté sur la période');
    for (const r of perf) {
      const pnl = r.pnlUsd != null ? this.fmtUsd(r.pnlUsd) : 'n/d';
      L.push(`• ${r.strategy} : ${pnl} • ${r.trades30d} trades (${r.trades24h}/24h)`);
    }
    L.push('');

    // Déséquilibres
    L.push(`<b>⚖️ Déséquilibres détectés</b>`);
    if (d.imbalances.length === 0) L.push('• Aucun déséquilibre majeur ✅');
    else for (const i of d.imbalances.slice(0, 10)) L.push(`• ${i}`);
    L.push('');

    // Suggestions
    L.push(`<b>💡 Actions correctives suggérées</b>`);
    d.suggestions.slice(0, 10).forEach((s: string, idx: number) => L.push(`${idx + 1}. ${s}`));

    // Alertes récentes
    if (d.riskEvents && d.riskEvents.length > 0) {
      L.push('');
      L.push(`<b>🚨 Alertes risque (24 h)</b>`);
      for (const e of d.riskEvents.slice(0, 3)) {
        L.push(`• ${e.kind || 'event'} — ${(e.detail || '').toString().slice(0, 80)}`);
      }
    }

    return L.join('\n');
  }
}
