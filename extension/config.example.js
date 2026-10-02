// config.example.js — copy to config.js and fill in your own values.
// config.js is git-ignored so secrets stay out of the repo.
//
//   cp extension/config.example.js extension/config.js
//
// Users can also override Base URL / API key / model at runtime from the
// Settings panel (stored in chrome.storage.sync); empty there = these defaults.

export const CONFIG = {
  LLM_BASE_URL: "http://127.0.0.1:20128/v1",
  LLM_API_KEY: "sk-your-key-here",
  MODEL_PRIMARY: "combos-auto",
  MODEL_FALLBACK: "combos-auto",
  SYMBOL: "XAUUSDm",
  TIMEFRAME_MIN: 15,
  LOOP_INTERVAL_MIN: 15,
  DEFAULT_VOLUME: 0.01,
  MAX_DAILY_LOSS_PCT: 5,
  MAX_SPREAD_POINTS: 50
};
