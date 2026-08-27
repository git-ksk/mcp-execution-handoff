import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";

const port = 18080 + (process.pid % 1000);
const image = process.env.HANDOFF_WSS_ACCEPT_IMAGE ?? "handoff-wss-acceptance:local";
const origin = "https://acceptance.example";
const container = `handoff-wss-accept-${process.pid}`;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const INPUT_X = 0.42;
const INPUT_Y_CANDIDATES = [0.3, 0.34, 0.38];
let stage = "docker-run";

function docker(args, stdio = "pipe") {
  return spawn("docker", args, { stdio });
}

async function dockerOk(args) {
  const child = docker(args);
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`docker command failed: ${args[0]}`);
}

async function dockerText(args) {
  const child = docker(args);
  const chunks = [];
  let bytes = 0;
  const collect = (chunk) => {
    if (bytes >= MAX_DIAGNOSTIC_BYTES) return;
    const remaining = MAX_DIAGNOSTIC_BYTES - bytes;
    const bounded = Buffer.from(chunk).subarray(0, remaining);
    chunks.push(bounded);
    bytes += bounded.byteLength;
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  await once(child, "close").catch(() => undefined);
  return Buffer.concat(chunks).toString("utf8");
}

async function get(path, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", headers, cache: "no-store" });
}

async function waitFor(label, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`WSS container acceptance timed out at ${label}`);
}

async function readAcceptanceStatus(cookie) {
  return await (await get("/acceptance-status", { cookie })).json();
}

async function focusAndTypeViaWss(ws, cookie) {
  for (const y of INPUT_Y_CANDIDATES) {
    ws.send(JSON.stringify({ kind: "tap", x: INPUT_X, y }));
    await new Promise((resolve) => setTimeout(resolve, 140));
    ws.send(JSON.stringify({ kind: "text", text: "harmless40" }));
    try {
      await waitFor("text", async () => (await readAcceptanceStatus(cookie)).textObserved === true, 2_000);
      return;
    } catch {}
  }
  throw new Error("WSS container acceptance could not focus and type into the bounded form");
}

async function submitViaWss(ws, cookie) {
  // The scroll path intentionally re-establishes top-level window focus before wheel injection.
  // Return to the top and explicitly re-focus the form control through WSS before pressing Enter;
  // no out-of-band keyboard or pointer input is allowed in the final physical acceptance contract.
  ws.send(JSON.stringify({ kind: "scroll", deltaY: -900 }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const y of INPUT_Y_CANDIDATES) {
    ws.send(JSON.stringify({ kind: "tap", x: INPUT_X, y }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    ws.send(JSON.stringify({ kind: "key", key: "Enter" }));
    try {
      await waitFor("submit", async () => (await readAcceptanceStatus(cookie)).submitObserved === true, 2_000);
      return;
    } catch {}
  }
  throw new Error("WSS container acceptance could not submit the bounded form");
}

async function printBoundedDiagnostics() {
  process.stderr.write(`WSS_CONTAINER_ACCEPTANCE_FAILED stage=${stage}\n`);
  const health = await get("/healthz").then((response) => response.text()).catch(() => "unreachable");
  process.stderr.write(`health=${health.slice(0, 512)}\n`);
  const processes = await dockerText([
    "exec", container, "sh", "-c",
    "for p in Xvfb openbox chromium; do if pgrep -x \"$p\" >/dev/null 2>&1; then echo \"$p=up\"; else echo \"$p=down\"; fi; done"
  ]).catch(() => "process-probe-unavailable");
  process.stderr.write(`processes=${processes.trim()}\n`);
  const windowCount = await dockerText([
    "exec", container, "sh", "-c",
    "DISPLAY=:99 xdotool search --onlyvisible --name 'Handoff WSS Physical Acceptance' 2>/dev/null | wc -l"
  ]).catch(() => "window-probe-unavailable");
  process.stderr.write(`matching_windows=${windowCount.trim()}\n`);
  const logs = await dockerText(["logs", container]).catch(() => "logs-unavailable");
  if (logs.trim()) process.stderr.write(`container_logs=${logs.trim()}\n`);
}

await dockerOk(["rm", "-f", container]).catch(() => undefined);
try {
  stage = "docker-run";
  await dockerOk([
    "run", "-d", "--rm", "--name", container,
    "-p", `127.0.0.1:${port}:8080`,
    "-e", `HANDOFF_WSS_PUBLIC_BASE_URL=${origin}`,
    image
  ]);
  stage = "target-ready";
  await waitFor("target-ready", async () => {
    const response = await get("/healthz").catch(() => undefined);
    if (!response?.ok) return false;
    const body = await response.json();
    return body.targetReady === true;
  });

  stage = "start";
  const start = await get("/start");
  assert.equal(start.status, 302);
  const location = start.headers.get("location");
  const setCookie = start.headers.get("set-cookie") ?? "";
  assert.match(location ?? "", /^\/takeover\/[A-Za-z0-9-]{8,100}$/);
  const cookie = /^(__Host-handoff-accept=[A-Za-z0-9_-]{32});/.exec(setCookie)?.[1];
  assert.ok(cookie);

  stage = "restart-fencing";
  const restarted = await get("/start", { cookie });
  assert.equal(restarted.status, 302);
  const freshLocation = restarted.headers.get("location");
  assert.match(freshLocation ?? "", /^\/takeover\/[A-Za-z0-9-]{8,100}$/);
  assert.notEqual(freshLocation, location);
  const stalePage = await get(location, { cookie });
  assert.equal(stalePage.status, 404);

  stage = "takeover-page";
  const page = await get(freshLocation, { cookie });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /new WebSocket\(target,body\.protocols\)/);
  assert.doesNotMatch(html, /processId|windowId|RTCPeerConnection|TURN|STUN/);

  stage = "bootstrap";
  const sessionId = freshLocation.split("/").at(-1);
  const bootstrap = await fetch(`http://127.0.0.1:${port}/takeover/api/websocket-bootstrap/${sessionId}`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" }
  });
  assert.equal(bootstrap.status, 200);
  const { protocols } = await bootstrap.json();
  assert.equal(protocols.length, 2);

  stage = "websocket-ready";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/takeover/ws/${sessionId}`, protocols, { origin });
  let ready = false;
  let jpeg = false;
  let closed = false;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = Buffer.from(data);
      if (frame.length >= 20 && frame.readUInt32BE(0) === 0x484f4631 && frame[4] === 1) jpeg = true;
      return;
    }
    const message = JSON.parse(String(data));
    if (message.kind === "ready") ready = true;
    if (message.kind === "closed") closed = true;
  });
  await once(ws, "open");
  await waitFor("ready-frame", () => ready && jpeg, 20_000);

  stage = "tap";
  ws.send(JSON.stringify({ kind: "tap", x: 0.5, y: 0.5 }));
  await waitFor("tap", async () => (await readAcceptanceStatus(cookie)).tapObserved === true);

  stage = "text";
  await focusAndTypeViaWss(ws, cookie);

  stage = "scroll";
  ws.send(JSON.stringify({ kind: "scroll", deltaY: 900 }));
  await waitFor("scroll", async () => (await readAcceptanceStatus(cookie)).scrollObserved === true);

  stage = "submit";
  await submitViaWss(ws, cookie);

  stage = "done";
  ws.send(JSON.stringify({ kind: "done" }));
  await waitFor("done", async () => {
    const status = await readAcceptanceStatus(cookie);
    return status.doneObserved === true && closed;
  });
  ws.close();
  process.stdout.write("WSS_CONTAINER_ACCEPTANCE_OK\n");
} catch (error) {
  await printBoundedDiagnostics();
  throw error;
} finally {
  await dockerOk(["rm", "-f", container]).catch(() => undefined);
}
