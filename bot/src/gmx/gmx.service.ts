import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { computeSignal } from '../indicators';
import {
  GMX_BUDGET_USD, GMX_TARGET_LEVERAGE, GMX_MAX_LEVERAGE,
  GMX_STOP_LOSS_PCT, GMX_COLLATERAL_USD, GMX_WETH_USD_MARKET,
  GMX_TAKE_PROFIT_LEVELS, GMX_FUNDING_LONG_THRESHOLD, GMX_FUNDING_SHORT_THRESHOLD,
} from '../constants';

/**
 * GMX V2 — Longs à levier modéré (2x, max 5x) sur WETH.
 * Budget collatéral hardcodé : $1500 ; $300/position ; stop-loss 10% du collatéral.
 * Cron toutes les 5 minutes. DÉMARRE EN PAUSE (sécurité, cf. schema paused=true).
 *
 * CÂBLAGE BLOCKCHAIN : l'ouverture/fermeture passe par BlockchainService.gmxOpenLong/
 * gmxCloseLong (ExchangeRouter V2 : multicall sendWnt+sendTokens+createOrder). L'exécution
 * GMX étant asynchrone (un keeper exécute l'ordre au prix oracle Chainlink), une ouverture
 * live passe en statut 'pending_open' puis 'open' ; une fermeture live en 'pending_close'.
 * En mode DRY-RUN (WALLET_PRIVATE_KEY absente), les opérations restent 'simulated'.
 * Le module démarre EN PAUSE (schema paused=true).
 */
@Injectable()
export class GmxService {
  private readonly logger = new Logger(GmxService.name);
  private enabled = true;
  private adoptionDone = false; // adoption des positions on-chain préexistantes (une fois/boot)

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  // Phase 3 : réévaluation (adoption + ouverture) toutes les 4h.
  @Cron('0 0 */4 * * *', { timeZone: 'Europe/Paris', name: 'gmx' })
  async handleCron(): Promise<void> {
    if (!this.enabled) return;
    if (!(await acquireCronRun(this.prisma, 'gmx', 14400000))) return;
    try {
      await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle GMX échoué: ${err.message}`);
    }
  }

  // Surveillance RAPPROCHÉE des positions ouvertes (stop-loss / take-profit / trailing)
  // toutes les 5 minutes : une position à effet de levier ne peut pas attendre 4h.
  // Ne fait QUE surveiller/protéger les positions existantes (n'ouvre rien).
  @Cron('0 */5 * * * *', { timeZone: 'Europe/Paris', name: 'gmx_monitor' })
  async handleMonitorCron(): Promise<void> {
    if (!this.enabled) return;
    if (!(await acquireCronRun(this.prisma, 'gmx_monitor', 300000))) return;
    try {
      // N'agit que s'il existe au moins une position ouverte (évite tout coût inutile).
      const openCount = await this.prisma.gmx_position.count({ where: { status: 'open' } });
      if (openCount === 0) return;
      const cfg = await this.ensureConfig();
      const monitoring = await this.monitorPositions(cfg);
      const actions = monitoring.filter((m: any) => m.action && m.action !== 'hold' && m.action !== 'skip');
      if (actions.length > 0) {
        this.logger.log(`👁️ GMX monitor : ${actions.length} action(s) sur position — ${JSON.stringify(actions)}`);
      }
    } catch (err: any) {
      this.logger.error(`Surveillance GMX échouée: ${err.message}`);
    }
  }

  private async ensureConfig(): Promise<any> {
    let cfg = await this.prisma.gmx_config.findFirst();
    if (!cfg) {
      cfg = await this.prisma.gmx_config.create({
        data: {
          name: 'GMX V2 Longs',
          index_token: 'WETH',
          collateral_token: 'USDC',
          budget_usd: String(GMX_BUDGET_USD),
          collateral_per_trade_usd: String(GMX_COLLATERAL_USD),
          default_leverage: String(GMX_TARGET_LEVERAGE),
          max_leverage: String(GMX_MAX_LEVERAGE),
          stop_loss_pct: GMX_STOP_LOSS_PCT,
          auto_open: false,
          paused: false, // Phase 3 : gestion active
        },
      });
      this.logger.log(`Config GMX initialisée (budget $${GMX_BUDGET_USD}, levier ${GMX_TARGET_LEVERAGE}x/max ${GMX_MAX_LEVERAGE}x, SL ${GMX_STOP_LOSS_PCT}%) — ACTIVE`);
    }

    // Phase 3 : aligner les paramètres existants (SL 15%, max lev 3, unpause).
    const updates: any = {};
    if (cfg.stop_loss_pct !== GMX_STOP_LOSS_PCT) updates.stop_loss_pct = GMX_STOP_LOSS_PCT;
    if (parseFloat(cfg.max_leverage) !== GMX_MAX_LEVERAGE) updates.max_leverage = String(GMX_MAX_LEVERAGE);
    if (cfg.paused) updates.paused = false;
    if (Object.keys(updates).length > 0) {
      cfg = await this.prisma.gmx_config.update({ where: { id: cfg.id }, data: updates });
      this.logger.log(`Config GMX alignée Phase 3: ${JSON.stringify(updates)}`);
    }
    return cfg;
  }

  async executeCycle(): Promise<any> {
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      return { success: false, reason: 'pause_globale' };
    }

    const cfg = await this.ensureConfig();

    // ── Adoption des positions GMX préexistantes on-chain ──
    // Le wallet peut déjà détenir des positions ouvertes par un bot précédent.
    // On les importe en base (une seule fois par boot) afin que le module puisse
    // les gérer (stop-loss, trailing). Ne s'exécute qu'en live (hors dry-run) et
    // quand le module est actif et non en pause.
    let adopted: any[] = [];
    if (cfg.active && !cfg.paused && !this.blockchain.getIsDryRun() && !this.adoptionDone) {
      adopted = await this.adoptOnChainPositions(cfg);
      this.adoptionDone = true;
    }

    // Le monitoring des stop-loss s'exécute MÊME si la config est en pause,
    // afin de protéger toute position ouverte (le pause bloque seulement les ouvertures).
    const monitoring = await this.monitorPositions(cfg);

    if (!cfg.active || cfg.paused) {
      return { success: true, reason: 'ouvertures_en_pause', adopted, monitoring };
    }

    // Phase 3 : signal funding rate (informationnel, non exécuté)
    const funding = await this.checkFundingRate().catch(() => null);

    let opened: any = null;
    if (cfg.auto_open) {
      opened = await this.maybeOpen(cfg);
    }

    return { success: true, adopted, monitoring, funding, opened };
  }

  /** Signal funding rate GMX V2 (Phase 3, informationnel).
   *  Lit /prices/tickers de l'API GMX Arbitrum et journalise un signal par marché.
   *  Seuils : funding > +0.05% → short, funding < -0.05% → long. */
  private async checkFundingRate(): Promise<any> {
    try {
      const res = await fetch('https://arbitrum-api.gmxinfra.io/prices/tickers');
      if (!res.ok) return { ok: false, status: res.status };
      const data: any = await res.json();
      const signals: any[] = [];
      const rows = Array.isArray(data) ? data : (data.tickers ?? []);
      for (const t of rows.slice(0, 8)) {
        // Le champ funding varie ; on tente plusieurs sources
        const rate = t.fundingRate ?? t.funding_rate ?? t.longFundingRatePerHour ?? null;
        const symbol = t.tokenSymbol ?? t.symbol ?? t.market ?? '?';
        if (rate === null || rate === undefined) continue;
        const rateNum = typeof rate === 'string' ? parseFloat(rate) : Number(rate);
        if (!isFinite(rateNum)) continue;
        let signal = 'neutre';
        if (rateNum > GMX_FUNDING_SHORT_THRESHOLD) signal = 'short';
        else if (rateNum < GMX_FUNDING_LONG_THRESHOLD) signal = 'long';
        signals.push({ symbol, rate: rateNum, signal });
      }
      if (signals.length > 0) {
        await this.prisma.leverage_event.create({
          data: {
            protocol: 'gmx', kind: 'funding_signal',
            detail: `Funding rate signals (${signals.length})`,
            payload: JSON.stringify({ signals }),
          },
        }).catch(() => undefined);
      }
      return { ok: true, signals };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Adopte les positions GMX déjà ouvertes on-chain par un bot précédent.
   * Lit les positions via le Reader (gmxGetPositionsDetailed) et les importe en base
   * (statut 'open', open_tx_hash='adopted') si elles n'y sont pas déjà. Crée une
   * entrée wallet_ledger (kind='adopted') et un leverage_event (kind='adopt') pour
   * la traçabilité. Idempotent : une position déjà suivie (même marché + sens) est ignorée.
   */
  private async adoptOnChainPositions(cfg: any): Promise<any[]> {
    const adopted: any[] = [];
    let details: any[] = [];
    try {
      details = await this.blockchain.gmxGetPositionsDetailed();
    } catch (err: any) {
      this.logger.warn(`Adoption GMX: lecture on-chain impossible (${err.message})`);
      return adopted;
    }

    for (const d of details) {
      // Idempotence : une position active du même marché/sens est-elle déjà suivie ?
      const existing = await this.prisma.gmx_position.findFirst({
        where: {
          market: d.market,
          is_long: d.isLong,
          status: { in: ['open', 'pending_open', 'pending_close'] },
        },
      });
      if (existing) {
        adopted.push({ market: d.market, indexToken: d.indexSymbol, action: 'skip', reason: 'déjà_suivie', id: existing.id });
        continue;
      }

      const pos = await this.prisma.gmx_position.create({
        data: {
          config_id: cfg.id,
          market: d.market,
          index_token: d.indexSymbol,
          collateral_token: d.collateralSymbol,
          is_long: d.isLong,
          collateral_usd: d.collateralUsd.toFixed(2),
          size_usd: d.sizeUsd.toFixed(2),
          leverage: d.leverage.toFixed(2),
          entry_price: d.entryPrice.toFixed(2),
          highest_price: d.markPrice.toFixed(2),
          status: 'open',
          open_tx_hash: 'adopted', // provenance : position adoptée (non ouverte par ce bot)
        },
      });

      // Ledger : mouvement 'adopted' (PAS un dépôt/retrait externe).
      await this.prisma.wallet_ledger.create({
        data: {
          chain: 'arbitrum',
          token: d.indexSymbol,
          kind: 'adopted',
          amount: d.sizeTokens.toString(),
          value_usd: d.positionValueUsd.toFixed(2),
          source: 'adopted',
          note: `Position GMX ${d.isLong ? 'long' : 'short'} ${d.indexSymbol} adoptée (levier ${d.leverage.toFixed(2)}x, collatéral $${d.collateralUsd.toFixed(2)})`,
        },
      }).catch(() => undefined);

      await this.prisma.leverage_event.create({
        data: {
          protocol: 'gmx', kind: 'adopt', detail: `position ${d.indexSymbol} adoptée`,
          payload: JSON.stringify({
            positionId: pos.id, market: d.market, isLong: d.isLong,
            collateralUsd: d.collateralUsd, sizeUsd: d.sizeUsd, leverage: d.leverage,
            entryPrice: d.entryPrice, markPrice: d.markPrice, uPnlUsd: d.unrealizedPnlUsd,
          }),
        },
      }).catch(() => undefined);

      // Synchronise le collatéral déployé dans la config.
      const deployed = parseFloat(cfg.deployed_usd) || 0;
      await this.prisma.gmx_config.update({
        where: { id: cfg.id },
        data: { deployed_usd: (deployed + d.collateralUsd).toFixed(2) },
      }).catch(() => undefined);

      this.logger.log(`GMX position adoptée: ${d.isLong ? 'long' : 'short'} ${d.indexSymbol} collatéral $${d.collateralUsd.toFixed(2)} levier ${d.leverage.toFixed(2)}x (PnL $${d.unrealizedPnlUsd.toFixed(2)})`);
      adopted.push({ id: pos.id, market: d.market, indexToken: d.indexSymbol, action: 'adopted', collateralUsd: d.collateralUsd, sizeUsd: d.sizeUsd, leverage: d.leverage });
    }
    return adopted;
  }

  /** Surveille les positions ouvertes : stop-loss (10% collatéral) + trailing stop. */
  private async monitorPositions(cfg: any): Promise<any[]> {
    const positions = await this.prisma.gmx_position.findMany({
      where: { status: 'open' },
    });
    const results: any[] = [];

    for (const pos of positions) {
      const price = await this.priceService.getPrice(pos.index_token);
      if (!price || price <= 0) {
        results.push({ id: pos.id, action: 'skip', reason: 'prix_indisponible' });
        continue;
      }
      const entry = parseFloat(pos.entry_price) || price;
      const leverage = parseFloat(pos.leverage) || GMX_TARGET_LEVERAGE;
      const collateral = parseFloat(pos.collateral_usd) || GMX_COLLATERAL_USD;

      // PnL sur le collatéral = variation prix × levier (long).
      const priceChangePct = ((price - entry) / entry) * 100;
      const collateralPnlPct = priceChangePct * leverage;

      // Trailing : mettre à jour le plus haut.
      const highest = Math.max(parseFloat(pos.highest_price) || entry, price);
      if (price > (parseFloat(pos.highest_price) || 0)) {
        await this.prisma.gmx_position.update({
          where: { id: pos.id }, data: { highest_price: price.toString() },
        });
      }

      // Stop-loss dur : perte du collatéral >= stop_loss_pct.
      if (collateralPnlPct <= -cfg.stop_loss_pct) {
        results.push(await this.closePosition(pos, price, 'stop_loss', collateralPnlPct));
        continue;
      }

      // Take-profit échelonnés (Phase 3) : +25% / +50% / +100% du PRIX.
      // Chaque niveau non encore touché ferme ~1/3 de la position restante.
      const tpEvents = await this.prisma.leverage_event.findMany({
        where: { protocol: 'gmx', kind: 'tp_hit' },
      });
      const hitLevels = new Set<number>();
      for (const ev of tpEvents) {
        try {
          const p = JSON.parse(ev.payload);
          if (p.positionId === pos.id && typeof p.level === 'number') hitLevels.add(p.level);
        } catch {}
      }
      let tpTriggered = false;
      for (const level of GMX_TAKE_PROFIT_LEVELS) {
        if (hitLevels.has(level)) continue;
        if (priceChangePct >= level) {
          const partial = await this.partialCloseTP(pos, price, level, priceChangePct);
          results.push(partial);
          tpTriggered = true;
          break; // un TP par cycle
        }
      }
      if (tpTriggered) continue;

      // Trailing stop : activé après trailing_activation_pct de gain PRIX, ferme si repli.
      const gainPricePct = priceChangePct;
      if (cfg.trailing_enabled && gainPricePct >= cfg.trailing_activation_pct) {
        const trailStop = highest * (1 - cfg.trailing_distance_pct / 100);
        if (price <= trailStop) {
          results.push(await this.closePosition(pos, price, 'trailing_stop', collateralPnlPct));
          continue;
        }
      }

      results.push({
        id: pos.id, action: 'hold', price, entry, leverage,
        collateralPnlPct: Number(collateralPnlPct.toFixed(2)),
      });
    }
    return results;
  }

  /** Fermeture partielle sur TP échelonné : ferme ~1/3 de la position restante. */
  private async partialCloseTP(pos: any, price: number, level: number, pricePct: number): Promise<any> {
    const collateral = parseFloat(pos.collateral_usd) || 0;
    const sizeUsd = parseFloat(pos.size_usd) || 0;
    const closeFrac = 1 / 3;
    const closeCollat = collateral * closeFrac;
    const closeSize = sizeUsd * closeFrac;
    const leverage = parseFloat(pos.leverage) || GMX_TARGET_LEVERAGE;
    const realized = (closeCollat * pricePct * leverage) / 100;
    const isDryRun = this.blockchain.getIsDryRun();

    const slippageBps = pos.slippage_bps ?? 100;
    const acceptablePrice = price * (1 - slippageBps / 10000);
    const chain = await this.blockchain.gmxCloseLong({
      market: pos.market || GMX_WETH_USD_MARKET,
      collateralTokenSymbol: pos.collateral_token || 'USDC',
      collateralDeltaUsd: closeCollat,
      sizeDeltaUsd: closeSize,
      acceptablePrice,
      indexTokenSymbol: pos.index_token || 'WETH',
      isLong: pos.is_long ?? true,
    });

    if (!chain.simulated && !chain.success) {
      this.logger.error(`GMX TP${level}% partial close échoué: ${chain.error}`);
      return { id: pos.id, action: 'tp_failed', level, error: chain.error };
    }

    // Mise à jour position : collat/size réduits ; si presque zéro → closed.
    const newCollat = Math.max(0, collateral - closeCollat);
    const newSize = Math.max(0, sizeUsd - closeSize);
    const closing = newCollat < 5;
    await this.prisma.gmx_position.update({
      where: { id: pos.id },
      data: {
        collateral_usd: newCollat.toFixed(2),
        size_usd: newSize.toFixed(2),
        ...(closing ? { status: chain.simulated ? 'closed' : 'pending_close', close_reason: `tp${level}_full`, closed_at: chain.simulated ? new Date() : undefined } : {}),
      },
    });
    await this.prisma.leverage_event.create({
      data: {
        protocol: 'gmx', kind: 'tp_hit',
        detail: `TP${level}% partial close ${pos.index_token}`,
        payload: JSON.stringify({ positionId: pos.id, level, pricePct: Number(pricePct.toFixed(2)), closedCollat: Number(closeCollat.toFixed(2)), realized: Number(realized.toFixed(2)), simulated: chain.simulated, txHash: chain.txHash }),
      },
    }).catch(() => undefined);
    this.logger.log(`GMX TP${level}% touché ${pos.index_token} : ferme $${closeCollat.toFixed(2)} collat, gain estimé $${realized.toFixed(2)} [${chain.simulated ? 'dry-run' : chain.txHash.slice(0,12)}]`);
    return { id: pos.id, action: 'tp_partial', level, closedCollat: Number(closeCollat.toFixed(2)), realized: Number(realized.toFixed(2)), simulated: chain.simulated };
  }

  private async closePosition(pos: any, price: number, reason: string, pnlPct: number): Promise<any> {
    const collateral = parseFloat(pos.collateral_usd) || 0;
    const sizeUsd = parseFloat(pos.size_usd) || 0;
    const realized = (collateral * pnlPct) / 100;
    const isDryRun = this.blockchain.getIsDryRun();

    // ── Appel on-chain GMX (MarketDecrease). Pour fermer un long, on accepte de
    //    vendre jusqu'à un prix plancher (price × (1 - slippage)). ──
    const slippageBps = pos.slippage_bps ?? 100;
    const acceptablePrice = price * (1 - slippageBps / 10000);
    const chain = await this.blockchain.gmxCloseLong({
      market: pos.market || GMX_WETH_USD_MARKET,
      collateralTokenSymbol: pos.collateral_token || 'USDC',
      collateralDeltaUsd: collateral,
      sizeDeltaUsd: sizeUsd,
      acceptablePrice,
      indexTokenSymbol: pos.index_token || 'WETH',
      isLong: pos.is_long ?? true,
    });

    // Si l'appel live échoue (hors dry-run), on NE clôt PAS la position en base
    // pour rester cohérent avec l'état réel on-chain ; on journalise l'erreur.
    if (!chain.simulated && !chain.success) {
      await this.prisma.leverage_event.create({
        data: {
          protocol: 'gmx', kind: 'error', detail: `close ${reason} échoué`,
          payload: JSON.stringify({ positionId: pos.id, error: chain.error }),
        },
      }).catch(() => undefined);
      this.logger.error(`GMX fermeture ${pos.index_token} échouée on-chain: ${chain.error}`);
      return { id: pos.id, action: 'close_failed', reason, error: chain.error };
    }

    // Live réussi → position en attente d'exécution keeper ('pending_close') ;
    // dry-run → clôture immédiate simulée ('closed').
    const newStatus = chain.simulated ? 'closed' : 'pending_close';
    await this.prisma.$transaction(async (tx: any) => {
      await tx.gmx_position.update({
        where: { id: pos.id },
        data: {
          status: newStatus,
          close_reason: reason,
          realized_pnl_usd: realized.toFixed(2),
          close_tx_hash: chain.txHash || '',
          ...(chain.simulated ? { closed_at: new Date() } : {}),
        },
      });
      const cfg = await tx.gmx_config.findFirst();
      if (cfg) {
        const deployed = parseFloat(cfg.deployed_usd) || 0;
        await tx.gmx_config.update({
          where: { id: cfg.id },
          data: { deployed_usd: Math.max(0, deployed - collateral).toFixed(2) },
        });
      }
    });
    await this.prisma.leverage_event.create({
      data: {
        protocol: 'gmx', kind: 'close', detail: reason,
        payload: JSON.stringify({ positionId: pos.id, pnlPct: Number(pnlPct.toFixed(2)), realized, txHash: chain.txHash, simulated: chain.simulated }),
      },
    }).catch(() => undefined);
    this.logger.warn(`GMX position ${pos.index_token} fermée (${reason}) PnL ${pnlPct.toFixed(2)}% = $${realized.toFixed(2)} [${chain.simulated ? 'dry-run' : 'pending_close ' + chain.txHash.slice(0, 12)}]`);
    return { id: pos.id, action: 'close', reason, pnlPct: Number(pnlPct.toFixed(2)), realized, txHash: chain.txHash, simulated: chain.simulated };
  }

  /** Ouverture auto sur signal momentum haussier (respecte budget + levier borné). */
  private async maybeOpen(cfg: any): Promise<any> {
    const deployed = parseFloat(cfg.deployed_usd) || 0;
    const budget = Math.min(parseFloat(cfg.budget_usd), GMX_BUDGET_USD);
    const collateral = Math.min(parseFloat(cfg.collateral_per_trade_usd), GMX_COLLATERAL_USD);
    if (deployed + collateral > budget) {
      return { action: 'skip', reason: 'budget_epuise', deployed, budget };
    }

    const prices = await this.priceService.getPriceSeries(cfg.index_token, 100);
    if (prices.length < cfg.ma_long + 1) {
      return { action: 'skip', reason: 'donnees_insuffisantes' };
    }
    const snap = computeSignal(prices, {
      maShort: cfg.ma_short, maLong: cfg.ma_long, rsiPeriod: cfg.rsi_period,
      rsiOversold: cfg.rsi_oversold, rsiOverbought: cfg.rsi_overbought,
    });
    if (snap.signal !== 'buy' || !snap.latestPrice) {
      return { action: 'skip', reason: 'pas_de_signal', signal: snap.signal };
    }

    // Levier borné dur : jamais > max_leverage.
    const leverage = Math.min(parseFloat(cfg.default_leverage) || GMX_TARGET_LEVERAGE,
      parseFloat(cfg.max_leverage) || GMX_MAX_LEVERAGE);
    const sizeUsd = collateral * leverage;

    // Prix acceptable : on paie un peu au-dessus du marché (slippage borné).
    const slippageBps = parseFloat(cfg.slippage_bps) || 30;
    const acceptablePrice = snap.latestPrice * (1 + slippageBps / 10000);

    // Ordre on-chain (createOrder MarketIncrease). En dry-run → simulé.
    const chain = await this.blockchain.gmxOpenLong({
      market: GMX_WETH_USD_MARKET,
      collateralTokenSymbol: cfg.collateral_token,
      collateralAmountUsd: collateral,
      sizeDeltaUsd: sizeUsd,
      acceptablePrice,
      indexTokenSymbol: cfg.index_token,
      isLong: true,
    });

    // Échec live : on n'ouvre PAS de position et on ne consomme PAS de budget.
    if (!chain.simulated && !chain.success) {
      this.logger.error(`GMX ouverture on-chain échouée ${cfg.index_token} : ${chain.error}`);
      await this.prisma.leverage_event.create({
        data: {
          protocol: 'gmx', kind: 'error',
          detail: `Ouverture échouée ${cfg.index_token}`,
          payload: JSON.stringify({ collateral, leverage, sizeUsd, error: chain.error }),
        },
      });
      return { action: 'open_failed', reason: 'chain_error', error: chain.error };
    }

    const pos = await this.prisma.gmx_position.create({
      data: {
        config_id: cfg.id,
        market: GMX_WETH_USD_MARKET,
        index_token: cfg.index_token,
        collateral_token: cfg.collateral_token,
        is_long: true,
        collateral_usd: collateral.toFixed(2),
        size_usd: sizeUsd.toFixed(2),
        leverage: leverage.toString(),
        entry_price: snap.latestPrice.toString(),
        highest_price: snap.latestPrice.toString(),
        status: chain.simulated ? 'simulated' : 'pending_open',
        open_tx_hash: chain.txHash,
        open_order_key: chain.orderKey || undefined,
      },
    });
    await this.prisma.gmx_config.update({
      where: { id: cfg.id },
      data: { deployed_usd: (deployed + collateral).toFixed(2) },
    });
    await this.prisma.leverage_event.create({
      data: {
        protocol: 'gmx', kind: 'open',
        detail: `Long ${cfg.index_token} collat $${collateral} levier ${leverage}x`,
        payload: JSON.stringify({ positionId: pos.id, collateral, leverage, sizeUsd, entry: snap.latestPrice, txHash: chain.txHash, simulated: chain.simulated }),
      },
    });
    this.logger.log(`GMX long ouvert ${cfg.index_token} collat $${collateral} levier ${leverage}x (taille $${sizeUsd}) [${chain.simulated ? 'dry-run' : 'pending_open ' + chain.txHash.slice(0, 12)}]`);
    return { action: 'open', positionId: pos.id, collateral, leverage, sizeUsd, entry: snap.latestPrice, txHash: chain.txHash, simulated: chain.simulated };
  }

  async getStatus(): Promise<any> {
    const cfg = await this.prisma.gmx_config.findFirst({
      include: { positions: { where: { status: 'open' } } },
    });
    return {
      enabled: this.enabled,
      schedule: '0 0 */4 * * * (toutes les 4 h)',
      budgetUsd: GMX_BUDGET_USD,
      targetLeverage: GMX_TARGET_LEVERAGE,
      maxLeverage: GMX_MAX_LEVERAGE,
      stopLossPct: GMX_STOP_LOSS_PCT,
      note: 'Ouvertures en pause par défaut. Exécution perp câblée sur GMX V2 (ExchangeRouter multicall) ; live requiert WALLET_PRIVATE_KEY, sinon simulé.',
      config: cfg ? { ...cfg, positions: undefined, openPositions: cfg.positions?.length ?? 0 } : null,
    };
  }
}
