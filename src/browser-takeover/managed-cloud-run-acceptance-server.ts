import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { BrowserHandoffAdapter } from "./browser-handoff-adapter.js";
import { parseWindowIds } from "./linux-webrtc-host-cli.js";

const DISPLAY = ":99";
const COOKIE_NAME = "__Host-handoff-accept";
const SESSION_TTL_MS = 15 * 60_000;
const PRINCIPAL_BYTES = 24;
const INTERVENTION_ID = "cloud-run-managed-physical-acceptance";
const TARGET_TITLE = "Handoff Managed Physical Acceptance";
const TARGET_WINDOW_TITLE = `${TARGET_TITLE} - Chromium`;
const TURN_ENV = [
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID",
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN",
  "MCP_HANDOFF_COTURN_SHARED_SECRET",
  "MCP_HANDOFF_COTURN_TURN_URLS",
  "MCP_HANDOFF_COTURN_STUN_URLS"
] as const;

interface TargetState {
  ready: boolean;
  formOpened: boolean;
  inputFocused: boolean;
  textObserved: boolean;
  backspaceObserved: boolean;
  scrolled: boolean;
  enterKeyDownObserved: boolean;
  enterKeyUpObserved: boolean;
  submitted: boolean;
}

interface BrowserTarget {
  processId: number;
  windowId: number;
}

interface ManagedEvidence {
  currentTransport: "webrtc_direct" | "websocket_relay" | "webrtc_relay" | "none";
  lastTransport: "webrtc_direct" | "websocket_relay" | "webrtc_relay" | "none";
  generation: number;
  transitionCount: number;
  lastFallbackReason?: "transport_unavailable";
}

assertNoTurnEnvironment();
const port = boundedPort(process.env.PORT);
const publicBaseUrl = requiredHttpsOrigin(process.env.HANDOFF_WSS_PUBLIC_BASE_URL);
const acceptanceRevision = requiredGitRevision(process.env.HANDOFF_ACCEPTANCE_REVISION);
const hostScript = path.resolve("dist/browser-takeover/linux-webrtc-host-cli.js");

const targetState: TargetState = {
  ready: false,
  formOpened: false,
  inputFocused: false,
  textObserved: false,
  backspaceObserved: false,
  scrolled: false,
  enterKeyDownObserved: false,
  enterKeyUpObserved: false,
  submitted: false
};
let doneObserved = false;
let verificationStartedObserved = false;
let teardownCompleted = false;
let staleDirectLocatorRejected = false;
let staleWebSocketLocatorRejected = false;
let browserTarget: BrowserTarget | undefined;
let browser: ChildProcess | undefined;
let xvfb: ChildProcess | undefined;
let openbox: ChildProcess | undefined;
let handoff: BrowserHandoffAdapter | undefined;
let activePrincipal: string | undefined;
let activeLocator: string | undefined;
let initialDirectPath: string | undefined;
let observedWebSocketPath: string | undefined;
let activeStartedAt = 0;
let activeEpoch = 0;
let managedEvidence: ManagedEvidence = {
  currentTransport: "none",
  lastTransport: "none",
  generation: 0,
  transitionCount: 0
};

const server = http.createServer((req, res) => {
  void handleHttp(req, res).catch(() => sendJson(res, 500, { error: "acceptance_unavailable" }));
});
server.on("upgrade", (req, socket, head) => {
  if (!handoff || !handoff.handleUpgrade(req, socket, head)) socket.destroy();
});

server.listen(port, "0.0.0.0");
await once(server, "listening");
void initializeBrowser().catch(() => {
  browserTarget = undefined;
});

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", publicBaseUrl);
  if (url.pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      targetReady: browserTarget !== undefined,
      revision: acceptanceRevision
    });
    return;
  }
  if (url.pathname === "/target") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    sendHtml(res, targetLandingPage());
    return;
  }
  if (url.pathname === "/target-form") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.formOpened = true;
    sendHtml(res, targetFormPage());
    return;
  }
  if (url.pathname === "/target-ready" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.ready = true;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/target-focused" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.inputFocused = true;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/target-blurred" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.inputFocused = false;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/target-typed" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.textObserved = true;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/target-backspace" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.backspaceObserved = true;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/target-scrolled" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.scrolled = true;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/target-enter-keydown" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.enterKeyDownObserved = true;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/target-enter-keyup" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.enterKeyUpObserved = true;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/target-submitted" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.submitted = true;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/acceptance-result") {
    await refreshManagedEvidence();
    sendJson(res, 200, acceptanceSnapshot());
    return;
  }
  if (url.pathname === "/acceptance-status") {
    const principal = principalFromRequest(req);
    if (!principal || principal !== activePrincipal) return sendJson(res, 404, { error: "not_found" });
    await refreshManagedEvidence();
    await probeStaleLocators();
    sendJson(res, 200, acceptanceSnapshot());
    return;
  }
  if (url.pathname === "/start") {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
    const target = browserTarget;
    if (!target) return sendJson(res, 503, { error: "target_not_ready" });
    let cookieValue = cookieValueFromRequest(req);
    if (!cookieValue) cookieValue = randomBytes(PRINCIPAL_BYTES).toString("base64url");
    const principal = `physical:${cookieValue}`;
    if (activeLocator && activeStartedAt > 0 && Date.now() - activeStartedAt >= SESSION_TTL_MS) {
      await handoff?.revoke(INTERVENTION_ID);
      activeLocator = undefined;
      activeStartedAt = 0;
    }
    if (activePrincipal && activePrincipal !== principal && activeLocator && !doneObserved) {
      return sendJson(res, 409, { error: "acceptance_in_use" });
    }
    if (!handoff) handoff = createManagedHandoff();
    if (activeLocator) {
      await handoff.revoke(INTERVENTION_ID);
      activeLocator = undefined;
      activeStartedAt = 0;
    }
    resetAcceptanceState();
    activeEpoch += 1;
    activePrincipal = principal;
    activeLocator = handoff.start({
      intervention: { id: INTERVENTION_ID, epoch: activeEpoch },
      principalBinding: principal,
      target,
      inputPolicy: { tap: true, scroll: true, text: true, key: true }
    });
    initialDirectPath = new URL(activeLocator).pathname;
    activeStartedAt = Date.now();
    await refreshManagedEvidence();
    res.statusCode = 302;
    res.setHeader("cache-control", "no-store");
    res.setHeader("location", initialDirectPath);
    res.setHeader(
      "set-cookie",
      `${COOKIE_NAME}=${cookieValue}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`
    );
    res.end();
    return;
  }

  if (!handoff || !handoff.ownsPath(url.pathname)) return sendJson(res, 404, { error: "not_found" });
  const principal = principalFromRequest(req);
  const request = new Request(new URL(req.url ?? "/", publicBaseUrl), {
    method: req.method ?? "GET",
    headers: requestHeaders(req)
  });
  const response = await handoff.handle(request, principal);
  await refreshManagedEvidence();
  if (
    principal === activePrincipal
    && managedEvidence.currentTransport === "websocket_relay"
    && /^\/takeover\/[A-Za-z0-9-]{8,100}$/.test(url.pathname)
    && url.pathname !== initialDirectPath
  ) {
    observedWebSocketPath = url.pathname;
  }
  await probeStaleLocators();
  await writeFetchResponse(res, response);
}

function createManagedHandoff(): BrowserHandoffAdapter {
  return new BrowserHandoffAdapter({
    takeover: {
      enabled: true,
      publicBaseUrl,
      ttlMs: SESSION_TTL_MS,
      reconnectIdleMs: 500
    },
    runtime: {
      hostExecutable: process.execPath,
      hostArgs: [hostScript],
      displayName: DISPLAY
    },
    managedFallback: {
      linuxHostScript: hostScript,
      displayName: DISPLAY
    },
    onComplete: () => {
      doneObserved = true;
      verificationStartedObserved = true;
      activeLocator = undefined;
      activeStartedAt = 0;
      setTimeout(() => { void finalizeManagedTeardown(); }, 0).unref();
    }
  });
}

async function refreshManagedEvidence(): Promise<void> {
  if (!handoff) return;
  const snapshot = handoff.operatorDiagnosticsSnapshot();
  if (snapshot.source !== "browser_handoff") return;
  const transport = snapshot.transport;
  if (transport.namespace !== "managed_handoff") return;
  managedEvidence = {
    currentTransport: transport.currentTransport,
    lastTransport: transport.lastTransport,
    generation: Math.max(managedEvidence.generation, transport.generation),
    transitionCount: Math.max(managedEvidence.transitionCount, transport.transitionCount),
    ...(transport.lastFallbackReason === undefined
      ? managedEvidence.lastFallbackReason === undefined
        ? {}
        : { lastFallbackReason: managedEvidence.lastFallbackReason }
      : { lastFallbackReason: transport.lastFallbackReason })
  };
}

async function probeStaleLocators(): Promise<void> {
  const principal = activePrincipal;
  if (!handoff || !principal) return;
  if (
    !staleDirectLocatorRejected
    && managedEvidence.transitionCount >= 1
    && managedEvidence.generation >= 2
    && initialDirectPath
  ) {
    const stale = await handoff.handle(new Request(new URL(initialDirectPath, publicBaseUrl)), principal);
    staleDirectLocatorRejected = stale.status === 404;
  }
  if (teardownCompleted && observedWebSocketPath && !staleWebSocketLocatorRejected) {
    const stale = await handoff.handle(
      new Request(new URL(observedWebSocketPath, publicBaseUrl)),
      principal
    );
    staleWebSocketLocatorRejected = stale.status === 404;
  }
}

async function finalizeManagedTeardown(): Promise<void> {
  const adapter = handoff;
  if (!adapter || teardownCompleted) return;
  await refreshManagedEvidence();
  await adapter.revoke(INTERVENTION_ID);
  teardownCompleted = true;
  await probeStaleLocators();
}

function acceptanceSnapshot(): object {
  const fallbackObserved = managedEvidence.lastTransport === "websocket_relay"
    || managedEvidence.currentTransport === "websocket_relay";
  return {
    revision: acceptanceRevision,
    targetReady: browserTarget !== undefined,
    exactTargetBounded: browserTarget !== undefined,
    turnConfigured: false,
    currentTransport: managedEvidence.currentTransport,
    lastTransport: managedEvidence.lastTransport,
    generation: managedEvidence.generation,
    transitionCount: managedEvidence.transitionCount,
    lastFallbackReason: managedEvidence.lastFallbackReason ?? null,
    fallbackObserved,
    staleDirectLocatorRejected,
    staleDirectGenerationFenced:
      staleDirectLocatorRejected && managedEvidence.generation >= 2 && managedEvidence.transitionCount >= 1,
    staleWebSocketLocatorRejected,
    tapObserved: targetState.formOpened,
    inputFocused: targetState.inputFocused,
    textObserved: targetState.textObserved,
    backspaceObserved: targetState.backspaceObserved,
    scrollObserved: targetState.scrolled,
    enterKeyDownObserved: targetState.enterKeyDownObserved,
    enterKeyUpObserved: targetState.enterKeyUpObserved,
    submitObserved: targetState.submitted,
    doneObserved,
    verificationStartedObserved,
    teardownCompleted
  };
}

function resetAcceptanceState(): void {
  doneObserved = false;
  verificationStartedObserved = false;
  teardownCompleted = false;
  staleDirectLocatorRejected = false;
  staleWebSocketLocatorRejected = false;
  initialDirectPath = undefined;
  observedWebSocketPath = undefined;
  targetState.formOpened = false;
  targetState.inputFocused = false;
  targetState.textObserved = false;
  targetState.backspaceObserved = false;
  targetState.scrolled = false;
  targetState.enterKeyDownObserved = false;
  targetState.enterKeyUpObserved = false;
  targetState.submitted = false;
  managedEvidence = {
    currentTransport: "none",
    lastTransport: "none",
    generation: 0,
    transitionCount: 0
  };
}

async function initializeBrowser(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Cloud Run managed acceptance requires Linux");
  const root = path.join(os.tmpdir(), `handoff-managed-${process.pid}`);
  await rm(root, { recursive: true, force: true });
  await Promise.all([
    mkdir(path.join(root, "profile"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(root, "home"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(root, "runtime"), { recursive: true, mode: 0o700 })
  ]);
  const xEnv = {
    DISPLAY,
    HOME: path.join(root, "home"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8"
  };
  xvfb = spawn("/usr/bin/Xvfb", [DISPLAY, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  await waitFor(
    "xvfb",
    async () => (await runBounded(
      "/usr/bin/xdotool",
      ["getmouselocation", "--shell"],
      xEnv
    ).catch(() => "")).includes("X="),
    8_000
  );
  openbox = spawn("/usr/bin/openbox", ["--sm-disable"], {
    env: xEnv,
    stdio: ["ignore", "ignore", "ignore"]
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (openbox.exitCode !== null) throw new Error("openbox unavailable");

  const chrome = firstExecutable([
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable"
  ]);
  const args = [
    `--user-data-dir=${path.join(root, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--disable-dev-shm-usage",
    "--window-size=1000,700",
    "--new-window",
    `http://127.0.0.1:${port}/target`
  ];
  if (process.getuid?.() === 0) args.unshift("--no-sandbox");
  if (args.some((arg) => /remote-debugging|enable-automation|headless/i.test(arg))) {
    throw new Error("normal-browser acceptance flags are invalid");
  }
  browser = spawn(chrome, args, { env: xEnv, stdio: ["ignore", "ignore", "ignore"] });
  if (!browser.pid) throw new Error("browser pid unavailable");
  const pid = browser.pid;
  await waitFor("target-page", () => targetState.ready, 30_000);
  let stable: number | undefined;
  let samples = 0;
  await waitFor("exact-window", async () => {
    if (browser?.exitCode !== null || browser?.signalCode !== null) throw new Error("browser exited");
    const raw = await runBounded(
      "/usr/bin/xdotool",
      ["search", "--onlyvisible", "--pid", String(pid)],
      xEnv
    ).catch(() => "");
    const ids = [...new Set(parseWindowIds(raw))];
    if (ids.length !== 1) { stable = undefined; samples = 0; return false; }
    const id = ids[0]!;
    const owner = Number((await runBounded(
      "/usr/bin/xdotool",
      ["getwindowpid", String(id)],
      xEnv
    ).catch(() => "")).trim());
    const title = (await runBounded(
      "/usr/bin/xdotool",
      ["getwindowname", String(id)],
      xEnv
    ).catch(() => "")).trim();
    if (owner !== pid || title !== TARGET_WINDOW_TITLE) {
      stable = undefined;
      samples = 0;
      return false;
    }
    if (stable === id) samples += 1;
    else { stable = id; samples = 1; }
    return samples >= 2;
  }, 30_000);
  browserTarget = { processId: pid, windowId: stable! };
}

function targetLandingPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${TARGET_TITLE}</title></head><body style="margin:0;font-family:system-ui"><button onclick="location.href='/target-form'" style="position:fixed;inset:0;border:0;font-size:40px">Tap to open managed fallback acceptance form</button><script>fetch('/target-ready',{method:'POST',cache:'no-store'}).catch(()=>{});</script></body></html>`;
}

function targetFormPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${TARGET_TITLE}</title></head><body style="margin:0;font-family:system-ui;min-height:2200px;background:linear-gradient(#fff,#ddd)"><form id="f" style="padding:60px"><label style="font-size:30px">Type harmless text, press Backspace, scroll, then press Enter<br><input id="i" autocomplete="off" style="margin-top:24px;width:80%;font-size:34px;padding:16px"></label></form><div style="margin-top:1400px;font-size:36px;padding:60px">Scroll marker</div><script>const i=document.getElementById('i');const f=document.getElementById('f');let typed=false,backspaced=false,scrolled=false;i.addEventListener('focus',()=>{fetch('/target-focused',{method:'POST',cache:'no-store'}).catch(()=>{})});i.addEventListener('blur',()=>{fetch('/target-blurred',{method:'POST',cache:'no-store'}).catch(()=>{})});i.addEventListener('input',()=>{if(!typed){typed=true;fetch('/target-typed',{method:'POST',cache:'no-store'}).catch(()=>{})}});document.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!backspaced){backspaced=true;fetch('/target-backspace',{method:'POST',cache:'no-store'}).catch(()=>{})}if(e.key==='Enter'){fetch('/target-enter-keydown',{method:'POST',cache:'no-store'}).catch(()=>{})}});document.addEventListener('keyup',e=>{if(e.key==='Enter'){fetch('/target-enter-keyup',{method:'POST',cache:'no-store'}).catch(()=>{})}});addEventListener('scroll',()=>{if(!scrolled&&scrollY>80){scrolled=true;fetch('/target-scrolled',{method:'POST',cache:'no-store'}).catch(()=>{})}},{passive:true});f.addEventListener('submit',e=>{e.preventDefault();fetch('/target-submitted',{method:'POST',cache:'no-store'}).then(()=>{document.body.innerHTML='<div style="padding:80px;font-size:42px">Submitted — press Done on the takeover UI.</div>'}).catch(()=>{})});setTimeout(()=>i.focus(),50);</script></body></html>`;
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

function sendHtml(res: ServerResponse, body: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: object | undefined): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function cookieValueFromRequest(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie ?? "";
  for (const part of cookie.split(";")) {
    const [name, value] = part.trim().split("=", 2);
    if (name === COOKIE_NAME && value && /^[A-Za-z0-9_-]{32}$/.test(value)) return value;
  }
  return undefined;
}

function principalFromRequest(req: IncomingMessage): string | undefined {
  const value = cookieValueFromRequest(req);
  return value ? `physical:${value}` : undefined;
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function requiredHttpsOrigin(value: string | undefined): string {
  if (!value) throw new Error("HANDOFF_WSS_PUBLIC_BASE_URL is required");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("HANDOFF_WSS_PUBLIC_BASE_URL must be an HTTPS origin");
  }
  return url.origin;
}

function requiredGitRevision(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error("HANDOFF_ACCEPTANCE_REVISION must be the exact 40-character git SHA");
  }
  return value;
}

function assertNoTurnEnvironment(): void {
  for (const name of TURN_ENV) {
    if (process.env[name]) throw new Error("Managed Cloud Run acceptance forbids TURN configuration");
  }
}

function boundedPort(value: string | undefined): number {
  const candidate = Number(value ?? "8080");
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 65_535) {
    throw new Error("PORT is invalid");
  }
  return candidate;
}

function firstExecutable(candidates: string[]): string {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error("normal browser executable unavailable");
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Managed physical acceptance timed out at ${label}`);
}

async function runBounded(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes <= 64 * 1024) chunks.push(chunk);
  });
  child.once("error", () => undefined);
  const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  if (code !== 0 || bytes > 64 * 1024) throw new Error("bounded acceptance command failed");
  return Buffer.concat(chunks).toString("utf8");
}

async function shutdown(): Promise<void> {
  await handoff?.revoke(INTERVENTION_ID).catch(() => undefined);
  for (const child of [browser, openbox, xvfb]) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  server.close();
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
