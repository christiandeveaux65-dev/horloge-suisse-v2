import { ethers } from 'ethers';
import { Logger } from '@nestjs/common';

/**
 * Provider JSON-RPC avec limitation de débit (rate limiting) et retry backoff
 * exponentiel pour éviter les erreurs 429 (too many requests) du RPC Arbitrum.
 *
 * - Sérialise TOUS les appels `send` via une chaîne de promesses.
 * - Respecte un espacement minimum entre deux départs d'appels (maxPerSec).
 * - Retente automatiquement (jusqu'à maxRetries) avec backoff exponentiel + jitter
 *   lorsque le RPC répond par une erreur de type rate-limit / 429.
 */
export class RateLimitedProvider extends ethers.JsonRpcProvider {
  private readonly rlLogger = new Logger('RateLimitedProvider');
  private readonly spacingMs: number;
  private readonly maxRetries: number;
  private chain: Promise<void> = Promise.resolve();
  private lastStart = 0;

  constructor(url: string, network?: ethers.Networkish, maxPerSec = 5, maxRetries = 5) {
    // staticNetwork évite des appels eth_chainId répétés ; batchMaxCount=1 désactive le batching.
    super(url, network, { staticNetwork: true, batchMaxCount: 1 });
    this.spacingMs = Math.ceil(1000 / Math.max(1, maxPerSec));
    this.maxRetries = maxRetries;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }

  /** Sérialise les appels et garantit un espacement minimum entre deux départs. */
  private gate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, this.lastStart + this.spacingMs - now);
      if (wait > 0) await this.sleep(wait);
      this.lastStart = Date.now();
      return fn();
    });
    // La chaîne ne doit jamais rester rejetée (sinon tous les appels suivants échouent).
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private isRateLimitError(err: any): boolean {
    const msg = String(err?.message || err?.error?.message || err || '').toLowerCase();
    const code = err?.code ?? err?.error?.code;
    return (
      msg.includes('rate limit') ||
      msg.includes('too many') ||
      msg.includes('429') ||
      msg.includes('exceeded') ||
      code === 429 ||
      code === -32005
    );
  }

  async send(method: string, params: Array<any>): Promise<any> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.gate(() => super.send(method, params));
      } catch (err: any) {
        if (this.isRateLimitError(err) && attempt < this.maxRetries) {
          const backoff = Math.min(8000, 250 * 2 ** attempt) + Math.floor(Math.random() * 250);
          this.rlLogger.warn(
            `429/rate-limit sur ${method} (tentative ${attempt + 1}/${this.maxRetries}) — backoff ${backoff}ms`,
          );
          await this.sleep(backoff);
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }
}
