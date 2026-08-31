import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedOperatorDiagnosticEventKind } from "../../../src/browser-takeover/managed-operator-diagnostics.ts";
import { WindowWebSocketHandoffAdapter } from "../../../src/window-takeover/window-websocket-handoff-adapter.ts";
import { resolveWssAcceptanceIngress, stopWssAcceptanceTunnel } from "./wss-public-ingress.mts";

const RELAY_ENV = [
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID",
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN",
  "MCP_HANDOFF_COTURN_SHARED_SECRET",
  "MCP_HANDOFF_COTURN_TURN_URLS",
  "MCP_HANDOFF_COTURN_STUN_URLS"
] as const;

function systemSettingsPid(): number {
  const output = execFileSync("/usr/bin/pgrep", ["-x", "System Settings"], { encoding: "utf8" }).trim();
  const pid = Number(output.split(/\s+/)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("System Settings is not running");
  return pid;
}

function assertSingleSystemSettingsWindow(): void {
  const count = Number(execFileSync("/usr/bin/osascript", ["-e",
    'tell application "System Events" to tell process "System Settings" to return count windows'
  ], { encoding: "utf8" }).trim());
  if (count !== 1) throw new Error("WSS lineage acceptance requires exactly one initial System Settings window");
}

function exactSystemSettingsWindowId(processId: number): number {
  const swift = `
import CoreGraphics
import Foundation
let pid: Int32 = ${processId}
let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let ids = raw.compactMap { info -> UInt32? in
  guard let owner = info[kCGWindowOwnerPID as String] as? NSNumber, owner.int32Value == pid,
        let layer = info[kCGWindowLayer as String] as? NSNumber, layer.intValue == 0,
        let number = info[kCGWindowNumber as String] as? NSNumber else { return nil }
  return number.uint32Value
}
guard ids.count == 1 else { FileHandle.standardError.write(Data("ambiguous exact Window\\n".utf8)); exit(2) }
print(ids[0])
`;
  const value = Number(execFileSync("/usr/bin/swift", ["-e", swift], { encoding: "utf8" }).trim());
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("failed to resolve exact System Settings Window id");
  return value;
}

const PORT = Number(process.env.HANDOFF_WSS_LINEAGE_PORT || "8897");
if (!Number.isSafeInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("invalid acceptance port");
if (RELAY_ENV.some((name) => Boolean(process.env[name]))) {
  throw new Error("Refusing WSS-lineage acceptance while WebRTC relay configuration is present");
}
const buildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.build/release");
const HOST = path.join(buildRoot, "takeover-webrtc-host");
const PRINCIPAL = "macos-wss-lineage-physical-acceptance";
const TARGET_PID = systemSettingsPid();
assertSingleSystemSettingsWindow();
const TARGET_WINDOW_ID = exactSystemSettingsWindowId(TARGET_PID);
const ingress = await resolveWssAcceptanceIngress(PORT);
const PUBLIC_ORIGIN = ingress.publicOrigin;
const diagnosticEvents: ManagedOperatorDiagnosticEventKind[] = [];
const noteDiagnostic = (kind: ManagedOperatorDiagnosticEventKind): void => {
  diagnosticEvents.push(kind);
  if (diagnosticEvents.length > 64) diagnosticEvents.splice(0, diagnosticEvents.length - 64);
};

const handoff = new WindowWebSocketHandoffAdapter({
  takeover: { enabled: true, publicBaseUrl: PUBLIC_ORIGIN, ttlMs: 300_000, reconnectIdleMs: 2_000 },
  allowedOrigins: [PUBLIC_ORIGIN],
  host: { platform: "macos", hostExecutable: HOST },
  successorWindowPolicy: { mode: "same_process", transitionWindowMs: 1_200 },
  onOperatorDiagnosticEvent: noteDiagnostic
});
const interventionId = `wss-window-lineage-${randomBytes(6).toString("hex")}`;
const locator = handoff.start({
  intervention: { id: interventionId, epoch: 1 },
  principalBinding: PRINCIPAL,
  target: { processId: TARGET_PID, windowId: TARGET_WINDOW_ID },
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
      res.end(JSON.stringify({
        successorAdmitted: diagnosticEvents.includes("host_successor_admitted"),
        successorReturned: diagnosticEvents.includes("host_successor_returned"),
        events: diagnosticEvents
      }));
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
  server.listen(PORT, "127.0.0.1", resolve);
});
server.on("upgrade", (req, socket, head) => {
  if (!handoff.handleUpgrade(req, socket, head)) socket.destroy();
});

console.log("macOS WSS successor-window physical acceptance ready");
console.log(`Initial exact target: pid=${TARGET_PID} window_id=${TARGET_WINDOW_ID}`);
console.log(`Locator: ${locator}`);
console.log(`Local diagnostics: http://127.0.0.1:${PORT}/__diag`);
console.log("Expected action: on iPhone Safari, use Aim to tap Accessibility Add (+) once. The same WSS session must rotate to the new file chooser. Do not select a file or change a permission.");
console.log("Acceptance proof: /__diag reports host_successor_admitted and the iPhone frame/input remain bounded to the admitted successor.");

async function shutdown(): Promise<void> {
  handoff.revoke(interventionId);
  await handoff.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopWssAcceptanceTunnel(ingress.tunnelProcess);
}
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
await new Promise(() => undefined);
