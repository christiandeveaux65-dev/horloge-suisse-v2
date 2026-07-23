/**
 * Moteur de simulation des 4 stratégies du bot (DCA, Grid, Mean Reversion, Momentum).
 *
 * Principes :
 *  - Pas de look-ahead : chaque décision à la bougie i n'utilise que closes[0..i].
 *    L'exécution se fait au close de la bougie i (avec friction).
 *  - Frictions réalistes : fees (%) + slippage (%) appliqués à chaque trade.
 *  - Un portefeuille unique (cash USDT + positions par token) partagé par la stratégie.
 */
import { rsi, bollingerBands } from '../indicators';
import { smaSeries, rsiSeries } from './metrics';
import { Candle, SimTrade, EquityPoint, SimResult } from './backtest.types';

interface Position {
  amountToken: number;
  costUsd: number; // base de coût cumulée (friction incluse)
}

class Portfolio {
  cash: number;
  positions: Map<string, Position> = new Map();
  trades: SimTrade[] = [];

  constructor(
    initialCapital: number,
    private readonly feePct: number,
    private readonly slipPct: number,
  ) {
    this.cash = initialCapital;
  }

  private pos(token: string): Position {
    let p = this.positions.get(token);
    if (!p) {
      p = { amountToken: 0, costUsd: 0 };
      this.positions.set(token, p);
    }
    return p;
  }

  exposureUsd(token: string): number {
    return this.pos(token).costUsd;
  }

  totalExposureUsd(): number {
    let s = 0;
    for (const p of this.positions.values()) s += p.costUsd;
    return s;
  }

  /** Achat pour `usdToSpend` (notionnel total prélevé sur le cash). */
  buy(token: string, usdToSpend: number, price: number, time: number, reason?: string): boolean {
    if (usdToSpend <= 0 || this.cash < usdToSpend || price <= 0) return false;
    const effPrice = price * (1 + this.slipPct / 100);
    const fee = usdToSpend * (this.feePct / 100);
    const tokensReceived = (usdToSpend - fee) / effPrice;
    if (tokensReceived <= 0) return false;
    this.cash -= usdToSpend;
    const p = this.pos(token);
    p.amountToken += tokensReceived;
    p.costUsd += usdToSpend;
    this.trades.push({
      token, side: 'buy', time, price: effPrice,
      amountUsd: usdToSpend, amountToken: tokensReceived, feeUsd: fee, reason,
    });
    return true;
  }

  /** Vente de `tokensToSell` tokens (ou tout si non précisé). Calcule le PnL réalisé. */
  sell(token: string, tokensToSell: number | 'all', price: number, time: number, reason?: string): boolean {
    const p = this.pos(token);
    const qty = tokensToSell === 'all' ? p.amountToken : Math.min(tokensToSell, p.amountToken);
    if (qty <= 0 || price <= 0) return false;
    const effPrice = price * (1 - this.slipPct / 100);
    const gross = qty * effPrice;
    const fee = gross * (this.feePct / 100);
    const proceeds = gross - fee;
    const avgCost = p.amountToken > 0 ? p.costUsd / p.amountToken : 0;
    const costBasis = avgCost * qty;
    const pnl = proceeds - costBasis;
    this.cash += proceeds;
    p.amountToken -= qty;
    p.costUsd -= costBasis;
    if (p.amountToken < 1e-12) { p.amountToken = 0; p.costUsd = 0; }
    this.trades.push({
      token, side: 'sell', time, price: effPrice,
      amountUsd: proceeds, amountToken: qty, feeUsd: fee, pnlUsd: pnl, reason,
    });
    return true;
  }

  equity(prices: Record<string, number>): number {
    let eq = this.cash;
    for (const [token, p] of this.positions.entries()) {
      const px = prices[token] ?? 0;
      eq += p.amountToken * px;
    }
    return eq;
  }
}

/** Construit la timeline maître (union triée des timestamps de tous les tokens). */
function masterTimeline(candlesByToken: Map<string, Candle[]>): number[] {
  const set = new Set<number>();
  for (const arr of candlesByToken.values()) for (const c of arr) set.add(c.t);
  return Array.from(set).sort((a, b) => a - b);
}

/** État par token pour un parcours aligné sur la timeline maître. */
interface TokenCursor {
  candles: Candle[];
  idx: number; // index de la dernière bougie connue (open_time <= t courant)
  lastPrice: number;
  closes: number[]; // closes[0..idx]
  // Séries pré-calculées pour Momentum (aligné sur la logique live computeSignal).
  mom?: {
    smaShort: (number | null)[];
    smaLong: (number | null)[];
    rsi: number[];
  };
}

export interface SimConfig {
  strategy: 'dca' | 'grid' | 'mean_reversion' | 'momentum';
  tokens: string[];
  initialCapital: number;
  feePct: number;
  slipPct: number;
  params: Record<string, any>;
}

export function simulate(candlesByToken: Map<string, Candle[]>, cfg: SimConfig): SimResult {
  const timeline = masterTimeline(candlesByToken);
  const pf = new Portfolio(cfg.initialCapital, cfg.feePct, cfg.slipPct);
  const equityCurve: EquityPoint[] = [];

  // Curseurs par token.
  const cursors = new Map<string, TokenCursor>();
  for (const [token, candles] of candlesByToken.entries()) {
    cursors.set(token, { candles, idx: -1, lastPrice: 0, closes: [] });
  }

  // Pré-calcul SMA + RSI (momentum) — aligné sur la logique live (computeSignal :
  // croisement SMA courte/longue + RSI + continuation de tendance). Séries
  // incrémentales O(n), aucun look-ahead (out[i] n'utilise que closes[0..i]).
  if (cfg.strategy === 'momentum') {
    const maShort = Math.max(2, parseInt(cfg.params.emaShort ?? cfg.params.maShort ?? 10, 10));
    const maLong = Math.max(3, parseInt(cfg.params.emaLong ?? cfg.params.maLong ?? 30, 10));
    const rsiPeriod = Math.max(2, parseInt(cfg.params.rsiPeriod ?? 14, 10));
    for (const cur of cursors.values()) {
      const closesFull = cur.candles.map((c) => c.close);
      cur.mom = {
        smaShort: smaSeries(closesFull, maShort),
        smaLong: smaSeries(closesFull, maLong),
        rsi: rsiSeries(closesFull, rsiPeriod),
      };
    }
  }

  // État spécifique DCA / Grid / Momentum.
  let lastDcaBuy = 0;
  const gridState: { center: number; boughtLevels: Set<number>; lastLevel: number | null } = {
    center: 0, boughtLevels: new Set(), lastLevel: null,
  };
  // Prix de référence par token pour le seuil d'achat DCA (buyThresholdPct).
  const dcaRefPrice = new Map<string, number>();
  // Sommet atteint par token pour le trailing stop Momentum (trailingStopPct).
  const momPeak = new Map<string, number>();
  // État TP échelonné par token (miroir de momentum.service.ts partialTakeProfit) :
  // prix d'entrée, quantité initiale et niveaux déjà déclenchés (tp_hits).
  const momState = new Map<string, { entryPrice: number; initialAmount: number; tpHits: Set<number> }>();

  for (const t of timeline) {
    // Avancer les curseurs jusqu'à t.
    for (const cur of cursors.values()) {
      while (cur.idx + 1 < cur.candles.length && cur.candles[cur.idx + 1].t <= t) {
        cur.idx++;
        cur.lastPrice = cur.candles[cur.idx].close;
        cur.closes.push(cur.candles[cur.idx].close);
      }
    }
    const prices: Record<string, number> = {};
    for (const [token, cur] of cursors.entries()) prices[token] = cur.lastPrice;

    switch (cfg.strategy) {
      case 'dca':
        lastDcaBuy = stepDca(pf, cfg, cursors, t, prices, lastDcaBuy, dcaRefPrice);
        break;
      case 'grid':
        stepGrid(pf, cfg, cursors, t, gridState);
        break;
      case 'mean_reversion':
        stepMeanReversion(pf, cfg, cursors, t);
        break;
      case 'momentum':
        stepMomentum(pf, cfg, cursors, t, momPeak, momState);
        break;
    }

    equityCurve.push({ t, equity: pf.equity(prices) });
  }

  return { trades: pf.trades, equityCurve };
}

// ─────────────────────────────── DCA ───────────────────────────────
function stepDca(
  pf: Portfolio, cfg: SimConfig, cursors: Map<string, TokenCursor>,
  t: number, prices: Record<string, number>, lastBuy: number,
  dcaRefPrice: Map<string, number>,
): number {
  const amountPerBuy = parseFloat(cfg.params.amountPerBuy ?? 50);
  const intervalHours = parseFloat(cfg.params.intervalHours ?? 24);
  const intervalMs = intervalHours * 3600 * 1000;
  // Seuil d'achat optionnel : n'acheter que si le prix a baissé d'au moins |thr| %
  // depuis le dernier achat du token. thr est négatif (ex : -5 => -5 %).
  const thrRaw = cfg.params.buyThresholdPct;
  const thr = thrRaw === undefined || thrRaw === null ? undefined : Number(thrRaw);
  const useThr = thr !== undefined && Number.isFinite(thr) && thr < 0;
  // Panier : poids fournis, sinon équipondéré sur les tokens sélectionnés.
  const basket: { token: string; weight: number }[] =
    Array.isArray(cfg.params.basket) && cfg.params.basket.length
      ? cfg.params.basket
      : cfg.tokens.map((tk) => ({ token: tk, weight: 1 / cfg.tokens.length }));

  if (lastBuy === 0) lastBuy = t; // ancre le premier achat au début de la période
  if (t - lastBuy < intervalMs && pf.trades.length > 0) return lastBuy;
  if (t - lastBuy < intervalMs && pf.trades.length === 0 && lastBuy !== t) return lastBuy;
  if (t - lastBuy < intervalMs) return lastBuy;

  for (const leg of basket) {
    const cur = cursors.get(leg.token);
    if (!cur || cur.idx < 0 || cur.lastPrice <= 0) continue;
    // Filtre de seuil : si le prix n'a pas assez baissé par rapport à la référence, on saute.
    if (useThr) {
      const ref = dcaRefPrice.get(leg.token);
      if (ref !== undefined && cur.lastPrice > ref * (1 + (thr as number) / 100)) continue;
    }
    const spend = amountPerBuy * leg.weight;
    if (pf.cash < spend) continue;
    if (pf.buy(leg.token, spend, cur.lastPrice, t, 'dca') && useThr) {
      dcaRefPrice.set(leg.token, cur.lastPrice);
    }
  }
  return t;
}

// ─────────────────────────────── Grid ──────────────────────────────
function stepGrid(
  pf: Portfolio, cfg: SimConfig, cursors: Map<string, TokenCursor>,
  t: number, state: { center: number; boughtLevels: Set<number>; lastLevel: number | null },
) {
  const token = (cfg.params.token ?? cfg.tokens[0] ?? 'WETH').toUpperCase();
  const cur = cursors.get(token);
  if (!cur || cur.idx < 0 || cur.lastPrice <= 0) return;
  const price = cur.lastPrice;
  const budget = parseFloat(cfg.params.budgetUsd ?? 1000);
  const levels = Math.max(2, parseInt(cfg.params.levels ?? 15, 10));
  const rangePct = parseFloat(cfg.params.rangePct ?? 3.5);
  const perLevel = budget / levels;

  // Initialisation / recentrage (drift > 5 %, comme le bot réel).
  if (state.center === 0) state.center = price;
  const drift = Math.abs(price - state.center) / state.center;
  if (drift > 0.05) {
    state.center = price;
    state.boughtLevels.clear();
    state.lastLevel = null;
  }

  const lower = state.center * (1 - rangePct / 100);
  const upper = state.center * (1 + rangePct / 100);
  const step = (upper - lower) / levels;
  if (step <= 0) return;

  const level = Math.floor((price - lower) / step);
  const prev = state.lastLevel;
  state.lastLevel = level;
  if (prev === null) return;

  if (level < prev) {
    // Franchissement à la baisse : acheter aux niveaux nouvellement franchis (moitié basse).
    for (let l = prev - 1; l >= Math.max(0, level); l--) {
      if (l >= Math.floor(levels / 2)) continue; // n'acheter que dans la moitié basse
      if (state.boughtLevels.has(l)) continue;
      if (pf.totalExposureUsd() + perLevel > budget) break;
      const buyPrice = lower + l * step;
      if (pf.buy(token, perLevel, buyPrice, t, `grid_buy_L${l}`)) state.boughtLevels.add(l);
    }
  } else if (level > prev) {
    // Franchissement à la hausse : vendre les lots achetés en dessous (FIFO niveaux bas).
    const sorted = Array.from(state.boughtLevels).sort((a, b) => a - b);
    for (const l of sorted) {
      if (l >= level) break; // vendre seulement les lots sous le niveau courant
      const sellPrice = Math.max(lower + (l + 1) * step, price);
      const p = pf['positions'].get(token);
      if (!p || p.amountToken <= 0) break;
      const lotTokens = p.amountToken / Math.max(1, state.boughtLevels.size);
      if (pf.sell(token, lotTokens, sellPrice, t, `grid_sell_L${l}`)) state.boughtLevels.delete(l);
    }
  }
}

// ─────────────────────── Mean Reversion (RSI + BB) ─────────────────
function stepMeanReversion(
  pf: Portfolio, cfg: SimConfig, cursors: Map<string, TokenCursor>, t: number,
) {
  const rsiPeriod = parseInt(cfg.params.rsiPeriod ?? 14, 10);
  // Défauts alignés sur le live (mean-reversion.service.ts) : rsi_oversold=25,
  // rsi_overbought=75, bb_period=20, bb_std_dev=2.5.
  const oversold = parseFloat(cfg.params.rsiOversold ?? 25);
  const overbought = parseFloat(cfg.params.rsiOverbought ?? 75);
  const bbPeriod = parseInt(cfg.params.bbPeriod ?? 20, 10);
  const bbStd = parseFloat(cfg.params.bbStdDev ?? 2.5);
  const tradeSize = parseFloat(cfg.params.tradeSizeUsd ?? 100);
  const maxPerToken = parseFloat(cfg.params.maxPerToken ?? 400);
  const maxTotal = parseFloat(cfg.params.maxTotal ?? 800);

  for (const [token, cur] of cursors.entries()) {
    if (cur.idx < 0 || cur.lastPrice <= 0) continue;
    if (cur.closes.length < Math.max(rsiPeriod + 1, bbPeriod)) continue;
    const price = cur.lastPrice;
    const rsiVal = rsi(cur.closes, rsiPeriod);
    const bands = bollingerBands(cur.closes, bbPeriod, bbStd);
    const p = pf['positions'].get(token);
    const hasPos = p && p.amountToken > 0;

    // Sortie : RSI en surachat.
    if (hasPos && rsiVal >= overbought) {
      pf.sell(token, 'all', price, t, 'mr_rsi_overbought');
      continue;
    }
    // Entrée : RSI survendu ET prix sous la bande inférieure.
    const entry = bands && rsiVal <= oversold && price < bands.lower;
    if (entry) {
      if (pf.totalExposureUsd() >= maxTotal) continue;
      if (pf.exposureUsd(token) >= maxPerToken) continue;
      const size = Math.min(tradeSize, maxTotal - pf.totalExposureUsd(), maxPerToken - pf.exposureUsd(token));
      if (size >= 5) pf.buy(token, size, price, t, 'mr_entry');
    }
  }
}

// ──────────── Momentum (SMA + RSI + tendance, aligné sur le live) ────────────
// Réplique fidèlement computeSignal() de indicators.ts utilisé en production :
// signal d'achat = croisement SMA haussier OU RSI qui repasse au-dessus de la
// survente OU continuation de tendance ; signal de vente = croisement baissier
// OU RSI en surchauffe. Sorties dans l'ordre du live : stop-loss dur, trailing
// stop, puis signal de vente. (Le holding minimum du live opère à l'échelle de
// la minute ; sur des bougies 1h/4h il n'a aucun effet et n'est donc pas répliqué.)
function stepMomentum(
  pf: Portfolio, cfg: SimConfig, cursors: Map<string, TokenCursor>, t: number,
  momPeak: Map<string, number>,
  momState: Map<string, { entryPrice: number; initialAmount: number; tpHits: Set<number> }>,
) {
  // Niveaux de take-profit échelonné (miroir de take_profit_levels du live).
  // Format accepté : "30,60,100" (chaîne), [30,60,100] (tableau) ou vide/absent → désactivé.
  const rawTp = cfg.params.takeProfitLevels ?? cfg.params.take_profit_levels;
  const tpLevels: number[] = (() => {
    if (Array.isArray(rawTp)) return rawTp.map((x) => parseFloat(x)).filter((n) => Number.isFinite(n) && n > 0);
    if (typeof rawTp === 'string' && rawTp.trim().length) {
      return rawTp.split(',').map((s) => parseFloat(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    }
    return [];
  })();
  const positionSizeUsd = parseFloat(
    cfg.params.positionSizeUsd ?? cfg.initialCapital / Math.max(1, cfg.tokens.length),
  );
  const stopLossPct = parseFloat(cfg.params.stopLossPct ?? 0); // 0 = désactivé
  const trailingStopPct = parseFloat(cfg.params.trailingStopPct ?? 0); // 0 = désactivé
  const maShort = Math.max(2, parseInt(cfg.params.emaShort ?? cfg.params.maShort ?? 10, 10));
  const maLong = Math.max(3, parseInt(cfg.params.emaLong ?? cfg.params.maLong ?? 30, 10));
  const rsiPeriod = Math.max(2, parseInt(cfg.params.rsiPeriod ?? 14, 10));
  const rsiOversold = parseFloat(cfg.params.rsiOversold ?? 35);
  const rsiOverbought = parseFloat(cfg.params.rsiOverbought ?? 70);

  for (const [token, cur] of cursors.entries()) {
    if (cur.idx < 1 || !cur.mom || cur.lastPrice <= 0) continue;
    const i = cur.idx;
    const len = i + 1; // équivalent de prices.length dans computeSignal
    const price = cur.lastPrice;
    const p = pf['positions'].get(token);
    const hasPos = !!(p && p.amountToken > 0);

    // ── Sorties (uniquement si position ouverte) ──
    if (hasPos) {
      // 1) Stop-loss dur : sortie si le prix chute sous le coût moyen d'entrée.
      if (stopLossPct > 0) {
        const avgCost = p!.costUsd / p!.amountToken;
        if (avgCost > 0 && price <= avgCost * (1 - stopLossPct / 100)) {
          pf.sell(token, 'all', price, t, 'mom_stop_loss');
          momPeak.delete(token);
          momState.delete(token);
          continue;
        }
      }
      // 2) Trailing stop : suit le plus haut atteint ; sortie si repli de trailingStopPct %.
      if (trailingStopPct > 0) {
        const peak = Math.max(momPeak.get(token) ?? price, price);
        momPeak.set(token, peak);
        if (peak > 0 && price <= peak * (1 - trailingStopPct / 100)) {
          pf.sell(token, 'all', price, t, 'mom_trailing_stop');
          momPeak.delete(token);
          momState.delete(token);
          continue;
        }
      }
      // 3) Take-profit échelonné (miroir de partialTakeProfit du live) : à chaque
      //    niveau franchi (dans l'ordre, pas de saut), on vend initialAmount / N.
      //    Au dernier niveau, on solde tout le reste. Un seul niveau par bougie.
      if (tpLevels.length > 0) {
        const st = momState.get(token);
        if (st && st.entryPrice > 0 && st.initialAmount > 0) {
          for (let lvl = 0; lvl < tpLevels.length; lvl++) {
            if (st.tpHits.has(lvl)) continue;
            const tpPrice = st.entryPrice * (1 + tpLevels[lvl] / 100);
            if (price >= tpPrice) {
              const isLast = st.tpHits.size + 1 >= tpLevels.length;
              const posNow = pf['positions'].get(token);
              const remaining = posNow?.amountToken ?? 0;
              const fraction = 1 / tpLevels.length;
              let sellQty = isLast ? remaining : Math.min(st.initialAmount * fraction, remaining);
              if (sellQty > 0) {
                pf.sell(token, sellQty, price, t, `mom_take_profit_L${lvl}`);
                st.tpHits.add(lvl);
                if (isLast || (pf['positions'].get(token)?.amountToken ?? 0) <= 0) {
                  momPeak.delete(token);
                  momState.delete(token);
                }
              }
              break; // pas de saut de niveau
            } else {
              break; // niveaux ordonnés croissants : rien à faire au-delà
            }
          }
        }
      }
    }

    // ── Calcul du signal (fidèle à computeSignal) ──
    const smaShort = cur.mom.smaShort[i];
    const smaLongVal = cur.mom.smaLong[i];
    const smaShortPrev = len > maShort ? cur.mom.smaShort[i - 1] : null;
    const smaLongPrev = len > maLong ? cur.mom.smaLong[i - 1] : null;
    const rsiVal = cur.mom.rsi[i];
    const rsiPrev = len > rsiPeriod + 1 ? cur.mom.rsi[i - 1] : null;

    const crossUp =
      smaShort !== null && smaLongVal !== null &&
      smaShortPrev !== null && smaLongPrev !== null &&
      smaShortPrev <= smaLongPrev && smaShort > smaLongVal;

    const crossDown =
      smaShort !== null && smaLongVal !== null &&
      smaShortPrev !== null && smaLongPrev !== null &&
      smaShortPrev >= smaLongPrev && smaShort < smaLongVal;

    const rsiRecovering =
      rsiPrev !== null && rsiPrev < rsiOversold && rsiVal >= rsiOversold;
    const rsiRising = rsiPrev !== null && rsiVal > rsiPrev;
    const rsiHot = rsiVal >= rsiOverbought;

    const trendUpEntry =
      smaShort !== null && smaLongVal !== null &&
      smaShort > smaLongVal &&
      rsiVal < rsiOverbought && rsiRising &&
      price >= smaShort;

    const buySignal = crossUp || rsiRecovering || trendUpEntry;
    const sellSignal = crossDown || rsiHot;

    // ── Entrée / sortie sur signal ──
    if (buySignal && !hasPos) {
      const size = Math.min(positionSizeUsd, pf.cash);
      if (size >= 5 && pf.buy(token, size, price, t, 'mom_entry')) {
        momPeak.set(token, price);
        const posAfter = pf['positions'].get(token);
        momState.set(token, {
          entryPrice: price,
          initialAmount: posAfter?.amountToken ?? 0,
          tpHits: new Set<number>(),
        });
      }
    } else if (sellSignal && hasPos) {
      pf.sell(token, 'all', price, t, 'mom_signal_sell');
      momPeak.delete(token);
      momState.delete(token);
    }
  }
}

/** Équité finale d'un buy&hold équipondéré (référence de comparaison). */
export function buyHoldFinal(
  candlesByToken: Map<string, Candle[]>, initialCapital: number,
): number {
  const tokens = Array.from(candlesByToken.keys()).filter(
    (tk) => (candlesByToken.get(tk) ?? []).length > 0,
  );
  if (tokens.length === 0) return initialCapital;
  const alloc = initialCapital / tokens.length;
  let final = 0;
  for (const tk of tokens) {
    const arr = candlesByToken.get(tk)!;
    const first = arr[0].close;
    const last = arr[arr.length - 1].close;
    if (first > 0) final += alloc * (last / first);
  }
  return final;
}
