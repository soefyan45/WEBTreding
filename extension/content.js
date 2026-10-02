// content.js — runs in the Exness WebTerminal page (not a module: MV3 content scripts can't use ES imports).
// Responsibilities: sample price from document.title, read open positions from DOM, render signal overlay.

function parsePrice(str) {
  if (!str) return null;
  const cleaned = str.replace(/[^\d.-]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// --- Price sampling (F-01) -------------------------------------------------
let lastTick = 0;
let stagnantSince = Date.now();

setInterval(() => {
  const match = document.title.match(/(\d{1,3}(,\d{3})*\.\d+)/);
  if (!match) return;

  const price = parseFloat(match[1].replace(/,/g, ""));
  const now = Date.now();

  if (price === lastTick) {
    if (now - stagnantSince > 60_000) console.warn("[AI-TS] price stagnant > 60s");
  } else {
    lastTick = price;
    stagnantSince = now;
  }

  chrome.runtime.sendMessage({ type: "PRICE_TICK", price, timestamp: now });
}, 1000);

// --- Open positions from DOM (F-10) ----------------------------------------
function readOpenPositions() {
  const rows = document.querySelectorAll(
    '[data-test^="portfolio_list_row_"]:not([data-test*="_group_"]):not([data-test$="_header"])'
  );
  const positions = [];

  rows.forEach((row) => {
    const get = (key) => row.querySelector(`[data-test="${key}"]`);
    const ticket = get("ticket")?.textContent.trim();
    if (!ticket) return;

    const symbol =
      get("symbol")?.querySelector('[data-test^="symbol-"]')?.textContent.trim() || "";
    const type = get("type")?.textContent.trim() || "";
    const volume = parseFloat(get("volume")?.textContent.trim() || "0");
    const entry = parsePrice(get("openPrice")?.textContent);
    // Live WebTerminal labels the mark price "closePrice"; older builds used
    // "currentPrice". Accept whichever is present.
    const current = parsePrice(
      (get("closePrice") || get("currentPrice"))?.textContent
    );

    const tpText = get("tp")?.textContent.trim();
    const slText = get("sl")?.textContent.trim();
    const tp = tpText && tpText !== "Add" && tpText !== "--" ? parsePrice(tpText) : null;
    const sl = slText && slText !== "Add" && slText !== "--" ? parsePrice(slText) : null;

    const plEl = get("pl")?.querySelector('[data-test="pl-value"]');
    const plValue = parseFloat(plEl?.textContent.replace(/\s/g, "") || "0");

    positions.push({
      ticket,
      symbol,
      side: type.toUpperCase(),
      volume,
      entry,
      current,
      sl,
      tp,
      profitLoss: plValue,
      isProfit: plValue > 0,
      isLoss: plValue < 0
    });
  });

  return positions;
}

// Expose for debugging / future LLM position context.
window.__aiTradingReadPositions = readOpenPositions;

// --- Positions poller (F-10) -----------------------------------------------
// The side panel can't read the page DOM, so push positions to storage.
// Only write when something changed, to avoid constant storage churn.
let lastPositionsJson = "";
setInterval(() => {
  const positions = readOpenPositions();
  const json = JSON.stringify(positions);
  if (json === lastPositionsJson) return;
  lastPositionsJson = json;
  chrome.storage.local.set({ positions, positionsAt: Date.now() });
}, 3000);

// --- Historical candle backfill (F-02) -------------------------------------
// The WebTerminal chart reads history from Exness rtapi using auth data that only
// exists in page context (cookie JWT + localStorage). So the fetch happens here,
// then candles are handed to the service worker for storage.
function readCookie(name) {
  const raw = document.cookie.split("; ").find((c) => c.startsWith(name + "=")) || "";
  return decodeURIComponent(raw.split("=")[1] || "");
}

async function backfillCandles(timeFrameSec = 900, count = 300) {
  const jwt = readCookie("JWT");
  const account = localStorage.getItem("texActiveAccountNumber");
  const domain = JSON.parse(localStorage.getItem("texTradingLastGoodDomain") || "{}").domain;
  const cid = readCookie("exterm_web_cid");

  if (!jwt || !account || !domain) {
    throw new Error(
      `auth belum lengkap (jwt=${!!jwt} acc=${!!account} dom=${!!domain} cid=${!!cid}) — pastikan sudah login & pilih akun`
    );
  }

  const url =
    `https://rtapi-sg.${domain}/rtapi/mt5/trial7/v3/accounts/${account}` +
    `/instruments/XAUUSDm/candles?time_frame=${timeFrameSec}` +
    `&from=${Date.now()}&count=-${count}&price=bid`;

  let data;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${jwt}`, "X-Cid": cid, Accept: "application/json" }
    });
    if (!resp.ok) throw new Error(`rtapi jawab HTTP ${resp.status} (session mungkin expired — refresh tab lalu coba lagi)`);
    data = await resp.json();
  } catch (e) {
    if (e.message.startsWith("rtapi jawab")) throw e;
    throw new Error(`rtapi tidak bisa dijangkau (${e.message})`);
  }
  const history = data.price_history || [];
  if (!history.length) throw new Error("rtapi balik tanpa candle (price_history kosong)");

  return history.map((c) => ({ time: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
}

window.__aiTradingBackfill = backfillCandles;

// --- Order panel prefill (user still clicks Buy/Sell + Confirm) ------------
// Selector contract verified against the live WebTerminal DOM (order-panel-XAUUSDm).
const ORDER_PANEL = {
  panel: '[data-test="order-panel-XAUUSDm"]',
  volume: '[data-test="order-panel-volume-input"] [data-test="input"]',
  tpWrap: '[data-test="order-panel-tp-input"]',
  slWrap: '[data-test="order-panel-sl-input"]'
};

// Fallback pip distances when the signal has none (mirrors settings.js
// defaults; the SW sends the real values with PREPARE_ORDER / TRAIL_STOPS).
const FALLBACK_SL_PIPS = 100;
const FALLBACK_TP_PIPS = 200;

// React-controlled inputs ignore el.value = x directly; use the native setter + event.
function setNativeInput(el, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  ).set;
  setter.call(el, String(value));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function readButtonPrice(side) {
  const btn = document.querySelector(`[data-test="order-button-${side}"]`);
  if (!btn) return null;
  const text = [...btn.querySelectorAll("[data-test='first-pip'], [data-test='major-pip'], [data-test='minor-pip']")]
    .map((s) => s.textContent.trim())
    .join("")
    .replace(/,/g, "");
  const n = parseFloat(text);
  return isNaN(n) ? null : n;
}

function inputInWrap(wrapSel) {
  const wrap = document.querySelector(wrapSel);
  return wrap ? wrap.querySelector('[data-test="input"]') : null;
}

// The order panel lets each SL/TP field be entered as Price or Pips via a
// dropdown button (data-test="dropdown-button", label "Price" by default).
// Our values are pip magnitudes, so make sure the field is in Pips mode
// before writing them — otherwise -160 is read as a floor price and rejected.
async function switchToPips(wrapSel) {
  const wrap = document.querySelector(wrapSel);
  if (!wrap) return;
  const btn = wrap.querySelector('[data-test="dropdown-button"]');
  if (!btn) return;
  const label = btn.textContent || "";
  if (/pip/i.test(label)) return "pips"; // already in Pips mode

  // Open the menu and pick the Pips option. Defensive: if the menu item
  // never appears, we just leave the field as-is rather than failing.
  btn.click();
  await new Promise((r) => setTimeout(r, 200));
  const candidates = document.querySelectorAll(
    '[role="menuitem"], [role="option"], [data-test="menu-item"], [data-test^="menu-"], li'
  );
  const pips = [...candidates].find((el) => /pips?$/i.test((el.textContent || "").trim()));
  let applied = false;
  if (pips) {
    pips.click();
    await new Promise((r) => setTimeout(r, 200));
    applied = true;
  }
  // If the toggle landed, the button label now reads "Pips".
  return applied ? "pips" : label || "unknown";
}

// Click the panel's Buy/Sell price button so the confirmation matches the
// signal side. The active button carries class OrderButton_active__*.
// React re-renders asynchronously, so poll for the class to flip.
async function selectOrderSide(side) {
  const which = side === "BUY" ? "buy" : "sell";
  const btn = document.querySelector(`[data-test="order-button-${which}"]`);
  if (!btn) return { ok: false, error: `Tombol ${which.toUpperCase()} tidak ada` };
  if (btn.className.includes("OrderButton_active")) return { ok: true };

  btn.click();
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const el = document.querySelector(`[data-test="order-button-${which}"]`);
    if (el?.className.includes("OrderButton_active")) return { ok: true };
  }
  return { ok: false, error: `Gagal memilih sisi ${side}` };
}

// volume is a lot size; slPips/tpPips are positive magnitudes from the LLM.
// Exness pips convention (verified empirically on both sides): SL input is
// NEGATIVE, TP input is POSITIVE, regardless of Buy or Sell side.
async function fillOrderPanel({ volume, slPips, tpPips }) {
  const panel = document.querySelector(ORDER_PANEL.panel);
  if (!panel) return { ok: false, error: "Order panel tidak terbuka (klik Buy/Sell dulu)" };

  const volEl = panel.querySelector(ORDER_PANEL.volume);
  if (!volEl) return { ok: false, error: "Input panel tidak ditemukan" };

  setNativeInput(volEl, volume);

  // SL/TP are pip values — force both fields into Pips mode first.
  const slMode = await switchToPips(ORDER_PANEL.slWrap);
  const tpMode = await switchToPips(ORDER_PANEL.tpWrap);

  let slApplied = false;
  let tpApplied = false;
  const slEl = inputInWrap(ORDER_PANEL.slWrap);
  const tpEl = inputInWrap(ORDER_PANEL.tpWrap);
  if (slEl) {
    setNativeInput(slEl, -Math.abs(slPips));
    slApplied = true;
  }
  if (tpEl) {
    setNativeInput(tpEl, Math.abs(tpPips));
    tpApplied = true;
  }

  // Give React a tick, then read validation errors the panel surfaced.
  await new Promise((r) => setTimeout(r, 400));
  const slErr = document
    .querySelector(`${ORDER_PANEL.slWrap} [data-test="input-error"]`)
    ?.textContent.trim();
  const tpErr = document
    .querySelector(`${ORDER_PANEL.tpWrap} [data-test="input-error"]`)
    ?.textContent.trim();

  const errors = [slErr && `SL: ${slErr}`, tpErr && `TP: ${tpErr}`].filter(Boolean);
  if (errors.length) return { ok: false, error: errors.join(" · ") };

  return {
    ok: true,
    filled: { volume, slPips: -Math.abs(slPips), tpPips: Math.abs(tpPips) },
    slInputApplied: slApplied,
    tpInputApplied: tpApplied,
    modes: { sl: slMode, tp: tpMode }
  };
}

window.__aiTradingFillOrderPanel = fillOrderPanel;

// Fill the open order panel from the latest signal. With pips mode we do not
// need the entry price at all — only the side (for logging) and a fresh signal.
async function prepareOrderFromSignal() {
  const { lastSignal } = await chrome.storage.local.get("lastSignal");
  if (!lastSignal) return { ok: false, error: "Belum ada sinyal. Klik Analyze dulu." };
  if (lastSignal.signal === "WAIT") return { ok: false, error: "Sinyal terakhir WAIT — tidak diisikan." };

  const age = Date.now() - lastSignal.time;
  if (age > 15 * 60_000) return { ok: false, error: "Sinyal terlalu lama (>15 mnt). Analyze ulang." };

  const side = lastSignal.signal; // BUY | SELL
  const slPips = lastSignal.slPips ?? FALLBACK_SL_PIPS;
  const tpPips = lastSignal.tpPips ?? FALLBACK_TP_PIPS;

  // Volume & trade params come from user settings (SW is the store).
  let volume = 0.01;
  try {
    const s = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (s?.volume) volume = s.volume;
  } catch {
    /* keep 0.01 fallback */
  }

  // Make sure the panel is on the right side (Buy vs Sell) before filling.
  const sel = await selectOrderSide(side);
  if (!sel.ok) return { ok: false, error: sel.error };
  await new Promise((r) => setTimeout(r, 250));

  const res = await fillOrderPanel({ volume, slPips, tpPips });
  if (res.ok) res.info = `${side} · Vol ${volume} · SL ${slPips} pips · TP ${tpPips} pips`;
  return res;
}

window.__aiTradingPrepareOrder = prepareOrderFromSignal;

// --- Trailing stop (F-11, manual trigger) ----------------------------------
// Endpoint confirmed from the Exness bundle: PUT /accounts/{acc}/positions/{ticket}/modify
// with body {position:{sl, tp}}. Important: the API version for this route is v1
// (the v3/v2 paths return "No mapping for HTTP-method: 'PUT'"; candles uses v3,
// modify does not). Empirically 1 "pip" in the panel = 0.01 price units.
const PIP = 0.01;

async function modifyPosition(ticket, sl, tp) {
  const jwt = readCookie("JWT");
  const account = localStorage.getItem("texActiveAccountNumber");
  const domain = JSON.parse(localStorage.getItem("texTradingLastGoodDomain") || "{}").domain;
  const cid = readCookie("exterm_web_cid");
  if (!jwt || !account || !domain)
    return { ok: false, error: `auth missing (jwt=${!!jwt} acc=${!!account} dom=${!!domain})` };

  const url =
    `https://rtapi-sg.${domain}/rtapi/mt5/trial7/v1/accounts/${account}` +
    `/positions/${ticket}/modify`;

  try {
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Cid": cid,
        "Content-Type": "application/json",
        Accept: "application/json",
        Referer: "https://my.exness.com/"
      },
      body: JSON.stringify({ position: { sl, tp } })
    });
    const text = await resp.text();
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 150)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const round3 = (n) => Math.round(n * 1000) / 1000;

async function applyTrailingStops() {
  const positions = readOpenPositions();
  if (!positions.length) return { ok: false, error: "Tidak ada posisi terbuka" };

  let trailPips = 100;
  let minImprovePips = 50;
  try {
    const s = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (s?.trailDistancePips) trailPips = s.trailDistancePips;
    if (s?.trailMinImprovePips) minImprovePips = s.trailMinImprovePips;
  } catch {
    /* keep defaults */
  }

  const moved = [];
  const skipped = [];
  const failed = [];

  for (const p of positions) {
    if (!p.current || p.side === "HEDGED") {
      skipped.push(`#${p.ticket}: no price`);
      continue;
    }
    const dist = trailPips * PIP;
    const minImprove = minImprovePips * PIP;
    let newSl;
    if (p.side.includes("BUY")) {
      newSl = round3(p.current - dist);
      if (p.sl != null && newSl - p.sl < minImprove) {
        skipped.push(`#${p.ticket}: SL sudah pas (${p.sl})`);
        continue;
      }
    } else {
      newSl = round3(p.current + dist);
      if (p.sl != null && p.sl - newSl < minImprove) {
        skipped.push(`#${p.ticket}: SL sudah pas (${p.sl})`);
        continue;
      }
    }

    // Preserve the existing TP; MT5 uses 0 for "not set". Never send null,
    // which the API could interpret as clearing the TP.
    const r = await modifyPosition(p.ticket, newSl, p.tp ?? 0);
    if (r.ok) moved.push(`#${p.ticket} ${p.side} SL→${newSl}`);
    else failed.push(`#${p.ticket}: ${r.error}`);
  }

  const note = [
    moved.length ? `Trek: ${moved.join(", ")}` : null,
    skipped.length ? `Lewat: ${skipped.join(", ")}` : null,
    failed.length ? `GAGAL: ${failed.join(", ")}` : null
  ]
    .filter(Boolean)
    .join(" · ");

  return { ok: failed.length === 0, info: note, moved, skipped, failed };
}

window.__aiTradingTrail = applyTrailingStops;

// --- Auto-fill (user request: TP/SL terisi otomatis setiap selesai analisa) --
// Two triggers: (1) order panel just opened, (2) a new signal landed while the
// panel is open. Fills once per signal+panel session so manual edits are not
// clobbered by repeated renders.
let autoFilledSignalTime = 0;
let panelVisible = false;

async function autoFill(trigger) {
  try {
    const visible = !!document.querySelector(ORDER_PANEL.panel);
    if (visible && !panelVisible) {
      // Panel just opened — fill for the current signal if not yet done.
      panelVisible = true;
      if (autoFilledSignalTime === (await currentSignalTime())) return;
    } else {
      panelVisible = visible;
      if (!visible) return;
    }

    const res = await prepareOrderFromSignal();
    if (res.ok) {
      autoFilledSignalTime = await currentSignalTime();
      console.log(`[AI-TS] auto-fill (${trigger}): ${res.info}`);
      window.dispatchEvent(new CustomEvent("ai-ts-order-filled", { detail: res.info }));
    }
  } catch {
    /* panel mid-transition — next mutation retries */
  }
}

async function currentSignalTime() {
  const { lastSignal } = await chrome.storage.local.get("lastSignal");
  return lastSignal?.time || 0;
}

// Watch panel appearance (user clicked Buy/Sell). Debounced — the trading DOM
// mutates constantly.
let fillTimer = null;
function scheduleFill(trigger) {
  clearTimeout(fillTimer);
  fillTimer = setTimeout(() => autoFill(trigger), 300);
}

new MutationObserver(() => {
  const visible = !!document.querySelector(ORDER_PANEL.panel);
  if (visible !== panelVisible || visible) scheduleFill("mutation");
}).observe(document.documentElement, { childList: true, subtree: true });

// New signal from analysis (manual Analyze or the 15-min alarm).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastSignal) scheduleFill("new-signal");
});

// Service worker asks content script to backfill on startup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "BACKFILL_REQUEST") {
    backfillCandles(msg.timeFrameSec, msg.count)
      .then((candles) => sendResponse({ ok: true, candles }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }

  if (msg.type === "FILL_ORDER_PANEL") {
    fillOrderPanel(msg.params || {})
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }

  if (msg.type === "PREPARE_ORDER") {
    prepareOrderFromSignal()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }

  if (msg.type === "TRAIL_STOPS") {
    applyTrailingStops()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }
});
