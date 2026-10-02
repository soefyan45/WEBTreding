// sr.js — support/resistance levels from swing clustering of the M15 candles.
// A swing high = bar higher than `pivot` neighbours on both sides (and inverse for
// swings low). Nearby swings are merged into one level; more touches = stronger.

import { atr } from "./indicators.js";

export function computeLevels(candles, { pivot = 3, tolerance = null, maxPerSide = 3 } = {}) {
  const n = candles.length;
  if (n < pivot * 2 + 1) return { supports: [], resistances: [], tolerance: 0 };

  // Default cluster width: half an ATR, so only genuinely close swings merge.
  const tol = tolerance ?? Math.max(atr(candles, 14) * 0.5, 0.3);

  const swingHighs = [];
  const swingLows = [];
  for (let i = pivot; i < n - pivot; i++) {
    const window = candles.slice(i - pivot, i + pivot + 1);
    const isHigh = window.every((c, k) => k === pivot || c.h < window[pivot].h);
    const isLow = window.every((c, k) => k === pivot || c.l > window[pivot].l);
    if (isHigh) swingHighs.push(window[pivot].h);
    if (isLow) swingLows.push(window[pivot].l);
  }

  const price = candles[n - 1].c;

  const cluster = (values) => {
    const groups = [];
    for (const v of [...values].sort((a, b) => a - b)) {
      const g = groups[groups.length - 1];
      if (g && v - g.max <= tol) {
        g.items.push(v);
        g.max = v;
      } else {
        groups.push({ items: [v], max: v });
      }
    }
    return groups
      .map((g) => ({
        price: Math.round((g.items.reduce((a, b) => a + b, 0) / g.items.length) * 1000) / 1000,
        touches: g.items.length
      }))
      .sort(
        (a, b) =>
          b.touches - a.touches || Math.abs(a.price - price) - Math.abs(b.price - price)
      );
  };

  return {
    supports: cluster(swingLows)
      .filter((l) => l.price < price)
      .slice(0, maxPerSide),
    resistances: cluster(swingHighs)
      .filter((l) => l.price > price)
      .slice(0, maxPerSide),
    tolerance: tol
  };
}
