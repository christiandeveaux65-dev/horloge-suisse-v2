/**
 * Pool de worker_threads pour paralléliser l'évaluation des backtests.
 *
 * Chaque worker reçoit une fois le contexte in-sample (workerData) puis évalue
 * des lots de combinaisons. run() découpe les combinaisons en `size` tranches,
 * en confie une par worker, et réassemble les scores dans l'ordre d'origine.
 *
 * En cas d'échec de spawn (worker introuvable en runtime, etc.) l'appelant doit
 * utiliser un fallback synchrone : le constructeur lève alors une exception.
 */
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import { SharedCtx } from './optimizer.eval';
import { LossFunction } from './optimizer.constants';

export function resolveWorkerPath(): string | null {
  // Compilé par tsc à côté de ce fichier (dist/src/backtest/optimizer.worker.js).
  const candidates = [
    path.join(__dirname, 'optimizer.worker.js'),
    path.join(__dirname, 'optimizer.worker.ts'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export class WorkerPool {
  private workers: Worker[] = [];
  readonly size: number;

  constructor(size: number, ctx: SharedCtx, lossFunction: LossFunction) {
    const workerPath = resolveWorkerPath();
    if (!workerPath) throw new Error('worker introuvable');
    const isTs = workerPath.endsWith('.ts');
    this.size = Math.max(1, size);
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(workerPath, {
        workerData: { ctx, lossFunction },
        // Support de l'exécution en dev (ts) via ts-node si nécessaire.
        execArgv: isTs ? ['-r', 'ts-node/register'] : undefined,
      });
      // Empêche un crash worker de tuer le process principal.
      w.on('error', () => {});
      this.workers.push(w);
    }
  }

  /** Évalue toutes les combinaisons et renvoie les scores alignés sur l'entrée. */
  async run(combos: Record<string, any>[]): Promise<(number | null)[]> {
    if (combos.length === 0) return [];
    const n = this.workers.length;
    const chunkSize = Math.ceil(combos.length / n);
    const jobs: Promise<(number | null)[]>[] = [];
    for (let i = 0; i < n; i++) {
      const start = i * chunkSize;
      const slice = combos.slice(start, start + chunkSize);
      jobs.push(slice.length ? this.evalOn(this.workers[i], slice) : Promise.resolve([]));
    }
    const parts = await Promise.all(jobs);
    const out: (number | null)[] = [];
    for (const p of parts) out.push(...p);
    return out;
  }

  private evalOn(worker: Worker, combos: Record<string, any>[]): Promise<(number | null)[]> {
    return new Promise((resolve, reject) => {
      const onMessage = (msg: { type: string; scores?: (number | null)[] }) => {
        if (msg.type === 'result') {
          cleanup();
          resolve(msg.scores ?? []);
        }
      };
      const onError = (err: Error) => { cleanup(); reject(err); };
      const cleanup = () => {
        worker.off('message', onMessage);
        worker.off('error', onError);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.postMessage({ type: 'eval', combos });
    });
  }

  async destroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate().catch(() => 0)));
    this.workers = [];
  }
}
