import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WindowWebSocketHandoffAdapter } from "../../../src/window-takeover/window-websocket-handoff-adapter.ts";

function defaultLanHost(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (/^10\./.test(entry.address) || /^192\.168\./.test(entry.address)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) return entry.address;
    }
  }
  throw new Error("No private IPv4 LAN address found; set HANDOFF_LAN_HOST explicitly");
}

function localAuthenticationPid(): number {
  const override = process.env.HANDOFF_LOCAL_AUTH_PID;
  if (override) {
    const pid = Number(override);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("HANDOFF_LOCAL_AUTH_PID is invalid");
    return pid;
  }
  const output = execFileSync("/usr/bin/pgrep", ["-x", "coreautha"], { encoding: "utf8" }).trim();
  const pids = output.split(/\s+/).filter(Boolean).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (pids.length !== 1) throw new Error("expected exactly one running coreautha process; set HANDOFF_LOCAL_AUTH_PID explicitly");
  return pids[0];
}

const LAN_HOST = process.env.HANDOFF_LAN_HOST || defaultLanHost();
const PORT = Number(process.env.HANDOFF_LOCAL_AUTH_PORT || "8894");
if (!Number.isSafeInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("invalid acceptance port");
const PUBLIC_ORIGIN = process.env.HANDOFF_WSS_PUBLIC_BASE_URL || `http://${LAN_HOST}:${PORT}`;
const ALLOWED_ORIGIN = new URL(PUBLIC_ORIGIN).origin;
const HOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.build/release/takeover-webrtc-host");
const PRINCIPAL = "macos-local-auth-physical-acceptance";
const TARGET_PID = localAuthenticationPid();
if (process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID || process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN) {
  throw new Error("Refusing LocalAuthentication LAN acceptance while TURN credentials are present");
}

const handoff = new WindowWebSocketHandoffAdapter({
  takeover: { enabled: true, publicBaseUrl: PUBLIC_ORIGIN, ttlMs: 300_000, reconnectIdleMs: 2_000 },
  allowedOrigins: [ALLOWED_ORIGIN],
  host: {
    platform: "macos",
    hostExecutable: HOST,
    initialSecureWindowPolicy: { mode: "macos_local_authentication" }
  }
});
const interventionId = `local-auth-${randomBytes(6).toString("hex")}`;
const locator = handoff.start({
  intervention: { id: interventionId, epoch: 1 },
  principalBinding: PRINCIPAL,
  target: { processId: TARGET_PID },
  inputPolicy: { tap: true, scroll: false, text: true, key: true }
});

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
      const completed = await handoff.completeAfterVerification({ id: interventionId, epoch: 1 });
      res.writeHead(completed ? 200 : 409, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ completed }));
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
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "0.0.0.0", resolve);
});

console.log(`LocalAuthentication Window WSS-only acceptance ready: target_pid=${TARGET_PID}`);
console.log(`Transport proof: explicit WSS-only adapter; no WebRTC runtime, ICE, STUN, or TURN is constructed`);
console.log(`Locator: ${locator}`);
console.log(`Local diagnostics: http://127.0.0.1:${PORT}/__diag`);
console.log(`Local verified-complete control: POST http://127.0.0.1:${PORT}/__verified_complete`);
console.log("Expected action: inspect the exact Apple LocalAuthentication dialog. Human may use the iPhone keyboard for the focused secure field, Backspace if needed, then tap Cancel or OK. Secret text is transient input and must never be logged or copied into diagnostics.");

server.on("upgrade", (req, socket, head) => {
  if (!handoff.handleUpgrade(req, socket, head)) socket.destroy();
});

async function shutdown() {
  handoff.revoke(interventionId);
  await handoff.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
await new Promise(() => undefined);
