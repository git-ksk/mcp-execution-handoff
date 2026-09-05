import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WindowWebSocketHandoffAdapter } from "../../../src/window-takeover/window-websocket-handoff-adapter.ts";
import { resolveWssAcceptanceIngress, stopWssAcceptanceTunnel } from "./wss-public-ingress.mts";

const EXPECTED_MARKER = "WSS_ACCEPT_OK";
const EXPECTED_IME_MARKER = "テスト";
const REJECTED_IME_PREEDIT = "てすと";
const REQUIRE_THIRD_PARTY_IME = process.env.HANDOFF_ACCEPT_THIRD_PARTY_IME === "1";
const RELAY_ENV = [
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID",
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN",
  "MCP_HANDOFF_COTURN_SHARED_SECRET",
  "MCP_HANDOFF_COTURN_TURN_URLS",
  "MCP_HANDOFF_COTURN_STUN_URLS"
] as const;

type FixtureState = {
  pid: number;
  windowId: number;
  focused: boolean;
  text: string;
  tapX: number;
  tapY: number;
  aimActivated: boolean;
};


function optionalPositiveInteger(name: string): number | undefined {
  if (!process.env[name]) return undefined;
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function readFixtureState(statePath: string): Promise<FixtureState | undefined> {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8")) as Partial<FixtureState>;
    if (
      Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      && Number.isSafeInteger(value.windowId) && Number(value.windowId) > 0
      && typeof value.focused === "boolean"
      && typeof value.text === "string"
      && typeof value.tapX === "number" && Number.isFinite(value.tapX) && value.tapX >= 0 && value.tapX <= 1
      && typeof value.tapY === "number" && Number.isFinite(value.tapY) && value.tapY >= 0 && value.tapY <= 1
      && typeof value.aimActivated === "boolean"
    ) return value as FixtureState;
  } catch {
    // Fixture writes atomically; retry until a complete state record exists.
  }
  return undefined;
}

async function waitForFixture(statePath: string): Promise<FixtureState> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readFixtureState(statePath);
    if (state) return state;
    await sleep(50);
  }
  throw new Error("timed out waiting for the macOS WSS acceptance fixture");
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(1_000).then(() => undefined)
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const PORT = Number(process.env.HANDOFF_WSS_PORT || "8893");
if (!Number.isSafeInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("invalid acceptance port");
const buildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.build/release");
const HOST = path.join(buildRoot, "takeover-webrtc-host");
const FIXTURE = path.join(buildRoot, "takeover-macos-text-input-fixture");
const PRINCIPAL = "macos-wss-window-physical-acceptance";
if (RELAY_ENV.some((name) => Boolean(process.env[name]))) {
  throw new Error("Refusing WSS-only acceptance while relay configuration is present");
}
await access(HOST);

const overridePid = optionalPositiveInteger("HANDOFF_WSS_TARGET_PID");
const overrideWindowId = optionalPositiveInteger("HANDOFF_WSS_TARGET_WINDOW_ID");
if ((overridePid === undefined) !== (overrideWindowId === undefined)) {
  throw new Error("HANDOFF_WSS_TARGET_PID and HANDOFF_WSS_TARGET_WINDOW_ID must be supplied together");
}

let fixtureProcess: ChildProcess | undefined;
let fixtureStatePath: string | undefined;
let initialFixture: FixtureState | undefined;
if (overridePid === undefined) {
  await access(FIXTURE);
  fixtureStatePath = path.join(tmpdir(), `handoff-wss-window-${process.pid}-${Date.now()}.json`);
  fixtureProcess = spawn(FIXTURE, [fixtureStatePath], { stdio: ["ignore", "ignore", "pipe"] });
  fixtureProcess.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  try {
    initialFixture = await waitForFixture(fixtureStatePath);
  } catch (error) {
    await stopChild(fixtureProcess);
    await rm(fixtureStatePath, { force: true });
    throw error;
  }
}

const TARGET_PID = overridePid ?? initialFixture!.pid;
const TARGET_WINDOW_ID = overrideWindowId ?? initialFixture!.windowId;
let ingress;
try {
  ingress = await resolveWssAcceptanceIngress(PORT);
} catch (error) {
  await stopChild(fixtureProcess);
  if (fixtureStatePath) await rm(fixtureStatePath, { force: true });
  throw error;
}
const PUBLIC_ORIGIN = ingress.publicOrigin;
const ALLOWED_ORIGIN = PUBLIC_ORIGIN;
let handoff: WindowWebSocketHandoffAdapter;
let interventionId: string;
let locator: string;
try {
  handoff = new WindowWebSocketHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: PUBLIC_ORIGIN, ttlMs: 300_000, reconnectIdleMs: 2_000 },
    allowedOrigins: [ALLOWED_ORIGIN],
    host: { platform: "macos", hostExecutable: HOST }
  });
  interventionId = `macos-wss-window-${randomBytes(6).toString("hex")}`;
  locator = handoff.start({
    intervention: { id: interventionId, epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: TARGET_PID, windowId: TARGET_WINDOW_ID },
    inputPolicy: { tap: true, scroll: true, text: true, key: true }
  });
} catch (error) {
  await stopWssAcceptanceTunnel(ingress.tunnelProcess);
  await stopChild(fixtureProcess);
  if (fixtureStatePath) await rm(fixtureStatePath, { force: true });
  throw error;
}

function localOnly(req: import("node:http").IncomingMessage): boolean {
  const address = req.socket.remoteAddress || "";
  const loopbackSocket = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  const host = (req.headers.host || "").toLowerCase();
  const loopbackHost = host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}` || host === `[::1]:${PORT}`;
  return loopbackSocket && loopbackHost;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", PUBLIC_ORIGIN);
    if (url.pathname === "/__diag") {
      if (!localOnly(req)) { res.writeHead(404, { "cache-control": "no-store" }); res.end("Not Found"); return; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ diagnostics: handoff.diagnosticsSnapshot(), latency: handoff.latencySnapshot() }));
      return;
    }
    if (url.pathname === "/__verified_complete") {
      if (!localOnly(req) || req.method !== "POST") {
        res.writeHead(404, { "cache-control": "no-store" }); res.end("Not Found"); return;
      }
      if (!fixtureStatePath) {
        res.writeHead(412, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ completed: false, reason: "external_target_requires_external_verification" }));
        return;
      }
      const current = await readFixtureState(fixtureStatePath);
      const imeMarkerCount = current ? current.text.split(EXPECTED_IME_MARKER).length - 1 : 0;
      const verified = current?.pid === TARGET_PID
        && current.windowId === TARGET_WINDOW_ID
        && current.aimActivated === true
        && current.text.includes(EXPECTED_MARKER)
        && imeMarkerCount >= (REQUIRE_THIRD_PARTY_IME ? 2 : 1)
        && !current.text.includes(REJECTED_IME_PREEDIT);
      const completed = verified
        ? await handoff.completeAfterVerification({ id: interventionId, epoch: 1 })
        : false;
      res.writeHead(completed ? 200 : 409, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ completed, verified: Boolean(verified) }));
      return;
    }
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
    const response = await handoff.handle(request, PRINCIPAL);
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
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
} catch (error) {
  handoff.revoke(interventionId);
  await handoff.close().catch(() => undefined);
  await stopWssAcceptanceTunnel(ingress.tunnelProcess);
  await stopChild(fixtureProcess);
  if (fixtureStatePath) await rm(fixtureStatePath, { force: true });
  throw error;
}
server.on("upgrade", (req, socket, head) => {
  if (!handoff.handleUpgrade(req, socket, head)) socket.destroy();
});

console.log(`macOS exact-Window WSS-only acceptance ready: target_pid=${TARGET_PID} target_window_id=${TARGET_WINDOW_ID}`);
console.log("Transport proof: explicit WSS-only adapter; no WebRTC runtime, ICE, STUN, or TURN is constructed");
console.log(`Locator: ${locator}`);
console.log(`Local diagnostics: http://127.0.0.1:${PORT}/__diag`);
console.log(`Local verified-complete control: POST http://127.0.0.1:${PORT}/__verified_complete`);
if (initialFixture) {
  console.log(`Fixture tap hint: x=${initialFixture.tapX.toFixed(4)} y=${initialFixture.tapY.toFixed(4)}`);
  const thirdPartyStep = REQUIRE_THIRD_PARTY_IME
    ? ` then switch to one third-party iOS keyboard and independently commit ${EXPECTED_IME_MARKER} once more`
    : "";
  console.log(`Expected action: enable Aim, locally pan the 4× view until the tiny · button at the upper-right is under the crosshair, press the WSS Tap control once and confirm it changes to ✓; then disable Aim, press 4× once to return to 1×, tap the text area, enable ⌨︎, type WSS_ACCEPT_OKX, Backspace once, press Enter, then use the iOS system Japanese IME to enter ${REJECTED_IME_PREEDIT} and commit the candidate ${EXPECTED_IME_MARKER}${thirdPartyStep}; scroll the text view and Done. Verification accepts only the fixed harmless markers and rejects leaked preedit text.`);
} else {
  console.log("External target mode: verify exact bounded Window display, tap, text, Backspace, Enter, scroll, then Done; semantic verification remains external.");
}

async function shutdown() {
  handoff.revoke(interventionId);
  await handoff.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopChild(fixtureProcess);
  if (fixtureStatePath) await rm(fixtureStatePath, { force: true });
  await stopWssAcceptanceTunnel(ingress.tunnelProcess);
}
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
await new Promise(() => undefined);
