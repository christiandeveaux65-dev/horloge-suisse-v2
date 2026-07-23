import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OhlcvService } from './ohlcv.service';
import { simulate, buyHoldFinal, SimConfig } from './strategies';
import { computeMetrics } from './metrics';
import { Candle } from './backtest.types';
import {
  DEFAULT_FEES_PCT, DEFAULT_SLIPPAGE_PCT, SUPPORTED_TOKENS, KUCOIN_TYPE,
} from './backtest.constants';
import { RunBacktestDto } from './dto/backtest.dto';

/** Tokens par défaut selon la stratégie (miroir du bot réel). */
const DEFAULT_STRATEGY_TOKENS: Record<string, string[]> = {
  dca: ['WETH', 'WBTC', 'ARB'],
  grid: ['WETH'],
  mean_reversion: ['ARB', 'PENDLE', 'GMX'],
  momentum: ['WETH', 'WBTC', 'ARB', 'LINK'],
};

@Injectable()
export class BacktestEngineService {
  private readonly logger = new Logger(BacktestEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ohlcv: OhlcvService,
  ) {}

  async run(dto: RunBacktestDto): Promise<any> {
    const strategy = dto.strategy;
    if (!['dca', 'grid', 'mean_reversion', 'momentum'].includes(strategy)) {
      throw new BadRequestException(`Stratégie inconnue : ${strategy}`);
    }
    const timeframe = dto.timeframe && KUCOIN_TYPE[dto.timeframe] ? dto.timeframe : '1h';
    const tokens = (dto.tokens && dto.tokens.length
      ? dto.tokens
      : DEFAULT_STRATEGY_TOKENS[strategy]
    ).map((t) => t.toUpperCase()).filter((t) => SUPPORTED_TOKENS.includes(t));
    if (tokens.length === 0) throw new BadRequestException('Aucun token valide pour ce backtest.');

    const initialCapital = dto.initialCapital && dto.initialCapital > 0 ? dto.initialCapital : 10000;
    const feePct = dto.feesPct ?? DEFAULT_FEES_PCT;
    const slipPct = dto.slippagePct ?? DEFAULT_SLIPPAGE_PCT;
    const startMs = dto.startDate ? Date.parse(dto.startDate) : undefined;
    const endMs = dto.endDate ? Date.parse(dto.endDate) : undefined;

    // Chargement des bougies.
    const candlesByToken = new Map<string, Candle[]>();
    let totalCandles = 0;
    for (const token of tokens) {
      const candles = await this.ohlcv.getCandles(token, timeframe, startMs, endMs);
      if (candles.length > 0) {
        candlesByToken.set(token, candles);
        totalCandles += candles.length;
      }
    }
    if (totalCandles === 0) {
      throw new BadRequestException(
        `Aucune donnée OHLCV en base pour ${tokens.join(', ')} en ${timeframe}. `
        + 'Lancez d\'abord POST /api/backtest/fetch-data.',
      );
    }

    const cfg: SimConfig = {
      strategy, tokens: Array.from(candlesByToken.keys()),
      initialCapital, feePct, slipPct, params: dto.params ?? {},
    };

    const t0 = Date.now();
    const { trades, equityCurve } = simulate(candlesByToken, cfg);
    const bhFinal = buyHoldFinal(candlesByToken, initialCapital);
    const metrics = computeMetrics({ curve: equityCurve, trades, initialCapital, timeframe, buyHoldFinal: bhFinal });
    this.logger.log(
      `Backtest ${strategy}/${timeframe} : ${trades.length} trades, `
      + `rendement ${metrics.totalReturnPct.toFixed(2)}%, en ${Date.now() - t0}ms`,
    );

    const startDate = new Date(equityCurve[0]?.t ?? Date.now());
    const endDate = new Date(equityCurve[equityCurve.length - 1]?.t ?? Date.now());

    // Échantillonnage de la courbe d'équité pour limiter la taille stockée (~500 points).
    const sampled = this.sampleCurve(equityCurve, 500);

    const pf = this.safeNum(metrics.profitFactor);
    const saved = await this.prisma.backtest.create({
      data: {
        strategy_type: strategy,
        chain: 'arbitrum',
        tokens: JSON.stringify(cfg.tokens),
        params: JSON.stringify({ ...cfg.params, feePct, slipPct, timeframe }),
        start_date: startDate,
        end_date: endDate,
        initial_capital: String(initialCapital),
        final_equity: metrics.finalEquity.toFixed(2),
        total_return_pct: metrics.totalReturnPct.toFixed(4),
        annualized_pct: metrics.annualizedPct.toFixed(4),
        max_drawdown_pct: metrics.maxDrawdownPct.toFixed(4),
        sharpe_ratio: metrics.sharpeRatio.toFixed(4),
        win_rate_pct: metrics.winRatePct.toFixed(2),
        trades_count: metrics.tradesCount,
        buy_hold_pct: metrics.buyHoldPct.toFixed(4),
        equity_curve: JSON.stringify(sampled),
        trades: JSON.stringify(trades.slice(0, 2000)),
        timeframe,
        sortino_ratio: metrics.sortinoRatio.toFixed(4),
        calmar_ratio: metrics.calmarRatio.toFixed(4),
        profit_factor: String(pf),
        max_dd_duration: metrics.maxDrawdownDurationDays.toFixed(2),
        fees_pct: String(feePct),
        slippage_pct: String(slipPct),
        notes: `${cfg.tokens.join(',')} | ${timeframe} | fees ${feePct}% slip ${slipPct}%`,
      },
    });

    return this.format(saved);
  }

  async getResult(id: string): Promise<any> {
    const row = await this.prisma.backtest.findUnique({ where: { id } });
    if (!row) throw new BadRequestException('Backtest introuvable');
    return this.format(row, true);
  }

  async history(limit = 50): Promise<any> {
    const rows = await this.prisma.backtest.findMany({
      orderBy: { created_at: 'desc' },
      take: Math.min(200, Math.max(1, limit)),
    });
    return { count: rows.length, runs: rows.map((r: any) => this.format(r, false)) };
  }

  // ── helpers ──
  private safeNum(v: number): number {
    if (!Number.isFinite(v)) return 999.9999; // profit factor infini (aucune perte)
    return Math.round(v * 10000) / 10000;
  }

  private sampleCurve(curve: { t: number; equity: number }[], maxPoints: number) {
    if (curve.length <= maxPoints) return curve.map((p) => ({ t: p.t, equity: Math.round(p.equity * 100) / 100 }));
    const stepN = Math.ceil(curve.length / maxPoints);
    const out: { t: number; equity: number }[] = [];
    for (let i = 0; i < curve.length; i += stepN) {
      out.push({ t: curve[i].t, equity: Math.round(curve[i].equity * 100) / 100 });
    }
    // Toujours inclure le dernier point.
    const last = curve[curve.length - 1];
    if (out.length === 0 || out[out.length - 1].t !== last.t) {
      out.push({ t: last.t, equity: Math.round(last.equity * 100) / 100 });
    }
    return out;
  }

  private format(r: any, includeHeavy = false): any {
    const base = {
      id: r.id,
      strategy: r.strategy_type,
      timeframe: r.timeframe,
      tokens: this.parseJson(r.tokens, []),
      params: this.parseJson(r.params, {}),
      period: { start: r.start_date, end: r.end_date },
      initialCapital: parseFloat(r.initial_capital),
      frictions: { feesPct: parseFloat(r.fees_pct ?? '0'), slippagePct: parseFloat(r.slippage_pct ?? '0') },
      metrics: {
        finalEquity: parseFloat(r.final_equity),
        totalReturnPct: parseFloat(r.total_return_pct),
        annualizedPct: parseFloat(r.annualized_pct),
        sharpeRatio: parseFloat(r.sharpe_ratio),
        sortinoRatio: parseFloat(r.sortino_ratio ?? '0'),
        calmarRatio: parseFloat(r.calmar_ratio ?? '0'),
        maxDrawdownPct: parseFloat(r.max_drawdown_pct),
        maxDrawdownDurationDays: parseFloat(r.max_dd_duration ?? '0'),
        winRatePct: parseFloat(r.win_rate_pct),
        profitFactor: parseFloat(r.profit_factor ?? '0'),
        tradesCount: r.trades_count,
        buyHoldPct: parseFloat(r.buy_hold_pct),
      },
      createdAt: r.created_at,
    };
    if (includeHeavy) {
      return {
        ...base,
        equityCurve: this.parseJson(r.equity_curve, []),
        trades: this.parseJson(r.trades, []),
      };
    }
    return base;
  }

  private parseJson(s: string, fallback: any): any {
    try { return JSON.parse(s); } catch { return fallback; }
  }
}
