# AI Trading Signal — XAUUSD M15

> [Bahasa Indonesia](README.id.md) · **English**

A Chrome/Brave extension (MV3) that analyzes the **XAUUSD M15** chart on
Exness WebTerminal, asks an LLM for a verdict via a **2-stage debate
pipeline** (analyst → contrarian debater), then renders the signal, S/R
levels, trend, and a position plan — with visuals drawn directly on the
chart.

> **Manual execution.** The extension never places orders itself. It only
> pre-fills the order panel; you still press Buy/Sell + Confirm. Trailing
> stop also only runs when you click the button.

> **Purpose & ethical scope.** This extension is purely an analysis aid: it
> **reads data already rendered on the page** (price from the tab title,
> positions from the DOM) and processes it with technical indicators and an
> LLM/AI model to help you analyze — not to exploit, bypass protections, or
> damage the platform. No hidden scraping, no order manipulation, no access
> beyond what WebTerminal already grants its own user. Compliance with the
> broker's ToS remains your responsibility.

## Features

- **M15 candle builder** — samples price ticks from the WebTerminal page,
  stored in `chrome.storage.local` (+ historical candle backfill).
- **Technical indicators** — SMA9/SMA21, RSI14, ATR14, Bollinger Bands, MACD
  histogram, SMA9 slope (trend hint).
- **S/R levels + breakout** — support/resistance detected from candles,
  drawable on the chart (lines + touch labels).
- **2-stage debate pipeline** —
  1. *Analyst*: LLM produces a signal + confidence + trend + target price +
     `keyRisks`.
  2. *Contrarian debater*: a second LLM tries to refute the analyst using
     the same data; if it disagrees and proposes an alternative, the final
     verdict is computed in JS (`decideFinal`).
  The process is transparent — 3 debate lines show in the side panel
  (collapsible block), stored in `lastSignal.process`.
- **Pro chart visuals** — historical trend line + prediction arrow/target
  (only for non-WAIT signals); position plan (entry/SL/TP) drawn as overlay.
- **Full-control side panel** — Analyze Now, backfill, draw/clear S/R &
  position & trend, trailing stop, CSV signal log export, and **Settings**.
- **Runtime settings** — volume, default SL/TP, min SL, trailing, loop
  interval, model, **LLM Base URL + API key** (empty = fall back to
  `config.js`).
- **Auto loop** — `chrome.alarms` runs analysis every `loopIntervalMin`
  minutes (default 15); survives MV3 SW termination.

## Structure

```
extension/
  manifest.json        MV3, side panel, Exness content script
  background.js        SW: message router, analysis pipeline, LLM, chart drawing
  content.js           MAIN-world bridge: price ticks, overlay, order panel
  panel.js             shared controller for popup & side panel
  indicators.js        compute indicators + slope + 5-candle shape
  candle-builder.js    aggregate ticks → M15 candles
  sr.js                S/R level detection
  settings.js          defaults + sanitize + storage.sync
  config.js            live values — GIT-IGNORED, never commit
  config.example.js    template — cp to config.js then fill in
  sidepanel.html       side panel UI
  popup.html           popup UI (subset of panel)
dev/
  launch-brave.sh      Brave + remote debugging 9222 + load extension
  watch-reload.mjs     watcher: save file → reload SW + Exness tab
  cdp.mjs              CDP helper (eval, console, sniff, panel, sw)
```

> `prd.md` (original spec + decision notes) lives in the repo but is
> **git-ignored** — internal document, not tracked.

## Setup

### 1. LLM config

```bash
cd extension
cp config.example.js config.js
# edit config.js — fill in your LLM_BASE_URL + LLM_API_KEY
```

`config.js` is in `.gitignore` — secrets never enter the repo. Every value
(Base URL, API key, model) can also be overridden at runtime from the
**Settings** panel; empty there = use the `config.js` default.

### 2. Load the extension

**Dev mode (recommended):**

```bash
./dev/launch-brave.sh
```

Launches Brave (auto-detects `brave-origin-stable`) with a separate dev
profile (`~/.brave-trading-dev`), remote debugging on port 9222, and the
extension preloaded. Exness login is only needed once per profile.

**Manual:** `chrome://extensions` → Developer mode → Load unpacked → pick
the `extension/` folder.

### 3. Dev loop

```bash
node dev/watch-reload.mjs   # terminal 1 (optional)
```

Save any file under `extension/` → the service worker + Exness tab
auto-reload. The watcher resolves the CDP port from `BRAVE_DEV_PORT`, the
`DevToolsActivePort` file in the Brave profile, or falls back to 9222.

Debug helpers:

```bash
node dev/cdp.mjs eval "document.title"      # eval in the Exness tab
node dev/cdp.mjs console                    # dump console logs
node dev/cdp.mjs sniff                      # capture network for 8s
```

> MV3 note: a dormant service worker disappears from the CDP target list —
> that's normal, not a crash. Reload the Exness tab to wake it.

## Usage

1. Open Exness WebTerminal in the dev browser, log in.
2. Click the extension icon → side panel opens (or open `sidepanel.html`).
3. **Analyze Now** → the pipeline runs (~45–120s, 2 LLM calls + retry):
   - indicators + levels computed from stored candles,
   - analyst produces a verdict,
   - debater tries to refute it,
   - final verdict + debate show in the panel, visuals drawn on the chart.
4. **Draw S/R** / **Draw Position** for visual overlays; pair with the
   Clear buttons to remove.
5. **Fill Order** pre-fills the WebTerminal order panel per the latest
   signal — **you still confirm**.
6. **Trail SL** shifts SL on all open positions to follow price.
7. Settings (gear): volume, SL/TP, trailing, loop interval, model, LLM
   endpoint/key. Save to persist (chrome.storage.sync).

## Architecture overview

```
content.js (Exness page)          background.js (SW, ES module)
  ├─ PRICE_TICK ──────────────────▶ candle builder → storage
  ├─ REQUEST_SIGNAL ◀────────────▶ runAnalysis():
  │                                  computeIndicators → computeLevels
  │                                  → askAnalyst  (LLM #1)
  │                                  → askDebater  (LLM #2, contrarian)
  │                                  → decideFinal (JS)
  ├─ DRAW_SR / DRAW_POSITION /     → scripting.inject, draw on chart
  │   DRAW_TREND (+CLEAR_*)
  ├─ PREPARE_ORDER                 → pre-fill order panel (no submit)
  └─ TRAIL_STOPS                   → modify SL on open positions
```

- `chrome.storage.local` — candles, signals, positions, analysis state.
- `chrome.storage.sync` — settings (follows the Chrome account).
- `chrome.alarms` — auto analysis loop; alarms survive SW restarts.

## Security & limitations

- **No auto-trade.** Orders always require a manual click; the extension
  only pre-fills the panel.
- **`config.js` is git-ignored.** API keys live only on your machine (or
  override via the Settings panel, stored in your Chrome account's
  `chrome.storage.sync`).
- Anti-double-run guard (`analyzing` + `analysisAt` in storage) — the
  Analyze button self-recovers if the SW dies mid-analysis.
- The LLM proxy can be flaky (truncated SSE, reasoning models answering in
  `reasoning_content`) — `readLLMBody`/`parseLLMJson` are tolerant + 3×
  retry.
- Debate-stage failure is non-fatal; analyst failure falls back to a
  heuristic signal.
- **Demo first.** Designed to be tested on a demo account first.

## Dependencies

**Zero external dependencies** — no `package.json`, no libraries, no build
step. All code is native ES2022 JavaScript.

Platform APIs used:

| API | Used for |
|---|---|
| `chrome.storage` (local/sync) | candles, signals, settings |
| `chrome.alarms` | auto analysis loop |
| `chrome.scripting` + `chrome.sidePanel` | chart injection, side panel |
| `fetch` / `WebSocket` (dev) | LLM proxy, calendar, CDP |

External services:

| Service | Purpose |
|---|---|
| LLM proxy (OpenAI-compatible, user-owned) | analysis + debate |
| [FXMacroData](https://api.fxmacrodata.com) | USD high-impact economic calendar (free, no key) |
| Exness WebTerminal | price source, chart, positions, orders |

## Roadmap (from PRD)

| Item | Status |
|---|---|
| Price sampling + M15 candles + indicators | ✅ |
| LLM analysis + 2-stage debate pipeline | ✅ |
| Visual overlays (S/R, position, trend) | ✅ |
| Side panel + runtime settings | ✅ |
| Trailing stop (manual trigger) | ✅ |
| Order execution via Exness rtapi | ⏳ router exists (`EXECUTE_ORDER`), logic not yet |
| Multi-symbol / other brokers | ❌ out of scope — Exness-only by design |
| Auto-execute without confirmation | ❌ never, by design |

Design principles: Linux native, zero cost, zero install, transparent (user
sees indicators + LLM reasoning + debate), session token read fresh never
stored, manual confirm always.

## Disclaimer

This project is **not affiliated with Exness**, TradingView, or any LLM
provider. All trademarks belong to their owners.

- **No profit promise.** Whatever the LLM outputs — signal, confidence,
  target price — is not a guarantee of anything. This extension only moves
  analysis work to AI; results can still be wrong, and the market can move
  against even the best signal.
- **Not a "get-rich" tool.** The one thing this extension gives you: you
  can use an LLM integrated directly with WebTerminal — real chart data
  goes into the prompt, the verdict comes back to the chart. Everything
  else (when to enter, risk, discipline) remains your decision and
  responsibility.
- **LLM signals are not financial advice.** Gold trading is high-risk;
  test on a demo account first; responsibility lies entirely with the
  user.

## License

[MIT](LICENSE) — 100% original code, zero dependencies, free to use/modify.
