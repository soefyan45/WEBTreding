#!/usr/bin/env node
// watch-reload.mjs — zero-dependency dev loop for the MV3 extension.
//
// On any save under extension/:
//   1. reload the extension service worker (chrome.runtime.reload)
//   2. reload the Exness WebTerminal tab so content scripts re-inject
//
// Talks raw CDP to the debug port using Node's global fetch + WebSocket.
// Requires Brave launched via dev/launch-brave.sh (remote-debugging-port).

import { watch, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const EXT_DIR = path.resolve(import.meta.dirname, "..", "extension");
const DEBOUNCE_MS = 150;

// Resolve the CDP port. Priority:
//   1. BRAVE_DEV_PORT env var
//   2. DevToolsActivePort file in a Brave profile (written once remote debugging
//      is enabled — e.g. via chrome://inspect/#remote-debugging autoConnect)
//   3. 9222 default (dev/launch-brave.sh)
const PROFILE_CANDIDATES = [
  process.env.BRAVE_PROFILE,
  path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Origin"),
  path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser"),
  path.join(os.homedir(), ".brave-trading-dev")
].filter(Boolean);

function resolvePort() {
  if (process.env.BRAVE_DEV_PORT) return Number(process.env.BRAVE_DEV_PORT);
  for (const dir of PROFILE_CANDIDATES) {
    const f = path.join(dir, "DevToolsActivePort");
    if (existsSync(f)) {
      const first = readFileSync(f, "utf8").split("\n")[0].trim();
      if (first) return Number(first);
    }
  }
  return 9222;
}

let PORT = resolvePort();
let BASE = `http://127.0.0.1:${PORT}`;

function refreshEndpoint() {
  const next = resolvePort();
  if (next !== PORT) {
    PORT = next;
    BASE = `http://127.0.0.1:${PORT}`;
    console.log(`  · CDP endpoint -> ${BASE}`);
  }
}

// --- Minimal CDP client ----------------------------------------------------
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();

    ws.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try {
            ws.close();
          } catch {}
        }
      })
    );

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = msg.id && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    });

    ws.addEventListener("error", () => reject(new Error(`WS error: ${wsUrl}`)));
  });
}

async function listTargets() {
  const r = await fetch(`${BASE}/json/list`);
  if (!r.ok) throw new Error(`CDP ${r.status}`);
  return r.json();
}

// --- Reload actions --------------------------------------------------------
async function reloadExtension() {
  const targets = await listTargets();
  // Our extension id comes from the sidepanel target; the SW goes dormant and
  // disappears from the list, so we can't match on the SW url alone — other
  // extensions' workers would match instead.
  const ourId =
    targets.map((t) => t.url.match(/^chrome-extension:\/\/([a-p]{32})\/sidepanel\.html/)?.[1]).find(Boolean) ||
    process.env.AI_TS_EXT_ID;
  const sw = targets.find(
    (t) =>
      t.type === "service_worker" &&
      (ourId ? t.url.startsWith(`chrome-extension://${ourId}/`) : t.url.startsWith("chrome-extension://"))
  );

  if (sw) {
    const c = await connect(sw.webSocketDebuggerUrl);
    // Fire-and-forget: the worker tears itself down right after this call.
    c.send("Runtime.evaluate", { expression: "chrome.runtime.reload()" }).catch(() => {});
    setTimeout(() => c.close(), 400);
    return "service-worker";
  }

  // Fallback: drive chrome://extensions if the SW target isn't listed.
  const extPage = targets.find((t) => t.type === "page" && t.url.startsWith("chrome://extensions"));
  const extId = ourId ||
    targets
      .map((t) => t.url.match(/^chrome-extension:\/\/([a-p]{32})\//)?.[1])
      .find(Boolean);
  if (extPage && extId) {
    const c = await connect(extPage.webSocketDebuggerUrl);
    await c
      .send("Runtime.evaluate", {
        expression: `chrome.developerPrivate.reload(${JSON.stringify(extId)}, {failQuietly:true})`
      })
      .catch(() => {});
    c.close();
    return "chrome://extensions";
  }

  return null;
}

async function reloadExnessTabs() {
  const targets = await listTargets();
  const pages = targets.filter((t) => t.type === "page" && /exness\.com/.test(t.url));
  let n = 0;
  for (const p of pages) {
    try {
      const c = await connect(p.webSocketDebuggerUrl);
      await c.send("Page.reload", { ignoreCache: false });
      c.close();
      n++;
    } catch (e) {
      console.warn(`  ! page reload failed: ${e.message}`);
    }
  }
  return n;
}

// --- Debounced loop --------------------------------------------------------
let timer = null;
let busy = false;

async function run(changed) {
  const stamp = new Date().toLocaleTimeString();
  console.log(`\n[${stamp}] changed: ${changed}`);
  refreshEndpoint();
  try {
    const ext = await reloadExtension();
    console.log(ext ? `  ✓ extension reloaded (${ext})` : "  ! extension target not found (is it loaded?)");
    const pages = await reloadExnessTabs();
    console.log(pages ? `  ✓ reloaded ${pages} exness tab(s)` : "  ! no exness tab open");
  } catch (e) {
    console.error(`  ✗ ${e.message} — is Brave running with --remote-debugging-port=${PORT}?`);
  }
}

function onChange(filename) {
  const name = filename || "";
  // Ignore editor/CLI temp artifacts — only react to real source files.
  if (
    !/\.(js|json|html|css)$/.test(name) ||
    name.includes(".swp") ||
    name.endsWith("~") ||
    name.startsWith(".") ||
    name.includes(".tmp.")
  )
    return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (busy) return;
    busy = true;
    run(name).finally(() => (busy = false));
  }, DEBOUNCE_MS);
}

console.log(`Watching ${EXT_DIR}`);
console.log(`CDP endpoint ${BASE} (set BRAVE_DEV_PORT to override)`);
console.log("Save a file in extension/ to trigger reload. Ctrl+C to stop.");

watch(EXT_DIR, { recursive: true }, (_event, filename) => onChange(filename));
