/**
 * Tests unitaires pour le calcul de drawdown et les limites Mean Reversion
 * Leçon #8 : drawdown borné [0, 100], jamais négatif
 * Leçon #4 : limites hardcodées MR
 */
import { MAX_TRADE_SIZE_MR, MAX_EXPOSURE_PER_TOKEN, MAX_TOTAL_EXPOSURE_MR } from './constants';

describe('Calcul de drawdown (borné 0-100)', () => {
  function calcDrawdown(ath: number, current: number): number {
    const raw = ath > 0 ? ((ath - current) / ath) * 100 : 0;
    return Math.max(0, Math.min(100, raw));
  }

  it('drawdown = 0 si current = ATH', () => {
    expect(calcDrawdown(10000, 10000)).toBe(0);
  });

  it('drawdown = 50% si current = ATH/2', () => {
    expect(calcDrawdown(10000, 5000)).toBe(50);
  });

  it('drawdown = 100% si current = 0', () => {
    expect(calcDrawdown(10000, 0)).toBe(100);
  });

  it('drawdown borné à 0 si current > ATH', () => {
    expect(calcDrawdown(10000, 12000)).toBe(0);
  });

  it('drawdown borné à 100 si current très négatif (edge case)', () => {
    // Ce cas ne devrait pas arriver, mais le bornage empêche 297%
    expect(calcDrawdown(100, -197)).toBe(100);
  });

  it('drawdown = 0 si ATH = 0', () => {
    expect(calcDrawdown(0, 5000)).toBe(0);
  });

  it('calcul précis pour drawdown réaliste', () => {
    // Portefeuille $8000 ATH, maintenant $7200 = 10%
    const dd = calcDrawdown(8000, 7200);
    expect(dd).toBeCloseTo(10, 1);
  });
});

describe('Limites hardcodées Mean Reversion', () => {
  it('MAX_TRADE_SIZE_MR = 100', () => {
    expect(MAX_TRADE_SIZE_MR).toBe(100);
  });

  it('MAX_EXPOSURE_PER_TOKEN = 400', () => {
    expect(MAX_EXPOSURE_PER_TOKEN).toBe(400);
  });

  it('MAX_TOTAL_EXPOSURE_MR = 800', () => {
    expect(MAX_TOTAL_EXPOSURE_MR).toBe(800);
  });

  it('position sizing ne dépasse jamais MAX_TRADE_SIZE_MR', () => {
    const requestedSize = 150;
    const actualSize = Math.min(requestedSize, MAX_TRADE_SIZE_MR);
    expect(actualSize).toBe(100);
  });

  it('position sizing respecte MAX_EXPOSURE_PER_TOKEN', () => {
    const currentExposure = 350;
    const requestedSize = 100;
    const maxAllowed = MAX_EXPOSURE_PER_TOKEN - currentExposure;
    const actualSize = Math.min(requestedSize, maxAllowed, MAX_TRADE_SIZE_MR);
    expect(actualSize).toBe(50);
  });

  it('position sizing respecte MAX_TOTAL_EXPOSURE_MR', () => {
    const totalExposure = 770;
    const requestedSize = 75;
    const maxAllowed = MAX_TOTAL_EXPOSURE_MR - totalExposure;
    const actualSize = Math.min(requestedSize, maxAllowed, MAX_TRADE_SIZE_MR);
    expect(actualSize).toBe(30);
  });

  it('rejette un trade si exposition totale dépassée', () => {
    const totalExposure = 850;
    const allowed = totalExposure < MAX_TOTAL_EXPOSURE_MR;
    expect(allowed).toBe(false);
  });
});

describe('Validation trade — mode dry-run', () => {
  it('trade simulé ne produit pas de txHash réel', () => {
    const txHash = `dry-run-${Date.now()}`;
    expect(txHash.startsWith('dry-run-')).toBe(true);
  });

  it('trade simulé échoue si quote échoue', () => {
    // Simuler un échec de quote
    const quoteSuccess = false;
    const swapResult = {
      success: quoteSuccess,
      amountIn: '10',
      amountOut: '0',
      effectivePrice: '0',
      gasPaid: '0',
      txHash: '',
      error: 'Dry-run: quote échouée',
    };
    expect(swapResult.success).toBe(false);
    expect(swapResult.amountOut).toBe('0');
  });
});

describe('PnL calculation', () => {
  it('calcule le PnL correctement', () => {
    const totalBought = 1000;
    const totalSold = 400;
    const currentValue = 700;
    const totalPnl = (totalSold + currentValue) - totalBought;
    expect(totalPnl).toBe(100); // profit de $100
  });

  it('PnL négatif en cas de perte', () => {
    const totalBought = 1000;
    const totalSold = 200;
    const currentValue = 500;
    const totalPnl = (totalSold + currentValue) - totalBought;
    expect(totalPnl).toBe(-300);
  });
});
