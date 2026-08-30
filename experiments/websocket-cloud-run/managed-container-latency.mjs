import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";

const run = Number(process.env.HANDOFF_BASELINE_RUN ?? "1");
const revision = process.env.HANDOFF_ACCEPTANCE_REVISION;
if (!Number.isSafeInteger(run) || run < 1 || run > 9) throw new Error("invalid baseline run");
if (!revision || !/^[0-9a-f]{40}$/.test(revision)) throw new Error("exact revision is required");

const port = 18120 + run;
const image = process.env.HANDOFF_MANAGED_ACCEPT_IMAGE ?? "handoff-managed-acceptance:baseline";
const origin = "https://acceptance.example";
const container = `handoff-managed-baseline-${process.pid}-${run}`;

function docker(args) {
  return spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
}

async function dockerOk(args) {
  const child = docker(args);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`docker command failed: ${args[0]} ${stderr.slice(-1000)}`);
}

async function get(path, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: "manual",
    headers,
    cache: "no-store"
  });
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`managed WSS baseline timed out at ${label}`);
}

async function readStatus(cookie) {
  const response = await get("/acceptance-status", { cookie });
  assert.equal(response.status, 200);
  return response.json();
}

async function checkpoint(label, cookie) {
  const state = await readStatus(cookie);
  const latency = state.wssLatency ?? {};
  process.stdout.write(`MANAGED_WSS_INPUT_CHECKPOINT:${JSON.stringify({
    run,
    label,
    latency: {
      inputApply: latency.inputApply ?? null,
      inputPrepare: latency.inputPrepare ?? null,
      inputQueueWait: latency.inputQueueWait ?? null,
      inputRevalidate: latency.inputRevalidate ?? null,
      inputHostAck: latency.inputHostAck ?? null
    }
  })}\n`);
}

async function sendSpaced(ws, message, pauseMs = 180) {
  ws.send(JSON.stringify(message));
  await new Promise((resolve) => setTimeout(resolve, pauseMs));
}

await dockerOk(["rm", "-f", container]).catch(() => undefined);
try {
  await dockerOk([
    "run", "-d", "--rm", "--name", container,
    "-p", `127.0.0.1:${port}:8080`,
    "-e", `HANDOFF_WSS_PUBLIC_BASE_URL=${origin}`,
    "-e", `HANDOFF_ACCEPTANCE_REVISION=${revision}`,
    image
  ]);

  await waitFor("target-ready", async () => {
    const response = await get("/healthz").catch(() => undefined);
    if (!response?.ok) return false;
    const body = await response.json();
    return body.targetReady === true;
  }, 45_000);

  const start = await get("/start");
  assert.equal(start.status, 200);
  const cookie = /(?:^|;\s*)(__Host-handoff-accept=[A-Za-z0-9_-]{32})(?:;|$)/
    .exec(start.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(cookie);

  const continued = await get("/start/continue", { cookie });
  assert.equal(continued.status, 302);
  const directPath = continued.headers.get("location");
  assert.match(directPath ?? "", /^\/takeover\/[A-Za-z0-9-]{8,100}$/);

  const directPage = await get(directPath, { cookie });
  assert.equal(directPage.status, 200);
  const directHtml = await directPage.text();
  const fallbackCapability = /data-fallback="([A-Za-z0-9_-]{32,100})"/.exec(directHtml)?.[1];
  assert.ok(fallbackCapability);
  const directSessionId = directPath.split("/").at(-1);
  assert.ok(directSessionId);

  const fallback = await fetch(
    `http://127.0.0.1:${port}/takeover/api/transport-fallback/${directSessionId}`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin,
        "content-type": "application/json",
        "x-mcp-handoff-fallback": fallbackCapability
      }
    }
  );
  assert.equal(fallback.status, 200);
  const fallbackBody = await fallback.json();
  const wssPath = fallbackBody.path;
  assert.match(wssPath ?? "", /^\/takeover\/[A-Za-z0-9-]{8,100}$/);
  assert.notEqual(wssPath, directPath);

  const staleDirect = await get(directPath, { cookie });
  assert.equal(staleDirect.status, 404);

  const wssPage = await get(wssPath, { cookie });
  assert.equal(wssPage.status, 200);
  assert.match(await wssPage.text(), /new WebSocket\(target,body\.protocols\)/);
  const wssSessionId = wssPath.split("/").at(-1);
  assert.ok(wssSessionId);

  const bootstrap = await fetch(
    `http://127.0.0.1:${port}/takeover/api/websocket-bootstrap/${wssSessionId}`,
    {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" }
    }
  );
  assert.equal(bootstrap.status, 200);
  const { protocols } = await bootstrap.json();
  assert.equal(protocols.length, 2);

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/takeover/ws/${wssSessionId}`,
    protocols,
    { origin }
  );
  let ready = false;
  let jpeg = false;
  let closed = false;
  let channelError;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = Buffer.from(data);
      if (frame.length >= 20 && frame.readUInt32BE(0) === 0x484f4631 && frame[4] === 1) jpeg = true;
      return;
    }
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message.kind === "ready") ready = true;
    if (message.kind === "closed") closed = true;
    if (message.kind === "error") channelError = message.code ?? "channel_error";
  });
  await once(ws, "open");
  await waitFor("ready-frame", () => ready && jpeg && channelError === undefined, 20_000);

  await sendSpaced(ws, { kind: "tap", x: 0.5, y: 0.5 }, 220);
  await waitFor("form-focus", async () => {
    const state = await readStatus(cookie);
    return state.tapObserved === true && state.inputFocused === true;
  }, 5_000);
  await checkpoint("after_tap", cookie);

  for (let index = 0; index < 8; index += 1) {
    await sendSpaced(ws, { kind: "text", text: "x" });
  }
  await waitFor("text", async () => (await readStatus(cookie)).textObserved === true, 3_000);
  await checkpoint("after_text", cookie);

  for (let index = 0; index < 8; index += 1) {
    await sendSpaced(ws, { kind: "key", key: "Backspace" });
  }
  await waitFor("backspace", async () => (await readStatus(cookie)).backspaceObserved === true, 3_000);
  await checkpoint("after_backspace", cookie);

  for (let index = 0; index < 3; index += 1) {
    await sendSpaced(ws, { kind: "scroll", deltaY: 600 });
  }
  await waitFor("scroll", async () => (await readStatus(cookie)).scrollObserved === true, 3_000);
  await checkpoint("after_scroll", cookie);

  await sendSpaced(ws, { kind: "key", key: "Enter" }, 220);
  await waitFor("submit", async () => {
    const state = await readStatus(cookie);
    return state.enterKeyDownObserved === true
      && state.enterKeyUpObserved === true
      && state.submitObserved === true;
  }, 4_000);
  await checkpoint("after_enter", cookie);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const preDone = await readStatus(cookie);
  assert.equal(preDone.currentTransport, "websocket_relay");
  assert.equal(preDone.lastFallbackReason, "transport_unavailable");
  assert.equal(preDone.wssFailureCode, "none");
  assert.ok(preDone.wssLatency);
  process.stdout.write(`MANAGED_WSS_INPUT_BREAKDOWN_PRE_DONE:${JSON.stringify({run, latency: preDone.wssLatency})}\n`);

  ws.send(JSON.stringify({ kind: "done" }));
  await waitFor("done-teardown", async () => {
    const state = await readStatus(cookie);
    return state.doneObserved === true && state.teardownCompleted === true;
  }, 8_000);

  const finalResponse = await get("/acceptance-result");
  assert.equal(finalResponse.status, 200);
  const final = await finalResponse.json();
  for (const key of [
    "targetReady", "exactTargetBounded", "fallbackObserved", "staleDirectLocatorRejected",
    "staleDirectGenerationFenced", "tapObserved", "focusObserved", "textObserved",
    "backspaceObserved", "scrollObserved", "enterKeyDownObserved", "enterKeyUpObserved",
    "submitObserved", "doneObserved", "verificationStartedObserved", "teardownCompleted"
  ]) assert.equal(final[key], true, key);
  assert.equal(final.turnConfigured, false);
  assert.equal(final.lastTransport, "websocket_relay");
  assert.equal(final.wssFailureCode, "none");
  assert.equal(final.wssChannelLastInputStage, "applied");
  assert.equal(final.wssSurfaceInputBoundaryStage, "acknowledged");
  assert.ok(closed || final.doneObserved === true);

  process.stdout.write(`MANAGED_WSS_INPUT_BREAKDOWN:${JSON.stringify({
    run,
    latency: final.wssLatency,
    diagnostics: {
      framesObserved: final.wssFramesObserved,
      framesSent: final.wssSentFrames,
      framesDropped: final.wssDroppedFrames,
      inputAttempts: final.wssSurfaceInputAttempts,
      generation: final.generation,
      transitionCount: final.transitionCount
    }
  })}\n`);
  ws.close();
} finally {
  await dockerOk(["rm", "-f", container]).catch(() => undefined);
}
