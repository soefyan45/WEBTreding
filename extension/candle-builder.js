// candle-builder.js — M15 candle aggregation persisted in chrome.storage.local (F-02).

const MAX_CANDLES = 250;
const BUCKET_MS = 15 * 60 * 1000;

export async function getCandles() {
  const { candles } = await chrome.storage.local.get("candles");
  return candles || [];
}

export async function saveCandles(candles) {
  await chrome.storage.local.set({ candles });
}

export function applyTick(candles, price, ts) {
  const bucketTs = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
  const last = candles[candles.length - 1];

  if (!last || last.time !== bucketTs) {
    candles.push({ time: bucketTs, o: price, h: price, l: price, c: price });
    if (candles.length > MAX_CANDLES) candles.shift();
  } else {
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    last.c = price;
  }
  return candles;
}

export async function recordTick(price, ts) {
  const candles = await getCandles();
  applyTick(candles, price, ts);
  await saveCandles(candles);
  return candles;
}
