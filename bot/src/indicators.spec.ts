import { rsi, sma, bollingerBands, realizedVolatility, computeSignal, clamp } from './indicators';

describe('Indicateurs techniques', () => {
  // ─── RSI ───
  describe('RSI', () => {
    it('retourne 50 si données insuffisantes', () => {
      expect(rsi([100, 101], 14)).toBe(50);
    });

    it('retourne 100 si aucune perte', () => {
      const prices = Array.from({ length: 16 }, (_, i) => 100 + i);
      expect(rsi(prices, 14)).toBe(100);
    });

    it('calcule correctement avec des hausses et baisses', () => {
      const prices = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84,
        46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00];
      const result = rsi(prices, 14);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(100);
    });
  });

  // ─── SMA ───
  describe('SMA', () => {
    it('retourne null si données insuffisantes', () => {
      expect(sma([1, 2], 5)).toBeNull();
    });

    it('calcule correctement la moyenne', () => {
      expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    });

    it('utilise les N derniers prix', () => {
      expect(sma([10, 1, 2, 3, 4, 5], 5)).toBe(3);
    });
  });

  // ─── Bollinger Bands ───
  describe('Bollinger Bands', () => {
    it('retourne null si données insuffisantes', () => {
      expect(bollingerBands([1, 2], 20, 2)).toBeNull();
    });

    it('calcule correctement les bandes', () => {
      const prices = Array.from({ length: 20 }, (_, i) => 100 + i);
      const result = bollingerBands(prices, 20, 2);
      expect(result).not.toBeNull();
      expect(result!.upper).toBeGreaterThan(result!.mid);
      expect(result!.lower).toBeLessThan(result!.mid);
    });

    it('mid est la moyenne', () => {
      const prices = [10, 10, 10, 10, 10];
      const result = bollingerBands(prices, 5, 2);
      expect(result!.mid).toBe(10);
      expect(result!.upper).toBe(10); // écart-type = 0
      expect(result!.lower).toBe(10);
    });
  });

  // ─── Volatilité ───
  describe('Volatilité réalisée', () => {
    it('retourne null si données insuffisantes', () => {
      expect(realizedVolatility([100], 5)).toBeNull();
    });

    it('retourne 0 si prix constants', () => {
      const prices = [100, 100, 100, 100, 100];
      expect(realizedVolatility(prices, 5)).toBe(0);
    });

    it('retourne une valeur positive pour des prix variables', () => {
      const prices = [100, 102, 99, 103, 101, 104];
      const vol = realizedVolatility(prices, 6);
      expect(vol).not.toBeNull();
      expect(vol!).toBeGreaterThan(0);
    });
  });

  // ─── Signal Momentum ───
  describe('computeSignal', () => {
    it('retourne hold avec données insuffisantes', () => {
      const result = computeSignal([100, 101, 102], {
        maShort: 10, maLong: 30, rsiPeriod: 14, rsiOversold: 35, rsiOverbought: 70,
      });
      expect(result.signal).toBe('hold');
    });

    it('retourne les bons champs', () => {
      const prices = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5);
      const result = computeSignal(prices, {
        maShort: 10, maLong: 30, rsiPeriod: 14, rsiOversold: 35, rsiOverbought: 70,
      });
      expect(result).toHaveProperty('signal');
      expect(result).toHaveProperty('smaShort');
      expect(result).toHaveProperty('smaLong');
      expect(result).toHaveProperty('rsi');
      expect(result).toHaveProperty('volatility');
      expect(result).toHaveProperty('latestPrice');
    });
  });

  // ─── Clamp ───
  describe('clamp', () => {
    it('borne correctement', () => {
      expect(clamp(50, 0, 100)).toBe(50);
      expect(clamp(-10, 0, 100)).toBe(0);
      expect(clamp(150, 0, 100)).toBe(100);
    });
  });
});
