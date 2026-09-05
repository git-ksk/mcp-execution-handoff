import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { WebSocket } from "ws";

const port = 19080 + (process.pid % 700);
const image = process.env.HANDOFF_MANAGED_PUBLIC_WSS_IMAGE ?? "handoff-managed-public-wss-acceptance:local";
const origin = "https://acceptance.example";
const container = `handoff-managed-public-wss-${process.pid}`;
const STAGE_FILE = "/tmp/handoff-managed-public-wss-stage";
const revision = process.env.HANDOFF_ACCEPTANCE_REVISION ?? gitRevision();
let stage = "docker-run";

process.once("exit", () => {
  try { writeFileSync(STAGE_FILE, `${stage}\n`, { mode: 0o600 }); } catch {}
});

function gitRevision() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Unable to resolve acceptance revision");
  const value = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Acceptance revision is not an exact Git commit");
  return value;
}

function docker(args, stdio = "pipe") {
  return spawn("docker", args, { stdio });
}

async function dockerOk(args) {
  const child = docker(args);
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`docker command failed: ${args[0]}`);
}

async function request(path, { method = "GET", cookie, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    redirect: "manual",
    cache: "no-store",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...headers
    }
  });
}

async function waitFor(label, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Managed public WSS acceptance timed out at ${label}`);
}

async function status(cookie) {
  const response = await request("/acceptance-status", { cookie });
  assert.equal(response.status, 200);
  return response.json();
}

function extractCookie(setCookie) {
  const value = /^(__Host-handoff-accept=[A-Za-z0-9_-]{32});/.exec(setCookie ?? "")?.[1];
  assert.ok(value, "bounded acceptance cookie must be issued");
  return value;
}

rmSync(STAGE_FILE, { force: true });
await dockerOk(["rm", "-f", container]).catch(() => undefined);
try {
  stage = "docker-run";
  await dockerOk([
    "run", "-d", "--rm", "--name", container,
    "-p", `127.0.0.1:${port}:8080`,
    "-e", `HANDOFF_WSS_PUBLIC_BASE_URL=${origin}`,
    "-e", `HANDOFF_ACCEPTANCE_REVISION=${revision}`,
    "-e", "HANDOFF_ACCEPTANCE_WSS_ONLY=1",
    image
  ]);

  stage = "target-ready";
  await waitFor("target-ready", async () => {
    const response = await request("/ready").catch(() => undefined);
    if (!response?.ok) return false;
    const body = await response.json();
    return body.targetReady === true && body.revision === revision;
  });

  stage = "public-start";
  const start = await request("/start");
  assert.equal(start.status, 200);
  const cookie = extractCookie(start.headers.get("set-cookie"));
  const bootstrapPage = await start.text();
  assert.match(bootstrapPage, /\/start\/continue/);
  assert.doesNotMatch(bootstrapPage, /\/takeover\/[A-Za-z0-9-]{8,100}/);

  stage = "unauthorized-gateway";
  assert.equal((await request("/start/continue")).status, 404);

  stage = "authorized-locator";
  const follow = await request("/start/continue", { cookie });
  assert.equal(follow.status, 302);
  const locatorPath = follow.headers.get("location");
  assert.match(locatorPath ?? "", /^\/takeover\/[A-Za-z0-9-]{8,100}$/);
  const sessionId = locatorPath.split("/").at(-1);
  assert.ok(sessionId);

  stage = "wrong-principal";
  const wrongCookie = `__Host-handoff-accept=${"A".repeat(32)}`;
  assert.equal((await request(locatorPath, { method: "HEAD", cookie: wrongCookie })).status, 404);

  stage = "head-probe";
  const head = await request(locatorPath, { method: "HEAD", cookie });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  stage = "get-page";
  const page = await request(locatorPath, { cookie });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /new WebSocket\(target,body\.protocols\)/);
  assert.doesNotMatch(html, /RTCPeerConnection|TURN|STUN/);
  const preflight = await status(cookie);
  assert.equal(preflight.wssOnlyConfigured, true);
  assert.equal(preflight.currentTransport, "websocket_relay");
  assert.equal(preflight.transitionCount, 0);
  assert.equal(preflight.turnConfigured, false);

  stage = "bootstrap";
  const bootstrap = await request(`/takeover/api/websocket-bootstrap/${sessionId}`, {
    method: "POST",
    cookie,
    headers: { origin, "content-type": "application/json" }
  });
  assert.equal(bootstrap.status, 200);
  const body = await bootstrap.json();
  assert.ok(Array.isArray(body.protocols));
  assert.equal(body.protocols.length, 2);
  assert.equal((await request(`/takeover/api/websocket-bootstrap/${sessionId}`, {
    method: "POST",
    cookie: wrongCookie,
    headers: { origin, "content-type": "application/json" }
  })).status, 404);

  stage = "websocket-ready";
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/takeover/ws/${sessionId}`,
    body.protocols,
    { origin, headers: { cookie } }
  );
  let ready = false;
  let frame = false;
  let closed = false;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const value = Buffer.from(data);
      if (value.length >= 20 && value.readUInt32BE(0) === 0x484f4631 && value[4] === 1) frame = true;
      return;
    }
    const message = JSON.parse(String(data));
    if (message.kind === "ready") ready = true;
    if (message.kind === "closed") closed = true;
  });
  await once(ws, "open");
  await waitFor("first-frame-ready", () => ready && frame, 20_000);

  stage = "benign-input";
  ws.send(JSON.stringify({ kind: "tap", x: 0.5, y: 0.5 }));
  await waitFor("benign-input", async () => (await status(cookie)).tapObserved === true, 5_000);

  stage = "done";
  ws.send(JSON.stringify({ kind: "done" }));
  await waitFor("done", async () => {
    const snapshot = await status(cookie);
    return closed && snapshot.doneObserved === true && snapshot.completionCount === 1;
  }, 10_000);

  stage = "stale-fencing";
  await waitFor("teardown", async () => {
    const snapshot = await status(cookie);
    return snapshot.teardownCompleted === true && snapshot.staleWebSocketLocatorRejected === true;
  }, 10_000);
  assert.equal((await request(locatorPath, { cookie })).status, 404);
  assert.equal((await request(`/takeover/api/websocket-bootstrap/${sessionId}`, {
    method: "POST",
    cookie,
    headers: { origin, "content-type": "application/json" }
  })).status, 404);

  const final = await status(cookie);
  assert.equal(final.completionCount, 1);
  assert.equal(final.currentTransport, "none");
  assert.equal(final.lastTransport, "websocket_relay");
  assert.equal(final.transitionCount, 0);
  assert.equal(final.staleWebSocketLocatorRejected, true);
  assert.equal(final.turnConfigured, false);
  ws.close();
  process.stdout.write("MANAGED_PUBLIC_WSS_ACCEPTANCE_OK\n");
} catch (error) {
  try {
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf8" });
    if (logs.stdout) process.stderr.write(logs.stdout);
    if (logs.stderr) process.stderr.write(logs.stderr);
  } catch {}
  try { writeFileSync(STAGE_FILE, `${stage}\n`, { mode: 0o600 }); } catch {}
  throw error;
} finally {
  await dockerOk(["rm", "-f", container]).catch(() => undefined);
}
