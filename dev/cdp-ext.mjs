// Eval inside a chosen CDP target (default: the extension side panel),
// so we can call chrome.runtime.sendMessage like the panel does.
const BASE = "http://127.0.0.1:9222";

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const events = [];
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const my = ++id;
            pending.set(my, { res, rej });
            ws.send(JSON.stringify({ id: my, method, params }));
          });
        },
        events,
        close: () => ws.close(),
      });
    });
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
}

const ts = await (await fetch(`${BASE}/json/list`)).json();
const which = process.argv[2] || "sidepanel";
let t;
if (which === "sidepanel") t = ts.find((x) => x.type === "page" && /sidepanel\.html/.test(x.url));
else if (which === "sw") t = ts.find((x) => x.type === "service_worker" && /background\.js/.test(x.url) && /phfiklbeefmjjfgmbplhgbbkfedaipcm/.test(x.url));
else t = ts.find((x) => x.type === "page" && x.url.includes(which));
if (!t) { console.error("target not found:", which, "— available:", ts.map(x=>x.type+"/"+x.url.slice(0,60))); process.exit(1); }

const expr = process.argv[3];
const c = await connect(t.webSocketDebuggerUrl);
const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(r.result?.value ?? r.result, null, 2));
c.close();
