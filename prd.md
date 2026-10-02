# 📋 PRD — AI Trading Signal Extension

**Versi:** 1.0
**Tanggal:** 1 Oktober 2026
**Status:** Final Draft — Siap Implementasi
**Platform:** Chrome/Brave/Edge (Chromium-based), Linux native
**Target Broker:** Exness WebTerminal

---

## DAFTAR ISI

1. Executive Summary
2. Konteks & Keputusan dari Percakapan
3. Scope & Fitur
4. Arsitektur Teknis
5. Spesifikasi Fitur Detail
6. Risiko & Mitigasi
7. Timeline
8. Approval
- Appendix A: Kode Lengkap
- Appendix B: Prompt LLM Templates
- Appendix C: Selector DOM Exness
- Appendix D: Riwayat Percakapan Ringkas

---

## 1. EXECUTIVE SUMMARY

### 1.1 Latar Belakang
Trader retail di Exness WebTerminal tidak punya akses ke EA (Expert Advisor) atau analisa otomatis. Semua keputusan trading dilakukan manual dan rentan emosi. Sementara itu, LLM modern sudah mampu menganalisa data terstruktur dengan kualitas analis manusia — tetapi belum ada jembatan ke WebTerminal Exness yang aman dan native di Linux.

### 1.2 Solusi
Membangun ekstensi browser Chromium yang:
- Membaca harga & posisi dari DOM WebTerminal
- Membangun candle M15 dari sampling harga
- Menghitung indikator teknikal secara mandiri
- Mengirim konteks ke LLM via OpenRouter (user sudah punya)
- Menampilkan sinyal di overlay chart
- Mengeksekusi order via API internal Exness dengan token fresh dari session browser

### 1.3 Prinsip Desain

| Prinsip | Implementasi |
|---|---|
| Linux native | Tidak butuh Windows, Wine, VM |
| Zero cost | OpenRouter + kalender gratis |
| Zero install | Cukup load unpacked di Chrome |
| Transparan | User lihat nilai indikator + alasan LLM |
| Aman | Token dibaca fresh dari localStorage, tidak disimpan |
| Manual confirm | Tidak auto-execute tanpa konfirmasi |
| Demo first | Dirancang untuk uji di akun demo dulu |

---

## 2. KONTEKS & KEPUTUSAN DARI PERCAKAPAN

### 2.1 Perjalanan Keputusan

| Tahap | Keputusan | Kesimpulan |
|---|---|---|
| Awal | Forex vs Crypto? | Forex (Exness) lebih terstruktur |
| Modal | Rp500.000, target 50k/hari | Turunkan ke 5k–20k/hari |
| Instrumen | XAUUSD | Volatilitas tinggi & RR bagus |
| Timeframe | M1 → M15 | M15 karena M1 terlalu berisik |
| Platform | MT4/MT5 di Linux? | TIDAK. Pakai WebTerminal + ekstensi |
| Analisa | TradingView | Ya untuk chart, eksekusi di Exness |
| Indikator | SMA Cross + RSI + BB | Port ke Indie (berhasil) |
| Eksekusi | Auto? | Manual confirm, bukan auto |
| Analisa AI | LSTM vs LLM | Skip LSTM. Pakai LLM naratif + berita |
| AI Provider | Sudah punya OpenRouter dengan banyak model | Pakai OpenRouter dengan fallback |
| Arsitektur | Ekstensi saja | Semua logika di ekstensi |

### 2.2 Keputusan Teknis Kunci

1. **Tidak pakai MT4/MT5** — User menolak Windows/Wine
2. **Tidak pakai LSTM/ML** — Butuh data OHLCV panjang
3. **Tidak baca canvas chart** — Iframe cross-origin + canvas
4. **Token fresh dari localStorage** — Token expired 6 jam
5. **Manual confirm sebelum eksekusi** — Safety net
6. **Pakai `data-test` attribute** — Stabil, bukan class hash

### 2.3 Pertanyaan User yang Sudah Terjawab

| # | Pertanyaan | Jawaban |
|---|---|---|
| 1 | Forex atau crypto enak? | Forex (XAUUSD) lebih terstruktur |
| 2 | Bisa profit 50k/hari dari 500k? | Tidak realistis. Target 5k–20k |
| 3 | MT4/MT5 di Linux bisa? | Bisa via Wine, tapi user menolak |
| 4 | JForex bisa untuk Exness? | Tidak, eksklusif Dukascopy |
| 5 | Tokocrypto untuk Linux? | Bisa, tapi pair IDR mahal biaya |
| 6 | Bisa auto-execute di WebTerminal? | Ya via rtapi (melanggar ToS) |
| 7 | Trailing stop bisa otomatis? | Ya via `PUT /positions/{id}/modify` |
| 8 | Baca indikator dari DOM chart? | Tidak bisa, di canvas |
| 9 | AI yang cocok untuk trading? | LLM naratif + berita, bukan LSTM |
| 10 | Berapa lama untuk bangun? | 4 minggu |

---

## 3. SCOPE & FITUR

### 3.1 In Scope (MVP v1.0)

| ID | Fitur | Prioritas |
|---|---|---|
| F-01 | Price Sampling dari `document.title` | Wajib |
| F-02 | Candle Builder M15 (250 candle) | Wajib |
| F-03 | Indikator Teknikal (SMA, RSI, BB, MACD, ATR) | Wajib |
| F-04 | Fetch Kalender Ekonomi (FXMacroData) | Wajib |
| F-05 | LLM Analisa via OpenRouter | Wajib |
| F-06 | Overlay Sinyal di Chart | Wajib |
| F-07 | Popup UI (kontrol + log) | Wajib |
| F-08 | Eksekusi Order via rtapi Exness | Wajib |
| F-09 | Log Sinyal (7 hari) | Wajib |
| F-10 | Baca Posisi Terbuka dari DOM | Wajib |
| F-11 | Trailing Stop | Nice-to-have |
| F-12 | Export CSV | Nice-to-have |

### 3.2 Out of Scope
- Auto-execute tanpa konfirmasi
- Multi-symbol (hanya XAUUSD)
- Machine Learning / LSTM
- Backtest engine
- Mobile app
- Broker selain Exness

---

## 4. ARSITEKTUR TEKNIS

### 4.1 Diagram

```
┌──────────────────────────────────────────────────────────────┐
│  CHROME EXTENSION (Manifest V3)                              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ content.js                                             │  │
│  │ • Inject ke my.exness.com/webtrading                   │  │
│  │ • Baca Bid dari document.title (1 detik)               │  │
│  │ • Baca posisi terbuka dari DOM                         │  │
│  │ • Render overlay sinyal                                │  │
│  │ • Akses localStorage untuk token                       │  │
│  └──────────────┬─────────────────────────────────────────┘  │
│                 │ chrome.runtime.sendMessage                 │
│                 ▼                                            │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ background.js (service worker)                         │  │
│  │ • Aggregate candle M15                                 │  │
│  │ • Hitung indikator                                     │  │
│  │ • Fetch kalender ekonomi                               │  │
│  │ • Call OpenRouter LLM                                  │  │
│  │ • Kirim order ke rtapi Exness                          │  │
│  │ • Scheduler via chrome.alarms                          │  │
│  └──────────────┬─────────────────────────────────────────┘  │
│                 │ chrome.storage.local                       │
│                 ▼                                            │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ popup.html + popup.js                                  │  │
│  │ • Status sinyal terkini                                │  │
│  │ • Tombol: Analyze, Execute, Export, Settings           │  │
│  │ • Log history 7 hari                                   │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                            │ HTTPS
                            ▼
    ┌──────────────┬──────────────┬──────────────┐
    │  OpenRouter  │  FXMacroData │  Exness rtapi│
    │  (LLM)       │  (Kalender)  │  (Order)     │
    └──────────────┴──────────────┴──────────────┘
```

### 4.2 Tech Stack

| Layer | Teknologi | Alasan |
|---|---|---|
| Ekstensi | Chrome MV3 | Standar terbaru |
| Bahasa | JavaScript ES2022 | Native, no build step |
| Storage | chrome.storage.local | Persist antar restart |
| Scheduler | chrome.alarms | Lebih andal dari setInterval |
| LLM | OpenRouter (multi-model) | User sudah punya |
| Kalender | FXMacroData | Gratis, no key |
| Eksekusi | Exness rtapi | Satu-satunya jalur |

---

## 5. SPESIFIKASI FITUR DETAIL

### F-01: Price Sampling
Baca Bid dari `document.title` setiap 1 detik.

```javascript
setInterval(() => {
  const match = document.title.match(/(\d{1,3}(,\d{3})*\.\d+)/);
  if (!match) return;
  const price = parseFloat(match[1].replace(/,/g, ''));
  chrome.runtime.sendMessage({ type: 'PRICE_TICK', price, timestamp: Date.now() });
}, 1000);
```

Edge case: title tanpa angka → skip. Harga stagnant >60 detik → tandai.

### F-02: Candle Builder
- Timeframe: 15 menit (900.000 ms)
- Bucket: `Math.floor(ts / 900000) * 900000`
- Simpan: 250 candle (~2.5 hari trading)
- Format: `{ time, o, h, l, c }`

### F-03: Indikator Teknikal

| Indikator | Parameter | Formula |
|---|---|---|
| SMA9 | 9 | `sum(closes[-9:]) / 9` |
| SMA21 | 21 | `sum(closes[-21:]) / 21` |
| RSI14 | 14 | `100 - (100 / (1 + RS))` |
| BB Upper | 20, 2 | `SMA20 + 2*std20` |
| BB Lower | 20, 2 | `SMA20 - 2*std20` |
| MACD Hist | 12,26,9 | `EMA12 - EMA26 - EMA9(MACD)` |
| ATR14 | 14 | `avg(TrueRange[-14:])` |

### F-04: Fetch Kalender Ekonomi
Endpoint: `GET https://api.fxmacrodata.com/v1/calendar/usd`
Filter: High-impact, +24 jam, max 5 event.
Fallback: Jika API down → return "Kalender tidak tersedia", tetap lanjut ke LLM.

### F-05: LLM Analisa

Provider: OpenRouter (user sudah punya dengan banyak model)

| Model | Harga | Kecepatan |
|---|---|---|
| DeepSeek V3 | Gratis | Cepat |
| Claude 3.5 Haiku | $0.25/1M | Sangat cepat |
| GPT-4o Mini | $0.15/1M | Cepat |
| Gemini Flash | Gratis | Sangat cepat |

Parameter: `temperature: 0.2`, `response_format: json_object`, `max_tokens: 200`, `timeout: 30 detik`.

Validasi output:
```javascript
function validateSignal(json) {
  if (!['BUY', 'SELL', 'WAIT'].includes(json.signal)) throw new Error('Invalid signal');
  if (typeof json.confidence !== 'number' || json.confidence < 0 || json.confidence > 1)
    throw new Error('Invalid confidence');
  if (typeof json.reason !== 'string' || json.reason.length > 200)
    throw new Error('Invalid reason');
  return json;
}
```

### F-06: Overlay di Chart
Posisi: Fixed, top 80px, right 20px. Ukuran min-width 180px, max-width 300px.

```
┌─────────────────────────────┐
│ BUY · 75%                   │
│ ─────────────────────────── │
│ RSI 58.3 · SMA9 4161.2 ·    │
│ SMA21 4158.9                │
│ ─────────────────────────── │
│ Konfluensi SMA cross +      │
│ RSI > 50                    │
└─────────────────────────────┘
```

### F-07: Popup UI
Ukuran 400×500 px.

```
┌─────────────────────────────────────────┐
│ AI Trading Signal              [×]      │
├─────────────────────────────────────────┤
│ Status: ● Active                        │
│ Last analysis: 2 min ago                │
├─────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ │
│ │ BUY · 75%                           │ │
│ │ Konfluensi SMA cross + RSI > 50     │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ Indikator:                              │
│   SMA9:   4161.20   SMA21: 4158.90      │
│   RSI14:  58.3      ATR14: 4.2          │
│   BB U:   4165.10   BB L:  4155.80      │
│   MACD H: +0.45                         │
├─────────────────────────────────────────┤
│ [ Analyze Now ] [ Execute Order ]       │
│ [ Export Log ]  [ Settings ]            │
├─────────────────────────────────────────┤
│ Recent Signals (7 hari):                │
│ 10:15 BUY  75%  @ 4161.20               │
│ 09:45 WAIT  –   @ 4160.50               │
│ 09:15 SELL 68%  @ 4162.10               │
└─────────────────────────────────────────┘
```

### F-08: Eksekusi Order

Alur: Klik Execute → konfirmasi → ambil token fresh → POST ke rtapi.

Payload:
```json
{
  "order": {
    "type": 0,
    "price": 4161.20,
    "volume": 0.01,
    "instrument": "XAUUSDm",
    "sl": 0, "tp": 0, "deviation": 0
  },
  "ga": "GA1.1.860545600.1781707786",
  "fp": "dd6930c3563511973a4db952bc6a9fc7",
  "cid": "exterm_web_afe43526-e7a7-4a59-9ad2-a51972933b6f"
}
```

Safety guard: koneksi stable, spread <50 poin, sinyal umur <5 menit, max 1 posisi per simbol, daily loss limit -5%.

### F-09: Log Sinyal

```javascript
{
  signals: [{
    id: 'uuid',
    timestamp: 1790818103000,
    signal: 'BUY',
    confidence: 0.75,
    reason: 'SMA cross + RSI > 50',
    indicators: {...},
    news: '...',
    priceAtSignal: 4161.20,
    executed: true,
    orderResult: {...}
  }],
  maxEntries: 1000
}
```

---

## 6. RISIKO & MITIGASI

| # | Risiko | Dampak | Prob | Mitigasi |
|---|---|---|---|---|
| R1 | Exness ubah DOM | Tinggi | Sedang | Pakai data-test stabil + fallback |
| R2 | Token expired | Sedang | Rendah | Baca fresh tiap order, retry 1x |
| R3 | LLM down/rate limit | Sedang | Sedang | Fallback model, cache 15 menit |
| R4 | Candle tidak akurat | Sedang | Tinggi | Toleransi 95%, opsi fetch API |
| R5 | ToS Exness | Tinggi | Rendah | Dokumentasi sebagai alat bantu |
| R6 | Service worker mati | Sedang | Sedang | Pakai chrome.alarms |
| R7 | Data leakage log | Sedang | Rendah | Jangan simpan token |

---

## 7. TIMELINE

**Minggu 1: Fondasi**
- Hari 1: Setup manifest, load unpacked
- Hari 2: content.js sampling harga
- Hari 3: background.js candle builder
- Hari 4: indicators.js SMA, RSI, BB
- Hari 5: MACD, ATR + verifikasi
- Hari 6-7: Testing candle & indikator

**Minggu 2: LLM & UI**
- Hari 8: Fetch kalender
- Hari 9: Integrasi OpenRouter
- Hari 10: Overlay chart
- Hari 11: popup.html + popup.js
- Hari 12: Log sinyal + export
- Hari 13-14: End-to-end testing

**Minggu 3: Eksekusi**
- Hari 15: Eksekusi order rtapi
- Hari 16: Safety guard
- Hari 17: Konfirmasi dialog
- Hari 18: Trailing stop
- Hari 19-21: Testing di demo

**Minggu 4: Polish**
- Hari 22: Settings page
- Hari 23: Dokumentasi
- Hari 24: Backup config
- Hari 25-28: Uji 3 trader

---

## 8. APPROVAL

| Role | Nama | Tanggal |
|---|---|---|
| Product Owner | [User] | 1 Okt 2026 |
| Developer | [User] | 1 Okt 2026 |
| Reviewer | — | — |

---

# APPENDIX A: KODE LENGKAP

## A.1 manifest.json

```json
{
  "manifest_version": 3,
  "name": "AI Trading Signal — XAUUSD M15",
  "version": "1.0",
  "permissions": ["storage", "activeTab", "scripting", "alarms"],
  "host_permissions": [
    "https://my.exness.com/*",
    "https://rtapi-sg.eccweb.mobi/*",
    "https://openrouter.ai/*",
    "https://api.fxmacrodata.com/*"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [{
    "matches": ["https://my.exness.com/webtrading/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "action": {
    "default_popup": "popup.html",
    "default_icon": "icon.png"
  }
}
```

## A.2 config.js

```javascript
export const CONFIG = {
  OPENROUTER_KEY: "sk-or-v1-...",
  MODEL_PRIMARY: "deepseek/deepseek-chat",
  MODEL_FALLBACK: "anthropic/claude-3.5-haiku",
  SYMBOL: "XAUUSDm",
  TIMEFRAME_MIN: 15,
  LOOP_INTERVAL_MIN: 15,
  DEFAULT_VOLUME: 0.01,
  MAX_DAILY_LOSS_PCT: 5,
  MAX_SPREAD_POINTS: 50
};
```

## A.3 content.js

```javascript
setInterval(() => {
  const match = document.title.match(/(\d{1,3}(,\d{3})*\.\d+)/);
  if (!match) return;
  const price = parseFloat(match[1].replace(/,/g, ''));
  chrome.runtime.sendMessage({
    type: 'PRICE_TICK',
    price,
    timestamp: Date.now()
  });
}, 1000);

function parsePrice(str) {
  if (!str) return null;
  const cleaned = str.replace(/[^\d.-]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function readOpenPositions() {
  const rows = document.querySelectorAll(
    '[data-test^="portfolio_list_row_"]:not([data-test*="_group_"]):not([data-test$="_header"])'
  );
  const positions = [];

  rows.forEach(row => {
    const get = (key) => row.querySelector(`[data-test="${key}"]`);
    const ticket = get('ticket')?.textContent.trim();
    if (!ticket) return;

    const symbol = get('symbol')?.querySelector('[data-test^="symbol-"]')?.textContent.trim() || '';
    const type = get('type')?.textContent.trim() || '';
    const volume = parseFloat(get('volume')?.textContent.trim() || '0');
    const entry = parsePrice(get('openPrice')?.textContent);
    const current = parsePrice(get('currentPrice')?.textContent);

    const tpText = get('tp')?.textContent.trim();
    const slText = get('sl')?.textContent.trim();
    const tp = (tpText && tpText !== 'Add' && tpText !== '--') ? parsePrice(tpText) : null;
    const sl = (slText && slText !== 'Add' && slText !== '--') ? parsePrice(slText) : null;

    const plEl = get('pl')?.querySelector('[data-test="pl-value"]');
    const plValue = parseFloat(plEl?.textContent.replace(/\s/g, '') || '0');
    const isProfit = plEl?.className.includes('ProfitLoss_profit') || plValue > 0;
    const isLoss = plEl?.className.includes('ProfitLoss_loss') || plValue < 0;

    positions.push({
      ticket, symbol,
      side: type.toUpperCase(),
      volume, entry, current, sl, tp,
      profitLoss: plValue, isProfit, isLoss
    });
  });

  return positions;
}

async function renderOverlay() {
  const { lastSignal } = await chrome.storage.local.get('lastSignal');
  if (!lastSignal) return;

  let el = document.getElementById('ai-signal-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ai-signal-overlay';
    el.style.cssText = `
      position: fixed; top: 80px; right: 20px; z-index: 99999;
      padding: 12px 16px; border-radius: 8px;
      background: rgba(20,29,34,0.95); color: #E6EDF3;
      font-family: monospace; font-size: 12px;
      border: 2px solid #58A6FF; min-width: 180px;
    `;
    document.body.appendChild(el);
  }

  const color = lastSignal.signal === 'BUY' ? '#00C896'
              : lastSignal.signal === 'SELL' ? '#FF4757' : '#888';

  el.innerHTML = `
    <div style="font-weight:bold;color:${color};font-size:16px">
      ${lastSignal.signal} · ${(lastSignal.confidence * 100).toFixed(0)}%
    </div>
    <div style="font-size:10px;color:#8B949E;margin-top:6px">
      ${lastSignal.reason || ''}
    </div>
    <div style="font-size:9px;color:#8B949E;margin-top:4px">
      RSI: ${lastSignal.indicators?.rsi14?.toFixed(1) || '–'} |
      SMA9: ${lastSignal.indicators?.sma9?.toFixed(2) || '–'}
    </div>
  `;
}

setInterval(renderOverlay, 5000);
renderOverlay();
```

## A.4 background.js

```javascript
import { CONFIG } from './config.js';
import { getCandles, saveCandles } from './candle-builder.js';
import { computeIndicators } from './indicators.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PRICE_TICK') {
    handlePriceTick(msg.price, msg.timestamp);
  }
  if (msg.type === 'REQUEST_SIGNAL') {
    runAnalysis().then(sendResponse);
    return true;
  }
  if (msg.type === 'EXECUTE_ORDER') {
    executeOrder(msg.signal).then(sendResponse);
    return true;
  }
});

async function handlePriceTick(price, ts) {
  const bucketMs = CONFIG.TIMEFRAME_MIN * 60 * 1000;
  const bucketTs = Math.floor(ts / bucketMs) * bucketMs;

  const candles = await getCandles();
  const last = candles[candles.length - 1];

  if (!last || last.time !== bucketTs) {
    candles.push({ time: bucketTs, o: price, h: price, l: price, c: price });
    if (candles.length > 250) candles.shift();
  } else {
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    last.c = price;
  }
  await saveCandles(candles);
}

async function runAnalysis() {
  const candles = await getCandles();
  if (candles.length < 30) {
    return { error: `Baru ${candles.length} candle, butuh minimal 30` };
  }

  const indicators = computeIndicators(candles);
  const news = await fetchNews();
  const signal = await askLLM(indicators, news);

  await chrome.storage.local.set({
    lastSignal: { ...signal, time: Date.now(), indicators, news }
  });

  chrome.action.setBadgeText({
    text: signal.signal === 'BUY' ? '↑' : signal.signal === 'SELL' ? '↓' : '–'
  });
  chrome.action.setBadgeBackgroundColor({
    color: signal.signal === 'BUY' ? '#00C896' : signal.signal === 'SELL' ? '#FF4757' : '#888'
  });

  return signal;
}

async function fetchNews() {
  try {
    const calResp = await fetch('https://api.fxmacrodata.com/v1/calendar/usd');
    const calData = await calResp.json();

    const now = Date.now();
    const upcoming = (calData.events || [])
      .filter(e => {
        const t = new Date(e.date).getTime();
        return t > now && t < now + 24 * 3600 * 1000 && e.importance === 'high';
      })
      .slice(0, 5);

    const lines = upcoming.map(e =>
      `- ${e.date} | ${e.currency} | ${e.name} | forecast: ${e.forecast || 'N/A'}`
    );

    return lines.length ? lines.join('\n') : 'Tidak ada event high-impact 24 jam ke depan.';
  } catch (err) {
    console.error('News fetch error:', err);
    return 'Gagal ambil kalender: ' + err.message;
  }
}

async function askLLM(ind, news) {
  const prompt = `Kamu analis XAUUSD M15. Output JSON saja.

HARGA: ${ind.price} | Spread: ${ind.spread}
SMA9: ${ind.sma9} | SMA21: ${ind.sma21} | RSI14: ${ind.rsi14}
BB Upper: ${ind.bbUpper} | BB Lower: ${ind.bbLower}
MACD Hist: ${ind.macdHist} | ATR14: ${ind.atr14}

KALENDER HIGH-IMPACT 24 JAM:
${news}

ATURAN:
1. Event high-impact <30 menit → signal WAIT
2. Butuh minimal 2 konfluensi indikator
3. Confidence >= 0.6 untuk BUY/SELL

Format: {"signal":"BUY|SELL|WAIT","confidence":0.0-1.0,"reason":"..."}`;

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.OPENROUTER_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CONFIG.MODEL_PRIMARY,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    })
  });

  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
  const data = await resp.json();
  return JSON.parse(data.choices[0].message.content);
}

async function executeOrder(signal) {
  const tabs = await chrome.tabs.query({ url: 'https://my.exness.com/webtrading/*' });
  if (!tabs.length) return { error: 'WebTerminal tidak terbuka' };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: () => localStorage.getItem('access_token') || sessionStorage.getItem('access_token')
  });
  const token = result.result;

  if (!token) return { error: 'Token tidak ditemukan — login ulang' };

  const url = new URL(tabs[0].url);
  const accountId = url.pathname.match(/accounts\/(\d+)/)?.[1] || url.searchParams.get('login');

  const orderType = signal.signal === 'BUY' ? 0 : 1;
  const price = signal.signal === 'BUY' ? signal.askPrice : signal.bidPrice;

  const resp = await fetch(
    `https://rtapi-sg.eccweb.mobi/rtapi/mt5/trial7/v1/accounts/${accountId}/orders`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Referer': 'https://my.exness.com/'
      },
      body: JSON.stringify({
        order: {
          type: orderType, price, volume: 0.01,
          instrument: 'XAUUSDm', sl: 0, tp: 0, deviation: 0
        },
        ga: "GA1.1.860545600.1781707786",
        fp: "dd6930c3563511973a4db952bc6a9fc7",
        track_uid: "",
        cid: "exterm_web_afe43526-e7a7-4a59-9ad2-a51972933b6f",
        agent_timestamp: "", agent: "", agent_full_path: ""
      })
    }
  );

  return await resp.json();
}

chrome.alarms.create('analyze', { periodInMinutes: CONFIG.LOOP_INTERVAL_MIN });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'analyze') runAnalysis();
});
```

## A.5 indicators.js

```javascript
function sma(closes, period) {
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period = 14) {
  let gains = 0, losses = 0;
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
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function macdHist(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = ema12 - ema26;
  const signal = ema([macd], 9);
  return macd - signal;
}

function atr(candles, period = 14) {
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

export function computeIndicators(candles) {
  const closes = candles.map(c => c.c);
  const bb = bollinger(closes, 20, 2);
  return {
    price: closes[closes.length - 1],
    sma9: sma(closes, 9),
    sma21: sma(closes, 21),
    rsi14: rsi(closes, 14),
    bbUpper: bb.upper,
    bbLower: bb.lower,
    macdHist: macdHist(closes),
    atr14: atr(candles, 14)
  };
}
```

## A.6 candle-builder.js

```javascript
export async function getCandles() {
  const { candles } = await chrome.storage.local.get('candles');
  return candles || [];
}

export async function saveCandles(candles) {
  await chrome.storage.local.set({ candles });
}

export function buildCandle(tick, existing) {
  const bucketMs = 15 * 60 * 1000;
  const bucketTs = Math.floor(tick.timestamp / bucketMs) * bucketMs;

  if (!existing || existing.time !== bucketTs) {
    return { time: bucketTs, o: tick.price, h: tick.price, l: tick.price, c: tick.price };
  }
  existing.h = Math.max(existing.h, tick.price);
  existing.l = Math.min(existing.l, tick.price);
  existing.c = tick.price;
  return existing;
}
```

## A.7 Indikator Indie: Safe SMA Cross + RSI + BB

```python
# indie:lang_version = 5

from indie import indicator, param, color, plot, line_style
from indie.algorithms import Sma, Rsi, Bb
from indie.math import cross_over, cross_under
from math import nan

@indicator('Safe SMA Cross + RSI + BB', overlay_main_pane=True)

@param.int('len_fast', default=9, min=1, title='Fast SMA length')
@param.int('len_slow', default=21, min=1, title='Slow SMA length')
@param.int('rsi_len', default=14, min=2, title='RSI Length')
@param.int('rsi_buy_min', default=50, min=1, max=100, title='RSI Buy Threshold')
@param.int('rsi_sell_max', default=50, min=0, max=99, title='RSI Sell Threshold')
@param.int('bb_len', default=20, min=1, title='BB Length')
@param.float('bb_mult', default=2.0, min=0.1, title='BB Multiplier')

@plot.line('fast', title='Fast SMA', color=color.BLUE(alpha=0.65), line_style=line_style.SOLID, line_width=2)
@plot.line('slow', title='Slow SMA', color=color.ORANGE(alpha=0.65), line_style=line_style.DASHED, line_width=2)
@plot.line('bb_lower', title='Support (BB Lower)', color=color.GREEN(alpha=0.5), line_style=line_style.DOTTED, line_width=1)
@plot.line('bb_upper', title='Resistance (BB Upper)', color=color.RED(alpha=0.5), line_style=line_style.DOTTED, line_width=1)

@plot.marker(style=plot.marker_style.LABEL, title='Buy Signal', size=4, text='BUY', position=plot.marker_position.BELOW, color=color.GREEN)
@plot.marker(style=plot.marker_style.LABEL, title='Sell Signal', size=4, text='SELL', position=plot.marker_position.ABOVE, color=color.RED)

def Main(self, len_fast, len_slow, rsi_len, rsi_buy_min, rsi_sell_max, bb_len, bb_mult):
    fast = Sma.new(self.close, len_fast)
    slow = Sma.new(self.close, len_slow)
    rsi = Rsi.new(self.close, rsi_len)
    bb_lower, bb_middle, bb_upper = Bb.new(self.close, bb_len, bb_mult)

    crossUp = cross_over(fast, slow)
    crossDown = cross_under(fast, slow)

    safeBuy = crossUp and rsi[0] > rsi_buy_min
    safeSell = crossDown and rsi[0] < rsi_sell_max

    return fast[0], slow[0], bb_lower[0], bb_upper[0], \
           self.low[0] if safeBuy else nan, \
           self.high[0] if safeSell else nan
```

---

# APPENDIX B: PROMPT LLM TEMPLATES

## B.1 Prompt Utama

```
Kamu analis XAUUSD M15. Output JSON saja.

HARGA: {price} | Spread: {spread}
SMA9: {sma9} | SMA21: {sma21} | RSI14: {rsi14}
BB Upper: {bbUpper} | BB Lower: {bbLower}
MACD Hist: {macdHist} | ATR14: {atr14}

KALENDER HIGH-IMPACT 24 JAM:
{news}

ATURAN:
1. Event high-impact <30 menit → signal WAIT
2. Butuh minimal 2 konfluensi indikator
3. Confidence >= 0.6 untuk BUY/SELL
4. Jangan analisa berita secara terpisah — pakai sebagai konteks

Format: {"signal":"BUY|SELL|WAIT","confidence":0.0-1.0,"reason":"..."}
```

## B.2 Prompt dengan Posisi Terbuka

```
Kamu analis XAUUSD M15. Output JSON saja.

HARGA: {price} | Spread: {spread}
SMA9: {sma9} | SMA21: {sma21} | RSI14: {rsi14}
BB Upper: {bbUpper} | BB Lower: {bbLower}
MACD Hist: {macdHist} | ATR14: {atr14}

POSISI TERBUKA:
{positions}

KALENDER HIGH-IMPACT 24 JAM:
{news}

ATURAN:
1. Jika ada posisi profit, sarankan trailing SL
2. Jika ada posisi rugi >2x ATR, sarankan cut loss
3. Sinyal baru hanya jika tidak ada posisi berlawanan

Format: {"signal":"BUY|SELL|WAIT|TRAIL_SL|CUT_LOSS","confidence":0.0-1.0,"reason":"..."}
```

---

# APPENDIX C: SELECTOR DOM EXNESS

## C.1 Harga & Order Panel

| Data | Selector | Contoh |
|---|---|---|
| Harga Bid | `document.title` regex | `4,153.852` |
| Harga Ask | `[data-test="order-button-buy"]` + first-pip/major-pip/minor-pip | `4,154.09` |
| Harga Sell | `[data-test="order-button-sell"]` | `4,153.85` |
| Spread | `[data-test="spread"]` | `0.24 USD` |
| Equity | `[data-test="account-info-equity"]` | `49.99` |
| Balance | `[data-test="balance"] [data-test="value"]` | `49.99 USD` |
| Free Margin | `[data-test="free-margin"] [data-test="value"]` | `47.60 USD` |
| Margin Level | `[data-test="margin-level"] [data-test="value"]` | `2,388.46%` |
| Koneksi | `[data-test="footer-connection"]` class | `ConnectionStatus_stable` |

## C.2 Baris Posisi

| Field | `data-test` | Catatan |
|---|---|---|
| Row wrapper | `portfolio_list_row_{ticket}` | Skip jika mengandung `_group_` |
| Symbol | `symbol` | `XAU/USD` |
| Type | `type` | `Buy` / `Sell` / `Hedged` |
| Volume | `volume` | `0.01` |
| Open Price | `openPrice` | Unicode `⁦4,160.343⁩` — strip |
| Current Price | `currentPrice` | Sama |
| TP | `tp` | `Add` jika kosong, `--` jika grup |
| SL | `sl` | Sama |
| Ticket | `ticket` | `4806422867` |
| Open Time | `openTime` | `Oct 1, 2:43:03 AM` |
| Swap | `swap` | `0` |
| P/L | `pl` > `[data-test="pl-value"]` | `+0.74` / `-6.25` |
| Class P/L | `ProfitLoss_profit` / `ProfitLoss_loss` | Deteksi warna |
| Actions | `actions` | Berisi tombol modify & close |

## C.3 Tombol Aksi

| Tombol | `data-test` |
|---|---|
| Modify position | `portfolio-order-modify-btn` |
| Close position | `portfolio-order-close-btn` |
| Close group | `portfolio_order_close_group_btn` |
| Close all footer | `close-all-footer-button` |
| Ungroup positions | `option-2` |
| Group positions | `option-1` |
| Tab Open | `portfolio_tabs_open` |
| Tab Pending | `portfolio_tabs_pending` |
| Tab Closed | `portfolio_tabs_closed` |

## C.4 Fungsi Parsing yang Benar

```javascript
function parsePrice(str) {
  if (!str) return null;
  // Hapus Unicode directional isolate \u2066 \u2069 dan karakter lain
  const cleaned = str.replace(/[^\d.-]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}
```

---

# APPENDIX D: RIWAYAT PERCAKAPAN RINGKAS

## D.1 Fase Eksplorasi
**User:** "Enak trading apa? Forex atau crypto? Mau untung 50k/hari dari modal 500k."
**Analisa:** Target 10%/hari tidak realistis. Return realistis 1-2%/hari (5k-10k). Forex lebih cocok untuk pemula.

## D.2 Fase Platform
**User:** "MT4/MT5 tidak bisa native di Linux. Saya mau pakai extension browser saja."
**Keputusan:** WebTerminal + ekstensi browser. Tidak pakai Wine/VM.

## D.3 Fase Indikator
**User:** "Buat indikator Safe SMA Cross + RSI + BB di Indie."
**Hasil:** Indikator berhasil dibuat. Error yang ditemukan:
- `Bbands` tidak ada, harus `Bb`
- Tuple unpacking: `bb_lower, bb_middle, bb_upper = Bb.new(...)`

## D.4 Fase Eksekusi
**User:** "Bisa auto-execute posisi di WebTerminal?"
**Temuan:** Ya, via rtapi internal. Endpoint:
- `POST /orders` — buat posisi
- `PUT /positions/{id}/modify` — trailing SL/TP
- Token dari localStorage (expired 6 jam)

## D.5 Fase AI
**User:** "Mau pakai LLM naratif + berita, bukan LSTM."
**Keputusan:**
- Data OHLCV dari sampling `document.title`
- Kalender dari FXMacroData (gratis)
- LLM via OpenRouter (user sudah punya)
- Arsitektur 4 lapisan: Data → Prompt → LLM → Validasi

## D.6 Fase Arsitektur
**User:** "Ekstensi saja biar bisa lihat grafik, token awet dari session browser."
**Keputusan final:**
- Manifest V3
- content.js (sampling + overlay)
- background.js (candle, indikator, LLM, eksekusi)
- popup.html (kontrol)
- Token fresh dari localStorage setiap kali order

---

## LANGKAH PERTAMA

Yang perlu Anda lakukan sekarang:
1. Buat folder `ai-trading-extension/`
2. Buat 7 file sesuai Appendix A
3. Isi `config.js` dengan OpenRouter API key Anda
4. Load unpacked di `chrome://extensions`
5. Buka WebTerminal, login, buka XAUUSD M15
6. Tunggu 30-60 menit agar candle terkumpul
7. Klik "Analyze Now" di popup

**Belum ada di dokumen ini:** `popup.html` + `popup.js`. Lanjutkan di iterasi berikutnya.

---

*Akhir Dokumen*