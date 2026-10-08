// background.js — MV3 service worker (module).
// Wiring: price ticks -> candles; analyze request -> indicators + LLM signal.
// rtapi writes (trailing stop) run through the Exness tab's page context.

import { CONFIG } from "./config.js";
import { recordTick, getCandles, saveCandles } from "./candle-builder.js";
import { computeIndicators } from "./indicators.js";
import { computeLevels } from "./sr.js";
import { getSettings, saveSettings, SETTINGS_DEFAULTS } from "./settings.js";

console.log("[AI-TS] background service worker started");

// Clicking the toolbar icon opens the side panel (replaces the old popup).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("[AI-TS] sidePanel behavior", e));

// --- Exness tab readiness --------------------------------------------------
// Fresh install: the WebTerminal tab was often opened *before* the extension
// loaded, so content.js never injected and there is no message listener. Rather
// than telling the user to reload the tab, we ping; if nobody answers, inject
// content.js ourselves and retry. Concurrent callers share one injection.
const injectionInFlight = new Map(); // tabId -> Promise

async function exnessTabReady() {
  const tabs = await chrome.tabs.query({ url: "https://my.exness.com/webtrading/*" });
  if (!tabs.length)
    return { error: "Tab Exness belum terbuka — buka my.exness.com/webtrading", stage: "tab" };
  const tab = pickExnessTab(tabs);

  const ping = () => chrome.tabs.sendMessage(tab.id, { type: "PING" });
  try {
    await ping();
    return { tab };
  } catch {
    /* no listener — inject below */
  }

  try {
    let job = injectionInFlight.get(tab.id);
    if (!job) {
      job = chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
        .finally(() => injectionInFlight.delete(tab.id));
      injectionInFlight.set(tab.id, job);
    }
    await job;
    await ping(); // confirm the listener registered
    return { tab, injected: true };
  } catch (e) {
    return { error: `Gagal inject content script ke tab Exness (${e.message})`, stage: "content" };
  }
}

// --- Backfill: pull M15 history from the Exness tab (it holds the auth) ----
// Diagnostics: every stage reports so the user sees *which* step failed
// (tab open? content script injected? auth present? rtapi status code?),
// not one generic "check tab" message.
async function requestBackfill() {
  const ready = await exnessTabReady();
  if (!ready.tab) return { ok: false, error: ready.error, stage: ready.stage };

  let res;
  try {
    res = await chrome.tabs.sendMessage(ready.tab.id, {
      type: "BACKFILL_REQUEST",
      timeFrameSec: CONFIG.TIMEFRAME_MIN * 60,
      count: 300
    });
  } catch (e) {
    return { ok: false, error: `Content script tidak merespons (${e.message})`, stage: "content" };
  }

  if (!res?.ok) {
    const err = res?.error || "unknown";
    const stage = /auth/i.test(err) ? "auth" : "rtapi";
    return { ok: false, error: `Backfill gagal [${stage}]: ${err}`, stage };
  }

  const existing = await getCandles();
  const histByTime = new Map(res.candles.map((c) => [c.time, c]));
  const merged = new Map();
  for (const c of res.candles) merged.set(c.time, c);
  for (const live of existing) {
    const hist = histByTime.get(live.time);
    if (hist) live.v = live.v || hist.v || 0;
    merged.set(live.time, live);
  }

  const candles = [...merged.values()].sort((a, b) => a.time - b.time).slice(-250);
  await saveCandles(candles);
  if (candles.length < 30)
    return { ok: false, error: `Backfill balik tapi cuma ${candles.length} candle (<30)`, stage: "count" };
  return { ok: true, count: candles.length, stage: "ok" };
}

// Auto-backfill on SW start so a fresh install doesn't need a manual click.
// Errors are non-blocking (log only — first Analyze retry is the real gate).
(async () => {
  const { candles = [] } = await chrome.storage.local.get("candles");
  if (candles.length < 30) {
    const bf = await requestBackfill();
    console.log(`[AI-TS] startup backfill: ${bf.ok ? `OK ${bf.count} candle` : bf.error}`);
  }
})();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PRICE_TICK") {
    recordTick(msg.price, msg.timestamp).catch((e) => console.error("[AI-TS] tick", e));
    return false;
  }

  if (msg.type === "REQUEST_BACKFILL") {
    requestBackfill()
      .then(async (bf) => {
        const { candles = [] } = await chrome.storage.local.get("candles");
        sendResponse(bf.ok ? { ...bf, count: candles.length } : bf);
      })
      .catch((e) => sendResponse({ ok: false, error: e.message, stage: "unknown" }));
    return true; // async
  }

  if (msg.type === "REQUEST_SIGNAL") {
    runAnalysis().then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === "EXECUTE_ORDER") {
    sendResponse({ error: "Not implemented yet (iteration 3: rtapi execution)" });
    return false;
  }

  if (msg.type === "PREPARE_ORDER") {
    prepareOrder().then(sendResponse);
    return true;
  }

  if (msg.type === "TRAIL_STOPS") {
    trailStops().then(sendResponse);
    return true;
  }

  if (msg.type === "DRAW_SR") {
    drawSupportResistance().then(sendResponse);
    return true;
  }

  if (msg.type === "CLEAR_SR") {
    clearSupportResistance().then(sendResponse);
    return true;
  }

  if (msg.type === "DRAW_POSITION") {
    drawPosition().then(sendResponse);
    return true;
  }

  if (msg.type === "CLEAR_POSITION") {
    clearPosition().then(sendResponse);
    return true;
  }

  if (msg.type === "DRAW_TREND") {
    drawTrendFromStorage().then(sendResponse);
    return true;
  }

  if (msg.type === "CLEAR_TREND") {
    clearTrend().then(sendResponse);
    return true;
  }

  if (msg.type === "GET_SETTINGS") {
    getSettings().then(sendResponse);
    return true;
  }

  if (msg.type === "SET_SETTINGS") {
    const task = msg.patch?.__reset
      ? chrome.storage.sync.remove("settings").then(() => ({ ...SETTINGS_DEFAULTS }))
      : saveSettings(msg.patch || {});
    task
      .then(async (next) => {
        await refreshAlarm(next);
        sendResponse({ ok: true, settings: next });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "MANUAL_DEBATE") {
    runManualDebate()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }

  if (msg.type === "PREVIEW_DEBATE_PROMPT") {
    previewDebatePrompts()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }
});

// Re-create the analysis alarm whenever loopIntervalMin changes.
async function refreshAlarm(settings) {
  chrome.alarms.clear("analyze");
  chrome.alarms.create("analyze", { periodInMinutes: settings.loopIntervalMin });
}

// Fill the Exness order panel from the latest signal. The user still clicks
// Buy/Sell + Confirm themselves — this never places an order.
async function prepareOrder() {
  const ready = await exnessTabReady();
  if (!ready.tab) return { ok: false, error: ready.error };
  try {
    return await chrome.tabs.sendMessage(ready.tab.id, { type: "PREPARE_ORDER" });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Manual trailing stop: moves SL to TRAIL_DISTANCE_PIPS behind current price.
// Only runs when the user presses the button — never on a timer.
async function trailStops() {
  const ready = await exnessTabReady();
  if (!ready.tab) return { ok: false, error: ready.error };
  try {
    return await chrome.tabs.sendMessage(ready.tab.id, { type: "TRAIL_STOPS" });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Support / Resistance on the TradingView chart -------------------------
// Drawn through the chart's own shape API. The widget object lives in the page's
// MAIN world (not our content script's isolated world), so we inject a function
// into MAIN to create/remove the horizontal lines.
// Prefer the focused Exness tab: with several tabs open, tabs[0] can be a
// stale background tab, and shapes drawn there are invisible to the user.
// "Active" is per-window, so a focused window wins when there are several.
function pickExnessTab(tabs) {
  return tabs.find((t) => t.active) || tabs[0];
}

async function exnessTab() {
  const tabs = await chrome.tabs.query({ url: "https://my.exness.com/webtrading/*" });
  const focused = await chrome.windows.getLastFocused();
  return tabs.find((t) => t.active && t.windowId === focused.id) || pickExnessTab(tabs) || null;
}

async function drawSupportResistance() {
  const tab = await exnessTab();
  if (!tab) return { ok: false, error: "Tab Exness tidak terbuka" };

  // Prefer the levels the analysis picked (LLM-validated). Fall back to raw
  // technical candidates only when no analysis exists yet.
  const { lastSignal } = await chrome.storage.local.get("lastSignal");
  const bandHint = await (async () => {
    try {
      const candles = await getCandles();
      if (candles.length >= 14) {
        const i = computeIndicators(candles);
        return i.atr14 || null;
      }
    } catch { /* no candles yet */ }
    return null;
  })();
  let payload;
  if (lastSignal?.supports?.length || lastSignal?.resistances?.length) {
    payload = {
      supports: lastSignal.supports,
      resistances: lastSignal.resistances,
      breakout: lastSignal.breakout ?? null,
      breakdown: lastSignal.breakdown ?? null,
      bandHint
    };
  } else {
    let candles = await getCandles();
    if (candles.length < 30) {
      const bf = await requestBackfill();
      if (bf.ok) candles = await getCandles();
      else
        return {
          ok: false,
          error: `Candle belum cukup (${candles.length}/30) — backfill gagal: ${bf.error}`
        };
    }
    if (candles.length < 30)
      return { ok: false, error: `Candle belum cukup (${candles.length}/30). Klik Backfill dulu.` };
    const levels = computeLevels(candles);
    payload = { supports: levels.supports, resistances: levels.resistances, breakout: null, breakdown: null, bandHint };
  }

  if (!payload.supports.length && !payload.resistances.length)
    return { ok: false, error: "Belum ada level terdeteksi" };

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: paintSrLines,
      args: [payload]
    });
    if (!res?.result?.ok)
      return { ok: false, error: res?.result?.error || "Chart API tidak tersedia" };
    return { ...res.result, levels: payload };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function clearSupportResistance() {
  const tab = await exnessTab();
  if (!tab) return { ok: false, error: "Tab Exness tidak terbuka" };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: clearSrLines
    });
    return res?.result || { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Runs in the page MAIN world. window.tvWidget is the Exness chart instance.
// NOTE: TradingView ignores our requested `id` and mints random ones, and the
// shape handles only expose {id, name}. We therefore identify our own lines by
// diffing the shape list before/after drawing, and remember those ids on the
// page so "Hapus S/R" can remove exactly them.
async function paintSrLines(levels) {
  try {
    const chart = window.tvWidget?.activeChart?.();
    if (!chart) return { ok: false, error: "tvWidget tidak ditemukan" };

    // 1. Remove every S/R line the extension ever drew — identified by its
    // label text, not by remembered ids. Ids live only in window and vanish on
    // each reload, which is what let stale lines pile up one by one; matching
    // the label also cleans up leftovers from older builds.
    const isOwnSr = (text, name) =>
      name === "rectangle" ||
      text.startsWith("S ") ||
      text.startsWith("R ") ||
      text.startsWith("BREAK↑") ||
      text.startsWith("BREAK↓");
    for (const s of await chart.getAllShapes()) {
      let text = "";
      try { text = chart.getShapeById(s.id)?.getProperties?.()?.text || ""; } catch { /* unreadable */ }
      if (isOwnSr(text, s.name)) {
        try { chart.removeEntity(s.id); } catch { /* already gone */ }
      }
    }
    window.__aiSrIds = [];

    // 2. Snapshot the rest of the chart so we can diff out ours later.
    const before = new Set((await chart.getAllShapes()).map((s) => s.id));
    const vr = await chart.getVisibleRange();
    const leftTime = Math.floor(vr.from);
    const rightTime = Math.ceil(vr.to);

    // Each S/R level is drawn as a translucent BAND (rectangle) centered on the
    // level, like a price corridor — far easier to read at a glance than a thin
    // 1px line. The band half-height is a fraction of ATR so it stays
    // proportional to volatility.
    const halfBand = levels.bandHint ? Math.max(levels.bandHint * 0.25, 0.5) : 1.5;

    const paint = async (level, kind) => {
      const isSupport = kind === "support";
      const fill = isSupport ? "rgba(8, 153, 129, 0.22)" : "rgba(242, 54, 69, 0.22)";
      const edge  = isSupport ? "#089981" : "#F23645";
      const text = `${isSupport ? "S" : "R"} ${level.price.toFixed(3)} (${level.touches}x)`;
      const top = level.price + halfBand, bot = level.price - halfBand;
      const errors = [];
      try {
        // Filled zone (the professional "channel" look), spanning the full view.
        // createShape rejects 2 points for rectangle — must use createMultipointShape.
        await chart.createMultipointShape(
          [{ time: leftTime, price: top }, { time: rightTime, price: bot }],
          {
            shape: "rectangle", lock: true, disableSave: true,
            overrides: {
              fillBackground: true, backgroundColor: fill,
              color: edge, linewidth: 1,
              text, textColor: edge, fontSize: 10, bold: true
            }
          }
        );
      } catch (e) { errors.push(`band ${text}: ${e.message}`); }
      try {
        // Solid edge line at the exact level for a crisp price tag
        await chart.createShape(
          { text, points: [{ time: leftTime, price: level.price }], zorder: "top" },
          {
            shape: "horizontal_line", lock: true, disableSave: true,
            overrides: { linecolor: edge, linewidth: 2, linestyle: level.touches >= 3 ? 0 : 2, showLabel: true, text, textcolor: edge, toptext: true }
          }
        );
      } catch (e) { errors.push(`line ${text}: ${e.message}`); }
      return errors;
    };

    const paintErrors = [];
    for (const l of levels.supports) paintErrors.push(...(await paint(l, "support")));
    for (const l of levels.resistances) paintErrors.push(...(await paint(l, "resistance")));

    // Break lines from the analysis: dotted, orange, labelled so the trigger
    // price is unmistakable next to the plain S/R levels.
    const paintBreak = async (price, label) => {
      if (price == null) return [];
      try {
        await chart.createShape(
          { text: `${label} ${price.toFixed(3)}`, points: [{ time: leftTime, price }], zorder: "top" },
          {
            shape: "horizontal_line",
            lock: true,
            disableSave: true,
            overrides: {
              linecolor: "#FFA500",
              linewidth: 2,
              linestyle: 1, // dotted
              showLabel: true,
              text: `${label} ${price.toFixed(3)}`,
              textcolor: "#FFA500",
              toptext: true
            }
          }
        );
      } catch (e) { return [`${label}: ${e.message}`]; }
      return [];
    };
    paintErrors.push(...(await paintBreak(levels.breakout, "BREAK↑")));
    paintErrors.push(...(await paintBreak(levels.breakdown, "BREAK↓")));

    // 5. Anything that appeared is ours.
    const after = await chart.getAllShapes();
    const ids = after.map((s) => s.id).filter((id) => !before.has(id));
    window.__aiSrIds = ids;
    if (!ids.length)
      return { ok: false, error: paintErrors[0] || "Tidak ada shape tergambar (chart API reject diam-diam)" };
    return { ok: true, drawn: ids.length, errors: paintErrors };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Also runs in MAIN world: removes every line this extension drew. Matched by
// label text (not remembered ids) so stale shapes from earlier reloads or
// builds are cleaned up too.
async function clearSrLines() {
  try {
    const chart = window.tvWidget?.activeChart?.();
    if (!chart) return { ok: true };
    const isOwnSr = (text, name) =>
      name === "rectangle" ||
      text.startsWith("S ") ||
      text.startsWith("R ") ||
      text.startsWith("BREAK↑") ||
      text.startsWith("BREAK↓");
    for (const s of await chart.getAllShapes()) {
      let text = "";
      try { text = chart.getShapeById(s.id)?.getProperties?.()?.text || ""; } catch { /* unreadable */ }
      if (isOwnSr(text, s.name)) {
        try { chart.removeEntity(s.id); } catch { /* gone */ }
      }
    }
    window.__aiSrIds = [];
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Draw the analyzed trade plan as a TradingView Position Tool: entry line at
// the signal price, red zone to SL, green zone to TP (both from the LLM's
// slPips/tpPips). Purely visual — the user still clicks Buy/Sell manually.
const PIPS_TO_PRICE = 0.01; // 1 pip XAUUSD = 0.01 price units
const PRICE_TO_TICKS = 100; // 1000 ticks = 10.0 price (verified on live chart)

async function drawPosition() {
  const tab = await exnessTab();
  if (!tab) return { ok: false, error: "Tab Exness tidak terbuka" };

  const { lastSignal } = await chrome.storage.local.get("lastSignal");
  if (!lastSignal) return { ok: false, error: "Belum ada sinyal. Klik Analyze dulu." };
  if (lastSignal.signal === "WAIT")
    return { ok: false, error: "Sinyal terakhir WAIT — tidak ada rencana posisi." };

  const plan = {
    side: lastSignal.signal,
    entry: lastSignal.indicators?.price,
    slPips: lastSignal.slPips,
    tpPips: lastSignal.tpPips,
    confidence: lastSignal.confidence,
    reason: (lastSignal.reason || "").slice(0, 80)
  };
  if (!plan.entry) return { ok: false, error: "Sinyal tidak menyimpan harga entry." };

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: paintPosition,
      args: [plan]
    });
    return res?.result || { ok: false, error: "Chart API tidak tersedia" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Runs in MAIN world. long_position/short_position take TWO anchor points at
// the entry price; SL/TP are set afterwards via properties in TICK units
// (points past at creation are silently ignored, so the two-step is required).
async function paintPosition(plan) {
  try {
    const chart = window.tvWidget?.activeChart?.();
    if (!chart) return { ok: false, error: "tvWidget tidak ditemukan" };

    // The Position Tool ignores the `text` override (property stays empty), so
    // there is no durable label to match. This extension is the only thing
    // creating positions programmatically — remove ALL of them on redraw so
    // stale shapes from earlier reloads can never pile up.
    for (const s of await chart.getAllShapes()) {
      if (s.name === "long_position" || s.name === "short_position") {
        try { chart.removeEntity(s.id); } catch { /* already gone */ }
      }
    }
    window.__aiPosIds = [];

    const before = new Set((await chart.getAllShapes()).map((s) => s.id));
    const vr = await chart.getVisibleRange();
    const leftTime = Math.floor(vr.from);
    const rightTime = Math.ceil(vr.to);

    const shape = plan.side === "BUY" ? "long_position" : "short_position";
    const color = plan.side === "BUY" ? "#00C896" : "#FF4757";
    // serialized into MAIN world, so keep all constants in-scope here
    const pipsToPrice = 0.01; // 1 pip XAUUSD
    const priceToTicks = 100; // 1000 ticks = 10.0 price (verified on live chart)
    const ticksPerPip = pipsToPrice * priceToTicks;
    const stopTicks = Math.round(Math.abs(plan.slPips) * ticksPerPip);
    const profitTicks = Math.round(Math.abs(plan.tpPips) * ticksPerPip);

    const label =
      `${plan.side} ${Math.round(plan.confidence * 100)}% · SL ${Math.abs(plan.slPips)}p / TP ${Math.abs(plan.tpPips)}p`;

    await chart.createMultipointShape(
      [
        { time: leftTime, price: plan.entry },
        { time: rightTime, price: plan.entry }
      ],
      {
        shape,
        lock: true,
        disableSave: true,
        overrides: {
          text: label,
          textcolor: color,
          showPriceLabels: true,
          alwaysShowStats: true,
          compact: false,
          stopBackground: "rgba(242, 54, 69, 0.30)",
          profitBackground: "rgba(8, 153, 129, 0.30)",
          linecolor: color,
          stopBackgroundTransparency: 70,
          profitBackgroundTransparency: 70
        }
      }
    );

    const after = await chart.getAllShapes();
    const ids = after.map((s) => s.id).filter((id) => !before.has(id));
    window.__aiPosIds = ids;

    for (const id of ids) {
      try {
        chart.getShapeById(id).setProperties({ stopLevel: stopTicks, profitLevel: profitTicks });
      } catch { /* non-fatal: line drawn, zones may default */ }
    }

    const slPrice =
      plan.side === "BUY"
        ? plan.entry - Math.abs(plan.slPips) * pipsToPrice
        : plan.entry + Math.abs(plan.slPips) * pipsToPrice;
    const tpPrice =
      plan.side === "BUY"
        ? plan.entry + Math.abs(plan.tpPips) * pipsToPrice
        : plan.entry - Math.abs(plan.tpPips) * pipsToPrice;

    return { ok: true, side: plan.side, entry: plan.entry, slPrice, tpPrice };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function clearPosition() {
  const tab = await exnessTab();
  if (!tab) return { ok: false, error: "Tab Exness tidak terbuka" };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: clearPositionShapes
    });
    return res?.result || { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Runs in MAIN world: removes exactly the position shapes we drew.
async function clearPositionShapes() {
  try {
    const chart = window.tvWidget?.activeChart?.();
    if (!chart) return { ok: true };
    // The Position Tool ignores the `text` override (property stays empty), so
    // there is no durable label to match. This extension is the only thing
    // creating positions programmatically — remove ALL of them on redraw so
    // stale shapes from earlier reloads can never pile up.
    for (const s of await chart.getAllShapes()) {
      if (s.name === "long_position" || s.name === "short_position") {
        try { chart.removeEntity(s.id); } catch { /* already gone */ }
      }
    }
    window.__aiPosIds = [];
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Trend direction visuals (F: "garis arah pergerakan market") ------------
// Two shapes: (a) a trend_line over the recent bars showing the historical
// slope, (b) a dotted projection from the current price to the analyst's
// targetPrice. Drawn only for BUY/SELL signals — WAIT has no direction.
async function drawTrend(signal, candles) {
  const tab = await exnessTab();
  if (!tab) return { ok: false, error: "Tab Exness tidak terbuka" };

  const atr = signal.indicators?.atr14 || 1;
  const target = signal.targetPrice ?? null;
  // Clamp the LLM's target to ±5 ATR from price — keeps the arrow plausible.
  const entry = signal.indicators?.price;
  const clampedTarget =
    target != null
      ? Math.min(Math.max(target, entry - 5 * atr), entry + 5 * atr)
      : null;

  const plan = {
    side: signal.signal,
    trend: signal.trend || "FLAT",
    entry,
    target: clampedTarget,
    // Price ~20 bars ago anchors the historical trend line.
    pastPrice: candles.length >= 20 ? candles[candles.length - 20].c : null,
    pastTime: candles.length >= 20 ? candles[candles.length - 20].time : null
  };
  if (!plan.entry || !plan.pastPrice) return { ok: false, error: "Data tren tidak lengkap" };

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: paintTrend,
      args: [plan]
    });
    return res?.result || { ok: false, error: "Chart API tidak tersedia" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function clearTrend() {
  const tab = await exnessTab();
  if (!tab) return { ok: false, error: "Tab Exness tidak terbuka" };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: clearTrendShapes
    });
    return res?.result || { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Panel-button variant: read the current signal + candles from storage.
async function drawTrendFromStorage() {
  const { lastSignal } = await chrome.storage.local.get("lastSignal");
  if (!lastSignal || lastSignal.signal === "WAIT")
    return { ok: false, error: "Tidak ada sinyal arah (WAIT) — tidak digambar." };
  const candles = await getCandles();
  return drawTrend(lastSignal, candles);
}

const TREND_LABEL = "TREND";

// Runs in MAIN world. Removes previous trend shapes first (matched by the
// TREND label so reloads can't pile them up), then draws:
// 1. trend_line from pastPrice -> entry (the historical slope)
// 2. a dotted trend_line from entry -> target (the prediction ray)
async function paintTrend(plan) {
  try {
    const chart = window.tvWidget?.activeChart?.();
    if (!chart) return { ok: false, error: "tvWidget tidak ditemukan" };

    for (const s of await chart.getAllShapes()) {
      if (s.name !== "trend_line" && s.name !== "arrow" && s.name !== "ray") continue;
      let text = "";
      try { text = chart.getShapeById(s.id)?.getProperties?.()?.text || ""; } catch { /* unreadable */ }
      if (text.startsWith("TREND")) {
        try { chart.removeEntity(s.id); } catch { /* already gone */ }
      }
    }

    const color = plan.trend === "UP" ? "#089981" : plan.trend === "DOWN" ? "#F23645" : "#8B949E";
    const arrow = plan.side === "BUY" ? "↑" : plan.side === "SELL" ? "↓" : "→";

    // Historical slope over the recent bars.
    try {
      await chart.createMultipointShape(
        [
          { time: Math.floor(plan.pastTime / 1000), price: plan.pastPrice },
          { time: Math.floor(Date.now() / 1000), price: plan.entry }
        ],
        {
          shape: "trend_line",
          lock: true,
          disableSave: true,
          overrides: {
            linecolor: color,
            linewidth: 2,
            text: `TREND ${plan.trend} (historis)`,
            textColor: color
          }
        }
      );
    } catch { /* historical line is best-effort */ }

    // Prediction projection to the target price.
    if (plan.target != null) {
      try {
        const vr = await chart.getVisibleRange();
        const rightTime = Math.ceil(vr.to);
        await chart.createMultipointShape(
          [
            { time: Math.floor(Date.now() / 1000), price: plan.entry },
            { time: rightTime, price: plan.target }
          ],
          {
            shape: "trend_line",
            lock: true,
            disableSave: true,
            overrides: {
              linecolor: color,
              linewidth: 2,
              linestyle: 2, // dashed = prediction, not history
              text: `TREND ${arrow} target ${plan.target.toFixed(2)}`,
              textColor: color
            }
          }
        );
      } catch { /* projection is best-effort */ }
    }

    return { ok: true, trend: plan.trend, target: plan.target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function clearTrendShapes() {
  try {
    const chart = window.tvWidget?.activeChart?.();
    if (!chart) return { ok: true };
    for (const s of await chart.getAllShapes()) {
      if (s.name !== "trend_line" && s.name !== "arrow" && s.name !== "ray") continue;
      let text = "";
      try { text = chart.getShapeById(s.id)?.getProperties?.()?.text || ""; } catch { /* unreadable */ }
      if (text.startsWith("TREND")) {
        try { chart.removeEntity(s.id); } catch { /* gone */ }
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// In-flight guard + a stale-check so the panel button recovers even if the
// service worker was killed mid-analysis (MV3 idle timeout) and the
// sendMessage response never arrived.
let analyzing = false;

function isStale(analysisAt) {
  // Generous ceiling: 2 LLM calls x 3 retries x 45s timeout each.
  return !analysisAt || Date.now() - analysisAt > 5 * 60 * 1000;
}

async function runAnalysis() {
  if (analyzing) return { error: "Analisa masih berjalan…" };
  analyzing = true;
  await chrome.storage.local.set({ analysisAt: Date.now() });
  try {
    return await doAnalysis();
  } finally {
    analyzing = false;
    await chrome.storage.local.remove("analysisAt");
  }
}

// Multi-round debate: the debater attacks, the analyst rebuts, and the
// exchange repeats until they agree or maxRounds is hit. Returns the last
// debater verdict plus the round-by-round transcript for the panel.
async function runDebate(ind, news, levels, analyst, settings, maxRounds = 2) {
  const ctx = await buildContextBlock(settings);
  const rounds = [];
  const prompts = { debater: [], defense: [] };
  let debate = null;
  for (let r = 1; r <= maxRounds; r++) {
    const prompt = buildDebaterPrompt(ind, news, levels, analyst, ctx, rounds);
    prompts.debater.push(prompt);
    debate = normDebate(await callLLM(prompt, { settings, temperature: 0.3, maxTokens: 1200 }));
    if (debate.agree) {
      rounds.push({ round: r, agree: true, counter: debate.counter, flips: null, defense: null });
      break;
    }
    rounds.push({ round: r, agree: false, counter: debate.counter, flips: debate.flips, defense: null });
    if (r === maxRounds) break; // last round: no rebuttal round follows
    const defPrompt = buildDefensePrompt(ind, news, levels, analyst, debate.counter, ctx);
    prompts.defense.push(defPrompt);
    const d = normDefense(await callLLM(defPrompt, { settings, temperature: 0.3, maxTokens: 800 }));
    rounds[rounds.length - 1].defense = d.defense;
    rounds[rounds.length - 1].concede = d.concede;
    if (d.concede) break;
  }
  return { debate, rounds, prompts };
}

// Shared prep for the panel-driven flows (manual debate, prompt preview).
async function prepareAnalysisInputs() {
  let candles = await getCandles();
  if (candles.length < 30) {
    const bf = await requestBackfill();
    if (bf.ok) candles = await getCandles();
    else return { error: `Candle belum cukup (${candles.length}/30). ${bf.error}` };
  }
  const settings = await getSettings();
  return {
    candles,
    indicators: computeIndicators(candles),
    news: await fetchNews(),
    settings,
    levels: computeLevels(candles)
  };
}

// Stacks per-round prompt captures into one previewable text block.
function joinRoundPrompts(list) {
  if (!list || !list.length) return "";
  if (list.length === 1) return list[0];
  return list.map((p, i) => `--- RONDE ${i + 1} ---\n${p}`).join("\n\n");
}

// Runs a debate on current data WITHOUT touching lastSignal/badge/history —
// the panel shows the result, the scheduled analysis is unaffected.
async function runManualDebate() {
  const prep = await prepareAnalysisInputs();
  if (prep.error) return { ok: false, error: prep.error };
  const { indicators, news, levels, settings } = prep;

  const ctx = await buildContextBlock(settings);
  const analystPrompt = buildAnalystPrompt(indicators, news, levels, ctx);
  const analyst = await askAnalyst(indicators, news, levels, settings, analystPrompt);
  const { debate, rounds, prompts } = await runDebate(indicators, news, levels, analyst, settings, 2);
  const final = decideFinal(analyst, debate);

  return {
    ok: true,
    analyst: {
      signal: analyst.signal,
      confidence: analyst.confidence,
      reason: analyst.reason,
      trend: analyst.trend,
      targetPrice: analyst.targetPrice,
      keyRisks: analyst.keyRisks || []
    },
    debate,
    rounds,
    final: { signal: final.signal, confidence: final.confidence },
    prompts: {
      analyst: analystPrompt,
      debater: joinRoundPrompts(prompts.debater),
      defense: joinRoundPrompts(prompts.defense)
    }
  };
}

// Renders the exact prompts that would be sent, without calling the LLM.
async function previewDebatePrompts() {
  const prep = await prepareAnalysisInputs();
  if (prep.error) return { ok: false, error: prep.error };
  const { indicators, news, levels, settings } = prep;
  const ctx = await buildContextBlock(settings);
  const analyst = buildAnalystPrompt(indicators, news, levels, ctx);
  // A representative analyst verdict so the debater prompt has something to
  // attack in the preview.
  const stubAnalyst = {
    signal: "BUY",
    confidence: 0.7,
    reason: "(contoh — analyst placeholder)",
    trend: "UP",
    targetPrice: indicators.price,
    keyRisks: ["(contoh) resistance dekat"]
  };
  const debater = buildDebaterPrompt(indicators, news, levels, stubAnalyst, ctx);
  const defense = buildDefensePrompt(indicators, news, levels, stubAnalyst, "(contoh counter)", ctx);
  return { ok: true, analyst, debater, defense, ctx };
}

async function doAnalysis() {
  let candles = await getCandles();

  // Not enough history yet -> try a one-shot backfill from the Exness tab.
  if (candles.length < 30) {
    const bf = await requestBackfill();
    if (bf.ok) candles = await getCandles();
    else
      return {
        error: `Candle belum cukup (${candles.length}/30). ${bf.error}`
      };
  }

  const indicators = computeIndicators(candles);
  const news = await fetchNews();
  const settings = await getSettings();
  // Candidate levels from swing clustering — the LLM (or the fallback) picks
  // the key ones and decides possible breakout/breakdown points.
  const levels = computeLevels(candles);

  let signal;
  let process = null;
  try {
    // Stage 1 — the analyst proposes a trade plan.
    const analyst = await askAnalyst(indicators, news, levels, settings);

    // Stage 2 — multi-round debate. Failure is non-fatal: we keep the analyst's
    // verdict and annotate it.
    let debate;
    let rounds = [];
    try {
      const dr = await runDebate(indicators, news, levels, analyst, settings, 2);
      debate = dr.debate;
      rounds = dr.rounds;
    } catch (e) {
      debate = { agree: true, counter: `debat gagal: ${e.message.slice(0, 40)}`, confidence: analyst.confidence, flips: null, error: e.message.slice(0, 60) };
    }
    signal = decideFinal(analyst, debate);
    process = {
      at: Date.now(),
      analyst: {
        signal: analyst.signal,
        confidence: analyst.confidence,
        trend: analyst.trend || "FLAT",
        targetPrice: analyst.targetPrice ?? null,
        reason: analyst.reason,
        keyRisks: analyst.keyRisks || []
      },
      debate: { agree: debate.agree, counter: debate.counter, flips: debate.flips },
      rounds,
      final: { signal: signal.signal, confidence: signal.confidence }
    };
  } catch (e) {
    console.warn("[AI-TS] LLM failed, using heuristic fallback:", e.message);
    signal = heuristicSignal(indicators, settings);
    signal.reason += ` (LLM error: ${e.message.slice(0, 40)})`;
  }

  // Keep the analyzed levels alongside the signal: Gambar S/R draws exactly
  // what the analysis decided. Fall back per-side to the raw candidates when
  // the LLM did not return that side (or when the heuristic took over).
  const llmLevels = (signal.supports?.length || signal.resistances?.length) && signal.levelSource === "llm";
  signal.supports = snapToCandidates(signal.supports, levels.supports, levels.tolerance);
  signal.resistances = snapToCandidates(signal.resistances, levels.resistances, levels.tolerance);
  if (!signal.supports.length) signal.supports = levels.supports;
  if (!signal.resistances.length) signal.resistances = levels.resistances;
  signal.levelSource = llmLevels && (signal.supports.length || signal.resistances.length) ? "llm" : "teknikal";
  if (signal.breakout != null) signal.breakout = snapPrice(signal.breakout, levels.resistances, levels.tolerance);
  if (signal.breakdown != null) signal.breakdown = snapPrice(signal.breakdown, levels.supports, levels.tolerance);

  const lastSignal = { ...signal, process, time: Date.now(), indicators, news };

  await chrome.storage.local.set({ lastSignal });
  await pushLog(lastSignal);
  await updateBadge(lastSignal);

  // Refresh the on-chart position plan alongside the analysis so the entry/SL/TP
  // zones always match the newest signal. WAIT clears the previous plan.
  if (lastSignal.signal === "WAIT") {
    await clearPosition();
    await clearTrend();
  } else {
    await drawPosition();
    await drawTrend(lastSignal, candles);
  }

  return lastSignal;
}

// The LLM may invent a price slightly off the computed candidates. Snap each
// chosen level to the nearest candidate within tolerance; drop the rest.
function snapToCandidates(chosen, candidates, tol) {
  if (!Array.isArray(chosen) || !candidates.length) return [];
  const out = [];
  for (const c of chosen) {
    const near = candidates.reduce(
      (best, cand) => (Math.abs(cand.price - c.price) < Math.abs(best.price - c.price) ? cand : best),
      candidates[0]
    );
    if (Math.abs(near.price - c.price) <= tol) {
      if (!out.some((o) => o.price === near.price)) out.push({ ...near, note: c.note || near.note || "" });
    }
  }
  return out;
}

function snapPrice(price, candidates, tol) {
  if (!candidates.length) return null;
  const near = candidates.reduce(
    (best, cand) => (Math.abs(cand.price - price) < Math.abs(best.price - price) ? cand : best),
    candidates[0]
  );
  return Math.abs(near.price - price) <= tol ? near.price : price;
}

function heuristicSignal(i, settings) {
  // 1 pip XAUUSD = 0.1 price units.
  const atrPips = Math.round((i.atr14 || 5) / 0.1);
  const slPips = Math.min(1000, Math.max(settings.minSlPips, Math.round(1.5 * atrPips)));
  const tpPips = Math.min(2000, Math.max(settings.minSlPips + 50, Math.round(2.5 * atrPips)));
  const volBoost = (i.volRatio || 0) > 1.2;
  if (i.sma9 > i.sma21 && i.rsi14 > 50)
    return { signal: "BUY", confidence: volBoost ? 0.65 : 0.6, reason: volBoost ? "heuristic: SMA9>SMA21 + RSI>50 + volume tinggi" : "heuristic: SMA9>SMA21 + RSI>50", slPips, tpPips };
  if (i.sma9 < i.sma21 && i.rsi14 < 50)
    return { signal: "SELL", confidence: volBoost ? 0.65 : 0.6, reason: volBoost ? "heuristic: SMA9<SMA21 + RSI<50 + volume tinggi" : "heuristic: SMA9<SMA21 + RSI<50", slPips, tpPips };
  return { signal: "WAIT", confidence: 0.5, reason: "heuristic: tidak ada konfluensi", slPips, tpPips };
}

// F-04: economic calendar (high impact, next 24h, max 5). Fallback: text.
async function fetchNews() {
  try {
    const resp = await fetch("https://api.fxmacrodata.com/v1/calendar/usd");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const cal = await resp.json();
    const now = Date.now();
    const upcoming = (cal.events || [])
      .filter((e) => {
        const t = new Date(e.date).getTime();
        return t > now && t < now + 24 * 3600_000 && e.importance === "high";
      })
      .slice(0, 5);
    if (!upcoming.length) return "Tidak ada event high-impact 24 jam ke depan.";
    return upcoming
      .map((e) => `- ${e.date} | ${e.currency} | ${e.name} | forecast: ${e.forecast || "N/A"}`)
      .join("\n");
  } catch {
    return "Kalender tidak tersedia.";
  }
}

// F-05: LLM analysis via local proxy (OpenAI-compatible). Pip clamps live in
// settings.js defaults; SL floor is user-tunable (they got stopped out on
// tight SLs before).
function clampPips(value, fallback, min, max) {
  const n = Number(value);
  if (!isFinite(n) || n < min || n > max) return fallback;
  return Math.round(n);
}

// Normalise a level the LLM returned: {price, touches?, note?} or a bare number.
function normLevel(l) {
  if (typeof l === "number") return { price: l, touches: 1, note: "" };
  if (!l || typeof l.price !== "number") return null;
  return {
    price: l.price,
    touches: Number.isFinite(l.touches) ? l.touches : 1,
    note: typeof l.note === "string" ? l.note.slice(0, 60) : ""
  };
}

function normLevels(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(normLevel).filter(Boolean).slice(0, 4);
}

function validateSignal(json, settings) {
  if (!["BUY", "SELL", "WAIT"].includes(json.signal)) throw new Error("Invalid signal");
  if (typeof json.confidence !== "number" || json.confidence < 0 || json.confidence > 1)
    throw new Error("Invalid confidence");
  if (typeof json.reason !== "string" || !json.reason.length) throw new Error("Invalid reason");
  return {
    signal: json.signal,
    confidence: json.confidence,
    reason: json.reason.slice(0, 200),
    // Direction of the market the analyst reads (drawn on chart).
    trend: ["UP", "DOWN", "FLAT"].includes(json.trend) ? json.trend : "FLAT",
    trendNote: typeof json.trendNote === "string" ? json.trendNote.slice(0, 120) : "",
    targetPrice: typeof json.targetPrice === "number" && isFinite(json.targetPrice) ? json.targetPrice : null,
    keyRisks: Array.isArray(json.keyRisks)
      ? json.keyRisks.filter((r) => typeof r === "string").map((r) => r.slice(0, 80)).slice(0, 2)
      : [],
    // LLM picks the distances; fall back to defaults if missing/out of range.
    slPips: clampPips(json.slPips, settings.defaultSlPips, settings.minSlPips, 1000),
    tpPips: clampPips(json.tpPips, settings.defaultTpPips, settings.minSlPips, 2000),
    // Levels the LLM considers key, plus the price that would confirm a break.
    supports: normLevels(json.supports),
    resistances: normLevels(json.resistances),
    breakout: typeof json.breakout === "number" ? json.breakout : null,
    breakdown: typeof json.breakdown === "number" ? json.breakdown : null,
    levelNote: typeof json.levelNote === "string" ? json.levelNote.slice(0, 120) : "",
    levelSource: "llm"
  };
}

const fmtLevels = (arr) =>
  arr.length
    ? arr.map((l) => `${l.price.toFixed(3)} (${l.touches}x sentuh)`).join(", ")
    : "tidak ada";

// Shared context injected into the analyst AND debater prompts: the trader's
// manual note, the last 5 signals (with how each debate resolved), and any
// open positions. Returns "" when everything is empty so the section is
// skipped entirely (no wasted tokens).
async function buildContextBlock(settings) {
  const parts = [];

  const note = (settings.manualNote || "").trim();
  if (note) parts.push(`CATATAN TRADER:\n${note}`);

  const { signals = [] } = await chrome.storage.local.get("signals");
  const recent = signals.filter((s) => s.signal).slice(0, 5);
  if (recent.length) {
    const lines = recent.map((s, i) => {
      const mins = Math.max(1, Math.round((Date.now() - s.timestamp) / 60000));
      const flip = s.debate
        ? s.debate.flips
          ? ` -> debat: ${s.debate.flips}`
          : " -> debat setuju"
        : "";
      const price = s.priceAtSignal ?? s.indicators?.price ?? "?";
      return `[${i + 1}] ${mins}m lalu: ${s.signal} ${Math.round((s.confidence || 0) * 100)}% @ ${price}${flip}`;
    });
    parts.push(`5 SINYAL TERAKHIR:\n${lines.join("\n")}`);
  }

  const { positions = [] } = await chrome.storage.local.get("positions");
  if (positions.length) {
    const lines = positions.map(
      (p) =>
        `${p.side} ${p.volume} lot entry ${p.entry} sekarang ${p.current} (P/L ${p.profitLoss})`
    );
    parts.push(`POSISI TERBUKA:\n${lines.join("\n")}`);
  }

  if (!parts.length) return "";
  return `KONTEKS DATA TERKUMPUL (pertimbangkan saat menyusun analisa & risiko):\n${parts.join("\n\n")}`;
}

function buildAnalystPrompt(ind, news, levels, ctx) {
  return `Kamu senior market analis XAUUSD M15 (gold) dengan pengalaman 15 tahun. Output JSON saja.

DATA PASAR:
HARGA: ${ind.price.toFixed(2)}
SMA9: ${ind.sma9.toFixed(2)} | SMA21: ${ind.sma21.toFixed(2)} | RSI14: ${ind.rsi14.toFixed(1)}
BB Upper: ${ind.bbUpper.toFixed(2)} | BB Lower: ${ind.bbLower.toFixed(2)}
MACD Hist: ${ind.macdHist.toFixed(3)} | ATR14: ${ind.atr14.toFixed(2)}
Slope SMA9 (20 bar, per bar): ${ind.slopeSMA9.toFixed(3)}
VOLUME: ${ind.volume} (avg 20-bar: ${ind.volSma20.toFixed(1)}, rasio: ${ind.volRatio.toFixed(2)})
Bentuk 5 close terakhir (offset dari harga sekarang): [${ind.recentShape}]

KALENDER HIGH-IMPACT 24 JAM:
${news}

LEVEL S/R TEKNIS (swing M15, kandidat):
SUPPORT: ${fmtLevels(levels.supports)}
RESISTANCE: ${fmtLevels(levels.resistances)}
${ctx ? `\n${ctx}\n` : ""}
METODOLOGI (urutkan proses berpikirmu):
1. Tren: baca slope SMA9 + posisi harga vs SMA9/SMA21 -> trend UP/DOWN/FLAT.
2. Momentum: RSI + MACD hist + posisi vs Bollinger.
3. Volume: rasio volume bar vs rata-rata 20 bar (volRatio > 1 = volume di atas normal). Volume tinggi bisa menguatkan sinyal tren; divergensi/volume rendah melemahkan. Konfirmasi breakout dengan volume.
4. Struktur: jarak harga ke S/R terdekat; breakout/breakdown mana paling mungkin.
5. Risiko: event berita, level terlalu jauh, momentum berlawanan tren.

ATURAN OUTPUT:
1. Event high-impact <30 menit -> signal WAIT.
2. Butuh minimal 2 konfluensi untuk BUY/SELL; confidence >= 0.6, selain itu WAIT. Volume di atas rata-rata (volRatio > 1.2) bisa jadi konfluensi tambahan.
3. trend = UP|DOWN|FLAT; trendNote 1 kalimat arah pasar.
4. targetPrice = prediksi harga tujuan; WAJIB dalam 5x ATR14 dari harga sekarang.
5. keyRisks = 1-2 kelemahan analisamu sendiri (dipakai pendebat).
6. slPips/tpPips dalam PIPS (1 pip = 0.1 USD): SL 100-1000 (jangan ketat, ~1.5-2.5x ATR14), TP 2-4x ATR, TP > SL.
7. supports/resistances: pilih 1-3 dari kandidat di atas (pakai angka kandidat persis). breakout/breakdown dari level relevan atau null. levelNote 1 kalimat.

Format: {"signal":"BUY|SELL|WAIT","confidence":0.0-1.0,"reason":"...","trend":"UP|DOWN|FLAT","trendNote":"...","targetPrice":4180.5,"keyRisks":["..."],"slPips":150,"tpPips":300,"supports":[{"price":4150.3,"touches":9,"note":"..."}],"resistances":[{"price":4175.5,"touches":2,"note":"..."}],"breakout":4175.5,"breakdown":4150.3,"levelNote":"..."}`;
}

// The debater gets the SAME market data plus the analyst's full output, and is
// told to attack it with numbers, not opinions. `priorRounds` carries earlier
// defense/counter turns so a multi-round debate stays coherent.
function buildDebaterPrompt(ind, news, levels, analyst, ctx, priorRounds = []) {
  const history = priorRounds.length
    ? `\nRIWAYAT DEBAT SEBELUMNYA:\n${priorRounds
        .map((r) => `Ronde ${r.round}: pendebat bilang "${r.counter}" -> analis membela "${r.defense || "-"}"`)
        .join("\n")}\n`
    : "";
  return `Kamu pendebat kontrarian senior di desk XAUUSD M15. Tugasmu MENYERANG analisa bawah — bukan sekadar setuju. Output JSON saja.

DATA PASAR (sumber kebenaran):
HARGA: ${ind.price.toFixed(2)}
SMA9: ${ind.sma9.toFixed(2)} | SMA21: ${ind.sma21.toFixed(2)} | RSI14: ${ind.rsi14.toFixed(1)}
BB Upper: ${ind.bbUpper.toFixed(2)} | BB Lower: ${ind.bbLower.toFixed(2)}
MACD Hist: ${ind.macdHist.toFixed(3)} | ATR14: ${ind.atr14.toFixed(2)}
Slope SMA9 (20 bar): ${ind.slopeSMA9.toFixed(3)}
VOLUME: ${ind.volume} (avg 20-bar: ${ind.volSma20.toFixed(1)}, rasio: ${ind.volRatio.toFixed(2)})
Bentuk 5 close terakhir (offset dari harga sekarang): [${ind.recentShape}]
KALENDER HIGH-IMPACT 24 JAM:
${news}
SUPPORT: ${fmtLevels(levels.supports)}
RESISTANCE: ${fmtLevels(levels.resistances)}
${ctx ? `\n${ctx}\n` : ""}
ANALISA YANG DIBANTAH:
${JSON.stringify(analyst)}
${history}
ATURAN PENDABAT:
1. Bantahan HARUS menyebut angka dari data di atas (contoh: "RSI ${ind.rsi14.toFixed(0)} sudah dekat overbought", "harga ${ind.price.toFixed(2)} masih di bawah SMA21 ${ind.sma21.toFixed(2)}").
2. Cek dulu risiko yang si analis akui sendiri (keyRisks) — kalau fatal, tolak sinyalnya.
3. agree = true hanya kalau bantahanmu kalah kuat.
4. flips = sinyal yang menurutmu lebih benar ("BUY"/"SELL"/"WAIT"); null kalau kamu setuju.
5. confidence = keyakinanmu terhadap posisimu (0-1).
6. Gunakan KONTEKS DATA TERKUMPUL sebagai amunisi bantahan: kalau analis mengabaikan CATATAN TRADER atau bertentangan dengan hasil debat sebelumnya, tolak analisanya. Jangan setuju hanya karena analis mengulang sinyal debater yang gagal sebelumnya.
7. Kalau ini bukan ronde pertama, kamu boleh mengubah keputusanmu bila pembelaan analis memang kuat — jangan keras kepala demi konsistensi.

Format: {"agree":true|false,"counter":"1 kalimat bantahan terkuat berbasis angka","confidence":0.0-1.0,"flips":null|"BUY"|"SELL"|"WAIT"}`;
}

// The analyst's rebuttal turn in a multi-round debate: it sees the debater's
// counter and must either defend its call (with numbers) or concede.
function buildDefensePrompt(ind, news, levels, analyst, counter, ctx) {
  return `Kamu analis XAUUSD M15 yang barusan dihujani bantahan. Output JSON saja.

DATA PASAR:
HARGA: ${ind.price.toFixed(2)}
SMA9: ${ind.sma9.toFixed(2)} | SMA21: ${ind.sma21.toFixed(2)} | RSI14: ${ind.rsi14.toFixed(1)}
MACD Hist: ${ind.macdHist.toFixed(3)} | ATR14: ${ind.atr14.toFixed(2)}
VOLUME: ${ind.volume} (avg: ${ind.volSma20.toFixed(1)}, rasio: ${ind.volRatio.toFixed(2)})
${ctx ? `\n${ctx}\n` : ""}
SINYALMU:
${JSON.stringify({ signal: analyst.signal, confidence: analyst.confidence, reason: analyst.reason, slPips: analyst.slPips, tpPips: analyst.tpPips })}

BANTAHAN PENDABAT:
"${counter}"

ATURAN:
1. Belalah dengan angka dari data. Kalau bantahan lebih kuat, AKUI (concede = true) dan sebut kelemahanmu.
2. Jangan pindah kubu cuma karena desakan — hanya kalau data memang mendukung bantahan.
3. confidence = keyakinanmu setelah bantahan (0-1).

Format: {"concede":true|false,"defense":"1 kalimat pembelaan/akuan berbasis angka","confidence":0.0-1.0}`;
}

// Final verdict computed in JS from the analyst vs debater outcome.
function decideFinal(analyst, debate) {
  if (debate.agree || !["BUY", "SELL", "WAIT"].includes(debate.flips)) {
    return { ...analyst, reason: analyst.reason };
  }
  if (debate.flips === "WAIT") {
    return {
      ...analyst,
      signal: "WAIT",
      confidence: 0.5,
      reason: `${analyst.reason} [Debat menolak: ${debate.counter}]`.slice(0, 200)
    };
  }
  // Debater flipped the side — average the two confidences.
  const conf = Math.round(((analyst.confidence + debate.confidence) / 2) * 100) / 100;
  return {
    ...analyst,
    signal: debate.flips,
    confidence: conf,
    reason: `${analyst.reason} [Debat: ${debate.counter}]`.slice(0, 200)
  };
}

// Shared LLM transport for analyst, debater, and defense turns. Returns the
// parsed JSON object; validation happens in the caller. Retries with a fresh
// timeout per attempt (a shared AbortController would poison later retries).
async function callLLM(prompt, { settings, temperature = 0.2, maxTokens = 2000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    try {
      const resp = await fetch(`${settings.llmBaseUrl || CONFIG.LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${settings.llmApiKey || CONFIG.LLM_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [{ role: "user", content: prompt }],
          temperature,
          max_tokens: maxTokens,
          response_format: { type: "json_object" }
        })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await readLLMBody(resp);
      const msg = data.choices?.[0]?.message || {};
      // Reasoning models may put the answer in reasoning_content instead.
      const content = msg.content?.trim() || msg.reasoning_content || "";
      if (!content) {
        await chrome.storage.local.set({ llmDebug: { at: Date.now(), attempt, data } });
        throw new Error(`kosong (finish=${data.choices?.[0]?.finish_reason})`);
      }
      return parseLLMJson(content);
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function askAnalyst(ind, news, levels, settings, promptOverride) {
  const prompt = promptOverride || buildAnalystPrompt(ind, news, levels, await buildContextBlock(settings));
  return validateSignal(await callLLM(prompt, { settings }), settings);
}

function normDebate(d) {
  return {
    agree: d.agree === true,
    counter: typeof d.counter === "string" ? d.counter.slice(0, 120) : "",
    confidence:
      typeof d.confidence === "number" && d.confidence >= 0 && d.confidence <= 1
        ? d.confidence
        : 0.5,
    flips: ["BUY", "SELL", "WAIT"].includes(d.flips) ? d.flips : null
  };
}

// Stage 2: the contrarian debater. Failure is non-fatal — runAnalysis keeps the
// analyst's verdict and annotates it.
async function askDebater(ind, news, levels, analyst, settings) {
  const prompt = buildDebaterPrompt(ind, news, levels, analyst, await buildContextBlock(settings));
  return normDebate(await callLLM(prompt, { settings, temperature: 0.3, maxTokens: 1200 }));
}

function normDefense(d) {
  return {
    concede: d.concede === true,
    defense: typeof d.defense === "string" ? d.defense.slice(0, 120) : "",
    confidence:
      typeof d.confidence === "number" && d.confidence >= 0 && d.confidence <= 1
        ? d.confidence
        : 0.5
  };
}

// The proxy appends an SSE terminator ("data: [DONE]") to the non-stream JSON
// body, which breaks resp.json(). Strip it before parsing. Some combos also
// emit "event: ..." lines or double "data:" chunks — cut at the FIRST
// terminator line of either kind.
async function readLLMBody(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    for (const marker of ["data:", "event:"]) {
      const cut = text.indexOf(marker);
      if (cut > 0) {
        try {
          return JSON.parse(text.slice(0, cut).trim());
        } catch {
          /* try next marker */
        }
      }
    }
    // Last resort: the outermost {...} span (proxy may prepend junk).
    const l = text.indexOf("{");
    const r = text.lastIndexOf("}");
    if (l >= 0 && r > l) {
      try {
        return JSON.parse(text.slice(l, r + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error("Respons proxy tidak bisa di-parse");
  }
}

// The proxy may wrap JSON in markdown fences, double-encode it, or truncate the
// tail when a reasoning model overruns max_tokens. Fall back to field extraction.
function parseLLMJson(content) {
  let s = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    let out = JSON.parse(s);
    if (typeof out === "string") out = JSON.parse(out); // double-encoded
    return out;
  } catch {
    /* fall through to field extraction */
  }

  // Last-ditch recovery: slice the outermost {...} span — proxy may prepend
  // prose or truncate the tail mid-string (reasoning models overrun max_tokens).
  const l = s.indexOf("{");
  const r = s.lastIndexOf("}");
  if (l >= 0 && r > l) {
    try {
      return JSON.parse(s.slice(l, r + 1));
    } catch {
      /* fall through to field extraction */
    }
  }

  const sig = s.match(/"signal"\s*:\s*"(BUY|SELL|WAIT)"/i);
  const conf = s.match(/"confidence"\s*:\s*([0-9]*\.?[0-9]+)/i);
  if (!sig) throw new Error("Field 'signal' tidak ditemukan di respons LLM");
  if (!conf) throw new Error("Field 'confidence' tidak ditemukan");

  // reason may itself be truncated; keep whatever arrived.
  const reason = s.match(/"reason"\s*:\s*"([\s\S]*)$/i);
  const sl = s.match(/"slPips"\s*:\s*([0-9]+)/i);
  const tp = s.match(/"tpPips"\s*:\s*([0-9]+)/i);
  return {
    signal: sig[1].toUpperCase(),
    confidence: parseFloat(conf[1]),
    reason: (reason ? reason[1] : "LLM reason terpotong")
      .replace(/\\n/g, " ")
      .replace(/"\s*}\s*$/, "")
      .trim(),
    slPips: sl ? parseInt(sl[1], 10) : undefined,
    tpPips: tp ? parseInt(tp[1], 10) : undefined
  };
}

async function pushLog(entry) {
  const { signals = [] } = await chrome.storage.local.get("signals");
  signals.unshift({
    id: crypto.randomUUID(),
    timestamp: entry.time,
    signal: entry.signal,
    confidence: entry.confidence,
    reason: entry.reason,
    indicators: entry.indicators,
    priceAtSignal: entry.indicators?.price,
    // Debate outcome, kept so the next analysis can learn from past calls.
    analyst: entry.process?.analyst || null,
    debate: entry.process?.debate || null,
    executed: false
  });
  if (signals.length > 1000) signals.length = 1000;
  await chrome.storage.local.set({ signals });
}

async function updateBadge({ signal }) {
  const text = signal === "BUY" ? "↑" : signal === "SELL" ? "↓" : "–";
  const color = signal === "BUY" ? "#00C896" : signal === "SELL" ? "#FF4757" : "#888888";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// Scheduler (F-05 loop). chrome.alarms survives service worker restarts (R6).
// Cadence comes from user settings; refreshAlarm() re-creates it on change.
getSettings().then((s) => refreshAlarm(s));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "analyze") {
    runAnalysis().catch((e) => console.error("[AI-TS] scheduled analyze", e));
  }
});

// Dev hook: lets dev/cdp.mjs eval call internals from the service worker.
globalThis.__aiTS = { runAnalysis, requestBackfill, runManualDebate, previewDebatePrompts, CONFIG };
