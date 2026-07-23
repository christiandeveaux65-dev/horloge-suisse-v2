import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * TelegramService — Notifications temps réel vers Telegram (anti-spam).
 *
 * Règles STRICTES (pour ne PAS spammer l'utilisateur) :
 *   • Trade réellement exécuté on-chain (status = completed)
 *   • Trade échoué (failed) — MAX 1 notification par stratégie par heure
 *   • Alerte risque CRITIQUE uniquement (circuit breaker, drawdown pause > 5 %,
 *     stop-loss portefeuille)
 *   • Résumé périodique toutes les 6 h
 *
 * JAMAIS de notification pour : simulations (dry-run), scans de cron, vérifications
 * de conditions, checks de prix, heartbeat/status, démarrage/arrêt du conteneur.
 *
 * Rate limiter GLOBAL : au plus 1 message par minute. Les événements qui arrivent
 * dans la même fenêtre d'une minute sont regroupés en UN seul message.
 *
 * Résilience : fire-and-forget, aucune méthode ne lève d'exception. Une panne
 * Telegram ne doit JAMAIS interrompre le trading.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly token = process.env.TELEGRAM_BOT_TOKEN || '';
  private readonly chatId = process.env.TELEGRAM_CHAT_ID || '';

  // ─── Rate limiter / regroupement ───
  private readonly minIntervalMs = 60_000; // 1 message / minute max
  private queue: string[] = [];
  private lastSentAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  // ─── Dedup des échecs (1 par stratégie par heure) ───
  private readonly failWindowMs = 60 * 60 * 1000;
  private lastFailNotifiedAt: Map<string, number> = new Map();

  // ─── Dedup des trades déjà notifiés (par tradeId, garde anti double-appel) ───
  private notifiedTradeIds: Set<string> = new Set();

  // Seuil de drawdown à partir duquel une alerte de drawdown est notifiée.
  private readonly drawdownAlertPct = 5;

  // Types d'événements risque CRITIQUES — seuls ceux-ci déclenchent une notif.
  private readonly criticalRiskKinds = new Set([
    'circuit_breaker',
    'drawdown_pause',
    'portfolio_stop_loss',
  ]);

  constructor(private readonly prisma: PrismaService) {}

  get enabled(): boolean {
    return !!(this.token && this.chatId);
  }

  // ═══ Primitive d'envoi (directe, jamais bloquante, jamais throw) ═══
  async sendMessage(text: string): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Telegram non configuré (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID manquants)');
      return;
    }
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text: text.slice(0, 4000),
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(`Telegram sendMessage HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    } catch (err: any) {
      this.logger.warn(`Telegram sendMessage échoué: ${err.message}`);
    }
  }

  // ═══ File d'attente avec rate limiter + regroupement ═══
  /** Met un message en file ; l'envoi respecte le plafond de 1 msg/minute. */
  private enqueue(msg: string): void {
    if (!this.enabled) return;
    this.queue.push(msg);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return; // un flush est déjà programmé
    const elapsed = Date.now() - this.lastSentAt;
    const wait = Math.max(0, this.minIntervalMs - elapsed);
    if (wait === 0) {
      this.flush();
    } else {
      this.flushTimer = setTimeout(() => this.flush(), wait);
      // Ne pas empêcher le process de se terminer à cause du timer.
      if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
    }
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    this.lastSentAt = Date.now();
    const text =
      batch.length === 1
        ? batch[0]
        : `📬 <b>${batch.length} notifications</b>\n\n` +
          batch.map((m) => `———\n${m}`).join('\n\n');
    void this.sendMessage(text);
  }

  // ─── Helpers ───
  private esc(s: string): string {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private nowParis(): string {
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone: 'Europe/Paris',
    }).format(new Date());
  }

  // ═══ Notifications métier ═══

  /**
   * Notification OBLIGATOIRE de toute opération DeFi (Aave supply/borrow/withdraw/repay).
   * Envoi direct (non regroupé) pour visibilité immédiate. Jamais bloquant, jamais throw.
   */
  notifyDefiOp(op: {
    protocol: string;            // 'Aave V3'
    action: string;              // 'supply' | 'borrow' | 'withdraw' | 'repay'
    tokenSymbol: string;
    amountToken: number | string;
    amountUsd?: number | null;
    success: boolean;
    simulated?: boolean;
    txHash?: string;
    error?: string;
  }): void {
    if (!this.enabled) return;
    const actionLabel: Record<string, string> = {
      supply: '⬆️ Dépôt (supply)',
      borrow: '💸 Emprunt (borrow)',
      withdraw: '⬇️ Retrait (withdraw)',
      repay: '✅ Remboursement (repay)',
    };
    const label = actionLabel[op.action] || op.action;
    const head = op.success ? (op.simulated ? '🧪 DeFi (simulé)' : '🏦 Opération DeFi') : '❌ Opération DeFi échouée';
    const lines = [
      `${head} — <b>${this.esc(op.protocol)}</b>`,
      `${label} : <b>${this.esc(String(op.amountToken))} ${this.esc(op.tokenSymbol)}</b>${op.amountUsd != null ? ` (~$${op.amountUsd.toFixed(2)})` : ''}`,
    ];
    if (op.success && op.txHash && !op.simulated) {
      lines.push(`🔗 <a href="https://arbiscan.io/tx/${this.esc(op.txHash)}">Arbiscan</a>`);
    }
    if (!op.success && op.error) {
      lines.push(`⚠️ ${this.esc(op.error).slice(0, 200)}`);
    }
    lines.push(`🕒 ${this.nowParis()}`);
    // Envoi direct immédiat (fire-and-forget) — les opérations DeFi sont rares.
    void this.sendMessage(lines.join('\n')).catch(() => undefined);
  }

  /**
   * Trade exécuté. Notifie UNIQUEMENT :
   *   • completed (réel on-chain)
   *   • failed — au plus 1 fois par stratégie par heure
   * IGNORE totalement : simulated (dry-run) et tout autre statut.
   */
  notifyTrade(t: {
    tradeId?: string;
    source: string;
    side: string;
    sourceToken: string;
    targetToken: string;
    amountIn: string;
    amountOut: string;
    status: string;
    txHash?: string;
    error?: string | null;
  }): void {
    if (!this.enabled) return;

    // Dedup par tradeId : garde anti double-appel pour un même trade (évite les
    // notifications en double si notifyTrade est appelé deux fois pour le même trade).
    if (t.tradeId) {
      if (this.notifiedTradeIds.has(t.tradeId)) return;
      this.notifiedTradeIds.add(t.tradeId);
      // Bornage mémoire : on garde les 2000 derniers IDs.
      if (this.notifiedTradeIds.size > 2000) {
        this.notifiedTradeIds = new Set(Array.from(this.notifiedTradeIds).slice(-1000));
      }
    }

    if (t.status === 'completed') {
      const lines = [
        `✅ <b>Trade exécuté</b>`,
        `📦 ${this.esc(t.source)} (${this.esc(t.side)})`,
        `🔁 ${this.esc(t.amountIn)} ${this.esc(t.sourceToken)} → ${this.esc(t.amountOut)} ${this.esc(t.targetToken)}`,
      ];
      if (t.txHash && !t.txHash.startsWith('dry-run')) {
        lines.push(`🔗 <a href="https://arbiscan.io/tx/${this.esc(t.txHash)}">Arbiscan</a>`);
      }
      lines.push(`🕒 ${this.nowParis()}`);
      this.enqueue(lines.join('\n'));
      return;
    }

    if (t.status === 'failed') {
      // Dedup : max 1 notif d'échec par stratégie par heure.
      const key = t.source || 'inconnu';
      const last = this.lastFailNotifiedAt.get(key) || 0;
      if (Date.now() - last < this.failWindowMs) return; // trop récent → on étale
      this.lastFailNotifiedAt.set(key, Date.now());
      const lines = [
        `❌ <b>Trade échoué</b> — ${this.esc(key)}`,
        `🔁 ${this.esc(t.amountIn)} ${this.esc(t.sourceToken)} → ${this.esc(t.targetToken)}`,
      ];
      if (t.error) lines.push(`⚠️ ${this.esc(t.error).slice(0, 200)}`);
      lines.push(`<i>(1 alerte max par stratégie et par heure)</i>`);
      lines.push(`🕒 ${this.nowParis()}`);
      this.enqueue(lines.join('\n'));
      return;
    }

    // simulated / partial / autre → AUCUNE notification.
  }

  /**
   * Notification de trade INDIVIDUELLE et IMMÉDIATE (awaitée, sans passer par la
   * file d'attente 1 msg/minute).
   *
   * Raison d'être : le rate-limiter de `notifyTrade` diffère les messages au-delà
   * du premier via un `setTimeout(...).unref()`. En production, le conteneur se
   * met en veille dès que la requête HTTP a répondu — le timer différé ne se
   * déclenche alors JAMAIS et les notifications 2..N sont perdues. C'est le cas
   * d'un cycle DCA qui exécute plusieurs jambes d'affilée (WETH, WBTC, ARB, LINK,
   * GMX) : seule la 1re jambe était notifiée.
   *
   * Cette méthode envoie chaque notification directement et est `await`-ée dans le
   * flux d'exécution (avant que la réponse HTTP ne soit renvoyée), ce qui garantit
   * que chaque achat obtient bien sa propre notification. Réservée aux flux à faible
   * fréquence (DCA) — les stratégies à forte fréquence continuent d'utiliser
   * `notifyTrade` (file d'attente + regroupement).
   */
  async notifyTradeNow(t: {
    tradeId?: string;
    source: string;
    side: string;
    sourceToken: string;
    targetToken: string;
    amountIn: string;
    amountOut: string;
    status: string;
    txHash?: string;
    error?: string | null;
  }): Promise<void> {
    if (!this.enabled) return;

    // Dedup par tradeId (partagé avec notifyTrade) : jamais deux notifs pour un
    // même trade, quel que soit le chemin d'appel.
    if (t.tradeId) {
      if (this.notifiedTradeIds.has(t.tradeId)) return;
      this.notifiedTradeIds.add(t.tradeId);
      if (this.notifiedTradeIds.size > 2000) {
        this.notifiedTradeIds = new Set(Array.from(this.notifiedTradeIds).slice(-1000));
      }
    }

    let lines: string[] | null = null;
    if (t.status === 'completed') {
      lines = [
        `✅ <b>Trade exécuté</b>`,
        `📦 ${this.esc(t.source)} (${this.esc(t.side)})`,
        `🔁 ${this.esc(t.amountIn)} ${this.esc(t.sourceToken)} → ${this.esc(t.amountOut)} ${this.esc(t.targetToken)}`,
      ];
      if (t.txHash && !t.txHash.startsWith('dry-run')) {
        lines.push(`🔗 <a href="https://arbiscan.io/tx/${this.esc(t.txHash)}">Arbiscan</a>`);
      }
      lines.push(`🕒 ${this.nowParis()}`);
    } else if (t.status === 'failed') {
      lines = [
        `❌ <b>Trade échoué</b> — ${this.esc(t.source || 'inconnu')}`,
        `🔁 ${this.esc(t.amountIn)} ${this.esc(t.sourceToken)} → ${this.esc(t.targetToken)}`,
      ];
      if (t.error) lines.push(`⚠️ ${this.esc(t.error).slice(0, 200)}`);
      lines.push(`🕒 ${this.nowParis()}`);
    }
    // simulated / partial / autre → AUCUNE notification.
    if (!lines) return;
    await this.sendMessage(lines.join('\n'));
  }

  /**
   * Alerte risque. Notifie UNIQUEMENT les événements CRITIQUES
   * (circuit breaker, pause drawdown > 5 %, stop-loss portefeuille).
   * Tout le reste (recovery_mode, trailing armed, scans…) est ignoré.
   */
  /** Notification de supervision proactive. immediate=true → envoi direct (alerte critique, sans file d'attente). */
  async notifySupervision(text: string, immediate = false): Promise<void> {
    if (!this.enabled) return;
    if (immediate) {
      await this.sendMessage(text);
    } else {
      this.enqueue(text);
    }
  }

  notifyRisk(kind: string, detail: string): void {
    if (!this.enabled) return;
    if (!this.criticalRiskKinds.has(kind)) return;

    // Pour un drawdown, n'alerter qu'au-delà du seuil configuré (> 5 %).
    if (kind === 'drawdown_pause') {
      const m = detail.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
      const dd = m ? parseFloat(m[1]) : 100;
      if (dd <= this.drawdownAlertPct) return;
    }

    const icon = kind === 'circuit_breaker' ? '🚨' : '⚠️';
    const lines = [
      `${icon} <b>Alerte risque critique</b> — <code>${this.esc(kind)}</code>`,
      this.esc(detail),
      `🕒 ${this.nowParis()}`,
    ];
    this.enqueue(lines.join('\n'));
  }

  // ═══ Résumé périodique (toutes les 6 h) — appelé séquentiellement par le PipelineOrchestrator ═══
  async tickSummary(): Promise<any> {
    try {
      return await this.sendSummary();
    } catch (err: any) {
      this.logger.error(`Résumé Telegram échoué: ${err.message}`);
      return { error: err.message };
    }
  }

  /**
   * Claim ATOMIQUE du bucket 6h courant pour éviter les résumés en double
   * (cron déclenché deux fois, ou deux instances). Retourne true si CE process
   * a gagné le droit d'envoyer le résumé pour ce bucket, false sinon.
   * S'appuie sur un UPDATE conditionnel (WHERE value != bucket) sérialisé par la base.
   */
  private async claimSummaryBucket(): Promise<boolean> {
    const KEY = 'telegram_summary_bucket';
    const bucket = String(Math.floor(Date.now() / (6 * 60 * 60 * 1000)));
    try {
      // Garantit l'existence de la ligne (no-op si déjà présente).
      await this.prisma.app_config.upsert({ where: { key: KEY }, create: { key: KEY, value: '' }, update: {} });
      const res = await this.prisma.app_config.updateMany({
        where: { key: KEY, value: { not: bucket } },
        data: { value: bucket },
      });
      return res.count > 0; // 1 = claim gagné ; 0 = déjà envoyé pour ce bucket
    } catch (err: any) {
      this.logger.warn(`claimSummaryBucket échoué (${err.message}) — envoi autorisé par défaut`);
      return true;
    }
  }

  /** Compose et envoie un résumé de l'activité des 6 dernières heures. */
  async sendSummary(): Promise<void> {
    if (!this.enabled) return;
    if (!(await this.claimSummaryBucket())) {
      this.logger.log('Résumé 6h déjà envoyé pour ce créneau — doublon ignoré.');
      return;
    }
    try {
      const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const trades = await this.prisma.trade.findMany({
        where: { executed_at: { gte: since } },
        select: { status: true, source: true, gas_paid: true },
      });
      const total = trades.length;
      const completed = trades.filter((t: any) => t.status === 'completed').length;
      const failed = trades.filter((t: any) => t.status === 'failed').length;
      const gas = trades.reduce((s: any, t: any) => s + (parseFloat(t.gas_paid) || 0), 0);

      const bySource: Record<string, number> = {};
      for (const t of trades) bySource[t.source] = (bySource[t.source] || 0) + 1;
      const sources =
        Object.entries(bySource)
          .sort((a, b) => b[1] - a[1])
          .map(([s, n]) => `  • ${this.esc(s)} : ${n}`)
          .join('\n') || '  • aucune';

      const portfolioValue = await this.getLatestPortfolioValue();

      const lines = [
        `📊 <b>Résumé 6 h — L'Horloge Suisse v2</b>`,
        portfolioValue !== null
          ? `💰 Portefeuille : <b>$${portfolioValue.toFixed(2)}</b>`
          : `💰 Portefeuille : n/d`,
        ``,
        `🔁 Trades : <b>${total}</b> (✅ ${completed} · ❌ ${failed})`,
        `⛽ Gas total : ${gas.toFixed(6)} ETH`,
        `📈 Par stratégie :`,
        sources,
        ``,
        `🕒 ${this.nowParis()} (Paris)`,
      ];
      // Le résumé passe aussi par le rate limiter (regroupé si besoin).
      this.enqueue(lines.join('\n'));
    } catch (err: any) {
      this.logger.warn(`sendSummary échoué: ${err.message}`);
    }
  }

  /** Somme la valeur du dernier snapshot connu par token. */
  private async getLatestPortfolioValue(): Promise<number | null> {
    try {
      const snaps = await this.prisma.portfolio_snapshot.findMany({
        orderBy: { snapshot_at: 'desc' },
        take: 100,
      });
      if (snaps.length === 0) return null;
      const seen = new Set<string>();
      let total = 0;
      for (const s of snaps) {
        const key = `${s.chain}:${s.token}`;
        if (seen.has(key)) continue;
        seen.add(key);
        total += parseFloat(s.value_usd) || 0;
      }
      return total;
    } catch {
      return null;
    }
  }
}
