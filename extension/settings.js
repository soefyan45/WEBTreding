// settings.js — user-tunable settings (ES module, used by the service worker
// and the side panel). Content scripts are classic scripts and cannot import;
// they read settings via the GET_SETTINGS runtime message.

export const SETTINGS_DEFAULTS = {
  volume: 0.01, // lots per order
  minSlPips: 100, // floor: LLM SL below this is rejected (user got stopped out on tight SL)
  defaultSlPips: 100, // used when the LLM omits SL
  defaultTpPips: 200, // used when the LLM omits TP
  trailDistancePips: 100, // trailing stop distance behind price
  trailMinImprovePips: 50, // don't send modify if improvement < this
  model: "combos-auto", // LLM model id at the proxy
  loopIntervalMin: 15, // analysis cadence
  llmBaseUrl: "", // empty = CONFIG.LLM_BASE_URL
  llmApiKey: "" // empty = CONFIG.LLM_API_KEY
};

// Coerce user input to sane numbers so a bad value can't break the pipeline.
function sanitize(raw) {
  const d = SETTINGS_DEFAULTS;
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!isFinite(n) || n < min || n > max) return fallback;
    return n;
  };
  return {
    volume: num(raw.volume, d.volume, 0.01, 100),
    minSlPips: num(raw.minSlPips, d.minSlPips, 10, 1000),
    defaultSlPips: num(raw.defaultSlPips, d.defaultSlPips, 10, 1000),
    defaultTpPips: num(raw.defaultTpPips, d.defaultTpPips, 10, 2000),
    trailDistancePips: num(raw.trailDistancePips, d.trailDistancePips, 10, 1000),
    trailMinImprovePips: num(raw.trailMinImprovePips, d.trailMinImprovePips, 1, 1000),
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : d.model,
    loopIntervalMin: num(raw.loopIntervalMin, d.loopIntervalMin, 1, 240),
    llmBaseUrl: typeof raw.llmBaseUrl === "string" ? raw.llmBaseUrl.trim() : "",
    llmApiKey: typeof raw.llmApiKey === "string" ? raw.llmApiKey.trim() : ""
  };
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return sanitize({ ...SETTINGS_DEFAULTS, ...(stored.settings || {}) });
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = sanitize({ ...current, ...patch });
  await chrome.storage.sync.set({ settings: next });
  return next;
}
