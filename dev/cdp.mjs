#!/usr/bin/env node
// cdp.mjs — small CDP helper for debugging the extension in the Exness tab.
// Usage:
//   node dev/cdp.mjs eval "<js expression>"     # eval in the exness page
//   node dev/cdp.mjs console                    # dump console logs (3s capture)
//   node dev/cdp.mjs overlay                    # inspect overlay element
//   node dev/cdp.mjs sniff                      # capture network requests (8s)

const PORT = process.env.BRAVE_DEV_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;

async function targets() {
  const r = await fetch(`${BASE}/json/list`);
  return r.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener("open", () =>
      resolve({
        events,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { ws.close(); } catch {} }
      })
    );
    ws.addEventListener("message", (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
}

async function exnessPage() {
  const ts = await targets();
  return ts.find((t) => t.type === "page" && /exness\.com/.test(t.url));
}

function dumpNetwork(c) {
  const reqs = new Map();
  for (const e of c.events) {
    if (e.method === "Network.requestWillBeSent") {
      const { requestId, request } = e.params;
      reqs.set(requestId, { url: request.url, method: request.method, type: e.params.type });
    } else if (e.method === "Network.webSocketCreated") {
      console.log(`[WS-OPEN] ${e.params.url}`);
    } else if (e.method === "Network.webSocketFrameSent") {
      const d = e.params.response.payloadData || "";
      if (d.includes("history") || d.includes("candle") || d.includes("chart")) {
        console.log(`[WS-SENT] ${d.slice(0, 300)}`);
      }
    } else if (e.method === "Network.webSocketFrameReceived") {
      const d = e.params.response.payloadData || "";
      if (d.includes("history") || d.includes("candle") || d.includes("bars")) {
        console.log(`[WS-RECV] ${d.slice(0, 200)}`);
      }
    }
  }
  console.log("\n=== interesting HTTP requests ===");
  for (const [, r] of reqs) {
    if (r.type === "WebSocket" || r.type === "Document") continue;
    if (/candle|history|chart|bars|ohlc|quote|symbol|mt5|api|trade|price|candl/i.test(r.url)) {
      console.log(`${r.method} [${r.type}] ${r.url}`);
    }
  }
  console.log(`(total reqs captured: ${reqs.size})`);
}

const cmd = process.argv[2];
const arg = process.argv[3];

if (cmd === "eval") {
  const page = await exnessPage();
  const c = await connect(page.webSocketDebuggerUrl);
  const r = await c.send("Runtime.evaluate", { expression: arg, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r.result?.value ?? r.result, null, 2));
  c.close();
} else if (cmd === "overlay") {
  const page = await exnessPage();
  const c = await connect(page.webSocketDebuggerUrl);
  const expr = `(() => {
    const el = document.getElementById('ai-signal-overlay');
    return {
      pageUrl: location.href,
      overlayExists: !!el,
      overlayHTML: el ? el.innerHTML.slice(0,300) : null,
      overlayRect: el ? el.getBoundingClientRect().toJSON() : null,
      bodyChildren: document.body.children.length,
      hasChromeRuntime: typeof chrome !== 'undefined' && !!chrome.runtime,
      title: document.title
    };
  })()`;
  const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  console.log(JSON.stringify(r.result?.value, null, 2));
  c.close();
} else if (cmd === "console") {
  const page = await exnessPage();
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send("Runtime.enable");
  await c.send("Log.enable");
  await new Promise((r) => setTimeout(r, 3000));
  for (const e of c.events) {
    if (e.method === "Runtime.consoleAPICalled") {
      const args = e.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
      console.log(`[${e.params.type}] ${args}`);
    } else if (e.method === "Log.entryAdded") {
      console.log(`[${e.params.entry.level}] ${e.params.entry.text}`);
    } else if (e.method === "Runtime.exceptionThrown") {
      console.log(`[exception] ${e.params.exceptionDetails?.text} ${e.params.exceptionDetails?.exception?.description || ""}`);
    }
  }
  c.close();
} else if (cmd === "sniff") {
  const page = await exnessPage();
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send("Network.enable");
  // Trigger a chart data fetch by nudging the timeframe selector is unreliable;
  // instead just capture whatever flows for 8s (incl. any WS frames).
  console.log("Capturing network for 8s... (interact with the chart / switch TF now)");
  await new Promise((r) => setTimeout(r, 8000));
  await dumpNetwork(c);
  c.close();
} else if (cmd === "reloadsniff") {
  // Reload the Exness page and record every request from the very start —
  // this is how the chart's initial history fetch gets captured.
  const page = await exnessPage();
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send("Network.enable");
  await c.send("Page.enable");
  await c.send("Page.reload", { ignoreCache: true });
  console.log("Reloading Exness page, capturing 20s of traffic...");
  await new Promise((r) => setTimeout(r, 20000));
  await dumpNetwork(c);
  c.close();
} else if (cmd === "headers") {
  // Reload and capture request headers for the candles endpoint.
  const page = await exnessPage();
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send("Network.enable");
  await c.send("Page.enable");
  await c.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 18000));
  const pat = new RegExp(arg || "candles", "i");
  let found = 0;
  for (const e of c.events) {
    if (e.method === "Network.requestWillBeSent" && pat.test(e.params.request.url)) {
      console.log(`\n### ${e.params.request.method} ${e.params.request.url}`);
      console.log(JSON.stringify(e.params.request.headers, null, 2));
      found++;
    }
  }
  if (!found) console.log("(no matching request captured)");
  c.close();
} else if (cmd === "body") {
  const page = await exnessPage();
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send("Network.enable");
  await c.send("Page.enable");
  await c.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 20000));
  const pat = new RegExp(arg || "candle|history|bars|ohlc", "i");
  const ids = [];
  for (const e of c.events) {
    if (e.method === "Network.responseReceived" && pat.test(e.params.response.url) && e.params.type !== "WebSocket") {
      ids.push({ id: e.params.requestId, url: e.params.response.url });
    }
  }
  for (const { id, url } of ids.slice(0, 5)) {
    console.log(`\n### ${url}`);
    try {
      const b = await c.send("Network.getResponseBody", { requestId: id });
      console.log((b.body || "").slice(0, 1200));
    } catch (e) {
      console.log("(body unavailable:", e.message, ")");
    }
  }
  c.close();
} else if (cmd === "sw") {
  // Evaluate an expression in OUR extension's service worker. Other extensions
  // may also expose background.js, so match on this project's extension id
  // (the sidepanel URL carries it).
  const ts = await targets();
  const ourId =
    process.env.AI_TS_EXT_ID ||
    ts.map((t) => t.url.match(/^chrome-extension:\/\/([a-p]{32})\/sidepanel\.html/)?.[1]).find(Boolean) ||
    "phfiklbeefmjjfgmbplhgbbkfedaipcm";
  const sw = ts.find((t) => t.type === "service_worker" && t.url.includes(`chrome-extension://${ourId}/`));
  if (!sw) { console.log(`no service worker for extension ${ourId}`); process.exit(1); }
  const c = await connect(sw.webSocketDebuggerUrl);
  const r = await c.send("Runtime.evaluate", { expression: arg, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r.result?.value ?? r.result, null, 2));
  c.close();
} else if (cmd === "panel") {
  // Evaluate in the side panel page (chrome-extension world) — can use chrome.*
  // and send runtime messages, i.e. the real path the user's button uses.
  const ts = await targets();
  const sp = ts.find((t) => t.url.includes("sidepanel.html"));
  if (!sp) { console.log("sidepanel not open"); process.exit(1); }
  const c = await connect(sp.webSocketDebuggerUrl);
  const r = await c.send("Runtime.evaluate", { expression: arg, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r.result?.value ?? r.result, null, 2));
  c.close();
} else {
  console.log("usage: node dev/cdp.mjs <eval|sw|panel|overlay|console|sniff|reloadsniff|headers|body> [arg]");
}
