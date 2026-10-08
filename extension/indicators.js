// indicators.js — SMA, RSI, Bollinger, EMA, MACD, ATR (F-03).

function sma(closes, period) {
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period = 14) {
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

function bollinger(closes, period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, middle: mean, lower: mean - mult * std };
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function computeMacdHist(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = ema12 - ema26;
  const signal = ema([macd], 9);
  return macd - signal;
}

export function atr(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Slope of SMA9 over the last `span` closes, in price units per bar.
// Positive = rising trend, negative = falling.
export function slopeSMA9(candles, span = 20) {
  const closes = candles.map((c) => c.c).slice(-span);
  if (closes.length < 2) return 0;
  const n = closes.length;
  const meanX = (n - 1) / 2;
  const meanY = closes.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (closes[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den ? num / den : 0;
}

// Last `count` closes as offsets from the latest close, 2 decimals.
// Lets the LLM "see" the shape of recent bars without burning tokens.
export function recentShape(candles, count = 5) {
  const closes = candles.map((c) => c.c).slice(-count);
  if (!closes.length) return "";
  const last = closes[closes.length - 1];
  return closes.map((c) => (c - last).toFixed(2)).join(" ");
}

// Volume per bar: prefer broker tick volume (c.v from the history API), else
// the live tick counter (c.ticks). Returns the latest bar's volume plus the
// 20-bar average, so the caller can gauge whether activity is above/below norm.
export function volumeStats(candles, period = 20) {
  const vol = candles.map((c) => (c.v || c.ticks || 0));
  const last = vol[vol.length - 1] || 0;
  const slice = vol.slice(-period);
  const avg = slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
  return { volume: last, volSma20: avg, volRatio: avg ? last / avg : 0 };
}

export function computeIndicators(candles) {
  const closes = candles.map((c) => c.c);
  const bb = bollinger(closes, 20, 2);
  const vol = volumeStats(candles, 20);
  return {
    price: closes[closes.length - 1],
    sma9: sma(closes, 9),
    sma21: sma(closes, 21),
    rsi14: rsi(closes, 14),
    bbUpper: bb.upper,
    bbLower: bb.lower,
    macdHist: computeMacdHist(closes),
    atr14: atr(candles, 14),
    slopeSMA9: slopeSMA9(candles, 20),
    recentShape: recentShape(candles, 5),
    volume: vol.volume,
    volSma20: vol.volSma20,
    volRatio: vol.volRatio
  };
}
