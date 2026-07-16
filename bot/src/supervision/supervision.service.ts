import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RiskService } from '../risk/risk.service';
import { TelegramService } from '../telegram/telegram.service';
import { MarketIntelligenceService } from '../market/market-intelligence.service';
import { TOKENS, STABLECOINS, CHAIN } from '../constants';

export type MarketRegime = 'BULL' | 'BEAR' | 'RANGE' | 'HIGH_VOL';

export interface PipelineErrorContext {
  modulesExecuted?: string[];
  modulesFailed?: string[];
}

/**
 * SupervisionService — supervision proactive du bot.
 *  • Monitoring continu (drawdown, trades échoués consécutifs, latence KuCoin, taux d'erreur modules)
 *  • Auto-pause intelligente (met globalPaused=true via le Risk Manager)
 *  • Alertes Telegram (auto-pause, drawdown, trade échoué, résumé quotidien minuit Paris)
 *  • Détection de régime de marché (BULL / BEAR / RANGE / HIGH_VOL)
 * Intégré au PipelineOrchestrator en Phase 4 MESURER (fréquence 5 min).
 */
@Injectable()
export class SupervisionService implements OnModuleInit {
  private readonly logger = new Logger('SupervisionService');
  private static readonly KUCOIN_PING = 'https://api.kucoin.com/api/v1/timestamp';

  // Anti-spam : cooldown par catégorie d'alerte (ms).
  private readonly ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
  private lastAlertAt: Record<string, number> = {};

  // Ne pas ré-alerter les trades échoués historiques : on ne regarde que ceux postérieurs au démarrage.
  private lastTradeCheck: Date = new Date();

  // Dernier instantané calculé (exposé dans GET /status sans recalcul lourd).
  private lastSnapshot: any = null;
  private lastModuleErrorRate = 0;
  private lastModulesFailed: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly risk: RiskService,
    private readonly telegram: TelegramService,
    private readonly market: MarketIntelligenceService,
  ) {}

  onModuleInit(): void {
    // On ne notifie que les trades échoués survenus APRÈS le démarrage du service.
    this.lastTradeCheck = new Date();
  }

  // ─── Config ───
  async getOrCreateConfig(): Promise<any> {
    let cfg = await this.prisma.supervision_config.findFirst();
    if (!cfg) cfg = await this.prisma.supervision_config.create({ data: {} });
    return cfg;
  }

  async updateConfig(patch: Record<string, any>): Promise<any> {
    const cfg = await this.getOrCreateConfig();
    const allowed = [
      'drawdown_warn_pct',
      'drawdown_max_pct',
      'max_consecutive_failures',
      'kucoin_latency_max_ms',
      'module_error_rate_max',
      'auto_pause_enabled',
    ];
    const data: Record<string, any> = {};
    for (const k of allowed) {
      if (patch[k] !== undefined && patch[k] !== null) data[k] = patch[k];
    }
    if (Object.keys(data).length === 0) return { updated: false, config: cfg };
    const updated = await this.prisma.supervision_config.update({ where: { id: cfg.id }, data });
    this.logger.log(`[SUPERVISION] Config mise à jour : ${JSON.stringify(data)}`);
    return { updated: true, config: updated };
  }

  // ─── Métriques individuelles ───

  /** Mesure la latence de l'API KuCoin (ping léger /timestamp). */
  async measureKuCoinLatency(): Promise<{ ms: number; ok: boolean }> {
    const t0 = Date.now();
    try {
      const res = await fetch(SupervisionService.KUCOIN_PING, { signal: AbortSignal.timeout(12000) });
      await res.text().catch(() => undefined);
      return { ms: Date.now() - t0, ok: res.ok };
    } catch {
      return { ms: Date.now() - t0, ok: false };
    }
  }

  /** Nombre de trades échoués CONSÉCUTIFS (les plus récents). */
  async consecutiveFailedTrades(): Promise<number> {
    const trades = await this.prisma.trade.findMany({
      orderBy: { executed_at: 'desc' },
      take: 30,
      select: { status: true },
    });
    let count = 0;
    for (const t of trades) {
      if (t.status === 'failed') count++;
      else break;
    }
    return count;
  }

  /** Drawdown temps réel via le Risk Manager (source unique de vérité). */
  async computeDrawdown(): Promise<{ drawdownPct: number; portfolioValue: number; ath: number }> {
    try {
      const st = await this.risk.getStatus();
      return {
        drawdownPct: Number(st.drawdownPct ?? 0),
        portfolioValue: Number(st.portfolioValue ?? 0),
        ath: Number(st.ath ?? 0),
      };
    } catch {
      return { drawdownPct: 0, portfolioValue: 0, ath: 0 };
    }
  }

  /**
   * Détection du régime de marché global à partir des derniers relevés market_regime
   * (déjà collectés par MarketIntelligenceService) agrégés sur tous les tokens non-stables.
   */
  async detectRegime(): Promise<{
    regime: MarketRegime;
    avgVolatility: number;
    avgTrendStrength: number;
    perToken: Array<{ token: string; regime: string; volatility: number; trendStrength: number }>;
  }> {
    const tokens = Object.keys(TOKENS).filter((t) => !STABLECOINS.has(t));
    const perToken: Array<{ token: string; regime: string; volatility: number; trendStrength: number }> = [];

    for (const token of tokens) {
      const row = await this.prisma.market_regime
        .findFirst({ where: { token, chain: CHAIN }, orderBy: { recorded_at: 'desc' } })
        .catch(() => null);
      if (row) {
        perToken.push({
          token,
          regime: String(row.regime),
          volatility: parseFloat(row.volatility ?? '0') || 0,
          trendStrength: parseFloat(row.trend_strength ?? '0') || 0,
        });
      }
    }

    if (perToken.length === 0) {
      return { regime: 'RANGE', avgVolatility: 0, avgTrendStrength: 0, perToken };
    }

    const avgVolatility = perToken.reduce((s, p) => s + p.volatility, 0) / perToken.length;
    const avgTrendStrength = perToken.reduce((s, p) => s + p.trendStrength, 0) / perToken.length;

    const highVolCount = perToken.filter((p) => p.regime === 'high_vol').length;
    // Volatilité extrême : au moins la moitié des tokens en high_vol, ou volatilité moyenne très élevée.
    if (highVolCount / perToken.length >= 0.5 || avgVolatility > 0.05) {
      return { regime: 'HIGH_VOL', avgVolatility, avgTrendStrength, perToken };
    }

    // Vote majoritaire bull / bear / range (low_vol assimilé à range).
    let bull = 0;
    let bear = 0;
    let range = 0;
    for (const p of perToken) {
      if (p.regime === 'bull') bull++;
      else if (p.regime === 'bear') bear++;
      else range++; // range, low_vol, autres
    }
    let regime: MarketRegime = 'RANGE';
    if (bull > bear && bull >= range) regime = 'BULL';
    else if (bear > bull && bear >= range) regime = 'BEAR';
    else regime = 'RANGE';

    return { regime, avgVolatility, avgTrendStrength, perToken };
  }

  // ─── Alertes ───

  private canAlert(category: string): boolean {
    const last = this.lastAlertAt[category] ?? 0;
    return Date.now() - last >= this.ALERT_COOLDOWN_MS;
  }

  private icon(level: string): string {
    return level === 'critical' ? '🚨' : level === 'warning' ? '⚠️' : 'ℹ️';
  }

  /** Journalise une alerte en base et (optionnellement) l'envoie sur Telegram. */
  async logAlert(
    level: 'info' | 'warning' | 'critical',
    category: string,
    message: string,
    payload: any = {},
    opts: { notify?: boolean; immediate?: boolean; respectCooldown?: boolean } = {},
  ): Promise<void> {
    const { notify = true, immediate = false, respectCooldown = true } = opts;
    try {
      await this.prisma.supervision_alert.create({
        data: { level, category, message, payload: JSON.stringify(payload ?? {}) },
      });
    } catch (e: any) {
      this.logger.warn(`[SUPERVISION] Persistance alerte échouée : ${e.message}`);
    }

    if (level === 'critical') this.logger.warn(`[SUPERVISION] ${category} : ${message}`);
    else this.logger.log(`[SUPERVISION] ${category} : ${message}`);

    if (!notify) return;
    if (respectCooldown && !this.canAlert(category)) return;
    this.lastAlertAt[category] = Date.now();

    const text = [`${this.icon(level)} <b>Supervision — ${category}</b>`, message].join('\n');
    await this.telegram.notifySupervision(text, immediate).catch(() => undefined);
  }

  // ─── Cycle de supervision (appelé par le pipeline en Phase 4) ───

  async tick(ctx?: PipelineErrorContext): Promise<any> {
    return this.runChecks(ctx);
  }

  async runChecks(ctx?: PipelineErrorContext): Promise<any> {
    const cfg = await this.getOrCreateConfig();

    // 1. Métriques
    const { drawdownPct, portfolioValue, ath } = await this.computeDrawdown();
    const consecutiveFailures = await this.consecutiveFailedTrades();
    const latency = await this.measureKuCoinLatency();
    const regimeInfo = await this.detectRegime();

    // 2. Taux d'erreur des modules (issu du contexte du pipeline)
    const executed = ctx?.modulesExecuted ?? [];
    const failed = ctx?.modulesFailed ?? [];
    const totalModules = executed.length + failed.length;
    const moduleErrorRate = totalModules > 0 ? failed.length / totalModules : 0;
    this.lastModuleErrorRate = moduleErrorRate;
    this.lastModulesFailed = failed;

    // 3. État de pause courant
    const wasPaused = await this.risk.isPaused();

    // 4. Évaluation des seuils d'auto-pause
    const pauseReasons: string[] = [];
    if (drawdownPct > cfg.drawdown_max_pct) {
      pauseReasons.push(`Drawdown ${drawdownPct.toFixed(2)}% > ${cfg.drawdown_max_pct}%`);
    }
    if (consecutiveFailures > cfg.max_consecutive_failures) {
      pauseReasons.push(`${consecutiveFailures} trades échoués consécutifs > ${cfg.max_consecutive_failures}`);
    }
    if (latency.ms > cfg.kucoin_latency_max_ms) {
      pauseReasons.push(`Latence KuCoin ${latency.ms}ms > ${cfg.kucoin_latency_max_ms}ms`);
    }
    if (moduleErrorRate > cfg.module_error_rate_max) {
      pauseReasons.push(
        `${failed.length}/${totalModules} modules en erreur (${(moduleErrorRate * 100).toFixed(0)}%) > ${(cfg.module_error_rate_max * 100).toFixed(0)}%`,
      );
    }

    let autoPauseTriggered = false;
    if (cfg.auto_pause_enabled && pauseReasons.length > 0 && !wasPaused) {
      const reason = `Auto-pause supervision : ${pauseReasons.join(' ; ')}`;
      const res = await this.risk.forcePause(reason).catch((e: any) => ({ paused: false, error: e.message }));
      autoPauseTriggered = !!(res as any).paused && !(res as any).alreadyPaused;
      if (autoPauseTriggered) {
        await this.logAlert(
          'critical',
          'auto_pause',
          `Trading mis en pause automatiquement.\n<b>Raison(s)</b> : ${pauseReasons.join(' ; ')}`,
          { pauseReasons, drawdownPct, consecutiveFailures, latencyMs: latency.ms, moduleErrorRate },
          { immediate: true, respectCooldown: false },
        );
      }
    }

    // 5. Alertes drawdown (warning / critique) même sans auto-pause
    if (drawdownPct > cfg.drawdown_max_pct) {
      await this.logAlert(
        'critical',
        'drawdown',
        `Drawdown critique : ${drawdownPct.toFixed(2)}% (portefeuille $${portfolioValue.toFixed(2)}, ATH $${ath.toFixed(2)})`,
        { drawdownPct, portfolioValue, ath },
      );
    } else if (drawdownPct > cfg.drawdown_warn_pct) {
      await this.logAlert(
        'warning',
        'drawdown',
        `Drawdown élevé : ${drawdownPct.toFixed(2)}% (seuil warning ${cfg.drawdown_warn_pct}%)`,
        { drawdownPct, portfolioValue, ath },
      );
    }

    // 6. Alertes latence / modules (warning, avec cooldown)
    if (latency.ms > cfg.kucoin_latency_max_ms) {
      await this.logAlert('warning', 'latency', `Latence KuCoin élevée : ${latency.ms}ms`, { latencyMs: latency.ms });
    }
    if (moduleErrorRate > cfg.module_error_rate_max) {
      await this.logAlert(
        'warning',
        'module_errors',
        `Taux d'erreur modules élevé : ${failed.length}/${totalModules} (${(moduleErrorRate * 100).toFixed(0)}%) — ${failed.join(', ')}`,
        { failed, totalModules, moduleErrorRate },
      );
    }

    // 7. Nouveaux trades échoués (erreur blockchain) survenus depuis le dernier passage
    await this.checkNewFailedTrades();

    // 8. Résumé quotidien de santé (minuit Paris)
    await this.maybeSendDailyHealth(cfg, { drawdownPct, portfolioValue, ath, regimeInfo, consecutiveFailures });

    // 9. Instantané exposé par GET /status
    const snapshot = {
      regime: regimeInfo.regime,
      regimeDetail: {
        avgVolatility: Number(regimeInfo.avgVolatility.toFixed(6)),
        avgTrendStrength: Number(regimeInfo.avgTrendStrength.toFixed(6)),
        perToken: regimeInfo.perToken,
      },
      drawdown: {
        pct: Number(drawdownPct.toFixed(2)),
        portfolioValue: Number(portfolioValue.toFixed(2)),
        ath: Number(ath.toFixed(2)),
        level: drawdownPct > cfg.drawdown_max_pct ? 'critical' : drawdownPct > cfg.drawdown_warn_pct ? 'warning' : 'ok',
      },
      consecutiveFailedTrades: consecutiveFailures,
      kucoinLatencyMs: latency.ms,
      kucoinOk: latency.ok,
      moduleErrorRate: Number(moduleErrorRate.toFixed(3)),
      modulesFailed: failed,
      autoPauseTriggered,
      checkedAt: new Date().toISOString(),
    };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  private async checkNewFailedTrades(): Promise<void> {
    const since = this.lastTradeCheck;
    this.lastTradeCheck = new Date();
    let newFailed: any[] = [];
    try {
      newFailed = await this.prisma.trade.findMany({
        where: { status: 'failed', executed_at: { gt: since } },
        orderBy: { executed_at: 'desc' },
        take: 5,
      });
    } catch {
      return;
    }
    for (const t of newFailed) {
      await this.logAlert(
        'warning',
        'trade_failure',
        `Trade échoué : ${t.source} ${t.source_token}→${t.target_token}` +
          (t.error_message ? `\n<code>${String(t.error_message).slice(0, 200)}</code>` : ''),
        { tradeId: t.id, source: t.source, error: t.error_message },
        { respectCooldown: false },
      );
    }
  }

  // ─── Résumé quotidien (minuit Paris) ───

  private parisParts(): { date: string; hour: number } {
    const fmt = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    const hour = parseInt(get('hour'), 10) || 0;
    return { date, hour };
  }

  private async maybeSendDailyHealth(cfg: any, m: any): Promise<void> {
    const { date, hour } = this.parisParts();
    if (hour !== 0) return; // uniquement autour de minuit Paris
    if (cfg.last_daily_health_date === date) return;

    // Claim atomique cross-instance : ne réussit que si la date n'est pas déjà celle du jour.
    const claim = await this.prisma.supervision_config.updateMany({
      where: { id: cfg.id, last_daily_health_date: { not: date } },
      data: { last_daily_health_date: date },
    });
    if (claim.count === 0) return;

    const alerts24h = await this.prisma.supervision_alert
      .count({ where: { created_at: { gt: new Date(Date.now() - 24 * 3600 * 1000) } } })
      .catch(() => 0);
    const paused = await this.risk.isPaused().catch(() => false);

    const lines = [
      '🩺 <b>Résumé quotidien de santé</b>',
      `📅 ${date} (00:00 Paris)`,
      `💰 Portefeuille : $${m.portfolioValue.toFixed(2)} (ATH $${m.ath.toFixed(2)})`,
      `📉 Drawdown : ${m.drawdownPct.toFixed(2)}%`,
      `📈 Régime de marché : <b>${m.regimeInfo.regime}</b>`,
      `🔁 Trades échoués consécutifs : ${m.consecutiveFailures}`,
      `🔔 Alertes (24 h) : ${alerts24h}`,
      `⏸️ Trading en pause : ${paused ? 'OUI' : 'non'}`,
    ];
    await this.logAlert('info', 'daily_health', lines.join('\n'), { date, ...m.regimeInfo }, {
      immediate: false,
      respectCooldown: false,
    });
  }

  // ─── Endpoints ───

  async getStatus(): Promise<any> {
    const cfg = await this.getOrCreateConfig();
    const paused = await this.risk.isPaused().catch(() => false);
    let pauseInfo: any = { globalPaused: paused };
    try {
      const rc = await this.prisma.risk_config.findFirst();
      pauseInfo = {
        globalPaused: rc?.global_paused ?? false,
        reason: rc?.paused_reason ?? '',
        pausedAt: rc?.paused_at ?? null,
        circuitBreakerActive: rc?.circuit_breaker_active ?? false,
      };
    } catch {
      /* ignore */
    }

    // Régime + drawdown recalculés à la volée (données fraîches), reste depuis le dernier cycle.
    const regimeInfo = await this.detectRegime();
    const dd = await this.computeDrawdown();
    const recentAlerts = await this.prisma.supervision_alert
      .findMany({ orderBy: { created_at: 'desc' }, take: 10 })
      .catch(() => []);

    return {
      regime: regimeInfo.regime,
      regimeDetail: {
        avgVolatility: Number(regimeInfo.avgVolatility.toFixed(6)),
        avgTrendStrength: Number(regimeInfo.avgTrendStrength.toFixed(6)),
        perToken: regimeInfo.perToken,
      },
      drawdown: {
        pct: Number(dd.drawdownPct.toFixed(2)),
        portfolioValue: Number(dd.portfolioValue.toFixed(2)),
        ath: Number(dd.ath.toFixed(2)),
        level:
          dd.drawdownPct > cfg.drawdown_max_pct ? 'critical' : dd.drawdownPct > cfg.drawdown_warn_pct ? 'warning' : 'ok',
      },
      autoPause: {
        enabled: cfg.auto_pause_enabled,
        ...pauseInfo,
      },
      lastCycle: {
        moduleErrorRate: this.lastModuleErrorRate,
        modulesFailed: this.lastModulesFailed,
        snapshot: this.lastSnapshot,
      },
      config: cfg,
      recentAlerts: recentAlerts.map((a: any) => ({
        id: a.id,
        level: a.level,
        category: a.category,
        message: a.message,
        createdAt: a.created_at,
      })),
      timestamp: new Date().toISOString(),
    };
  }

  async getAlerts(limit = 100): Promise<any> {
    const take = Math.max(1, Math.min(limit, 100));
    const alerts = await this.prisma.supervision_alert
      .findMany({ orderBy: { created_at: 'desc' }, take })
      .catch(() => []);
    return {
      count: alerts.length,
      alerts: alerts.map((a: any) => ({
        id: a.id,
        level: a.level,
        category: a.category,
        message: a.message,
        payload: (() => {
          try {
            return JSON.parse(a.payload);
          } catch {
            return {};
          }
        })(),
        createdAt: a.created_at,
      })),
    };
  }
}
