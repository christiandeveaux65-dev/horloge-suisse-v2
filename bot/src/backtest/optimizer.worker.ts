/**
 * Worker de backtesting (worker_threads).
 *
 * Reçoit un contexte partagé (bougies in-sample) via workerData puis, sur chaque
 * message { type: 'eval', combos }, évalue les combinaisons et renvoie UNIQUEMENT
 * les scores (number|null) pour minimiser la taille des messages inter-threads.
 */
import { parentPort, workerData } from 'worker_threads';
import { evaluateComboCore, objective, SharedCtx } from './optimizer.eval';
import { LossFunction } from './optimizer.constants';

const ctx: SharedCtx = workerData.ctx;
const lossFunction: LossFunction = workerData.lossFunction;

parentPort?.on('message', (msg: { type: string; combos?: Record<string, any>[] }) => {
  if (msg.type === 'eval' && Array.isArray(msg.combos)) {
    const scores: (number | null)[] = msg.combos.map((combo) => {
      try {
        const m = evaluateComboCore(ctx, combo);
        return m ? objective(lossFunction, m) : null;
      } catch {
        return null;
      }
    });
    parentPort?.postMessage({ type: 'result', scores });
  }
});
