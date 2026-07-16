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

/**
 * Espaces de recherche par stratégie.
 * La clé spéciale `timeframe`, si présente, sélectionne le jeu de bougies
 * (sinon le timeframe de la requête est utilisé).
 */
export const SEARCH_SPACES: Record<StrategyName, Record<string, any[]>> = {
  dca: {
    amountPerBuy: [1, 2, 5, 10, 15, 20], // $ par cycle
    intervalHours: [1, 2, 4, 6, 8, 12], // fréquence d'achat
  },
  grid: {
    rangePct: [1, 2, 3, 5, 7, 10], // ±1 % à ±10 %
    levels: [5, 10, 15, 20, 30], // nombre de niveaux
    budgetUsd: [500, 1000, 2000], // budget par grille
  },
  mean_reversion: {
    rsiPeriod: [7, 14, 21],
    rsiOversold: [20, 25, 30, 35, 40],
    rsiOverbought: [60, 65, 70, 75, 80],
    tradeSizeUsd: [50, 100, 200], // montant par trade
  },
  momentum: {
    emaShort: [5, 10, 15, 20], // EMA rapide
    emaLong: [20, 30, 40, 50, 60], // EMA lente
    stopLossPct: [0, 5, 10], // stop-loss % (0 = désactivé)
    timeframe: ['1h', '4h'],
  },
};

/** Ratio in-sample (entraînement) vs out-of-sample (validation) pour le walk-forward. */
export const IN_SAMPLE_RATIO = 0.7;

/** Nombre d'itérations par défaut / maximum autorisé. */
export const DEFAULT_MAX_ITERATIONS = 200;
export const HARD_MAX_ITERATIONS = 1500;

/** Nombre de meilleures combinaisons remontées dans le résultat. */
export const TOP_N = 10;

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
