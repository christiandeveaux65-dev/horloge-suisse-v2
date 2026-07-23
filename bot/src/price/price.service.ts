import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { TOKENS, TokenInfo } from '../constants';
import { PrismaService } from '../prisma/prisma.service';
import { CHAIN } from '../constants';

/**
 * PriceService — Source primaire KuCoin, fallback cache local.
 * Cache TTL 30 secondes.
 * ATTENTION : CoinGecko et Binance sont BLOQUÉS sur Abacus.
 */
@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);
  private cache = new Map<string, { price: number; ts: number }>();
  private readonly CACHE_TTL_MS = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Obtenir le prix USD d'un token.
   * Cascade : cache → KuCoin → dernier prix en DB
   */
  async getPrice(token: string): Promise<number> {
    let tokenUpper = token.toUpperCase();
    // ETH natif = WETH côté prix (même actif sous-jacent).
    if (tokenUpper === 'ETH') tokenUpper = 'WETH';

    // Stablecoins = 1 USD
    if (tokenUpper === 'USDC' || tokenUpper === 'USDT') return 1;

    // Vérifier le cache
    const cached = this.cache.get(tokenUpper);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL_MS) {
      return cached.price;
    }

    // KuCoin API
    try {
      const price = await this.fetchKuCoin(tokenUpper);
      if (price > 0) {
        this.cache.set(tokenUpper, { price, ts: Date.now() });
        // Enregistrer en historique (fire-and-forget)
        this.recordPrice(tokenUpper, price).catch(() => {});
        return price;
      }
    } catch (err: any) {
      this.logger.warn(`KuCoin échoué pour ${tokenUpper}: ${err.message}`);
    }

    // Fallback : dernier prix en base
    try {
      const last = await this.prisma.price_history.findFirst({
        where: { token: tokenUpper, chain: CHAIN },
        orderBy: { recorded_at: 'desc' },
      });
      if (last) {
        const price = parseFloat(last.price_usd);
        this.cache.set(tokenUpper, { price, ts: Date.now() });
        return price;
      }
    } catch (err: any) {
      this.logger.error(`Fallback DB échoué pour ${tokenUpper}: ${err.message}`);
    }

    throw new Error(`Impossible d'obtenir le prix pour ${tokenUpper}`);
  }

  /** Obtenir les prix de plusieurs tokens */
  async getPrices(tokens: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const token of tokens) {
      try {
        result[token.toUpperCase()] = await this.getPrice(token);
      } catch {
        this.logger.warn(`Prix indisponible pour ${token}`);
      }
    }
    return result;
  }

  /**
   * Obtenir la série de prix historiques pour les indicateurs.
   * On récupère les `count` prix les PLUS RÉCENTS (orderBy desc), puis on inverse
   * pour restituer l'ordre chronologique (ancien → récent) attendu par les indicateurs.
   * (Correctif : l'ancienne version prenait les `count` plus ANCIENS enregistrements.)
   */
  async getPriceSeries(token: string, count: number): Promise<number[]> {
    const records = await this.prisma.price_history.findMany({
      where: { token: token.toUpperCase(), chain: CHAIN },
      orderBy: { recorded_at: 'desc' },
      take: count,
      select: { price_usd: true },
    });
    return records
      .map((r: any) => parseFloat(r.price_usd))
      .filter((p: any) => p > 0)
      .reverse();
  }

  /** Enregistrer un prix en historique */
  async recordPrice(token: string, price: number): Promise<void> {
    await this.prisma.price_history.create({
      data: {
        chain: CHAIN,
        token: token.toUpperCase(),
        price_usd: price.toString(),
      },
    });
  }

  /** Enregistrer les prix de tous les tokens supportés */
  async recordAllPrices(): Promise<void> {
    const tokenSymbols = Object.keys(TOKENS).filter((t) => t !== 'USDC');
    for (const symbol of tokenSymbols) {
      try {
        await this.getPrice(symbol);
        // Purge périodique : borne l'historique à MAX_HISTORY_PER_TOKEN entrées/token.
        await this.purgeHistory(symbol).catch(() => {});
      } catch (err: any) {
        this.logger.warn(`Enregistrement prix échoué pour ${symbol}: ${err.message}`);
      }
    }
  }

  /**
   * Purge l'historique de prix d'un token en ne conservant que les `keep` plus récents.
   * Évite la croissance illimitée de price_history (perf des requêtes + volume DB).
   */
  private static readonly MAX_HISTORY_PER_TOKEN = 500;
  async purgeHistory(token: string, keep = PriceService.MAX_HISTORY_PER_TOKEN): Promise<void> {
    const tokenUpper = token.toUpperCase();
    // Le (keep+1)-ième enregistrement le plus récent marque la limite de conservation.
    const boundary = await this.prisma.price_history.findMany({
      where: { token: tokenUpper, chain: CHAIN },
      orderBy: { recorded_at: 'desc' },
      skip: keep,
      take: 1,
      select: { recorded_at: true },
    });
    if (boundary.length === 0) return; // moins de `keep` entrées : rien à purger
    const cutoff = boundary[0].recorded_at;
    await this.prisma.price_history.deleteMany({
      where: { token: tokenUpper, chain: CHAIN, recorded_at: { lte: cutoff } },
    });
  }

  private async fetchKuCoin(token: string): Promise<number> {
    const info: TokenInfo | undefined = TOKENS[token];
    if (!info) throw new Error(`Token ${token} non supporté`);

    const symbol = `${info.kuCoinSymbol}-USDT`;
    const url = `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${symbol}`;

    const resp = await axios.get(url, { timeout: 5000 });
    const price = parseFloat(resp.data?.data?.price);
    if (!price || !Number.isFinite(price)) {
      throw new Error(`Réponse KuCoin invalide pour ${symbol}`);
    }
    return price;
  }
}
