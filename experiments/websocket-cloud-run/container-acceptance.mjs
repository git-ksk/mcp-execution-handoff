import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";

const port = 18080 + (process.pid % 1000);
const image = process.env.HANDOFF_WSS_ACCEPT_IMAGE ?? "handoff-wss-acceptance:local";
const origin = "https://acceptance.example";
const container = `handoff-wss-accept-${process.pid}`;

function docker(args, stdio = "pipe") {
  return spawn("docker", args, { stdio });
}

async function dockerOk(args) {
  const child = docker(args);
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`docker command failed: ${args[0]}`);
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

await dockerOk(["rm", "-f", container]).catch(() => undefined);
try {
  await dockerOk([
    "run", "-d", "--rm", "--name", container,
    "-p", `127.0.0.1:${port}:8080`,
    "-e", `HANDOFF_WSS_PUBLIC_BASE_URL=${origin}`,
    image
  ]);
  await waitFor("target-ready", async () => {
    const response = await get("/healthz").catch(() => undefined);
    if (!response?.ok) return false;
    const body = await response.json();
    return body.targetReady === true;
  });

  const start = await get("/start");
  assert.equal(start.status, 302);
  const location = start.headers.get("location");
  const setCookie = start.headers.get("set-cookie") ?? "";
  assert.match(location ?? "", /^\/takeover\/[A-Za-z0-9-]{8,100}$/);
  const cookie = /^(__Host-handoff-accept=[A-Za-z0-9_-]{32});/.exec(setCookie)?.[1];
  assert.ok(cookie);

  const restarted = await get("/start", { cookie });
  assert.equal(restarted.status, 302);
  const freshLocation = restarted.headers.get("location");
  assert.match(freshLocation ?? "", /^\/takeover\/[A-Za-z0-9-]{8,100}$/);
  assert.notEqual(freshLocation, location);
  const stalePage = await get(location, { cookie });
  assert.equal(stalePage.status, 404);

  const page = await get(freshLocation, { cookie });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /new WebSocket\(target,body\.protocols\)/);
  assert.doesNotMatch(html, /processId|windowId|RTCPeerConnection|TURN|STUN/);

  const sessionId = freshLocation.split("/").at(-1);
  const bootstrap = await fetch(`http://127.0.0.1:${port}/takeover/api/websocket-bootstrap/${sessionId}`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" }
  });
  assert.equal(bootstrap.status, 200);
  const { protocols } = await bootstrap.json();
  assert.equal(protocols.length, 2);

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

  ws.send(JSON.stringify({ kind: "tap", x: 0.5, y: 0.5 }));
  await waitFor("tap", async () => (await (await get("/acceptance-status", { cookie })).json()).tapObserved === true);

  ws.send(JSON.stringify({ kind: "text", text: "harmless40" }));
  await waitFor("text", async () => (await (await get("/acceptance-status", { cookie })).json()).textObserved === true);

  ws.send(JSON.stringify({ kind: "scroll", deltaY: 900 }));
  await waitFor("scroll", async () => (await (await get("/acceptance-status", { cookie })).json()).scrollObserved === true);

  ws.send(JSON.stringify({ kind: "key", key: "Enter" }));
  await waitFor("submit", async () => (await (await get("/acceptance-status", { cookie })).json()).submitObserved === true);

  ws.send(JSON.stringify({ kind: "done" }));
  await waitFor("done", async () => {
    const status = await (await get("/acceptance-status", { cookie })).json();
    return status.doneObserved === true && closed;
  });
  ws.close();
  process.stdout.write("WSS_CONTAINER_ACCEPTANCE_OK\n");
} finally {
  await dockerOk(["rm", "-f", container]).catch(() => undefined);
}
