import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WindowHandoffAdapter } from "../../../src/window-takeover/window-handoff-adapter.ts";

function defaultLanHost(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const address = entry.address;
      if (/^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address)) return address;
    }
  }
  throw new Error("No private IPv4 LAN address found; set HANDOFF_LAN_HOST explicitly");
}

const MODE = process.env.HANDOFF_ACCEPT_MODE === "public-relay" ? "public-relay" : "lan-direct";
const LAN_HOST = process.env.HANDOFF_LAN_HOST || defaultLanHost();
const PUBLIC_ORIGIN = MODE === "public-relay"
  ? process.env.HANDOFF_PUBLIC_ORIGIN
  : `http://${LAN_HOST}:8877`;
if (!PUBLIC_ORIGIN) throw new Error("HANDOFF_PUBLIC_ORIGIN is required for public-relay acceptance");
const publicUrl = new URL(PUBLIC_ORIGIN);
if (MODE === "public-relay" && publicUrl.protocol !== "https:") {
  throw new Error("public-relay acceptance requires an https HANDOFF_PUBLIC_ORIGIN");
}
const BROKER_PORT = MODE === "public-relay" ? 18789 : 8877;
const BROKER_HOST = MODE === "public-relay" ? "127.0.0.1" : "0.0.0.0";
const TARGET_PORT = 8891;
const PRINCIPAL = MODE === "public-relay" ? "public-relay-acceptance-principal" : "lan-acceptance-principal";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.resolve(SCRIPT_DIR, "../.build/release/takeover-webrtc-host");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const hasTurnKeyId = Boolean(process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID);
const hasTurnToken = Boolean(process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN);
if (MODE === "lan-direct" && (hasTurnKeyId || hasTurnToken)) {
  throw new Error("Refusing LAN direct acceptance while TURN credentials are present");
}
if (MODE === "public-relay" && (!hasTurnKeyId || !hasTurnToken)) {
  throw new Error("public-relay acceptance requires both Cloudflare TURN credential variables");
}

const profile = await mkdtemp(path.join(os.tmpdir(), "handoff-lan-acceptance-"));
let chrome: ChildProcess | undefined;
let currentIntervention: string | undefined;
let diagBaseline = 0;
let run = 0;
let targetGeneration = 0;
const lifecycleEvents: Array<{ operation: string; status: number }> = [];
type PointerAcceptanceState = {
  button: boolean;
  checkbox: boolean;
  focus: boolean;
  javascript: boolean;
  normalNavigation: boolean;
  secondNavigation: boolean;
};
function freshPointerState(): PointerAcceptanceState {
  return {
    button: false,
    checkbox: false,
    focus: false,
    javascript: false,
    normalNavigation: false,
    secondNavigation: false
  };
}
let pointerState = freshPointerState();
function pointerComplete(): boolean {
  return Object.values(pointerState).every(Boolean);
}

const targetHtml = `<!doctype html><meta charset="utf-8"><title>Handoff LAN Acceptance Target</title>
<style>body{font:20px system-ui;margin:0;background:#f6f6f6;color:#111}.card{margin:36px;padding:28px;background:white;border-radius:18px}.pointer-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:center}.pointer-grid button,.pointer-grid a,.pointer-grid input{font:22px system-ui;padding:14px;min-height:58px}.pointer-grid a{display:flex;align-items:center;background:#eef;border-radius:10px;text-decoration:none;color:#111}.text-entry{font:24px system-ui;padding:14px;width:80%}.spacer{height:1150px;background:linear-gradient(#fff,#ddd);margin:20px 0}.bottom{font-size:30px;padding:30px;background:white}</style>
<div class="card"><h1>Handoff LAN Acceptance</h1><p>Pointer matrix: activate the button, check the checkbox, focus the harmless focus field without typing, activate the JavaScript-backed link, then activate the normal navigation link and the second link on the next page.</p><div class="pointer-grid"><button id="pointer-button" onclick="markPointer('button')">Pointer button</button><label><input id="pointer-checkbox" type="checkbox" onchange="if(this.checked)markPointer('checkbox')"> Checkbox</label><input id="pointer-focus" aria-label="Pointer focus field" placeholder="focus only — do not type" onfocus="markPointer('focus')"><a id="pointer-js" href="javascript:markPointer('javascript');void 0">JavaScript-backed link</a><a id="pointer-normal" href="/pointer-next">Normal navigation link</a></div></div>
<div class="card"><p>Text/scroll baseline: tap the field, type a short harmless test string, Backspace once, then swipe up to move down the page.</p><input class="text-entry" aria-label="Acceptance text field" placeholder="type here"></div><div class="spacer"></div><div class="bottom">Scroll target reached</div>
<script>function markPointer(kind){fetch('/__pointer-event?kind='+encodeURIComponent(kind),{method:'POST',cache:'no-store'}).catch(()=>{})}let generation=-1;setInterval(async()=>{try{const r=await fetch('/__state',{cache:'no-store'});if(!r.ok)return;const s=await r.json();if(s.generation!==generation){generation=s.generation;scrollTo(0,0);const i=document.querySelector('input[aria-label="Acceptance text field"]');if(i)i.value='';const c=document.querySelector('#pointer-checkbox');if(c)c.checked=false}}catch{}},100)</script>`;

const pointerNextHtml = `<!doctype html><meta charset="utf-8"><title>Handoff Pointer Navigation</title><style>body{font:24px system-ui;padding:40px;background:#f6f6f6}.card{padding:30px;background:white;border-radius:18px}a{display:inline-flex;padding:18px 24px;background:#eef;border-radius:12px;color:#111;text-decoration:none}</style><div class="card"><h1>Normal navigation completed</h1><p>Activate the second ordinary link to return to the pointer matrix.</p><a id="pointer-second" href="/pointer-second">Second navigation link</a></div>`;

const targetServer = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${TARGET_PORT}`);
  if (url.pathname === "/__state") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ generation: targetGeneration, pointer: pointerState, pointerComplete: pointerComplete() }));
    return;
  }
  if (url.pathname === "/__pointer-event" && req.method === "POST") {
    const kind = url.searchParams.get("kind");
    if (kind === "button" || kind === "checkbox" || kind === "focus" || kind === "javascript") {
      pointerState[kind] = true;
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    res.writeHead(400, { "cache-control": "no-store" });
    res.end("Invalid pointer event");
    return;
  }
  if (url.pathname === "/pointer-next") {
    pointerState.normalNavigation = true;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(pointerNextHtml);
    return;
  }
  if (url.pathname === "/pointer-second") {
    pointerState.secondNavigation = true;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(targetHtml);
    return;
  }
  if (url.pathname !== "/") {
    res.writeHead(404, { "cache-control": "no-store" });
    res.end("Not Found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(targetHtml);
});
await new Promise<void>((resolve, reject) => {
  targetServer.once("error", reject);
  targetServer.listen(TARGET_PORT, "127.0.0.1", resolve);
});

chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--new-window",
  `http://127.0.0.1:${TARGET_PORT}/`
], { stdio: "ignore" });
if (!chrome.pid) throw new Error("Chrome target did not start");
await new Promise((resolve) => setTimeout(resolve, 1200));

const windowHandoff = new WindowHandoffAdapter({
  takeover: {
    enabled: true,
    publicBaseUrl: PUBLIC_ORIGIN,
    ttlMs: 180_000,
    reconnectIdleMs: 2_000
  },
  runtime: { hostExecutable: HOST }
});
const ACCEPTANCE_INPUT_POLICY = { tap: true, scroll: true, text: true, key: true } as const;

function localOnly(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress || "";
  const loopbackSocket = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  const host = (req.headers.host || "").toLowerCase();
  const loopbackHost = host === `127.0.0.1:${BROKER_PORT}`
    || host === `localhost:${BROKER_PORT}`
    || host === `[::1]:${BROKER_PORT}`;
  return loopbackSocket && loopbackHost;
}

async function control(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/__")) return false;
  if (!localOnly(req)) {
    res.writeHead(404, { "cache-control": "no-store" }); res.end("Not Found"); return true;
  }
  if (pathname === "/__new") {
    if (currentIntervention) await windowHandoff.revoke(currentIntervention).catch(() => undefined);
    run += 1;
    targetGeneration += 1;
    pointerState = freshPointerState();
    await new Promise((resolve) => setTimeout(resolve, 180));
    currentIntervention = `lan-run-${run}-${randomBytes(6).toString("hex")}`;
    diagBaseline = windowHandoff.diagnosticsSnapshot().events.length;
    const locator = windowHandoff.start({
      intervention: { id: currentIntervention, epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: chrome!.pid! },
      inputPolicy: ACCEPTANCE_INPUT_POLICY
    });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ run, locator }));
    return true;
  }
  if (pathname === "/__diag") {
    const snapshot = windowHandoff.diagnosticsSnapshot();
    const latency = windowHandoff.latencySnapshot();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ run, events: snapshot.events.slice(diagBaseline), latency }));
    return true;
  }
  if (pathname === "/__revoke") {
    if (currentIntervention) await windowHandoff.revoke(currentIntervention).catch(() => undefined);
    currentIntervention = undefined;
    res.writeHead(204, { "cache-control": "no-store" }); res.end();
    return true;
  }
  if (pathname === "/__lifecycle") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ run, events: lifecycleEvents.slice(-32) }));
    return true;
  }
  if (pathname === "/__health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, targetPid: chrome?.pid || 0 }));
    return true;
  }
  res.writeHead(404, { "cache-control": "no-store" }); res.end("Not Found");
  return true;
}

const brokerServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", PUBLIC_ORIGIN);
    if (await control(req, res, url.pathname)) return;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const data = Buffer.from(chunk);
      total += data.length;
      if (total > 256 * 1024) throw new Error("request too large");
      chunks.push(data);
    }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(url.toString(), {
      method: req.method || "GET",
      headers: req.headers as Record<string, string>,
      ...(body ? { body } : {})
    });
    const response = await windowHandoff.handle(request, PRINCIPAL);
    const operation = url.pathname.match(/^\/takeover\/api\/(webrtc-prepare-claim|webrtc-prepare-reconnect|webrtc-suspend)\//)?.[1];
    if (operation) lifecycleEvents.push({ operation, status: response.status });
    if (lifecycleEvents.length > 32) lifecycleEvents.splice(0, lifecycleEvents.length - 32);
    const responseBody = Buffer.from(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    res.writeHead(response.status, headers);
    res.end(responseBody);
  } catch {
    if (!res.headersSent) res.writeHead(500, { "cache-control": "no-store" });
    res.end("Internal Error");
  }
});
await new Promise<void>((resolve, reject) => {
  brokerServer.once("error", reject);
  brokerServer.listen(BROKER_PORT, BROKER_HOST, resolve);
});

console.log(`Handoff WebRTC acceptance ready: mode=${MODE} origin=${PUBLIC_ORIGIN}`);
console.log(`Fresh locator control: http://127.0.0.1:${BROKER_PORT}/__new`);
console.log(`Pointer matrix state: http://127.0.0.1:${TARGET_PORT}/__state`);

async function shutdown() {
  if (currentIntervention) await windowHandoff.revoke(currentIntervention).catch(() => undefined);
  await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
  await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  chrome?.kill("SIGTERM");
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });

await new Promise(() => undefined);
