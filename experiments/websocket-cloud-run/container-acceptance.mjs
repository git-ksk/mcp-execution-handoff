import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { WebSocket } from "ws";

const port = 18080 + (process.pid % 1000);
const image = process.env.HANDOFF_WSS_ACCEPT_IMAGE ?? "handoff-wss-acceptance:local";
const origin = "https://acceptance.example";
const container = `handoff-wss-accept-${process.pid}`;
const INPUT_X = 0.42;
const INPUT_Y_CANDIDATES = [0.3, 0.34, 0.38];
const STAGE_FILE = "/tmp/handoff-wss-stage";
let stage = "docker-run";
process.once("exit", () => {
  try { writeFileSync(STAGE_FILE, `${stage}\n`, { mode: 0o600 }); } catch {}
});

function docker(args, stdio = "pipe") {
  return spawn("docker", args, { stdio });
}

async function dockerOk(args) {
  const child = docker(args);
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`docker command failed: ${args[0]}`);
}

async function get(path, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: "manual",
    headers,
    cache: "no-store"
  });
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

async function ensureInputFocusedViaWss(ws, cookie) {
  if ((await readAcceptanceStatus(cookie)).inputFocused === true) return;
  for (const y of INPUT_Y_CANDIDATES) {
    ws.send(JSON.stringify({ kind: "tap", x: INPUT_X, y }));
    try {
      await waitFor(
        "input-focus",
        async () => (await readAcceptanceStatus(cookie)).inputFocused === true,
        1_500
      );
      return;
    } catch {}
  }
  throw new Error("WSS container acceptance could not establish bounded input focus");
}

rmSync(STAGE_FILE, { force: true });
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
  const bootstrap = await fetch(
    `http://127.0.0.1:${port}/takeover/api/websocket-bootstrap/${sessionId}`,
    {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" }
    }
  );
  assert.equal(bootstrap.status, 200);
  const { protocols } = await bootstrap.json();
  assert.equal(protocols.length, 2);

  stage = "websocket-ready";
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/takeover/ws/${sessionId}`,
    protocols,
    { origin }
  );
  let ready = false;
  let jpeg = false;
  let closed = false;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = Buffer.from(data);
      if (
        frame.length >= 20 &&
        frame.readUInt32BE(0) === 0x484f4631 &&
        frame[4] === 1
      ) {
        jpeg = true;
      }
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
  await waitFor(
    "tap",
    async () => (await readAcceptanceStatus(cookie)).tapObserved === true
  );

  stage = "focus";
  await ensureInputFocusedViaWss(ws, cookie);

  stage = "text";
  ws.send(JSON.stringify({ kind: "text", text: "harmless40" }));
  await waitFor(
    "text",
    async () => (await readAcceptanceStatus(cookie)).textObserved === true,
    4_000
  );

  stage = "backspace";
  ws.send(JSON.stringify({ kind: "key", key: "Backspace" }));
  await waitFor(
    "backspace",
    async () => (await readAcceptanceStatus(cookie)).backspaceObserved === true,
    4_000
  );

  stage = "scroll";
  ws.send(JSON.stringify({ kind: "scroll", deltaY: 600 }));
  await waitFor(
    "scroll",
    async () => (await readAcceptanceStatus(cookie)).scrollObserved === true,
    4_000
  );

  stage = "submit";
  ws.send(JSON.stringify({ kind: "key", key: "Enter" }));
  try {
    await waitFor(
      "submit",
      async () => (await readAcceptanceStatus(cookie)).submitObserved === true,
      4_000
    );
  } catch (error) {
    const status = await readAcceptanceStatus(cookie);
    if (status.enterKeyDownObserved !== true) {
      stage = status.inputFocused === true
        ? "submit-dom-keydown-missing-focus-held"
        : "submit-dom-keydown-missing-focus-lost";
    } else if (status.enterKeyUpObserved !== true) stage = "submit-dom-keyup-missing";
    else stage = "submit-event-missing";
    throw error;
  }

  stage = "done";
  ws.send(JSON.stringify({ kind: "done" }));
  await waitFor("done", async () => {
    const status = await readAcceptanceStatus(cookie);
    return status.doneObserved === true && closed;
  });
  const baseline = await readAcceptanceStatus(cookie);
  process.stdout.write(`WSS_CONTAINER_LATENCY_BASELINE:${JSON.stringify(baseline.wssLatency ?? null)}\n`);
  ws.close();
  process.stdout.write("WSS_CONTAINER_ACCEPTANCE_OK\n");
} catch (error) {
  try {
    const response = await get("/acceptance-result");
    if (response.ok) {
      const status = await response.json();
      const diagnostics = {
        wssSurfaceLastFailure: status.wssSurfaceLastFailure ?? "none",
        wssLastInputStage: status.wssLastInputStage ?? "none",
        wssSurfaceInputBoundaryStage: status.wssSurfaceInputBoundaryStage ?? "none",
        wssSurfaceFailure: status.wssSurfaceFailure ?? "none",
        wssSurfaceFailureInputStage: status.wssSurfaceFailureInputStage ?? "none",
        wssSurfaceFailureInputBoundaryStage: status.wssSurfaceFailureInputBoundaryStage ?? "none",
        wssSurfaceLastInputFailureDetail: status.wssSurfaceLastInputFailureDetail ?? "none",
        wssSurfaceFailureInputFailureDetail: status.wssSurfaceFailureInputFailureDetail ?? "none",
        wssSurfaceLastHelperStopReason: status.wssSurfaceLastHelperStopReason ?? "none",
        wssSurfaceFailureHelperStopReason: status.wssSurfaceFailureHelperStopReason ?? "none",
        wssSurfaceLastHelperCrashReason: status.wssSurfaceLastHelperCrashReason ?? "none",
        wssSurfaceFailureHelperCrashReason: status.wssSurfaceFailureHelperCrashReason ?? "none",
        wssSurfaceLastHelperExitKind: status.wssSurfaceLastHelperExitKind ?? "none",
        wssSurfaceFailureHelperExitKind: status.wssSurfaceFailureHelperExitKind ?? "none",
        wssSurfaceLastHelperCrashClass: status.wssSurfaceLastHelperCrashClass ?? "none",
        wssSurfaceFailureHelperCrashClass: status.wssSurfaceFailureHelperCrashClass ?? "none",
        wssSurfaceLastHelperCrashOrigin: status.wssSurfaceLastHelperCrashOrigin ?? "none",
        wssSurfaceFailureHelperCrashOrigin: status.wssSurfaceFailureHelperCrashOrigin ?? "none",
        wssSurfaceLastHelperCrashErrorKind: status.wssSurfaceLastHelperCrashErrorKind ?? "none",
        wssSurfaceFailureHelperCrashErrorKind: status.wssSurfaceFailureHelperCrashErrorKind ?? "none",
        wssSurfaceLastHelperCrashMessageClass: status.wssSurfaceLastHelperCrashMessageClass ?? "none",
        wssSurfaceFailureHelperCrashMessageClass: status.wssSurfaceFailureHelperCrashMessageClass ?? "none",
        wssChannelLastFailure: status.wssChannelLastFailure ?? "none",
        wssChannelLastInputStage: status.wssChannelLastInputStage ?? "none",
        wssFailureCode: status.wssFailureCode ?? "none",
        wssFailureInputStage: status.wssFailureInputStage ?? "none",
        wssLatency: status.wssLatency ?? null
      };
      process.stderr.write(`WSS_CONTAINER_DIAGNOSTICS:${JSON.stringify(diagnostics)}\n`);
    }
  } catch {}
  try {
    writeFileSync(STAGE_FILE, `${stage}\n`, { mode: 0o600 });
  } catch {}
  throw error;
} finally {
  await dockerOk(["rm", "-f", container]).catch(() => undefined);
}
