import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { computeSignal, IndicatorSnapshot } from '../indicators';
import { computeAtrStops } from '../common/dynamic-stops';
import { GmxService } from '../gmx/gmx.service';
import { SHORT_ALLOWED_TOKENS } from '../constants';
import {
  CHAIN, MOMENTUM_ALTS_SIZE_USD, MOMENTUM_BC_SIZE_USD,
  TARGET_VOLATILITY, MOMENTUM_MIN_HOLD_MIN,
} from '../constants';
import { getStrategyModulation } from '../common/strategy-modulation';
import { estimateRoundTripCost, getMinProfitPct, passesProfitability } from '../common/profitability';

/**
 * Momentum — Stratégie tactique SMA + RSI
 * 2 configs : "Alts Volatils" ($150/trade) et "Blue Chips" ($200/trade)
 * Cron toutes les 5 minutes
 */
@Injectable()
export class MomentumService implements OnModuleInit {
  private readonly logger = new Logger(MomentumService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tradeExecution: TradeExecutionService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
    private readonly gmx: GmxService,
  ) {}

  /**
   * Réconcilie le montant à vendre avec le solde on-chain réel.
   * - Retourne le montant vendable (min entre demandé et solde réel).
   * - Si plusieurs positions ouvertes partagent le même token, répartit le solde
   *   proportionnellement à la part réclamée par CETTE position.
   * - Retourne 0 si le solde on-chain est négligeable (position fantôme).
   */
  private async reconcileSellAmount(
    token: string,
    positionId: string,
    requestedAmount: number,
  ): Promise<{ sellable: number; onChainBalance: number; claimedTotal: number; isPhantom: boolean }> {
    let onChainBalance = 0;
    try {
      const { formatted } = await this.blockchain.getBalance(token);
      onChainBalance = parseFloat(formatted) || 0;
    } catch (err: any) {
      this.logger.warn(`reconcileSellAmount: solde ${token} indisponible: ${err.message}`);
      return { sellable: 0, onChainBalance: 0, claimedTotal: 0, isPhantom: true };
    }

    // Somme des montants réclamés par toutes les positions momentum ouvertes sur ce token
    const openPositions = await this.prisma.position.findMany({
      where: { token, status: 'open' },
      select: { id: true, amount_token: true },
    });
    const claimedTotal = openPositions.reduce(
      (sum: number, p: any) => sum + (parseFloat(p.amount_token) || 0),
      0,
    );

    // Seuil poussière : 0.0001 % du montant demandé, ou 1e-8 absolu
    const dustThreshold = Math.max(requestedAmount * 1e-6, 1e-8);
    if (onChainBalance <= dustThreshold) {
      return { sellable: 0, onChainBalance, claimedTotal, isPhantom: true };
    }

    let sellable = Math.min(requestedAmount, onChainBalance);

    // Si le total réclamé dépasse le solde, répartir proportionnellement
    if (claimedTotal > onChainBalance && claimedTotal > 0) {
      const share = requestedAmount / claimedTotal;
      sellable = Math.min(sellable, onChainBalance * share);
    }

    // Marge de sécurité 0.1 % pour éviter les erreurs d'arrondi on-chain
    sellable = sellable * 0.999;
    if (sellable <= dustThreshold) {
      return { sellable: 0, onChainBalance, claimedTotal, isPhantom: true };
    }

    return { sellable, onChainBalance, claimedTotal, isPhantom: false };
  }

  /**
   * Marque une position comme fantôme (aucun solde on-chain correspondant).
   * Ne déclenche PAS de trade — nettoie uniquement l'état DB.
   */
  private async markPositionAsPhantom(cfg: any, pos: any, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      await tx.position.update({
        where: { id: pos.id },
        data: {
          status: 'phantom',
          closed_at: new Date(),
          amount_token: '0',
        },
      });
      const row = await tx.momentum_config.findUnique({ where: { id: cfg.id } });
      const deployed = parseFloat(row?.deployed_usd ?? '0');
      const cost = parseFloat(pos.cost_usd);
      await tx.momentum_config.update({
        where: { id: cfg.id },
        data: { deployed_usd: Math.max(0, deployed - cost).toFixed(2) },
      });
    });
    this.logger.warn(
      `Position ${pos.token} (id=${pos.id}) marquée FANTÔME : ${reason}. Aucun solde on-chain — nettoyage DB uniquement.`,
    );
  }

  /**
   * Nettoie toutes les positions fantômes (solde on-chain nul ou négligeable).
   * Peut être déclenché manuellement via l'API.
   */
  async cleanupPhantomPositions(): Promise<{ scanned: number; phantoms: any[]; kept: number }> {
    const openPositions = await this.prisma.position.findMany({
      where: { status: 'open' },
      include: { config: true },
    });
    const phantoms: any[] = [];
    let kept = 0;

    // Grouper par token pour minimiser les appels balanceOf
    const balancesCache: Record<string, number> = {};

    for (const pos of openPositions) {
      const token = pos.token;
      if (!(token in balancesCache)) {
        try {
          const { formatted } = await this.blockchain.getBalance(token);
          balancesCache[token] = parseFloat(formatted) || 0;
        } catch (err: any) {
          this.logger.warn(`cleanup: solde ${token} indisponible: ${err.message}`);
          balancesCache[token] = -1; // sentinelle : on ne peut pas juger
        }
      }
      const balance = balancesCache[token];
      const claimed = parseFloat(pos.amount_token) || 0;

      if (balance < 0) {
        kept++;
        continue; // solde indisponible → on ne touche pas
      }

      const dustThreshold = Math.max(claimed * 1e-6, 1e-8);
      if (balance <= dustThreshold) {
        await this.markPositionAsPhantom(pos.config, pos, `solde on-chain=${balance}, réclamé=${claimed}`);
        phantoms.push({
          id: pos.id,
          token: pos.token,
          config: pos.config?.name,
          claimed_amount: claimed,
          on_chain_balance: balance,
          cost_usd: pos.cost_usd,
        });
      } else {
        kept++;
      }
    }

    return { scanned: openPositions.length, phantoms, kept };
  }

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /**
   * Phase 2 : crée les 2 configs Momentum par défaut si elles n'existent pas encore.
   *   • Alts Volatils : ARB/LINK/UNI, budget $1500, SMA 10/30, RSI 30/70, SL 8%, TP 30/60/100%
   *   • Blue Chips   : WETH/WBTC,     budget $1000, SMA 20/50, RSI 35/65, SL 5%, TP 20/40/80%
   */
  async onModuleInit(): Promise<void> {
    try {
      const specs = [
        {
          name: 'Momentum Alts Volatils',
          tokens: 'ARB,LINK,UNI',
          budget_usd: '1500',
          ma_short: 10, ma_long: 30,
          rsi_period: 14, rsi_oversold: 30, rsi_overbought: 70,
          stop_loss_pct: 8,
          take_profit_levels: '30,60,100',
        },
        {
          name: 'Momentum Blue Chips',
          tokens: 'WETH,WBTC',
          budget_usd: '1000',
          ma_short: 20, ma_long: 50,
          rsi_period: 14, rsi_oversold: 35, rsi_overbought: 65,
          stop_loss_pct: 5,
          take_profit_levels: '20,40,80',
        },
      ];
      for (const spec of specs) {
        const existing = await this.prisma.momentum_config.findFirst({ where: { name: spec.name } });
        if (!existing) {
          await this.prisma.momentum_config.create({
            data: { ...spec, chain: CHAIN, active: true, paused: false },
          });
          this.logger.log(`Momentum config créée : "${spec.name}" (${spec.tokens}, budget $${spec.budget_usd})`);
        }
      }
    } catch (err: any) {
      this.logger.error(`Momentum onModuleInit: ${err.message}`);
    }
  }

  /** Récupère le multiplicateur momentum du coupling. 0 = stratégie coupée (capitulation). */
  private async getCouplingMultiplier(): Promise<number> {
    const decision = await this.prisma.coupling_decision.findFirst({
      where: { kind: 'momentum_modulation' },
      orderBy: { created_at: 'desc' },
    });
    if (!decision) return 1;
    try {
      const payload = JSON.parse(decision.payload);
      const mult = parseFloat(payload.multiplier);
      if (Number.isFinite(mult) && mult >= 0 && mult <= 2) return mult;
    } catch {}
    return 1;
  }

  /** Appelé séquentiellement par le PipelineOrchestrator (plus de @Cron individuel). */
  async tick(): Promise<any> {
    if (!this.enabled) return { skipped: true, reason: 'disabled' };
    try {
      return await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle momentum échoué: ${err.message}`);
      return { error: err.message };
    }
  }

  async executeCycle(): Promise<any> {
    const riskCfg = await this.prisma.risk_config.findFirst();
    if (riskCfg?.global_paused) {
      return { success: false, reason: 'pause_globale' };
    }

    // Coupling : récupérer le multiplicateur momentum (0 = capitulation, coupe les entrées).
    const couplingMult = await this.getCouplingMultiplier();

    const configs = await this.prisma.momentum_config.findMany({
      where: { active: true, paused: false },
    });

    const results: any[] = [];
    for (const cfg of configs) {
      try {
        const result = await this.processConfig(cfg, riskCfg, couplingMult);
        results.push(result);
      } catch (err: any) {
        this.logger.error(`Momentum config ${cfg.name} échoué: ${err.message}`);
        results.push({ configId: cfg.id, error: err.message });
      }
    }

    return { results, couplingMultiplier: couplingMult };
  }

  private async processConfig(cfg: any, riskCfg: any, couplingMult: number = 1): Promise<any> {
    const tokens = cfg.tokens.split(',').map((t: string) => t.trim().toUpperCase());
    const results: any[] = [];

    for (const token of tokens) {
      // Récupérer la série de prix
      const prices = await this.priceService.getPriceSeries(token, 100);
      if (prices.length < cfg.ma_long + 1) {
        results.push({ token, action: 'skip', reason: 'données insuffisantes' });
        continue;
      }

      // Calculer le signal
      const snap = computeSignal(prices, {
        maShort: cfg.ma_short,
        maLong: cfg.ma_long,
        rsiPeriod: cfg.rsi_period,
        rsiOversold: cfg.rsi_oversold,
        rsiOverbought: cfg.rsi_overbought,
      });

      // Gérer les positions ouvertes
      const openPositions = await this.prisma.position.findMany({
        where: { config_id: cfg.id, token, status: 'open' },
      });

      for (const pos of openPositions) {
        const result = await this.managePosition(cfg, pos, snap, prices);
        if (result) results.push(result);
      }

      // Ouverture de nouvelle position si signal buy
      if (snap.signal === 'buy' && snap.latestPrice) {
        // Coupling capitulation → mult=0 → on coupe les entrées (gestion des positions ouvertes conservée).
        if (couplingMult <= 0) {
          results.push({ token, action: 'skip', reason: 'coupling_capitulation' });
          continue;
        }
        const result = await this.tryOpenPosition(cfg, token, snap, riskCfg, couplingMult, prices);
        results.push(result);
      }

      // Phase 2 : signal SHORT en régime BEAR (signal sell + aucun long ouvert).
      // Le signal sell = MA courte < MA longue + RSI > overbought — tendance baissière.
      // Ouvre un SHORT via GMX Perps pour capter la baisse.
      if (snap.signal === 'sell' && snap.latestPrice && openPositions.length === 0
          && SHORT_ALLOWED_TOKENS.includes(token) && couplingMult > 0) {
        // Phase 3 : régime autorisé assoupli — le SHORT momentum se déclenche en BEAR
        // (bear/downtrend) MAIS AUSSI en RANGE (marché sans tendance : un signal sell
        // momentum y capte les rejets du haut de fourchette). Seuls les régimes
        // franchement haussiers (bull/uptrend) bloquent encore le short.
        const regimeRow = await this.prisma.market_regime.findFirst({
          where: { token }, orderBy: { recorded_at: 'desc' },
        }).catch(() => null);
        const reg = regimeRow?.regime?.toLowerCase() || 'inconnu';
        const isBullRegime = reg === 'bull' || reg === 'uptrend';
        const shortAllowedByRegime = !isBullRegime; // bear, downtrend, range, high_vol, low_vol, inconnu → autorisé
        // Traçabilité : log systématique de l'évaluation du short momentum.
        this.logger.log(
          `[SHORT-EVAL] Momentum ${token} : signal sell + 0 long ouvert, régime « ${reg} » → ` +
          `${shortAllowedByRegime ? 'SHORT AUTORISÉ' : 'bloqué (régime haussier)'}`,
        );
        if (shortAllowedByRegime) {
          const shortRes = await this.gmx.openShortForStrategy({
            source: 'momentum',
            indexToken: token,
            entryPrice: snap.latestPrice,
            reasonNote: `signal sell + régime ${reg}`,
          });
          results.push({ token, action: 'short_signal', regime: reg, short: shortRes });
        } else {
          results.push({ token, action: 'skip_short', reason: 'regime_haussier', regime: reg });
        }
      }
    }

    return { configId: cfg.id, name: cfg.name, results };
  }

  private async managePosition(cfg: any, pos: any, snap: IndicatorSnapshot, prices: number[] = []): Promise<any> {
    if (!snap.latestPrice) return null;
    const price = snap.latestPrice;
    const entry = parseFloat(pos.entry_price);
    const highest = Math.max(parseFloat(pos.highest_price), price);

    // Stops dynamiques basés sur l'ATR (volatilité réelle). Repli sur les % fixes de la
    // config si l'ATR n'est pas calculable (série trop courte).
    const atrStops = computeAtrStops(prices, entry);

    // Mettre à jour le plus haut
    if (price > parseFloat(pos.highest_price)) {
      await this.prisma.position.update({
        where: { id: pos.id },
        data: { highest_price: price.toString() },
      });
    }

    // Durée de détention (minutes) depuis l'ouverture.
    const holdMin = pos.opened_at
      ? (Date.now() - new Date(pos.opened_at).getTime()) / 60000
      : Infinity;
    const withinMinHold = holdMin < MOMENTUM_MIN_HOLD_MIN;

    // Stop-loss HARD (depuis le prix d'entrée) : TOUJOURS actif, même pendant la
    // détention minimum — c'est la seule sortie autorisée avant le seuil.
    // Stop dynamique ATR prioritaire (coupe les pertes tôt) ; sinon % fixe de la config.
    const stopLossPct = atrStops ? atrStops.stopPct : cfg.stop_loss_pct;
    const basicStop = atrStops ? atrStops.stopLoss : entry * (1 - stopLossPct / 100);
    if (price <= basicStop) {
      return this.closePosition(cfg, pos, price, atrStops ? 'stop_loss_atr' : 'stop_loss');
    }

    // Take-profit dynamique ATR (laisse courir les gains, ratio 2:1). Sortie totale.
    // Actif uniquement au-delà de la détention minimum.
    if (atrStops && !withinMinHold && price >= atrStops.takeProfit) {
      return this.closePosition(cfg, pos, price, 'take_profit_atr');
    }

    // Pendant la détention minimum : aucune autre sortie (ni trailing, ni signal
    // inverse, ni take-profit). Empêche les round-trips perdants en 3-9 min.
    if (withinMinHold) {
      return null;
    }

    // Trailing stop (au-delà de la détention minimum) — paramètre dédié
    // trailing_stop_pct, puis fallback sur stop_loss_pct, puis valeur par défaut.
    const params = cfg as any;
    const DEFAULT_TRAILING_STOP = 3;
    const trailingStopPct = params?.trailing_stop_pct ?? params?.stop_loss_pct ?? DEFAULT_TRAILING_STOP;
    const trailingStop = highest * (1 - Number(trailingStopPct) / 100);
    if (price <= trailingStop) {
      return this.closePosition(cfg, pos, price, 'trailing_stop');
    }

    // Signal de vente
    if (snap.signal === 'sell') {
      return this.closePosition(cfg, pos, price, 'signal_sell');
    }

    // Take-profit échelonné
    const levels = cfg.take_profit_levels
      .split(',')
      .map((l: string) => parseInt(l.trim(), 10))
      .filter((n: number) => !isNaN(n));

    const tpHits = (pos.tp_hits || '').split(',').map((s: string) => s.trim()).filter((s: string) => s.length);

    for (let i = 0; i < levels.length; i++) {
      if (tpHits.includes(String(i))) continue;
      const tpPrice = entry * (1 + levels[i] / 100);
      if (price >= tpPrice) {
        return this.partialTakeProfit(cfg, pos, price, i, levels.length);
      }
      break; // pas de saut de niveau
    }

    return null;
  }

  private async partialTakeProfit(
    cfg: any, pos: any, price: number, level: number, numLevels: number,
  ): Promise<any> {
    const currentAmount = parseFloat(pos.amount_token);
    const initialRaw = parseFloat(pos.initial_amount ?? '0');
    const initialAmount = initialRaw > 0 ? initialRaw : currentAmount;
    const fraction = 1 / numLevels;
    let sellAmount = initialAmount * fraction;

    const tpHits = (pos.tp_hits || '').split(',').map((s: string) => s.trim()).filter((s: string) => s.length);
    // Dernier niveau → vendre tout le reste
    if (tpHits.length + 1 >= numLevels) sellAmount = currentAmount;
    if (sellAmount > currentAmount) sellAmount = currentAmount;

    // Réconciliation on-chain avant la vente
    const rec = await this.reconcileSellAmount(pos.token, pos.id, sellAmount);
    if (rec.isPhantom) {
      await this.markPositionAsPhantom(
        cfg, pos,
        `TP niveau ${level} annulé — solde on-chain=${rec.onChainBalance}, demandé=${sellAmount}`,
      );
      return { action: 'phantom_detected', token: pos.token, price, reason: 'no_on_chain_balance' };
    }
    if (rec.sellable < sellAmount) {
      this.logger.warn(
        `TP ${pos.token}: plafonnement ${sellAmount} → ${rec.sellable} (solde on-chain=${rec.onChainBalance})`,
      );
      sellAmount = rec.sellable;
    }

    // Exécuter la vente partielle
    const result = await this.tradeExecution.executeTrade({
      source: 'momentum',
      sourceToken: pos.token,
      targetToken: 'USDC',
      amountIn: sellAmount.toFixed(8),
      side: 'sell',
    });

    const newAmount = currentAmount - sellAmount;
    const newTpHits = [...tpHits, String(level)].join(',');

    if (newAmount <= 0 || tpHits.length + 1 >= numLevels) {
      // Fermer complètement
      await this.prisma.$transaction(async (tx: any) => {
        await tx.position.update({
          where: { id: pos.id },
          data: { status: 'closed', closed_at: new Date(), amount_token: '0', tp_hits: newTpHits },
        });
        const row = await tx.momentum_config.findUnique({ where: { id: cfg.id } });
        const deployed = parseFloat(row?.deployed_usd ?? '0');
        const cost = parseFloat(pos.cost_usd);
        await tx.momentum_config.update({
          where: { id: cfg.id },
          data: { deployed_usd: Math.max(0, deployed - cost).toFixed(2) },
        });
      });
    } else {
      await this.prisma.position.update({
        where: { id: pos.id },
        data: { amount_token: newAmount.toFixed(8), tp_hits: newTpHits },
      });
    }

    return { action: 'take_profit', level, price, sellAmount, result };
  }

  private async closePosition(cfg: any, pos: any, price: number, reason: string): Promise<any> {
    const amount = parseFloat(pos.amount_token);
    if (amount <= 0) return { action: 'skip', reason: 'position_vide' };

    // Réconciliation on-chain avant la vente (évite les erreurs STF)
    const rec = await this.reconcileSellAmount(pos.token, pos.id, amount);
    if (rec.isPhantom) {
      await this.markPositionAsPhantom(
        cfg, pos,
        `${reason} annulé — solde on-chain=${rec.onChainBalance}, demandé=${amount}`,
      );
      return { action: 'phantom_detected', token: pos.token, price, reason: 'no_on_chain_balance' };
    }
    const sellAmount = rec.sellable < amount ? rec.sellable : amount;
    if (rec.sellable < amount) {
      this.logger.warn(
        `Close ${pos.token}: plafonnement ${amount} → ${sellAmount} (solde on-chain=${rec.onChainBalance})`,
      );
    }

    const result = await this.tradeExecution.executeTrade({
      source: 'momentum',
      sourceToken: pos.token,
      targetToken: 'USDC',
      amountIn: sellAmount.toFixed(8),
      side: 'sell',
    });

    // Ne PAS marquer la position comme fermée si le trade a échoué
    // (sinon on perd la trace du solde on-chain qui reste dans le wallet)
    if (!result.success) {
      this.logger.error(
        `closePosition ${pos.token} : trade ÉCHOUÉ (${result.error || 'unknown'}). Position laissée ouverte pour retry.`,
      );
      return { action: 'close_failed', token: pos.token, price, reason, error: result.error };
    }

    await this.prisma.$transaction(async (tx: any) => {
      await tx.position.update({
        where: { id: pos.id },
        data: { status: 'closed', closed_at: new Date(), amount_token: '0' },
      });
      const row = await tx.momentum_config.findUnique({ where: { id: cfg.id } });
      const deployed = parseFloat(row?.deployed_usd ?? '0');
      const cost = parseFloat(pos.cost_usd);
      await tx.momentum_config.update({
        where: { id: cfg.id },
        data: { deployed_usd: Math.max(0, deployed - cost).toFixed(2) },
      });
    });

    this.logger.log(`Position ${pos.token} fermée : ${reason} @ $${price}`);
    return { action: reason, token: pos.token, price, result };
  }

  private async tryOpenPosition(
    cfg: any, token: string, snap: IndicatorSnapshot, riskCfg: any, couplingMult: number = 1,
    prices: number[] = [],
  ): Promise<any> {
    // Compter les positions ouvertes
    const openCount = await this.prisma.position.count({
      where: { config_id: cfg.id, status: 'open' },
    });
    if (openCount >= 5) {
      return { token, action: 'skip', reason: 'max_positions_atteint' };
    }

    // Déjà une position ouverte sur ce token ?
    const existing = await this.prisma.position.findFirst({
      where: { config_id: cfg.id, token, status: 'open' },
    });
    if (existing) {
      return { token, action: 'skip', reason: 'position_deja_ouverte' };
    }

    // Pilotage adaptatif (Strategist × Strategy Evaluator).
    const modulation = await getStrategyModulation(this.prisma, 'momentum');
    if (!modulation.active) {
      return { token, action: 'skip', reason: 'directive_inactive', modulation: modulation.reason };
    }

    // Calculer la taille
    const budget = parseFloat(cfg.budget_usd);
    const freshCfg = await this.prisma.momentum_config.findUnique({ where: { id: cfg.id } });
    const deployed = parseFloat(freshCfg?.deployed_usd ?? cfg.deployed_usd);
    const remaining = budget - deployed;

    // Taille cible selon le type de config
    const isBlueChip = ['WETH', 'WBTC'].includes(token);
    let sizeUsd = isBlueChip ? MOMENTUM_BC_SIZE_USD : MOMENTUM_ALTS_SIZE_USD;

    // Réduction par volatilité
    if (snap.volatility && snap.volatility > 0) {
      const factor = Math.max(0.3, Math.min(1, TARGET_VOLATILITY / snap.volatility));
      sizeUsd = sizeUsd * factor;
    }

    // Recovery mode
    if (riskCfg?.recovery_mode) {
      const recoveryFactor = parseFloat(riskCfg.recovery_factor) || 0.5;
      sizeUsd = sizeUsd * recoveryFactor;
    }

    // Coupling : boost/frein selon régime de marché
    if (couplingMult > 0 && couplingMult !== 1) {
      sizeUsd = sizeUsd * couplingMult;
    }

    // Pilotage adaptatif : facteur de taille Strategist × allocation Evaluator
    if (modulation.sizeFactor !== 1) {
      sizeUsd = sizeUsd * modulation.sizeFactor;
    }

    // Plafonnement par budget restant
    if (remaining <= 1) {
      return { token, action: 'skip', reason: 'budget_epuisé' };
    }
    if (sizeUsd > remaining) sizeUsd = remaining;

    sizeUsd = Math.floor(sizeUsd * 100) / 100;
    if (sizeUsd < 5) {
      return { token, action: 'skip', reason: 'taille_trop_faible', sizeUsd };
    }

    // Filtre de rentabilité minimum : ne trader que si l'amplitude de mouvement
    // attendue dépasse le coût de l'aller-retour DEX (frais + slippage + gas) + marge.
    // Proxy du mouvement attendu pour le momentum = amplitude du range récent
    // (max - min) / moyenne sur la fenêtre longue.
    const window = (prices || []).slice(-Math.max(2, cfg.ma_long || 20));
    if (window.length >= 2) {
      const mx = Math.max(...window);
      const mn = Math.min(...window);
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      const expectedMovePct = mean > 0 ? ((mx - mn) / mean) * 100 : 0;
      const minPP = await getMinProfitPct(this.prisma, 'momentum');
      const est = estimateRoundTripCost(sizeUsd, minPP);
      if (!passesProfitability(expectedMovePct, est)) {
        this.logger.log(
          `[RENTABILITÉ] Momentum ${token} REFUSÉ : mouvement attendu ${expectedMovePct.toFixed(2)}% < seuil ${est.breakevenPct.toFixed(2)}% (coût ${est.costPct.toFixed(2)}% + marge ${minPP.toFixed(2)}%)`,
        );
        return {
          token,
          action: 'skip',
          reason: 'rentabilite_insuffisante',
          expectedMovePct: Number(expectedMovePct.toFixed(2)),
          breakevenPct: Number(est.breakevenPct.toFixed(2)),
        };
      }
    }

    // Exécuter l'achat
    const result = await this.tradeExecution.executeTrade({
      source: 'momentum',
      sourceToken: 'USDC',
      targetToken: token,
      amountIn: sizeUsd.toFixed(2),
      side: 'buy',
    });

    if (result.success) {
      // Créer la position atomiquement
      await this.prisma.$transaction(async (tx: any) => {
        await tx.position.create({
          data: {
            config_id: cfg.id,
            chain: CHAIN,
            token,
            amount_token: result.amountOut,
            initial_amount: result.amountOut,
            entry_price: snap.latestPrice!.toString(),
            cost_usd: sizeUsd.toFixed(2),
            highest_price: snap.latestPrice!.toString(),
          },
        });
        const row = await tx.momentum_config.findUnique({ where: { id: cfg.id } });
        const deployedNow = parseFloat(row?.deployed_usd ?? '0');
        await tx.momentum_config.update({
          where: { id: cfg.id },
          data: { deployed_usd: (deployedNow + sizeUsd).toFixed(2) },
        });
      });

      this.logger.log(`Position ouverte : ${token} $${sizeUsd} @ $${snap.latestPrice}`);
    }

    return { token, action: 'buy', sizeUsd, result };
  }

  async getStatus(): Promise<any> {
    const configs = await this.prisma.momentum_config.findMany({
      include: { positions: { where: { status: 'open' } } },
    });
    const minPP = await getMinProfitPct(this.prisma, 'momentum');
    const estRef = estimateRoundTripCost(MOMENTUM_ALTS_SIZE_USD, minPP);
    return {
      enabled: this.enabled,
      min_holding_minutes: MOMENTUM_MIN_HOLD_MIN,
      profitability: {
        min_profit_pct: minPP,
        round_trip_cost_pct_estimate: Number(estRef.costPct.toFixed(3)),
        breakeven_move_pct_estimate: Number(estRef.breakevenPct.toFixed(3)),
        note: 'Un momentum n\'entre que si l\'amplitude de range attendue dépasse le seuil de breakeven. Ajustable via app_config: profitability.momentum.minProfitPct ou profitability.minProfitPct.',
      },
      configs: configs.map((c: any) => ({
        ...c,
        openPositions: c.positions?.length ?? 0,
        // Durée de détention minimum : sous ce seuil, seul le stop-loss hard
        // peut clôturer une position (pas de sortie sur signal inverse / trailing).
        min_holding_minutes: MOMENTUM_MIN_HOLD_MIN,
      })),
    };
  }
}
