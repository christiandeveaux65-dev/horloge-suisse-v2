import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { acquireCronRun } from '../common/cron-lock';
import { TradeExecutionService } from '../trade/trade-execution.service';
import { PriceService } from '../price/price.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { TelegramService } from '../telegram/telegram.service';
import { STABLECOINS, LIQUIDATION_SLIPPAGE_BPS, CHAIN, TOKENS } from '../constants';

/**
 * Risk Manager — Gardien central CRITIQUE
 * Vérifie TOUS les stop-loss de TOUTES les stratégies à chaque cycle
 * Drawdown borné 0-100, circuit breaker, portfolio stop-loss absolu
 * Cron toutes les 5 minutes — NE JAMAIS DÉSACTIVER
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tradeExecution: TradeExecutionService,
    private readonly priceService: PriceService,
    private readonly blockchain: BlockchainService,
    private readonly telegram: TelegramService,
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(val: boolean): void { this.enabled = val; }

  /** Cron Risk Manager : toutes les 5 minutes — CRITIQUE */
  @Cron('0 */5 * * * *', { timeZone: 'Europe/Paris', name: 'risk' })
  async handleCron(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('⚠️ Risk Manager désactivé — DANGER');
      return;
    }
    // Verrou distribué : une seule instance exécute le cycle risque par tick de 5 min.
    if (!(await acquireCronRun(this.prisma, 'risk', 300000))) return;
    try {
      await this.executeCycle();
    } catch (err: any) {
      this.logger.error(`Cycle Risk Manager échoué: ${err.message}`);
    }
  }

  /** Exécuter toutes les vérifications de protection */
  async executeCycle(): Promise<any> {
    await this.ensurePhase3Config();
    const athCheck = await this.updateATHAndCheck();
    const cb = await this.checkCircuitBreaker();
    const recovery = await this.updateRecoveryMode();
    const trailing = await this.checkTrailingStop();
    const stopLoss = await this.checkPortfolioStopLoss();
    const stopsChecked = await this.checkAllStopLosses();

    const paused = await this.isPaused();
    return { paused, ath_check: athCheck, circuit_breaker: cb, recovery, trailing_stop: trailing, stop_loss: stopLoss, stops_checked: stopsChecked };
  }

  /** Aligne la config sur les seuils Phase 3 (idémpotent, s'exécute chaque cycle). */
  private async ensurePhase3Config(): Promise<void> {
    const cfg = await this.getOrCreateConfig();
    const updates: any = {};
    if (cfg.circuit_breaker_threshold_pct !== 7) updates.circuit_breaker_threshold_pct = 7;
    if (cfg.circuit_breaker_window_hours !== 24) updates.circuit_breaker_window_hours = 24;
    if (Object.keys(updates).length > 0) {
      await this.prisma.risk_config.update({ where: { id: cfg.id }, data: updates });
    }
  }

  /** Calculer la valeur totale du portefeuille en USD */
  async getPortfolioValue(): Promise<number> {
    return (await this.getPortfolioValueDetailed()).total;
  }

  /**
   * Valeur totale du portefeuille + indicateur de COMPLÉTUDE.
   * `incomplete` = true si au moins un token détenu de façon significative (> $1)
   * n'a pas pu être valorisé (prix indisponible). Dans ce cas, la valeur totale est
   * SOUS-ÉVALUÉE et ne doit JAMAIS servir à déclencher une pause/circuit breaker
   * (sinon une simple panne transitoire de flux de prix provoque un faux drawdown).
   */
  async getPortfolioValueDetailed(): Promise<{ total: number; incomplete: boolean; missing: string[] }> {
    let total = 0;
    const missing: string[] = [];
    // Lecture des soldes SANS avaler les erreurs RPC : `failed` liste les tokens dont
    // la lecture on-chain a échoué (429/timeout). Une valorisation avec des soldes en
    // échec est SOUS-ÉVALUÉE → on la marque incomplète pour bloquer tout stop-loss.
    const { balances, failed } = await this.blockchain.getAllBalancesDetailed();
    for (const f of failed) missing.push(`${f}(rpc)`);

    for (const [token, balStr] of Object.entries(balances)) {
      const bal = parseFloat(balStr);
      if (bal <= 0) continue;
      const up = token.toUpperCase();
      if (up === 'USDC' || up === 'USDT') { total += bal; continue; }
      try {
        const price = await this.priceService.getPrice(token);
        if (!(price > 0)) throw new Error('prix nul');
        total += bal * price;
      } catch {
        // Prix indisponible : on estime la valeur perdue via le dernier prix connu
        // pour juger si le token est significatif. S'il l'est (> $1), on marque incomplet.
        let lastKnown = 0;
        try {
          const last = await this.prisma.price_history.findFirst({
            where: { token: up, chain: CHAIN }, orderBy: { recorded_at: 'desc' },
          });
          if (last) lastKnown = parseFloat(last.price_usd) || 0;
        } catch { /* ignore */ }
        if (lastKnown > 0) {
          // On réintègre la valeur au dernier prix connu (évite la sous-évaluation)
          total += bal * lastKnown;
        }
        if (bal * lastKnown > 1 || lastKnown === 0) {
          missing.push(up);
        }
      }
    }

    // Ajoute la valeur des positions DeFi actives (GMX collatéral+PnL, Aave net collatéral-dette)
    // afin que l'ATH, le drawdown et les circuit breakers reposent sur le capital RÉEL complet
    // (wallet + DeFi), pas seulement les soldes ERC20 du wallet. En dry-run → 0.
    try {
      const defi = await this.blockchain.getDefiValueUsd();
      total += defi.totalUsd;
      if (defi.incomplete) missing.push('DEFI(rpc)');
    } catch (err: any) {
      this.logger.warn(`Valeur DeFi indisponible pour le calcul de risque: ${err.message}`);
      missing.push('DEFI(rpc)');
    }
    return { total, incomplete: missing.length > 0, missing };
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Cache de valorisation fiable (survit aux redéploiements via app_config)
  // ─────────────────────────────────────────────────────────────────────
  private static readonly RELIABLE_KEY = 'last_reliable_portfolio_usd';
  private static readonly RELIABLE_AT_KEY = 'last_reliable_portfolio_at';
  private reliableCache: { total: number; at: number } | null = null;

  /** Lit une valeur app_config (null si absente). */
  private async cfgGet(key: string): Promise<string | null> {
    try {
      const row = await this.prisma.app_config.findUnique({ where: { key } });
      return row ? row.value : null;
    } catch { return null; }
  }

  /** Écrit une valeur app_config (upsert, best-effort). */
  private async cfgSet(key: string, value: string): Promise<void> {
    try {
      await this.prisma.app_config.upsert({ where: { key }, create: { key, value }, update: { value } });
    } catch (err: any) { this.logger.warn(`cfgSet(${key}) échoué: ${err.message}`); }
  }

  private async cfgDel(key: string): Promise<void> {
    try { await this.prisma.app_config.delete({ where: { key } }); } catch { /* absente : ok */ }
  }

  /**
   * Valorisation FIABLE du portefeuille pour les décisions critiques (stop-loss).
   * - Si la lecture est COMPLÈTE (aucun échec RPC/prix) et total > 0 → on met la valeur
   *   en cache (mémoire + app_config) et on la retourne (fromCache=false).
   * - Si la lecture est INCOMPLÈTE ou total<=0 → on retourne la dernière valeur fiable
   *   connue (cache mémoire, sinon app_config) avec fromCache=true, pour NE PAS agir sur
   *   une valeur sous-évaluée par une panne RPC transitoire.
   */
  async getReliablePortfolioValue(): Promise<{ total: number; incomplete: boolean; fromCache: boolean; missing: string[] }> {
    const { total, incomplete, missing } = await this.getPortfolioValueDetailed();

    if (!incomplete && total > 0) {
      this.reliableCache = { total, at: Date.now() };
      await this.cfgSet(RiskService.RELIABLE_KEY, String(total));
      await this.cfgSet(RiskService.RELIABLE_AT_KEY, String(Date.now()));
      return { total, incomplete: false, fromCache: false, missing };
    }

    // Lecture non fiable → on tente le cache mémoire puis la base.
    let cachedTotal = this.reliableCache?.total ?? 0;
    if (!(cachedTotal > 0)) {
      const raw = await this.cfgGet(RiskService.RELIABLE_KEY);
      cachedTotal = raw ? parseFloat(raw) : 0;
    }
    this.logger.warn(
      `⚠️ Valorisation non fiable (incomplete=${incomplete}, brut=$${total.toFixed(2)}, manquants=${missing.join(',')}) — usage cache $${cachedTotal.toFixed(2)}`,
    );
    return { total: cachedTotal, incomplete: true, fromCache: true, missing };
  }

  /** Mettre à jour l'ATH et vérifier le drawdown */
  private async updateATHAndCheck(): Promise<any> {
    let cfg = await this.getOrCreateConfig();
    const { total, incomplete, missing } = await this.getPortfolioValueDetailed();

    // Sécurité anti-faux-positif : si la valorisation est incomplète (prix manquant
    // pour un token significatif), on NE met à jour NI l'ATH NI on ne déclenche de pause.
    if (incomplete) {
      this.logger.warn(`Drawdown non évalué : valorisation incomplète (prix manquant : ${missing.join(', ')})`);
      const currentAth = parseFloat(cfg.ath_value_usd) || total;
      return { total, ath: currentAth, drawdownPct: 0, triggered: false, skipped: 'valorisation_incomplete' };
    }

    const ath = parseFloat(cfg.ath_value_usd) || 0;

    // Mettre à jour l'ATH si nouveau max
    if (total > ath) {
      await this.prisma.risk_config.update({
        where: { id: cfg.id },
        data: { ath_value_usd: total.toFixed(2), ath_recorded_at: new Date() },
      });
      cfg = await this.prisma.risk_config.findUnique({ where: { id: cfg.id } }) as any;
    }

    // Calcul drawdown — borné [0, 100] (leçon #8)
    const currentAth = parseFloat(cfg.ath_value_usd) || total;
    const rawDrawdown = currentAth > 0 ? ((currentAth - total) / currentAth) * 100 : 0;
    const drawdownPct = Math.max(0, Math.min(100, rawDrawdown));

    let triggered = false;
    if (!cfg.global_paused && currentAth > 0 && drawdownPct >= cfg.max_drawdown_pct) {
      triggered = true;
      const reason = `Drawdown ${drawdownPct.toFixed(2)}% ≥ seuil ${cfg.max_drawdown_pct}%`;
      await this.prisma.risk_config.update({
        where: { id: cfg.id },
        data: { global_paused: true, paused_reason: reason, paused_at: new Date() },
      });
      await this.logEvent('drawdown_pause', reason);
      this.logger.error(`🚨 ${reason}`);
    }

    return { total, ath: currentAth, drawdownPct, triggered };
  }

  /** Circuit breaker : drawdown > seuil sur fenêtre glissante */
  private async checkCircuitBreaker(): Promise<any> {
    const cfg = await this.getOrCreateConfig();
    const windowHours = cfg.circuit_breaker_window_hours;
    const threshold = cfg.circuit_breaker_threshold_pct;

    // Chercher les snapshots dans la fenêtre
    const windowStart = new Date(Date.now() - windowHours * 3600 * 1000);
    const snapshots = await this.prisma.portfolio_snapshot.findMany({
      where: { snapshot_at: { gte: windowStart } },
      orderBy: { snapshot_at: 'asc' },
    });

    if (snapshots.length === 0) {
      return { checked: false, reason: 'pas de snapshots' };
    }

    // Agréger par timestamp pour obtenir la valeur totale.
    // DÉDUPLICATION : un même token peut apparaître en double au même timestamp
    // (bug d'écriture lors du dépôt externe → ligne USDC dupliquée le 15/07 21:30
    // qui gonflait le pic à ~$12856 au lieu de $6428 → faux drawdown 38.94%).
    // On ne compte donc qu'UNE valeur par (timestamp, token).
    const totals = new Map<string, number>();
    const seenTokens = new Map<string, Set<string>>();
    for (const snap of snapshots) {
      const key = snap.snapshot_at.toISOString();
      const token = snap.token;
      if (!seenTokens.has(key)) seenTokens.set(key, new Set());
      const tokenSet = seenTokens.get(key)!;
      if (tokenSet.has(token)) continue; // doublon du même token au même instant → ignoré
      tokenSet.add(token);
      const val = parseFloat(snap.value_usd) || 0;
      totals.set(key, (totals.get(key) || 0) + val);
    }

    const values = Array.from(totals.values());
    const rawPeak = Math.max(...values);
    const { total, incomplete, missing } = await this.getPortfolioValueDetailed();

    // GARDE ANTI-PIC-FANTÔME : le pic de la fenêtre 24h ne peut logiquement pas
    // dépasser l'ATH global (maintenu sur valorisations complètes uniquement).
    // Tout snapshot supérieur à l'ATH est un artefact de données → on plafonne.
    const athValue = parseFloat(cfg.ath_value_usd) || rawPeak;
    const peak = Math.min(rawPeak, athValue > 0 ? athValue : rawPeak);

    // Sécurité anti-faux-positif : ne jamais déclencher le circuit breaker sur une
    // valorisation incomplète (une panne transitoire de prix ferait chuter le total
    // et simulerait un faux drawdown — cause de la fausse pause du 15/07).
    if (incomplete) {
      this.logger.warn(`Circuit breaker non évalué : valorisation incomplète (prix manquant : ${missing.join(', ')})`);
      return { checked: false, reason: 'valorisation_incomplete', missing };
    }

    const windowDrawdownPct = Math.max(0, ((peak - total) / peak) * 100);

    // ─── AUTO-RÉCUPÉRATION ───
    // Si le circuit breaker est actif mais que le drawdown réel est repassé sous la
    // moitié du seuil (marge anti-oscillation), on lève automatiquement la pause :
    // le bot se remet à trader sans intervention (évite de rester bloqué indéfiniment).
    if (cfg.circuit_breaker_active) {
      const rearmBelow = threshold / 2;
      if (windowDrawdownPct < rearmBelow) {
        const reason = `Circuit breaker levé automatiquement : drawdown ${windowDrawdownPct.toFixed(2)}% < ${rearmBelow.toFixed(1)}% (récupération)`;
        // On ne lève la pause QUE si elle avait été posée par le circuit breaker
        // (ne pas écraser une pause drawdown/trailing/stop-loss encore justifiée).
        const wasCircuitPause = (cfg.paused_reason || '').toLowerCase().includes('circuit breaker');
        await this.prisma.risk_config.update({
          where: { id: cfg.id },
          data: {
            circuit_breaker_active: false,
            ...(wasCircuitPause ? { global_paused: false, paused_reason: '', paused_at: null } : {}),
          },
        });
        await this.logEvent('circuit_breaker_recovered', reason);
        this.logger.log(`✅ ${reason}`);
        return { windowDrawdownPct, peak, total, recovered: true };
      }
      return { windowDrawdownPct, peak, total, stillActive: true };
    }

    let triggered = false;
    if (windowDrawdownPct >= threshold) {
      triggered = true;
      const reason = `Circuit breaker : drawdown ${windowDrawdownPct.toFixed(2)}% en ${windowHours}h ≥ seuil ${threshold}%`;
      await this.prisma.risk_config.update({
        where: { id: cfg.id },
        data: {
          circuit_breaker_active: true,
          circuit_breaker_triggered_at: new Date(),
          global_paused: true,
          paused_reason: reason,
          paused_at: new Date(),
        },
      });
      await this.logEvent('circuit_breaker', reason);
      this.logger.error(`🚨 ${reason}`);
    }

    return { windowDrawdownPct, peak, total, triggered };
  }

  /** Recovery progressif (Phase 3) :
   *   DD 3-5%  → ×0.8
   *   DD 5-8%  → ×0.6
   *   DD 8-10% → ×0.4
   *   DD ≥ 10% → pause totale
   */
  private async updateRecoveryMode(): Promise<any> {
    const cfg = await this.getOrCreateConfig();
    const total = await this.getPortfolioValue();
    const ath = parseFloat(cfg.ath_value_usd) || total;
    const drawdownPct = ath > 0 ? Math.max(0, Math.min(100, ((ath - total) / ath) * 100)) : 0;

    let recoveryMode = false;
    let factor = 1;
    if (drawdownPct >= 10) {
      // pause totale (gérée par updateATHAndCheck / seuil max_drawdown_pct)
      recoveryMode = true; factor = 0;
    } else if (drawdownPct >= 8) {
      recoveryMode = true; factor = 0.4;
    } else if (drawdownPct >= 5) {
      recoveryMode = true; factor = 0.6;
    } else if (drawdownPct >= 3) {
      recoveryMode = true; factor = 0.8;
    }

    const currentFactor = parseFloat(cfg.recovery_factor) || 1;
    if (recoveryMode !== cfg.recovery_mode || Math.abs(factor - currentFactor) > 0.01) {
      await this.prisma.risk_config.update({
        where: { id: cfg.id },
        data: { recovery_mode: recoveryMode, recovery_factor: factor.toString() },
      });
      if (recoveryMode) {
        await this.logEvent('recovery_mode', `Recovery DD ${drawdownPct.toFixed(2)}% → ×${factor}`);
      }
    }

    return { recovery_mode: recoveryMode, factor, drawdownPct: Number(drawdownPct.toFixed(2)) };
  }

  /** Trailing stop global (Phase 3) :
   *   – baseline = première valeur observée (persistée dans risk_metric).
   *   – Activation : portfolio ≥ baseline × 1.10 (+10% depuis la baseline / ATH initial).
   *   – Trailing : ferme (pause globale) si valeur ≤ peak_local × 0.95 (-5% du pic).
   */
  private async checkTrailingStop(): Promise<any> {
    const total = await this.getPortfolioValue();
    if (total <= 0) return { active: false, reason: 'no_value' };

    let m = await this.prisma.risk_metric.findFirst({ where: { kind: 'trailing_stop' }, orderBy: { computed_at: 'desc' } });
    let state: any = m ? JSON.parse(m.payload) : { baseline: total, peak: total, active: false };

    // Mise à jour du peak
    if (total > state.peak) state.peak = total;

    // Activation : +10% au-dessus de la baseline
    if (!state.active && total >= state.baseline * 1.10) {
      state.active = true;
      await this.logEvent('trailing_stop_armed', `Trailing armé : total $${total.toFixed(2)} ≥ baseline $${state.baseline.toFixed(2)} ×1.10`);
    }

    let triggered = false;
    if (state.active && total <= state.peak * 0.95) {
      triggered = true;
      const reason = `Trailing stop déclenché : $${total.toFixed(2)} ≤ peak $${state.peak.toFixed(2)} ×0.95`;
      const cfg = await this.getOrCreateConfig();
      if (!cfg.global_paused) {
        await this.prisma.risk_config.update({
          where: { id: cfg.id },
          data: { global_paused: true, paused_reason: reason, paused_at: new Date() },
        });
        await this.logEvent('trailing_stop', reason);
        this.logger.error(`🚨 ${reason}`);
      }
      // Réinitialiser peak après déclenchement pour ne pas re-tirer immédiatement
      state.peak = total;
    }

    await this.prisma.risk_metric.create({
      data: {
        kind: 'trailing_stop', scope: 'portfolio',
        value: total.toFixed(2),
        payload: JSON.stringify(state),
      },
    });

    return { active: state.active, baseline: state.baseline, peak: state.peak, total, triggered };
  }

  /**
   * Portfolio stop-loss absolu : liquidation totale.
   *
   * SÉCURITÉ ANTI-FAUX-DÉCLENCHEMENT (double-lecture + valeur fiable) :
   *  1. On utilise getReliablePortfolioValue() : si la valorisation est incomplète
   *     (panne RPC/prix) on N'AGIT JAMAIS (cause du faux stop-loss à $6339/$5315).
   *  2. Une seule lecture sous le seuil NE liquide PAS : on enregistre un "pending"
   *     (app_config, JSON {at, value}). La liquidation n'est déclenchée que si une
   *     2ᵉ lecture FIABLE, au moins 30 s plus tard, confirme un total < seuil.
   *     Le cron risk tourne toutes les 5 min → 2 cycles = confirmation ~5 min.
   */
  private static readonly SL_PENDING_KEY = 'stop_loss_breach_pending';
  private static readonly SL_MIN_GAP_MS = 30_000;

  private async checkPortfolioStopLoss(): Promise<any> {
    const cfg = await this.getOrCreateConfig();
    const threshold = parseFloat(cfg.portfolio_stop_loss_usd);

    const { total, incomplete, fromCache } = await this.getReliablePortfolioValue();

    // Valorisation non fiable → ne rien faire (surtout ne pas liquider).
    if (incomplete || fromCache) {
      return { breached: false, total, threshold, skipped: 'valorisation_incomplete' };
    }

    if (threshold <= 0 || total >= threshold) {
      // Sous le seuil résolu → on efface tout candidat en attente.
      await this.cfgDel(RiskService.SL_PENDING_KEY);
      return { breached: false, total, threshold };
    }

    // total < threshold ET valeur fiable → logique de double-lecture.
    const now = Date.now();
    const pendingRaw = await this.cfgGet(RiskService.SL_PENDING_KEY);
    let pending: { at: number; value: number } | null = null;
    if (pendingRaw) { try { pending = JSON.parse(pendingRaw); } catch { pending = null; } }

    if (!pending || now - pending.at < RiskService.SL_MIN_GAP_MS) {
      // 1ʳᵉ lecture (ou 2ᵉ trop rapprochée) → on enregistre le candidat, PAS de liquidation.
      await this.cfgSet(RiskService.SL_PENDING_KEY, JSON.stringify({ at: now, value: total }));
      this.logger.warn(
        `⏳ Portfolio stop-loss CANDIDAT (1/2) : $${total.toFixed(2)} < $${threshold} — confirmation requise à la prochaine lecture fiable (≥30s).`,
      );
      await this.logEvent(
        'portfolio_stop_loss_pending',
        `Candidat stop-loss : $${total.toFixed(2)} < seuil $${threshold} (confirmation en attente)`,
      );
      return { breached: false, pending: true, total, threshold };
    }

    // 2ᵉ lecture fiable ≥30s plus tard, toujours sous le seuil → LIQUIDATION.
    this.logger.error(
      `🚨 Portfolio stop-loss CONFIRMÉ (2/2) : $${total.toFixed(2)} < $${threshold} (1ʳᵉ lecture $${pending.value.toFixed(2)}) — liquidation.`,
    );
    await this.logEvent(
      'portfolio_stop_loss',
      `Confirmé : $${total.toFixed(2)} < seuil $${threshold} (1ʳᵉ lecture $${pending.value.toFixed(2)})`,
    );
    await this.cfgDel(RiskService.SL_PENDING_KEY);
    await this.liquidateAllPositions('portfolio_stop_loss');

    return { breached: true, total, threshold, confirmed: true };
  }

  /** Vérifier TOUS les stop-loss (Momentum + Mean Reversion) */
  private async checkAllStopLosses(): Promise<any> {
    let checked = 0;
    let triggered = 0;

    // Mean Reversion positions
    const mrPositions = await this.prisma.mean_reversion_position.findMany({
      where: { status: 'open' },
    });

    for (const pos of mrPositions) {
      checked++;
      try {
        const price = await this.priceService.getPrice(pos.token);
        const stopLoss = parseFloat(pos.stop_loss);
        const takeProfit = parseFloat(pos.take_profit);

        if (price <= stopLoss) {
          triggered++;
          await this.forceCloseMRPosition(pos, price, 'stop_loss');
        } else if (price >= takeProfit) {
          triggered++;
          await this.forceCloseMRPosition(pos, price, 'take_profit');
        }
      } catch (err: any) {
        this.logger.warn(`Stop-loss check MR ${pos.token} échoué: ${err.message}`);
      }
    }

    // Momentum positions
    const momPositions = await this.prisma.position.findMany({
      where: { status: 'open' },
      include: { config: true },
    });

    for (const pos of momPositions) {
      checked++;
      try {
        const price = await this.priceService.getPrice(pos.token);
        const entry = parseFloat(pos.entry_price);
        const highest = Math.max(parseFloat(pos.highest_price), price);
        const stopPct = pos.config?.stop_loss_pct ?? 8;
        const basicStop = entry * (1 - stopPct / 100);
        const trailingStop = highest * (1 - stopPct / 100);
        const stopPrice = Math.max(basicStop, trailingStop);

        if (price <= stopPrice) {
          triggered++;
          await this.forceCloseMomPosition(pos, price, 'stop_loss');
        }
      } catch (err: any) {
        this.logger.warn(`Stop-loss check Momentum ${pos.token} échoué: ${err.message}`);
      }
    }

    if (triggered > 0) {
      this.logger.warn(`Stop-loss déclenchés : ${triggered}/${checked}`);
    }

    return { checked, triggered };
  }

  private async forceCloseMRPosition(pos: any, price: number, reason: string): Promise<void> {
    const amount = parseFloat(pos.amount_token);
    if (amount <= 0) return;

    const result = await this.tradeExecution.executeTrade({
      source: 'risk',
      sourceToken: pos.token,
      targetToken: 'USDC',
      amountIn: amount.toFixed(8),
      side: 'sell',
    });

    const pnl = parseFloat(result.amountOut) - parseFloat(pos.cost_usd);
    await this.prisma.mean_reversion_position.update({
      where: { id: pos.id },
      data: { status: 'closed', closed_at: new Date(), pnl_usd: pnl.toFixed(2) },
    });

    await this.logEvent('stop_loss_mr', `${pos.token} fermée par ${reason} @ $${price}`);
  }

  private async forceCloseMomPosition(pos: any, price: number, reason: string): Promise<void> {
    const amount = parseFloat(pos.amount_token);
    if (amount <= 0) return;

    const result = await this.tradeExecution.executeTrade({
      source: 'risk',
      sourceToken: pos.token,
      targetToken: 'USDC',
      amountIn: amount.toFixed(8),
      side: 'sell',
    });

    await this.prisma.$transaction(async (tx: any) => {
      await tx.position.update({
        where: { id: pos.id },
        data: { status: 'closed', closed_at: new Date(), amount_token: '0' },
      });
      if (pos.config_id) {
        const row = await tx.momentum_config.findUnique({ where: { id: pos.config_id } });
        if (row) {
          const deployed = parseFloat(row.deployed_usd);
          const cost = parseFloat(pos.cost_usd);
          await tx.momentum_config.update({
            where: { id: pos.config_id },
            data: { deployed_usd: Math.max(0, deployed - cost).toFixed(2) },
          });
        }
      }
    });

    await this.logEvent('stop_loss_momentum', `${pos.token} fermée par ${reason} @ $${price}`);
  }

  /** Liquidation totale : vendre tout en USDC */
  private async liquidateAllPositions(reason: string): Promise<void> {
    this.logger.error(`🚨 Liquidation totale : ${reason}`);

    const balances = await this.blockchain.getAllBalances();

    for (const [token, balStr] of Object.entries(balances)) {
      if (STABLECOINS.has(token.toUpperCase()) || token === 'ETH') continue;
      const bal = parseFloat(balStr);
      if (bal <= 0.000001) continue;

      try {
        await this.tradeExecution.executeTrade({
          source: 'risk',
          sourceToken: token,
          targetToken: 'USDC',
          amountIn: bal.toFixed(8),
          side: 'sell',
          slippageBps: LIQUIDATION_SLIPPAGE_BPS,
        });
      } catch (err: any) {
        this.logger.error(`Liquidation ${token} échouée: ${err.message}`);
      }
    }

    // Fermer toutes les positions
    await this.prisma.position.updateMany({
      where: { status: 'open' },
      data: { status: 'closed', closed_at: new Date(), amount_token: '0' },
    });
    await this.prisma.mean_reversion_position.updateMany({
      where: { status: 'open' },
      data: { status: 'closed', closed_at: new Date() },
    });
    await this.prisma.momentum_config.updateMany({
      data: { deployed_usd: '0' },
    });

    // Pause globale
    const cfg = await this.getOrCreateConfig();
    await this.prisma.risk_config.update({
      where: { id: cfg.id },
      data: {
        global_paused: true,
        paused_reason: `Liquidation totale : ${reason}`,
        paused_at: new Date(),
      },
    });
  }

  async isPaused(): Promise<boolean> {
    const cfg = await this.prisma.risk_config.findFirst();
    return cfg?.global_paused ?? false;
  }

  /**
   * Reprise MANUELLE après une pause protectrice.
   * Le Risk Manager reste le gardien : on n'autorise la reprise QUE si le drawdown
   * réel actuel est sous le seuil max (sinon la pause reste justifiée → 409).
   * Ne désactive jamais le Risk Manager lui-même — lève uniquement la pause/circuit breaker.
   */
  async manualResume(): Promise<any> {
    const cfg = await this.getOrCreateConfig();
    if (!cfg.global_paused && !cfg.circuit_breaker_active) {
      return { resumed: false, reason: 'aucune_pause_active', paused: false };
    }
    const { total, incomplete, missing } = await this.getPortfolioValueDetailed();
    if (incomplete) {
      return { resumed: false, reason: 'valorisation_incomplete', missing };
    }
    const ath = parseFloat(cfg.ath_value_usd) || total;
    const drawdownPct = ath > 0 ? Math.max(0, Math.min(100, ((ath - total) / ath) * 100)) : 0;
    if (drawdownPct >= cfg.max_drawdown_pct) {
      return {
        resumed: false,
        reason: 'drawdown_reel_dangereux',
        drawdownPct: Number(drawdownPct.toFixed(2)),
        maxDrawdownPct: cfg.max_drawdown_pct,
      };
    }
    await this.prisma.risk_config.update({
      where: { id: cfg.id },
      data: {
        global_paused: false,
        circuit_breaker_active: false,
        paused_reason: '',
        paused_at: null,
      },
    });
    await this.logEvent('manual_resume', `Reprise manuelle — drawdown réel ${drawdownPct.toFixed(2)}% < seuil ${cfg.max_drawdown_pct}%`);
    this.logger.log(`✅ Reprise manuelle : pause levée (drawdown réel ${drawdownPct.toFixed(2)}%)`);
    return { resumed: true, drawdownPct: Number(drawdownPct.toFixed(2)), total: Number(total.toFixed(2)) };
  }

  async getSizingFactor(): Promise<number> {
    const cfg = await this.prisma.risk_config.findFirst();
    if (!cfg) return 1;
    if (cfg.recovery_mode) {
      const f = parseFloat(cfg.recovery_factor);
      return isFinite(f) ? f : 1;
    }
    return 1;
  }

  private async logEvent(kind: string, detail: string, payload: any = {}): Promise<void> {
    await this.prisma.risk_event.create({
      data: { kind, detail, payload: JSON.stringify(payload) },
    });
    // Notification Telegram (fire-and-forget)
    this.telegram.notifyRisk(kind, detail);
  }

  private async getOrCreateConfig(): Promise<any> {
    let cfg = await this.prisma.risk_config.findFirst();
    if (!cfg) {
      cfg = await this.prisma.risk_config.create({ data: {} });
    }
    return cfg;
  }

  async getStatus(): Promise<any> {
    const cfg = await this.getOrCreateConfig();
    const total = await this.getPortfolioValue();
    const ath = parseFloat(cfg.ath_value_usd) || total;
    const drawdownPct = ath > 0 ? Math.max(0, Math.min(100, ((ath - total) / ath) * 100)) : 0;

    const recentEvents = await this.prisma.risk_event.findMany({
      orderBy: { created_at: 'desc' },
      take: 10,
    });

    return {
      enabled: this.enabled,
      config: cfg,
      portfolioValue: total,
      ath,
      drawdownPct,
      recentEvents,
    };
  }
}
