import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { ExperimentalWebSocketBrowserHandoff } from "./websocket-browser-handoff.js";
import { ExperimentalLinuxWebSocketWindowSurface } from "./linux-websocket-window-surface.js";
import { parseWindowIds } from "../browser-takeover/linux-webrtc-host-cli.js";

const DISPLAY = ":99";
const COOKIE_NAME = "__Host-handoff-accept";
const SESSION_TTL_MS = 15 * 60_000;
const PRINCIPAL_BYTES = 24;
const TARGET_TITLE = "Handoff WSS Physical Acceptance";
const TARGET_WINDOW_TITLE = `${TARGET_TITLE} - Chromium`;

interface TargetState {
  ready: boolean;
  formOpened: boolean;
  textObserved: boolean;
  scrolled: boolean;
  submitted: boolean;
}

interface BrowserTarget {
  processId: number;
  windowId: number;
}

const targetState: TargetState = {
  ready: false,
  formOpened: false,
  textObserved: false,
  scrolled: false,
  submitted: false
};
let doneObserved = false;
let browserTarget: BrowserTarget | undefined;
let browser: ChildProcess | undefined;
let xvfb: ChildProcess | undefined;
let openbox: ChildProcess | undefined;
let surface: ExperimentalLinuxWebSocketWindowSurface | undefined;
let handoff: ExperimentalWebSocketBrowserHandoff | undefined;
let activePrincipal: string | undefined;
let activeLocator: string | undefined;
let activeStartedAt = 0;
let activeEpoch = 0;

const port = boundedPort(process.env.PORT);
const publicBaseUrl = requiredHttpsOrigin(process.env.HANDOFF_WSS_PUBLIC_BASE_URL);
const hostScript = path.resolve("dist/browser-takeover/linux-webrtc-host-cli.js");

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
    sendJson(res, 200, { ok: true, targetReady: browserTarget !== undefined });
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
  if (url.pathname === "/target-typed" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.textObserved = true;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/target-scrolled" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.scrolled = true;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/target-submitted" && req.method === "POST") {
    if (!isLoopback(req)) return sendJson(res, 404, { error: "not_found" });
    targetState.submitted = true;
    return sendJson(res, 204, undefined);
  }
  if (url.pathname === "/acceptance-result") {
    sendJson(res, 200, {
      targetReady: browserTarget !== undefined,
      tapObserved: targetState.formOpened,
      textObserved: targetState.textObserved,
      scrollObserved: targetState.scrolled,
      submitObserved: targetState.submitted,
      doneObserved
    });
    return;
  }
  if (url.pathname === "/acceptance-status") {
    const principal = principalFromRequest(req);
    if (!principal || principal !== activePrincipal) return sendJson(res, 404, { error: "not_found" });
    sendJson(res, 200, {
      targetReady: browserTarget !== undefined,
      sessionActive: activeLocator !== undefined && !doneObserved,
      tapObserved: targetState.formOpened,
      textObserved: targetState.textObserved,
      scrollObserved: targetState.scrolled,
      submitObserved: targetState.submitted,
      doneObserved
    });
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
      handoff?.revoke("cloud-run-wss-physical-acceptance");
      activeLocator = undefined;
      activeStartedAt = 0;
    }
    if (activePrincipal && activePrincipal !== principal && activeLocator && !doneObserved) {
      return sendJson(res, 409, { error: "acceptance_in_use" });
    }
    if (!surface) {
      surface = new ExperimentalLinuxWebSocketWindowSurface({
        hostScript,
        displayName: DISPLAY,
        helperTtlMs: SESSION_TTL_MS
      });
    }
    if (!handoff) {
      handoff = new ExperimentalWebSocketBrowserHandoff({
        takeover: {
          enabled: true,
          publicBaseUrl,
          ttlMs: SESSION_TTL_MS,
          reconnectIdleMs: 500
        },
        allowedOrigins: [publicBaseUrl],
        surface,
        frameIntervalMs: 100,
        onComplete: () => {
          doneObserved = true;
          activeLocator = undefined;
          activeStartedAt = 0;
        }
      });
    }
    // `/start` is an explicit acceptance-session request, not a stable bookmark. Reopening it with
    // the same authenticated browser must never recycle a locator whose broker TTL may already have
    // expired. Fence any prior session first, then mint a fresh epoch/locator for the same principal.
    if (activeLocator) {
      handoff.revoke("cloud-run-wss-physical-acceptance");
      activeLocator = undefined;
      activeStartedAt = 0;
    }
    activeEpoch += 1;
    doneObserved = false;
    targetState.formOpened = false;
    targetState.textObserved = false;
    targetState.scrolled = false;
    targetState.submitted = false;
    activePrincipal = principal;
    activeLocator = handoff.start({
      intervention: { id: "cloud-run-wss-physical-acceptance", epoch: activeEpoch },
      principalBinding: principal,
      target,
      inputPolicy: { tap: true, scroll: true, text: true, key: true }
    });
    activeStartedAt = Date.now();
    res.statusCode = 302;
    res.setHeader("cache-control", "no-store");
    res.setHeader("location", new URL(activeLocator).pathname);
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
  await writeFetchResponse(res, response);
}

async function initializeBrowser(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Cloud Run WSS acceptance requires Linux");
  const root = path.join(os.tmpdir(), `handoff-wss-${process.pid}`);
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
  await waitFor("xvfb", async () => (await runBounded("/usr/bin/xdotool", ["getmouselocation", "--shell"], xEnv).catch(() => "")).includes("X="), 8_000);
  openbox = spawn("/usr/bin/openbox", ["--sm-disable"], { env: xEnv, stdio: ["ignore", "ignore", "ignore"] });
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (openbox.exitCode !== null) throw new Error("openbox unavailable");

  const chrome = firstExecutable(["/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]);
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
    const raw = await runBounded("/usr/bin/xdotool", ["search", "--onlyvisible", "--pid", String(pid)], xEnv).catch(() => "");
    const ids = [...new Set(parseWindowIds(raw))];
    if (ids.length !== 1) { stable = undefined; samples = 0; return false; }
    const id = ids[0]!;
    const owner = Number((await runBounded("/usr/bin/xdotool", ["getwindowpid", String(id)], xEnv).catch(() => "")).trim());
    const title = (await runBounded("/usr/bin/xdotool", ["getwindowname", String(id)], xEnv).catch(() => "")).trim();
    if (owner !== pid || title !== TARGET_WINDOW_TITLE) { stable = undefined; samples = 0; return false; }
    if (stable === id) samples += 1; else { stable = id; samples = 1; }
    return samples >= 2;
  }, 30_000);
  browserTarget = { processId: pid, windowId: stable! };
}

function targetLandingPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${TARGET_TITLE}</title></head><body style="margin:0;font-family:system-ui"><button onclick="location.href='/target-form'" style="position:fixed;inset:0;border:0;font-size:40px">Tap to open WSS acceptance form</button><script>fetch('/target-ready',{method:'POST',cache:'no-store'}).catch(()=>{});</script></body></html>`;
}

function targetFormPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${TARGET_TITLE}</title></head><body style="margin:0;font-family:system-ui;min-height:2200px;background:linear-gradient(#fff,#ddd)"><form id="f" style="padding:60px"><label style="font-size:30px">Type any harmless text, scroll, then press Enter<br><input id="i" autocomplete="off" style="margin-top:24px;width:80%;font-size:34px;padding:16px"></label></form><div style="margin-top:1400px;font-size:36px;padding:60px">Scroll marker</div><script>const i=document.getElementById('i');const f=document.getElementById('f');let typed=false,scrolled=false;i.addEventListener('input',()=>{if(!typed){typed=true;fetch('/target-typed',{method:'POST',cache:'no-store'}).catch(()=>{})}});addEventListener('scroll',()=>{if(!scrolled&&scrollY>80){scrolled=true;fetch('/target-scrolled',{method:'POST',cache:'no-store'}).catch(()=>{})}},{passive:true});f.addEventListener('submit',e=>{e.preventDefault();fetch('/target-submitted',{method:'POST',cache:'no-store'}).then(()=>{document.body.innerHTML='<div style="padding:80px;font-size:42px">Submitted — press Done on the takeover UI.</div>'}).catch(()=>{})});setTimeout(()=>i.focus(),50);</script></body></html>`;
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

function boundedPort(value: string | undefined): number {
  const port = Number(value ?? "8080");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid");
  return port;
}

function firstExecutable(candidates: string[]): string {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error("normal browser executable unavailable");
}

async function waitFor(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`WSS physical acceptance timed out at ${label}`);
}

async function runBounded(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
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
  await surface?.close().catch(() => undefined);
  for (const child of [browser, openbox, xvfb]) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  server.close();
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
