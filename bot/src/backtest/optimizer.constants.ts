/**
 * Constantes de l'optimiseur de paramètres (style Freqtrade Hyperopt).
 *
 * Chaque stratégie définit un espace de recherche : param -> liste de valeurs à tester.
 * L'optimiseur teste soit toutes les combinaisons (grid search), soit un
 * échantillon aléatoire (random search) si l'espace est trop grand.
 */

export type StrategyName = 'dca' | 'grid' | 'mean_reversion' | 'momentum';

export type LossFunction =
  | 'SharpeOptimize'
  | 'SortinoOptimize'
  | 'ProfitMaximize'
  | 'MinDrawdown'
  | 'Balanced';

export const LOSS_FUNCTIONS: LossFunction[] = [
  'SharpeOptimize',
  'SortinoOptimize',
  'ProfitMaximize',
  'MinDrawdown',
  'Balanced',
];

/** Méthodes de recherche disponibles. */
export type SearchMethod = 'grid' | 'random' | 'bayesian';
export const SEARCH_METHODS: SearchMethod[] = ['grid', 'random', 'bayesian'];

/** Génère [min, min+step, ..., max] (bornes incluses, tolérance flottante). */
export function rangeStep(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const n = Math.round((max - min) / step);
  for (let i = 0; i <= n; i++) {
    out.push(Math.round((min + i * step) * 1e6) / 1e6);
  }
  return out;
}

/**
 * Espaces de recherche étendus par stratégie.
 * La clé spéciale `timeframe`, si présente, sélectionne le jeu de bougies
 * (sinon le timeframe de la requête est utilisé).
 *
 * Tailles brutes (avant contraintes de validité) :
 *  - dca            : 48 × 20 × 21              = 20 160
 *  - grid           : 28 × 28 × 50              = 39 200
 *  - mean_reversion : 26 × 26 × 31 × 20         = 419 120
 *  - momentum       : 26 × 71 × 16 × 10         = 295 360
 */
export const SEARCH_SPACES: Record<StrategyName, Record<string, any[]>> = {
  dca: {
    intervalHours: rangeStep(1, 48, 1), // fréquence d'achat (1 h à 48 h)
    amountPerBuy: rangeStep(5, 100, 5), // $ par cycle (5 à 100)
    buyThresholdPct: rangeStep(-20, 0, 1), // seuil d'achat sur repli (-20 % à 0 %)
  },
  grid: {
    rangePct: rangeStep(3, 30, 1), // largeur de grille ±3 % à ±30 %
    levels: rangeStep(3, 30, 1), // nombre de niveaux
    budgetUsd: rangeStep(100, 5000, 100), // budget par grille
  },
  mean_reversion: {
    rsiPeriod: rangeStep(5, 30, 1),
    rsiOversold: rangeStep(15, 40, 1),
    rsiOverbought: rangeStep(55, 85, 1),
    bbPeriod: rangeStep(10, 40, 2), // période des Bollinger Bands (aligné sur le live bb_period)
    bbStdDev: rangeStep(1.5, 3.0, 0.1), // écart-type BB (aligné sur le live bb_std_dev)
    tradeSizeUsd: rangeStep(25, 500, 25), // montant par trade
  },
  momentum: {
    emaShort: rangeStep(5, 30, 1), // EMA rapide
    emaLong: rangeStep(30, 100, 1), // EMA lente
    stopLossPct: rangeStep(0, 15, 1), // stop-loss % (0 = désactivé)
    trailingStopPct: rangeStep(1, 10, 1), // trailing stop %
  },
};

/** Ratio in-sample (entraînement) vs out-of-sample (validation) pour le walk-forward. */
export const IN_SAMPLE_RATIO = 0.7;

/** Nombre d'itérations par défaut / maximum autorisé. */
export const DEFAULT_MAX_ITERATIONS = 200;
export const HARD_MAX_ITERATIONS = 500000;

/** Nombre de meilleures combinaisons remontées dans le résultat. */
export const TOP_N = 10;

/**
 * Au-delà de ce nombre de combinaisons, on n'énumère PAS le produit cartésien
 * complet (risque OOM) : on échantillonne valeur par valeur (random / bayésien).
 */
export const ENUM_CAP = 60000;

/** Nombre de points conservés dans la courbe de convergence renvoyée. */
export const CONVERGENCE_POINTS = 200;

/** Budget wall-clock maximal d'une optimisation (ms) — au-delà : résultat partiel. */
export const MAX_WALL_MS = 240000;

/** Paramètres TPE (Tree-structured Parzen Estimator). */
export const TPE_GAMMA = 0.25; // fraction "bons" points
export const TPE_N_EI_CANDIDATES = 24; // candidats évalués par l'espérance d'amélioration
export const TPE_MIN_STARTUP = 20; // tirages aléatoires initiaux minimum
export const POOL_MAX_WORKERS = 8; // plafond de workers

/**
 * Contrainte de validité des combinaisons par stratégie.
 * Retourne false si la combinaison est incohérente (ex EMA rapide >= EMA lente).
 */
export function isValidCombo(strategy: StrategyName, combo: Record<string, any>): boolean {
  if (strategy === 'momentum') {
    if (Number(combo.emaShort) >= Number(combo.emaLong)) return false;
  }
  if (strategy === 'mean_reversion') {
    if (Number(combo.rsiOversold) >= Number(combo.rsiOverbought)) return false;
  }
  return true;
}
