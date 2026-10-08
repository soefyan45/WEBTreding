// panel.js — shared controller for the browser-action popup and the side panel.
// Both surfaces render the same state and expose the same controls.

const els = {
  status: document.getElementById("status"),
  statusDot: document.getElementById("statusDot"),
  lastAnalyze: document.getElementById("lastAnalyze"),
  signalCard: document.getElementById("signalCard"),
  signalText: document.getElementById("signalText"),
  signalReason: document.getElementById("signalReason"),
  indicators: document.getElementById("indicators"),
  debateBlock: document.getElementById("debateBlock"),
  debateBody: document.getElementById("debateBody"),
  debateToggle: document.getElementById("debateToggle"),
  debateAnalyst: document.getElementById("debateAnalyst"),
  debateCounter: document.getElementById("debateCounter"),
  debateFinal: document.getElementById("debateFinal"),
  logList: document.getElementById("logList"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  fillBtn: document.getElementById("fillBtn"),
  trailBtn: document.getElementById("trailBtn"),
  drawSrBtn: document.getElementById("drawSrBtn"),
  clearSrBtn: document.getElementById("clearSrBtn"),
  drawPosBtn: document.getElementById("drawPosBtn"),
  clearPosBtn: document.getElementById("clearPosBtn"),
  backfillBtn: document.getElementById("backfillBtn"),
  exportBtn: document.getElementById("exportBtn"),
  settingsToggleBtn: document.getElementById("settingsToggleBtn"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  resetSettingsBtn: document.getElementById("resetSettingsBtn"),
  positionsList: document.getElementById("positionsList"),
  positionsAt: document.getElementById("positionsAt")
};

function fmtMoney(n) {
  const s = typeof n === "number" && isFinite(n) ? n.toFixed(2) : "–";
  return (n > 0 ? "+" : "") + s;
}

function renderPositions() {
  if (!els.positionsList) return; // popup.html has no positions section
  chrome.storage.local.get(["positions", "positionsAt"]).then(({ positions = [], positionsAt }) => {
    els.positionsAt.textContent = positionsAt ? timeAgo(positionsAt) : "";
    if (!positions.length) {
      els.positionsList.innerHTML = `<div class="entry muted">Tidak ada posisi terbuka</div>`;
      return;
    }
    els.positionsList.innerHTML = positions
      .map(
        (p) => `<div class="entry">
          <span class="${tagClass(p.side === "BUY" ? "BUY" : "SELL")}">${p.side}</span>
          <span class="muted">${p.volume} ${p.symbol}</span>
          <span class="muted"> @ ${fmt(p.entry, 3)}</span>
          <span class="${p.isProfit ? "tag-buy" : p.isLoss ? "tag-sell" : ""}" style="float:right">
            ${fmtMoney(p.profitLoss)} USD
          </span>
          <div class="muted" style="font-size:10px">
            cur ${fmt(p.current, 3)} · SL ${fmt(p.sl, 2)} · TP ${fmt(p.tp, 2)} · #${p.ticket}
          </div>
        </div>`
      )
      .join("");
  });
}

function fmt(n, d = 2) {
  return typeof n === "number" && isFinite(n) ? n.toFixed(d) : "–";
}

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// Mirrors the background's staleness ceiling (5 min). If the SW died mid-run
// the analysisAt key lingers — treat it as over so the button unlocks.
function stale(analysisAt) {
  return !analysisAt || Date.now() - analysisAt > 5 * 60 * 1000;
}

function tagClass(sig) {
  return sig === "BUY" ? "tag-buy" : sig === "SELL" ? "tag-sell" : "tag-wait";
}

function colorFor(sig) {
  return sig === "BUY" ? "#00C896" : sig === "SELL" ? "#FF4757" : "#8B949E";
}

// Debate log: 3 numbered lines — analyst, debater, final verdict. Hidden when
// the signal predates the debate pipeline (no `process` field).
function renderDebate(lastSignal) {
  if (!els.debateBlock) return; // popup has no debate section
  const p = lastSignal?.process;
  if (!p) {
    els.debateBlock.hidden = true;
    return;
  }
  els.debateBlock.hidden = false;
  const c = (s) => `<span style="color:${colorFor(s)};font-weight:700">${s}</span>`;
  const risks = p.analyst.keyRisks?.length ? ` — risiko: ${p.analyst.keyRisks.join("; ")}` : "";
  els.debateAnalyst.innerHTML =
    `[1] Analis: ${c(p.analyst.signal)} ${(p.analyst.confidence * 100).toFixed(0)}% · tren ${p.analyst.trend}` +
    (p.analyst.targetPrice ? ` · target ${fmt(p.analyst.targetPrice)}` : "") + risks;
  const agree = p.debate.agree;
  els.debateCounter.innerHTML = agree
    ? `[2] Pendebat: <span style="color:#00C896;font-weight:700">setuju</span>${p.debate.counter ? ` — ${p.debate.counter}` : ""}`
    : `[2] Pendebat: <span style="color:#FF4757;font-weight:700">menolak</span> — ${p.debate.counter}${p.debate.flips ? ` (maju ${c(p.debate.flips)})` : ""}`;
  els.debateFinal.innerHTML =
    `[3] Final: ${c(p.final.signal)} ${(p.final.confidence * 100).toFixed(0)}%`;
}

// Collapse toggle for the debate block.
let debateCollapsed = false;
els.debateToggle?.addEventListener("click", () => {
  debateCollapsed = !debateCollapsed;
  els.debateBody.hidden = debateCollapsed;
  els.debateToggle.textContent = debateCollapsed ? "▸" : "▾";
});

async function render() {
  // Analyze button: reflect the background in-flight state so it recovers by
  // itself instead of being stuck disabled when the response never arrives
  // (SW killed mid-analysis) or an alarm-driven run is in progress.
  const { lastSignal, signals = [], analysisAt } = await chrome.storage.local.get([
    "lastSignal",
    "signals",
    "analysisAt"
  ]);
  const running = !!analysisAt && !stale(analysisAt);
  els.analyzeBtn.disabled = running;
  els.analyzeBtn.textContent = running ? "Analyzing…" : "Analyze Now";

  // Status: active if a signal landed in the last 30 min.
  const fresh = lastSignal && Date.now() - lastSignal.time < 30 * 60 * 1000;
  els.status.textContent = fresh ? "Active" : "Idle";
  els.statusDot.className = "status-dot" + (fresh ? " active" : "");
  els.lastAnalyze.textContent = lastSignal ? timeAgo(lastSignal.time) : "—";

  if (lastSignal) {
    els.signalCard.className =
      "card " +
      (lastSignal.signal === "BUY" ? "signal-buy" : lastSignal.signal === "SELL" ? "signal-sell" : "");
    els.signalText.style.color = colorFor(lastSignal.signal);
    els.signalText.textContent = `${lastSignal.signal} · ${(lastSignal.confidence * 100).toFixed(0)}%`;
    els.signalReason.textContent =
      (lastSignal.reason || "") +
      (lastSignal.slPips ? `  ·  SL ${lastSignal.slPips}p / TP ${lastSignal.tpPips}p` : "");

    const i = lastSignal.indicators || {};
    const lvSrc = lastSignal.levelSource === "llm" ? "LLM" : "teknikal";
    const breaks = [
      lastSignal.breakout && `BREAK↑ ${fmt(lastSignal.breakout)}`,
      lastSignal.breakdown && `BREAK↓ ${fmt(lastSignal.breakdown)}`
    ]
      .filter(Boolean)
      .join(" · ");
    els.indicators.innerHTML = `
      <span><b>SMA9</b> ${fmt(i.sma9)}</span><span><b>SMA21</b> ${fmt(i.sma21)}</span>
      <span><b>RSI14</b> ${fmt(i.rsi14, 1)}</span><span><b>ATR14</b> ${fmt(i.atr14, 2)}</span>
      <span><b>BB U</b> ${fmt(i.bbUpper)}</span><span><b>BB L</b> ${fmt(i.bbLower)}</span>
      <span><b>MACD H</b> ${fmt(i.macdHist, 3)}</span><span><b>Price</b> ${fmt(i.price)}</span>
      <span><b>Volume</b> ${fmt(i.volume, 0)} (${fmt(i.volRatio, 2)}x avg)</span><span><b>Vol Avg</b> ${fmt(i.volSma20, 1)}</span>
      ${lastSignal.levelNote ? `<span style="grid-column:1/-1"><b>${lvSrc}</b>: ${lastSignal.levelNote}</span>` : ""}
      ${breaks ? `<span style="grid-column:1/-1;color:#FFA500"><b>${breaks}</b></span>` : ""}
      ${lastSignal.trend ? `<span style="grid-column:1/-1"><b>Tren</b> ${lastSignal.trend}${lastSignal.trendNote ? `: ${lastSignal.trendNote}` : ""}${lastSignal.targetPrice ? ` → target ${fmt(lastSignal.targetPrice)}` : ""}</span>` : ""}
    `;
    renderDebate(lastSignal);
  }

  els.logList.innerHTML =
    signals.length === 0
      ? "—"
      : signals
          .slice(0, 20)
          .map((s) => {
            const d = new Date(s.timestamp);
            const hh = String(d.getHours()).padStart(2, "0");
            const mm = String(d.getMinutes()).padStart(2, "0");
            return `<div class="entry">
              <span class="time">${hh}:${mm}</span>
              <span class="${tagClass(s.signal)}">${s.signal}</span>
              <span class="muted">${(s.confidence * 100).toFixed(0)}% @ ${fmt(s.priceAtSignal)}</span>
            </div>`;
          })
          .join("");

  renderPositions();
}

els.analyzeBtn.addEventListener("click", async () => {
  // Optimistic disable; render() keeps it disabled while the background is
  // actually analyzing, and re-enables once analysisAt clears (or goes stale).
  els.analyzeBtn.disabled = true;
  els.analyzeBtn.textContent = "Analyzing…";
  els.signalReason.textContent = "Analyzing…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "REQUEST_SIGNAL" });
    if (res?.error) els.signalReason.textContent = res.error;
  } catch (e) {
    els.signalReason.textContent = "Error: " + e.message;
  } finally {
    render();
  }
});

// The popup has no #orderNote; fall back to the reason line so messages still show.
function setNote(text) {
  const note = document.getElementById("orderNote");
  if (note) note.textContent = text;
  else els.signalReason.textContent = text;
}

els.fillBtn?.addEventListener("click", async () => {
  els.fillBtn.disabled = true;
  setNote("Mengisi order panel…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "PREPARE_ORDER" });
    setNote(
      res?.ok
        ? `${res.info} — cek lalu klik Buy/Sell + Confirm di WebTerminal.`
        : `Gagal: ${res?.error || "tidak diketahui"}`
    );
  } catch (e) {
    setNote("Error: " + e.message);
  } finally {
    els.fillBtn.disabled = false;
  }
});

els.drawSrBtn?.addEventListener("click", async () => {
  els.drawSrBtn.disabled = true;
  setNote("Menggambar support/resistance…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "DRAW_SR" });
    if (res?.ok) {
      const fmt = (l) => `${l.price.toFixed(1)}(${l.touches}x)`;
      const s = (res.levels?.supports || []).map(fmt).join(", ") || "-";
      const r = (res.levels?.resistances || []).map(fmt).join(", ") || "-";
      const br = [
        res.levels?.breakout != null && `↑${res.levels.breakout.toFixed(1)}`,
        res.levels?.breakdown != null && `↓${res.levels.breakdown.toFixed(1)}`
      ].filter(Boolean).join(" ");
      setNote(`S/R: S ${s} · R ${r}${br ? ` · Break ${br}` : ""}`);
    } else {
      setNote(`Gagal: ${res?.error || "tidak diketahui"}`);
    }
  } catch (e) {
    setNote("Error: " + e.message);
  } finally {
    els.drawSrBtn.disabled = false;
  }
});

els.clearSrBtn?.addEventListener("click", async () => {
  els.clearSrBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "CLEAR_SR" });
    setNote("S/R dihapus dari chart.");
  } catch (e) {
    setNote("Error: " + e.message);
  } finally {
    els.clearSrBtn.disabled = false;
  }
});

els.drawPosBtn?.addEventListener("click", async () => {
  els.drawPosBtn.disabled = true;
  setNote("Menggambar rencana posisi…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "DRAW_POSITION" });
    if (res?.ok) {
      setNote(`${res.side} @ ${res.entry.toFixed(2)} · SL ${res.slPrice.toFixed(2)} · TP ${res.tpPrice.toFixed(2)}`);
    } else {
      setNote(`Gagal: ${res?.error || "tidak diketahui"}`);
    }
  } catch (e) {
    setNote("Error: " + e.message);
  } finally {
    els.drawPosBtn.disabled = false;
  }
});

els.clearPosBtn?.addEventListener("click", async () => {
  els.clearPosBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "CLEAR_POSITION" });
    setNote("Rencana posisi dihapus dari chart.");
  } catch (e) {
    setNote("Error: " + e.message);
  } finally {
    els.clearPosBtn.disabled = false;
  }
});

els.trailBtn?.addEventListener("click", async () => {
  els.trailBtn.disabled = true;
  setNote("Menggeser SL semua posisi…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "TRAIL_STOPS" });
    setNote(res?.ok ? res.info : `Gagal: ${res?.error || "tidak diketahui"}`);
  } catch (e) {
    setNote("Error: " + e.message);
  } finally {
    els.trailBtn.disabled = false;
  }
});

els.backfillBtn?.addEventListener("click", async () => {
  els.backfillBtn.disabled = true;
  els.signalReason.textContent = "Backfilling candle M15…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "REQUEST_BACKFILL" });
    els.signalReason.textContent = res?.ok
      ? `Backfill OK — ${res.count} candle tersimpan.`
      : `Backfill gagal: ${res?.error || "tidak diketahui"}`;
  } catch (e) {
    els.signalReason.textContent = "Error: " + e.message;
  } finally {
    els.backfillBtn.disabled = false;
    render();
  }
});

// --- Settings form ---------------------------------------------------------
const SET_FIELDS = {
  setVolume: "volume",
  setMinSl: "minSlPips",
  setDefSl: "defaultSlPips",
  setDefTp: "defaultTpPips",
  setTrailDist: "trailDistancePips",
  setTrailMin: "trailMinImprovePips",
  setModel: "model",
  setLlmUrl: "llmBaseUrl",
  setLlmKey: "llmApiKey",
  setLoop: "loopIntervalMin",
  setManualNote: "manualNote"
};

async function loadSettingsForm() {
  const s = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (!s) return;
  for (const [id, key] of Object.entries(SET_FIELDS)) {
    const el = document.getElementById(id);
    if (el && s[key] != null) el.value = s[key];
  }
}

els.settingsToggleBtn?.addEventListener("click", () => {
  const panel = document.getElementById("settingsPanel");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) loadSettingsForm();
});

els.saveSettingsBtn?.addEventListener("click", async () => {
  const patch = {};
  for (const [id, key] of Object.entries(SET_FIELDS)) {
    const el = document.getElementById(id);
    if (el) patch[key] = el.value;
  }
  const status = document.getElementById("settingsStatus");
  const res = await chrome.runtime.sendMessage({ type: "SET_SETTINGS", patch });
  if (res?.ok) {
    await loadSettingsForm(); // reflect sanitized values
    if (status) status.textContent = "Tersimpan.";
  } else if (status) {
    status.textContent = "Gagal: " + (res?.error || "tidak diketahui");
  }
});

els.resetSettingsBtn?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", patch: { __reset: true } });
  await loadSettingsForm();
  const status = document.getElementById("settingsStatus");
  if (status) status.textContent = "Direset ke default.";
});

els.exportBtn.addEventListener("click", async () => {
  const { signals = [] } = await chrome.storage.local.get("signals");
  const header = "timestamp,signal,confidence,price,reason,debate\n";
  const rows = signals
    .map((s) =>
      [
        s.timestamp,
        s.signal,
        s.confidence,
        s.priceAtSignal,
        JSON.stringify(s.reason || ""),
        s.process?.debate?.flips || "-"
      ].join(",")
    )
    .join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `trading-signals-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

render();
setInterval(render, 2000);
