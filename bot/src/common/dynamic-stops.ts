/**
 * Stops dynamiques basés sur l'ATR (Average True Range).
 *
 * Contexte : les stop-loss / take-profit en pourcentage FIXE ignorent la volatilité
 * réelle du marché. En période calme ils sont trop larges (pertes trop tardives), en
 * période agitée trop serrés (sorties prématurées). Ce module calcule des niveaux
 * proportionnels à l'ATR :
 *   - stop-loss   = entrée − (SL_MULT × ATR)
 *   - take-profit = entrée + (TP_MULT × ATR)
 * avec TP_MULT > SL_MULT pour couper les pertes tôt et laisser courir les gains.
 *
 * Les pourcentages effectifs sont bornés [minStopPct, maxStopPct] pour éviter les
 * niveaux absurdes lors de pics d'ATR ou de séries trop courtes.
 */
import { atr } from '../indicators';
import {
  ATR_PERIOD, ATR_SL_MULT, ATR_TP_MULT, ATR_MIN_STOP_PCT, ATR_MAX_STOP_PCT,
} from '../constants';

export interface AtrStops {
  atr: number;
  atrPct: number;
  stopLoss: number;
  takeProfit: number;
  stopPct: number;
  takePct: number;
}

export interface AtrStopsOpts {
  period?: number;
  slMult?: number;
  tpMult?: number;
  minStopPct?: number;
  maxStopPct?: number;
}

/**
 * Calcule des niveaux de stop-loss et take-profit dynamiques (position longue).
 * @param prices     série de prix de clôture
 * @param entryPrice prix d'entrée de la position
 * @returns niveaux calculés, ou null si l'ATR n'est pas calculable (données insuffisantes)
 */
export function computeAtrStops(
  prices: number[],
  entryPrice: number,
  opts?: AtrStopsOpts,
): AtrStops | null {
  const period = opts?.period ?? ATR_PERIOD;
  const slMult = opts?.slMult ?? ATR_SL_MULT;
  const tpMult = opts?.tpMult ?? ATR_TP_MULT;
  const minStopPct = opts?.minStopPct ?? ATR_MIN_STOP_PCT;
  const maxStopPct = opts?.maxStopPct ?? ATR_MAX_STOP_PCT;

  if (!(entryPrice > 0)) return null;
  const a = atr(prices, period);
  if (a === null || !(a > 0)) return null;

  const atrPctVal = (a / entryPrice) * 100;

  // Pourcentages bruts issus de l'ATR, bornés pour rester raisonnables.
  let stopPct = clampPct(slMult * atrPctVal, minStopPct, maxStopPct);
  // Le take-profit conserve le ratio reward:risk (tpMult/slMult) appliqué au stop borné.
  const ratio = slMult > 0 ? tpMult / slMult : 2;
  let takePct = stopPct * ratio;

  const stopLoss = entryPrice * (1 - stopPct / 100);
  const takeProfit = entryPrice * (1 + takePct / 100);

  return {
    atr: a,
    atrPct: Number(atrPctVal.toFixed(4)),
    stopLoss,
    takeProfit,
    stopPct: Number(stopPct.toFixed(4)),
    takePct: Number(takePct.toFixed(4)),
  };
}

function clampPct(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
