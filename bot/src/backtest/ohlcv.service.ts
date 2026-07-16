import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { Candle } from './backtest.types';
import {
  BACKTEST_TOKENS,
  KUCOIN_TYPE,
  TIMEFRAME_MS,
  KUCOIN_MAX_CANDLES,
  SUPPORTED_TOKENS,
  SUPPORTED_TIMEFRAMES,
} from './backtest.constants';

/**
 * Récupération + stockage des bougies OHLCV historiques (KuCoin).
 * Table Postgres : ohlcv_candles.
 */
@Injectable()
export class OhlcvService {
  private readonly logger = new Logger(OhlcvService.name);
  private readonly KUCOIN_BASE = 'https://api.kucoin.com';

  constructor(private readonly prisma: PrismaService) {}

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Télécharge et stocke les bougies pour les tokens & timeframes demandés.
   * @returns résumé par (token, timeframe).
   */
  async fetchAndStore(params: {
    tokens?: string[];
    timeframes?: string[];
    months?: number;
  }): Promise<any> {
    const tokens = (params.tokens && params.tokens.length ? params.tokens : SUPPORTED_TOKENS)
      .map((t) => t.toUpperCase())
      .filter((t) => BACKTEST_TOKENS[t]);
    const timeframes = (params.timeframes && params.timeframes.length
      ? params.timeframes
      : [...SUPPORTED_TIMEFRAMES]
    ).filter((tf) => KUCOIN_TYPE[tf]);
    const months = Math.max(1, params.months ?? 12);

    const now = Date.now();
    const startMs = now - months * 30 * 24 * 60 * 60 * 1000;
    const summary: any[] = [];

    for (const token of tokens) {
      for (const tf of timeframes) {
        try {
          const stored = await this.downloadRange(token, tf, startMs, now);
          summary.push({ token, timeframe: tf, candles: stored });
          this.logger.log(`OHLCV ${token} ${tf} : ${stored} bougies stockées`);
        } catch (err: any) {
          this.logger.error(`OHLCV ${token} ${tf} échec : ${err.message}`);
          summary.push({ token, timeframe: tf, candles: 0, error: err.message });
        }
      }
    }
    return { months, tokens, timeframes, summary };
  }

  /** Pagine l'API KuCoin (max ~1500 bougies/requête) et upsert en base. */
  private async downloadRange(
    token: string,
    tf: string,
    startMs: number,
    endMs: number,
  ): Promise<number> {
    const kuSymbol = `${BACKTEST_TOKENS[token]}-USDT`;
    const type = KUCOIN_TYPE[tf];
    const stepMs = TIMEFRAME_MS[tf];
    const windowMs = stepMs * KUCOIN_MAX_CANDLES;
    let cursorEnd = endMs;
    let total = 0;

    while (cursorEnd > startMs) {
      const cursorStart = Math.max(startMs, cursorEnd - windowMs);
      const url = `${this.KUCOIN_BASE}/api/v1/market/candles`;
      const resp = await axios.get(url, {
        params: {
          type,
          symbol: kuSymbol,
          startAt: Math.floor(cursorStart / 1000),
          endAt: Math.floor(cursorEnd / 1000),
        },
        timeout: 15000,
      });
      const data: string[][] = resp.data?.data ?? [];
      if (!Array.isArray(data) || data.length === 0) {
        cursorEnd = cursorStart - stepMs;
        continue;
      }

      // KuCoin : [time(sec), open, close, high, low, volume, turnover], ordre décroissant.
      const rows = data.map((c) => ({
        token,
        timeframe: tf,
        open_time: new Date(parseInt(c[0], 10) * 1000),
        open: c[1],
        close: c[2],
        high: c[3],
        low: c[4],
        volume: c[5] ?? '0',
      }));

      // Insertion en masse, on ignore les doublons (contrainte unique).
      const res = await this.prisma.ohlcv_candles.createMany({
        data: rows,
        skipDuplicates: true,
      });
      total += res.count;

      // Bougie la plus ancienne de ce lot -> curseur suivant.
      const oldest = Math.min(...data.map((c) => parseInt(c[0], 10) * 1000));
      cursorEnd = oldest - stepMs;

      await this.sleep(250); // respect du rate-limit KuCoin
    }
    return total;
  }

  /** Lit les bougies stockées (ordre chronologique croissant). */
  async getCandles(
    token: string,
    tf: string,
    startMs?: number,
    endMs?: number,
  ): Promise<Candle[]> {
    const where: any = { token: token.toUpperCase(), timeframe: tf };
    if (startMs || endMs) {
      where.open_time = {};
      if (startMs) where.open_time.gte = new Date(startMs);
      if (endMs) where.open_time.lte = new Date(endMs);
    }
    const rows = await this.prisma.ohlcv_candles.findMany({
      where,
      orderBy: { open_time: 'asc' },
    });
    return rows.map((r) => ({
      t: r.open_time.getTime(),
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume),
    }));
  }

  /** Statistiques de couverture des données en base. */
  async coverage(): Promise<any> {
    const grouped = await this.prisma.ohlcv_candles.groupBy({
      by: ['token', 'timeframe'],
      _count: { _all: true },
      _min: { open_time: true },
      _max: { open_time: true },
    });
    return grouped.map((g) => ({
      token: g.token,
      timeframe: g.timeframe,
      candles: g._count._all,
      from: g._min.open_time,
      to: g._max.open_time,
    }));
  }
}
