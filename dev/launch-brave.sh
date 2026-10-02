#!/usr/bin/env bash
# Launch Brave with a persistent dev profile, remote debugging on 9222, and the
# trading extension preloaded. Profile persists cookies/session — Exness login is
# only needed once per profile.
set -euo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../extension" && pwd)"
PROFILE="${BRAVE_DEV_PROFILE:-$HOME/.brave-trading-dev}"
PORT="${BRAVE_DEV_PORT:-9222}"

# Detect the Brave binary (Brave Origin ships as brave-origin-stable).
BRAVE_BIN=""
for b in brave-origin-stable brave-browser brave; do
  if command -v "$b" >/dev/null 2>&1; then BRAVE_BIN="$b"; break; fi
done
if [ -z "$BRAVE_BIN" ]; then
  echo "Brave binary not found (tried: brave-origin-stable, brave-browser, brave)" >&2
  exit 1
fi

# Reuse an already-running debug instance instead of spawning a second one.
if curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "Brave dev already running on :${PORT}"
else
  "$BRAVE_BIN" \
    --remote-debugging-port="${PORT}" \
    --user-data-dir="${PROFILE}" \
    --load-extension="${EXT_DIR}" \
    --no-first-run \
    --no-default-browser-check \
    "https://my.exness.com/webtrading/" >/dev/null 2>&1 &
  # Give CDP a moment to come up.
  for _ in $(seq 1 30); do
    curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

echo "CDP: $(curl -sf http://127.0.0.1:${PORT}/json/version | head -c 200)"
echo
echo "Targets:"
curl -sf "http://127.0.0.1:${PORT}/json/list" | grep -E '"(type|url)"' | head -20

EXT_ID="$(curl -sf "http://127.0.0.1:${PORT}/json/list" | grep -oE 'chrome-extension://[a-p]{32}/background\.js' | head -1 | sed -E 's|chrome-extension://([a-p]{32})/.*|\1|')"
if [ -n "${EXT_ID}" ]; then
  echo
  echo "Extension loaded, ID: ${EXT_ID}"
else
  echo
  echo "WARNING: extension service worker not found in targets."
  echo "If --load-extension was ignored, load unpacked once via chrome://extensions"
  echo "(profile persists it — subsequent launches keep it)."
fi
