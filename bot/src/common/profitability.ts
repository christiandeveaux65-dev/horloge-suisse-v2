/**
 * Filtre de rentabilité minimum partagé par les stratégies de trading.
 *
 * Problème adressé : sur DEX, chaque aller-retour (achat + vente) paie ~2 × (frais de
 * pool + slippage) plus le gas des deux swaps. Sur de petits tickets et de faibles
 * mouvements, le bot perd systématiquement (les frais dépassent le gain).
 *
 * Ce module estime le coût total d'un aller-retour (round-trip) et fournit un seuil
 * de mouvement minimum requis (coût + marge de profit) que le mouvement ATTENDU par la
 * stratégie doit dépasser pour autoriser une entrée.
 *
 * Le seuil de marge (`minProfitPct`) est AJUSTABLE via la table app_config :
 *   - clé spécifique : `profitability.<stratégie>.minProfitPct`  (ex: profitability.momentum.minProfitPct)
 *   - clé globale    : `profitability.minProfitPct`
 *   - sinon          : DEFAULT_MIN_PROFIT_PCT
 */

// Hypothèses de friction alignées sur le dry-run (SIM_* de blockchain.service.ts).
export const RT_POOL_FEE_PCT = 0.3; // frais de pool Uniswap par swap (%)
export const RT_SLIPPAGE_PCT = 0.1; // slippage estimé par swap (%)
export const RT_GAS_USD = 0.15; // coût de gas estimé par swap (USD)
export const DEFAULT_MIN_PROFIT_PCT = 1.0; // marge de profit nette minimum visée après frais (%)
// Marge de profit minimum PAR STRATÉGIE (repli si aucune surcharge app_config).
// Momentum : abaissée à 0.5 % (reco analyste — rendre la stratégie moins passive en
// marché calme) → seuil de déclenchement (breakeven) ramené de ~2.0 % à ~1.5 %.
export const STRATEGY_MIN_PROFIT_PCT_DEFAULTS: Record<string, number> = {
  momentum: 0.5,
};

export interface RoundTripEstimate {
  /** Coût total d'un aller-retour, en % du notionnel. */
  costPct: number;
  /** Coût total d'un aller-retour, en USD. */
  costUsd: number;
  /** Marge de profit minimum configurée (%). */
  minProfitPct: number;
  /** Mouvement favorable minimum requis = costPct + minProfitPct (%). */
  breakevenPct: number;
}

export interface ProfitabilityOpts {
  poolFeePct?: number;
  slippagePct?: number;
  gasUsd?: number;
}

/**
 * Estime le coût d'un aller-retour pour un notionnel donné.
 *  - jambe d'achat + jambe de vente : chacune paie (frais de pool + slippage)
 *  - gas facturé deux fois (achat + vente)
 */
export function estimateRoundTripCost(
  notionalUsd: number,
  minProfitPct: number,
  opts?: ProfitabilityOpts,
): RoundTripEstimate {
  const poolFee = opts?.poolFeePct ?? RT_POOL_FEE_PCT;
  const slip = opts?.slippagePct ?? RT_SLIPPAGE_PCT;
  const gas = opts?.gasUsd ?? RT_GAS_USD;
  const n = notionalUsd > 0 ? notionalUsd : 1;

  const feeSlipPct = 2 * (poolFee + slip); // deux swaps
  const gasPct = ((2 * gas) / n) * 100; // gas des deux swaps rapporté au notionnel
  const costPct = feeSlipPct + gasPct;
  const costUsd = (costPct / 100) * n;
  const margin = Number.isFinite(minProfitPct) && minProfitPct >= 0 ? minProfitPct : DEFAULT_MIN_PROFIT_PCT;

  return {
    costPct,
    costUsd,
    minProfitPct: margin,
    breakevenPct: costPct + margin,
  };
}

/**
 * Lit la marge de profit minimum ajustable depuis app_config (override par stratégie
 * puis clé globale), avec repli sur DEFAULT_MIN_PROFIT_PCT. Ne lève jamais.
 */
export async function getMinProfitPct(prisma: any, strategy: string): Promise<number> {
  try {
    const specificKey = `profitability.${strategy}.minProfitPct`;
    const globalKey = 'profitability.minProfitPct';
    const rows = await prisma.app_config.findMany({
      where: { key: { in: [specificKey, globalKey] } },
    });
    const map = new Map<string, string>(rows.map((r: any) => [r.key, r.value]));
    const raw = map.get(specificKey) ?? map.get(globalKey);
    if (raw !== undefined) {
      const v = parseFloat(raw);
      if (Number.isFinite(v) && v >= 0) return v;
    }
  } catch {
    /* app_config indisponible : repli sur le défaut */
  }
  // Repli : défaut spécifique à la stratégie (ex. momentum 0.5 %) sinon défaut global.
  return STRATEGY_MIN_PROFIT_PCT_DEFAULTS[strategy] ?? DEFAULT_MIN_PROFIT_PCT;
}

/**
 * Décision de rentabilité : le mouvement attendu couvre-t-il le coût + la marge ?
 * @param expectedMovePct  mouvement favorable attendu estimé par la stratégie (%)
 */
export function passesProfitability(
  expectedMovePct: number,
  est: RoundTripEstimate,
): boolean {
  return Number.isFinite(expectedMovePct) && expectedMovePct >= est.breakevenPct;
}
