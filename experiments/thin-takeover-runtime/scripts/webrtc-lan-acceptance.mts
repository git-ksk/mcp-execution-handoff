import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TakeoverBroker, type TakeoverBrowserAdapter } from "../../../src/browser-takeover/broker.ts";
import { SpawnedWebRtcRuntimeProvider } from "../../../src/browser-takeover/webrtc-runtime.ts";

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

const LAN_HOST = process.env.HANDOFF_LAN_HOST || defaultLanHost();
const BROKER_PORT = 8877;
const TARGET_PORT = 8891;
const PRINCIPAL = "lan-acceptance-principal";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.resolve(SCRIPT_DIR, "../.build/release/takeover-webrtc-host");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID || process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN) {
  throw new Error("Refusing LAN direct acceptance while TURN credentials are present");
}

const profile = await mkdtemp(path.join(os.tmpdir(), "handoff-lan-acceptance-"));
let chrome: ChildProcess | undefined;
let currentIntervention: string | undefined;
let diagBaseline = 0;
let run = 0;
let targetGeneration = 0;
const lifecycleEvents: Array<{ operation: string; status: number }> = [];

const targetHtml = `<!doctype html><meta charset="utf-8"><title>Handoff LAN Acceptance Target</title>
<style>body{font:20px system-ui;margin:0;background:#f6f6f6;color:#111}.card{margin:36px;padding:28px;background:white;border-radius:18px}input{font:24px system-ui;padding:14px;width:80%}.spacer{height:1150px;background:linear-gradient(#fff,#ddd);margin:20px 0}.bottom{font-size:30px;padding:30px;background:white}</style>
<div class="card"><h1>Handoff LAN Acceptance</h1><p>Tap the field, type a short harmless test string, Backspace once, then swipe up to move down the page.</p><input aria-label="Acceptance text field" placeholder="type here"></div><div class="spacer"></div><div class="bottom">Scroll target reached</div>
<script>let generation=-1;setInterval(async()=>{try{const r=await fetch('/__state',{cache:'no-store'});if(!r.ok)return;const s=await r.json();if(s.generation!==generation){generation=s.generation;scrollTo(0,0);const i=document.querySelector('input');if(i)i.value=''}}catch{}},100)</script>`;

const targetServer = createServer((req, res) => {
  if (req.url === "/__state") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ generation: targetGeneration }));
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

const adapter: TakeoverBrowserAdapter = {
  async captureHumanTakeoverFrame() { throw new Error("legacy frame surface disabled for WebRTC acceptance"); },
  async tapHumanTakeover() { throw new Error("legacy input disabled"); },
  async scrollHumanTakeover() { throw new Error("legacy input disabled"); },
  async insertHumanTakeoverText() { throw new Error("legacy input disabled"); },
  async pressHumanTakeoverKey() { throw new Error("legacy input disabled"); }
};
const runtime = new SpawnedWebRtcRuntimeProvider({ hostExecutable: HOST });
const broker = new TakeoverBroker(adapter, {
  enabled: true,
  publicBaseUrl: `http://${LAN_HOST}:${BROKER_PORT}`,
  ttlMs: 180_000,
  reconnectIdleMs: 2_000
}, undefined, runtime);

function localOnly(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function control(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/__")) return false;
  if (!localOnly(req)) {
    res.writeHead(404, { "cache-control": "no-store" }); res.end("Not Found"); return true;
  }
  if (pathname === "/__new") {
    if (currentIntervention) await broker.revokeWebRtcForIntervention(currentIntervention).catch(() => undefined);
    run += 1;
    targetGeneration += 1;
    await new Promise((resolve) => setTimeout(resolve, 180));
    currentIntervention = `lan-run-${run}-${randomBytes(6).toString("hex")}`;
    diagBaseline = runtime.diagnosticsSnapshot().events.length;
    const locator = broker.createWebRtcLink({ id: currentIntervention, epoch: 1 }, PRINCIPAL, { processId: chrome!.pid! });
    if (!locator) throw new Error("Unable to create WebRTC locator");
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ run, locator }));
    return true;
  }
  if (pathname === "/__diag") {
    const snapshot = runtime.diagnosticsSnapshot();
    const latency = runtime.latencySnapshot();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ run, events: snapshot.events.slice(diagBaseline), latency }));
    return true;
  }
  if (pathname === "/__revoke") {
    if (currentIntervention) await broker.revokeWebRtcForIntervention(currentIntervention).catch(() => undefined);
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
    const base = `http://${req.headers.host || `${LAN_HOST}:${BROKER_PORT}`}`;
    const url = new URL(req.url || "/", base);
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
    const response = await broker.handle(request, PRINCIPAL);
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
  brokerServer.listen(BROKER_PORT, "0.0.0.0", resolve);
});

console.log(`Handoff LAN acceptance ready: http://${LAN_HOST}:${BROKER_PORT}`);
console.log(`Fresh locator control: http://127.0.0.1:${BROKER_PORT}/__new`);

async function shutdown() {
  if (currentIntervention) await broker.revokeWebRtcForIntervention(currentIntervention).catch(() => undefined);
  await new Promise<void>((resolve) => brokerServer.close(() => resolve()));
  await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  chrome?.kill("SIGTERM");
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });

await new Promise(() => undefined);
