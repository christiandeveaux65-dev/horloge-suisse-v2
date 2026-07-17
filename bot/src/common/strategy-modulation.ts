import { PrismaService } from '../prisma/prisma.service';

/**
 * Pilotage adaptatif des stratégies d'exécution.
 *
 * Cette couche relie les DEUX cerveaux d'analyse aux moteurs d'exécution :
 *   1. Le Strategist (strategist.service.ts) écrit des facteurs de taille bornés
 *      dans app_config sous les clés `strategist.<strat>SizeFactor`.
 *   2. Le Strategy Evaluator (strategy-evaluator.service.ts) écrit une directive
 *      par stratégie dans la table `strategy_directive` :
 *        - recommended_active     : faut-il ouvrir de NOUVELLES positions ?
 *        - recommended_allocation_pct : part cible du capital (0-100).
 *
 * Avant cette couche, ces sorties n'étaient lues par AUCUN module → le pilotage
 * était « débranché ». getStrategyModulation() renvoie un verdict unifié consommé
 * par DCA / momentum / mean-reversion / grid / arbitrage.
 */

export type StrategyKey = 'dca' | 'momentum' | 'mean_reversion' | 'grid' | 'arbitrage';

/** Clé app_config du facteur de taille écrit par le Strategist (DCA n'en a pas). */
const STRATEGIST_FACTOR_KEY: Partial<Record<StrategyKey, string>> = {
  momentum: 'strategist.momentumSizeFactor',
  mean_reversion: 'strategist.meanReversionSizeFactor',
  grid: 'strategist.gridSizeFactor',
  arbitrage: 'strategist.arbitrageSizeFactor',
};

/** Nombre de stratégies évaluées → poids d'allocation « neutre » (équi-réparti). */
const EQUAL_WEIGHT = 1 / 5; // 20 %

export interface StrategyModulation {
  /** false → ne PAS ouvrir de nouvelle position (gestion des positions ouvertes conservée). */
  active: boolean;
  /** Multiplicateur de taille combiné (Strategist × allocation), borné [0.3, 2.0]. */
  sizeFactor: number;
  /** Part d'allocation recommandée (0-100) ou null si aucune directive. */
  allocationPct: number | null;
  /** Trace lisible des composantes appliquées (pour les logs). */
  reason: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Calcule la modulation adaptative d'une stratégie en combinant :
 *   - le facteur de taille du Strategist (app_config) ;
 *   - la directive du Strategy Evaluator (strategy_directive).
 *
 * Ne LÈVE JAMAIS : en cas d'erreur DB ou d'absence de données, renvoie un verdict
 * neutre (active=true, sizeFactor=1) pour ne jamais bloquer l'exécution par défaut.
 */
export async function getStrategyModulation(
  prisma: PrismaService,
  strategy: StrategyKey,
): Promise<StrategyModulation> {
  let sizeFactor = 1;
  let active = true;
  let allocationPct: number | null = null;
  const parts: string[] = [];

  // 1. Facteur de taille du Strategist (app_config).
  const key = STRATEGIST_FACTOR_KEY[strategy];
  if (key) {
    try {
      const row = await (prisma as any).app_config.findUnique({ where: { key } });
      const f = row ? parseFloat(row.value) : NaN;
      if (Number.isFinite(f) && f > 0) {
        sizeFactor *= f;
        parts.push(`strategist ×${f.toFixed(2)}`);
      }
    } catch {
      /* neutre en cas d'erreur */
    }
  }

  // 2. Directive du Strategy Evaluator (strategy_directive).
  try {
    const dir = await (prisma as any).strategy_directive.findUnique({ where: { strategy } });
    if (dir) {
      if (dir.recommended_active === false) {
        active = false;
        parts.push('directive: inactive');
      }
      const pct = Number(dir.recommended_allocation_pct);
      if (Number.isFinite(pct) && pct > 0) {
        allocationPct = pct;
        // Multiplicateur relatif au poids neutre (20 %), borné [0.5, 1.5] pour
        // éviter des variations de taille trop brutales.
        const allocMult = clamp(pct / 100 / EQUAL_WEIGHT, 0.5, 1.5);
        sizeFactor *= allocMult;
        parts.push(`alloc ${pct.toFixed(0)}% ×${allocMult.toFixed(2)}`);
      }
    }
  } catch {
    /* neutre en cas d'erreur */
  }

  // Borne de sécurité globale sur le facteur combiné.
  sizeFactor = Math.round(clamp(sizeFactor, 0.3, 2.0) * 100) / 100;

  return {
    active,
    sizeFactor,
    allocationPct,
    reason: parts.length ? parts.join(', ') : 'neutre',
  };
}
