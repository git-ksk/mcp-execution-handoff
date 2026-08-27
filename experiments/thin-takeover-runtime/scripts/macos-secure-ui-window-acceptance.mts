import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WindowHandoffAdapter } from "../../../src/window-takeover/window-handoff-adapter.ts";

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

function systemSettingsPid(): number {
  const output = execFileSync("/usr/bin/pgrep", ["-x", "System Settings"], { encoding: "utf8" }).trim();
  const first = output.split(/\s+/)[0];
  const pid = Number(first);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("System Settings is not running");
  return pid;
}

const LAN_HOST = process.env.HANDOFF_LAN_HOST || defaultLanHost();
const PORT = Number(process.env.HANDOFF_SECURE_UI_PORT || "8894");
if (!Number.isSafeInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("invalid acceptance port");
const PUBLIC_ORIGIN = `http://${LAN_HOST}:${PORT}`;
const HOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.build/release/takeover-webrtc-host");
const PRINCIPAL = "macos-secure-ui-physical-acceptance";
const TARGET_PID = systemSettingsPid();
if (process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID || process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN) {
  throw new Error("Refusing secure-UI LAN acceptance while TURN credentials are present");
}

const handoff = new WindowHandoffAdapter({
  takeover: { enabled: true, publicBaseUrl: PUBLIC_ORIGIN, ttlMs: 300_000, reconnectIdleMs: 2_000 },
  runtime: { hostExecutable: HOST }
});
const interventionId = `secure-ui-${randomBytes(6).toString("hex")}`;
const locator = handoff.start({
  intervention: { id: interventionId, epoch: 1 },
  principalBinding: PRINCIPAL,
  target: { processId: TARGET_PID },
  inputPolicy: { tap: true, scroll: false, text: false, key: false }
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

console.log(`Secure UI Window Handoff acceptance ready: target_pid=${TARGET_PID}`);
console.log(`Locator: ${locator}`);
console.log(`Local diagnostics: http://127.0.0.1:${PORT}/__diag`);
console.log("Expected action: on iPhone, use Aim for the Accessibility pane Add (+) control, then press Tap once. Do not select a file or change a permission.");

async function shutdown() {
  await handoff.revoke(interventionId).catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
await new Promise(() => undefined);
