import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import type { TakeoverHostTarget } from "../src/browser-takeover/broker.js";
import {
  ExperimentalWebSocketWindowHandoff,
  ExperimentalWebSocketWindowHandoffError,
  type ExperimentalWebSocketWindowSurface
} from "../src/experimental/websocket-window-handoff.js";

const ORIGIN = "https://takeover.example";
const PRINCIPAL = "window-principal-binding";
const TARGET = Object.freeze({ processId: 4321, windowId: 9876 });
const POLICY = Object.freeze({ tap: true, scroll: true, text: true, key: true });

interface SurfaceCall {
  kind: "capture" | "tap" | "scroll" | "text" | "key";
  target: TakeoverHostTarget;
  args: unknown[];
}

function fixture(options: { captureFails?: boolean } = {}) {
  const calls: SurfaceCall[] = [];
  const completed: Array<{ interventionId: string; epoch: number }> = [];
  const surface: ExperimentalWebSocketWindowSurface = {
    async captureExactWindow(target) {
      calls.push({ kind: "capture", target: { ...target }, args: [] });
      if (options.captureFails) throw new Error("exact target unavailable");
      return {
        data: Buffer.from("exact-window-frame"),
        width: 640,
        height: 480,
        mimeType: "image/jpeg"
      };
    },
    async tapExactWindow(target, x, y) {
      calls.push({ kind: "tap", target: { ...target }, args: [x, y] });
    },
    async scrollExactWindow(target, deltaY) {
      calls.push({ kind: "scroll", target: { ...target }, args: [deltaY] });
    },
    async insertExactWindowText(target, text) {
      calls.push({ kind: "text", target: { ...target }, args: [text] });
    },
    async pressExactWindowKey(target, key) {
      calls.push({ kind: "key", target: { ...target }, args: [key] });
    }
  };
  const handoff = new ExperimentalWebSocketWindowHandoff({
    takeover: {
      enabled: true,
      publicBaseUrl: ORIGIN,
      ttlMs: 60_000,
      reconnectIdleMs: 250
    },
    allowedOrigins: [ORIGIN],
    surface,
    frameIntervalMs: 50,
    onComplete(event) {
      completed.push(event);
    }
  });
  return { handoff, surface, calls, completed };
}

function sessionIdFrom(link: string): string {
  const id = new URL(link).pathname.split("/").at(-1);
  assert.ok(id);
  return id;
}

async function bootstrapProtocols(
  handoff: ExperimentalWebSocketWindowHandoff,
  sessionId: string,
  principal = PRINCIPAL
): Promise<string[]> {
  const response = await handoff.handle(new Request(
    `${ORIGIN}/takeover/api/websocket-bootstrap/${sessionId}`,
    { method: "POST", headers: { origin: ORIGIN } }
  ), principal);
  assert.equal(response.status, 200);
  const body = await response.json() as { protocols?: string[] };
  assert.equal(body.protocols?.length, 2);
  return body.protocols!;
}

async function startServer(handoff: ExperimentalWebSocketWindowHandoff): Promise<Server> {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    if (!handoff.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function socketUrl(server: Server, sessionId: string): string {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `ws://127.0.0.1:${address.port}/takeover/ws/${sessionId}`;
}

function nextMessage(socket: WebSocket): Promise<{ data: WebSocket.RawData; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket message timeout")), 2_000);
    socket.once("message", (data, isBinary) => {
      clearTimeout(timer);
      resolve({ data, isBinary });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("Generic Window WSS captures and inputs only through the exact trusted process/window", async (t) => {
  const { handoff, calls, completed } = fixture();
  const intervention = { id: "generic-window-wss", epoch: 7 };
  const locator = handoff.start({
    intervention,
    principalBinding: PRINCIPAL,
    target: TARGET,
    inputPolicy: POLICY
  });
  const sessionId = sessionIdFrom(locator);
  assert.equal(new URL(locator).search, "");
  assert.equal(handoff.ownsPath(`/takeover/ws/${sessionId}`), true);

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls.length, 0, "no framebuffer capture should occur without an authenticated WSS client");

  const protocols = await bootstrapProtocols(handoff, sessionId);
  const server = await startServer(handoff);
  t.after(async () => closeServer(server));
  const socket = new WebSocket(socketUrl(server, sessionId), protocols, { origin: ORIGIN });

  const ready = await nextMessage(socket);
  assert.equal(ready.isBinary, false);
  assert.deepEqual(JSON.parse(ready.data.toString()), { kind: "ready" });

  const frame = await nextMessage(socket);
  assert.equal(frame.isBinary, true);
  const bytes = Buffer.from(frame.data as Buffer);
  assert.equal(bytes.readUInt32BE(0), 0x484f4631);
  assert.equal(bytes.readUInt16BE(6), 640);
  assert.equal(bytes.readUInt16BE(8), 480);
  assert.equal(bytes.subarray(16).toString(), "exact-window-frame");
  assert.deepEqual(calls[0], { kind: "capture", target: TARGET, args: [] });

  socket.send(JSON.stringify({ kind: "tap", x: 0.25, y: 0.75 }));
  socket.send(JSON.stringify({ kind: "text", text: "harmless-window-input" }));
  socket.send(JSON.stringify({ kind: "key", key: "Backspace" }));
  socket.send(JSON.stringify({ kind: "scroll", deltaY: 240 }));
  await waitFor(() => calls.filter((call) => call.kind !== "capture").length === 4);
  assert.deepEqual(
    calls.filter((call) => call.kind !== "capture"),
    [
      { kind: "tap", target: TARGET, args: [0.25, 0.75] },
      { kind: "text", target: TARGET, args: ["harmless-window-input"] },
      { kind: "key", target: TARGET, args: ["Backspace"] },
      { kind: "scroll", target: TARGET, args: [240] }
    ]
  );

  const closed = new Promise<void>((resolve, reject) => {
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ kind: "done" }));
  await closed;
  assert.deepEqual(completed, [{ interventionId: intervention.id, epoch: intervention.epoch }]);
  assert.equal(handoff.ownsPath(`/takeover/ws/${sessionId}`), false);
});

test("Generic Window WSS revokes the session when exact-window capture cannot be revalidated", async (t) => {
  const { handoff, calls } = fixture({ captureFails: true });
  const locator = handoff.start({
    intervention: { id: "window-capture-failure", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: TARGET,
    inputPolicy: POLICY
  });
  const sessionId = sessionIdFrom(locator);
  const protocols = await bootstrapProtocols(handoff, sessionId);
  const server = await startServer(handoff);
  t.after(async () => closeServer(server));
  const socket = new WebSocket(socketUrl(server, sessionId), protocols, { origin: ORIGIN });
  assert.deepEqual(JSON.parse((await nextMessage(socket)).data.toString()), { kind: "ready" });

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const close = await closed;
  assert.deepEqual(close, { code: 1000, reason: "revoked" });
  assert.deepEqual(calls[0], { kind: "capture", target: TARGET, args: [] });
  assert.equal(handoff.ownsPath(`/takeover/ws/${sessionId}`), false);

  const stale = await handoff.handle(new Request(
    `${ORIGIN}/takeover/api/websocket-bootstrap/${sessionId}`,
    { method: "POST", headers: { origin: ORIGIN } }
  ), PRINCIPAL);
  assert.equal(stale.status, 404);
});

test("Generic Window WSS start is idempotent only for the exact authority/target/policy tuple", () => {
  const { handoff } = fixture();
  const request = {
    intervention: { id: "window-idempotent", epoch: 3 },
    principalBinding: PRINCIPAL,
    target: TARGET,
    inputPolicy: POLICY
  };
  const first = handoff.start(request);
  assert.equal(handoff.start(request), first);

  assert.throws(
    () => handoff.start({ ...request, principalBinding: "other-principal" }),
    (error: unknown) => error instanceof ExperimentalWebSocketWindowHandoffError
      && error.code === "WINDOW_HANDOFF_UNAVAILABLE"
  );
  assert.throws(
    () => handoff.start({ ...request, target: { ...TARGET, windowId: TARGET.windowId + 1 } }),
    (error: unknown) => error instanceof ExperimentalWebSocketWindowHandoffError
      && error.code === "WINDOW_HANDOFF_UNAVAILABLE"
  );
  assert.throws(
    () => handoff.start({ ...request, inputPolicy: { ...POLICY, text: false } }),
    (error: unknown) => error instanceof ExperimentalWebSocketWindowHandoffError
      && error.code === "WINDOW_HANDOFF_UNAVAILABLE"
  );
  handoff.revoke(request.intervention.id);
});

test("Generic Window WSS rejects invalid targets and never widens to a display", () => {
  const { handoff } = fixture();
  assert.throws(
    () => handoff.start({
      intervention: { id: "window-invalid-target", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 0 },
      inputPolicy: POLICY
    }),
    (error: unknown) => error instanceof ExperimentalWebSocketWindowHandoffError
      && error.code === "WINDOW_HANDOFF_TARGET_INVALID"
  );
  assert.throws(
    () => handoff.start({
      intervention: { id: "window-invalid-window", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 123, windowId: 0 },
      inputPolicy: POLICY
    }),
    (error: unknown) => error instanceof ExperimentalWebSocketWindowHandoffError
      && error.code === "WINDOW_HANDOFF_TARGET_INVALID"
  );
});

test("Generic Window WSS rotates intervention epoch without reviving the stale locator", async () => {
  const { handoff } = fixture();
  const first = handoff.start({
    intervention: { id: "window-epoch", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: TARGET,
    inputPolicy: POLICY
  });
  const firstId = sessionIdFrom(first);
  const second = handoff.start({
    intervention: { id: "window-epoch", epoch: 2 },
    principalBinding: PRINCIPAL,
    target: TARGET,
    inputPolicy: POLICY
  });
  assert.notEqual(second, first);
  assert.equal(handoff.ownsPath(`/takeover/ws/${firstId}`), false);
  const stale = await handoff.handle(new Request(
    `${ORIGIN}/takeover/api/websocket-bootstrap/${firstId}`,
    { method: "POST", headers: { origin: ORIGIN } }
  ), PRINCIPAL);
  assert.equal(stale.status, 404);
  handoff.revoke("window-epoch");
});

test("peer messages cannot replace the exact Window target", async (t) => {
  const { handoff, calls } = fixture();
  const locator = handoff.start({
    intervention: { id: "window-peer-target-injection", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: TARGET,
    inputPolicy: POLICY
  });
  const sessionId = sessionIdFrom(locator);
  const protocols = await bootstrapProtocols(handoff, sessionId);
  const server = await startServer(handoff);
  t.after(async () => closeServer(server));
  const socket = new WebSocket(socketUrl(server, sessionId), protocols, { origin: ORIGIN });
  assert.deepEqual(JSON.parse((await nextMessage(socket)).data.toString()), { kind: "ready" });

  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.send(JSON.stringify({
    kind: "tap",
    x: 0.5,
    y: 0.5,
    targetProcessId: 1,
    targetWindowId: 2
  }));
  await closed;
  assert.equal(calls.some((call) => call.kind === "tap"), false);
  handoff.revoke("window-peer-target-injection");
});
