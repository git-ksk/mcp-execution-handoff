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

function fixture(options: {
  captureFails?: boolean;
  recoverableCaptureFailures?: number;
  recoverableInputFailures?: number;
} = {}) {
  const calls: SurfaceCall[] = [];
  const diagnosticEvents: string[] = [];
  let recoverableCaptureFailures = options.recoverableCaptureFailures ?? 0;
  let recoverableInputFailures = options.recoverableInputFailures ?? 0;
  const completed: Array<{ interventionId: string; epoch: number }> = [];
  const releases: Array<{ interventionId: string; epoch: number; disposition: string; reason: string }> = [];
  const surface: ExperimentalWebSocketWindowSurface = {
    ...(options.recoverableCaptureFailures === undefined
      ? {}
      : { captureFailureDisposition: () => "recoverable" as const }),
    ...(options.recoverableInputFailures === undefined
      ? {}
      : { inputFailureDisposition: () => "recoverable" as const }),
    async captureExactWindow(target) {
      calls.push({ kind: "capture", target: { ...target }, args: [] });
      if (options.captureFails) throw new Error("exact target unavailable");
      if (recoverableCaptureFailures > 0) {
        recoverableCaptureFailures -= 1;
        throw new Error("transient exact-window helper capture failed");
      }
      return {
        data: Buffer.from("exact-window-frame"),
        width: 640,
        height: 480,
        mimeType: "image/jpeg"
      };
    },
    async tapExactWindow(target, x, y) {
      calls.push({ kind: "tap", target: { ...target }, args: [x, y] });
      if (recoverableInputFailures > 0) {
        recoverableInputFailures -= 1;
        throw new Error("transient exact-window input helper failed");
      }
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
    onDiagnosticEvent(kind) { diagnosticEvents.push(kind); },
    onComplete(event) {
      completed.push(event);
    },
    onAuthorityReleased(event) {
      releases.push(event);
    }
  });
  return { handoff, surface, calls, completed, releases, diagnosticEvents };
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
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      reject(error);
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve({ data, isBinary });
    };
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      reject(new Error("WebSocket message timeout"));
    }, 2_000);
    socket.once("message", onMessage);
    socket.once("error", onError);
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
  const { handoff, calls, completed, releases } = fixture();
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
  assert.deepEqual(releases, [{
    interventionId: intervention.id,
    epoch: intervention.epoch,
    disposition: "completed",
    reason: "human_completed"
  }]);
  assert.equal(handoff.ownsPath(`/takeover/ws/${sessionId}`), false);
  assert.equal(await handoff.completeAfterVerification(intervention), true);
  assert.equal(await handoff.completeAfterVerification(intervention), false);
});

test("Generic Window WSS retains the generation after a recoverable input helper failure", async (t) => {
  const { handoff, calls, completed, diagnosticEvents } = fixture({ recoverableInputFailures: 1 });
  const intervention = { id: "window-recoverable-input", epoch: 1 };
  const locator = handoff.start({ intervention, principalBinding: PRINCIPAL, target: TARGET, inputPolicy: POLICY });
  const sessionId = sessionIdFrom(locator);
  const protocols = await bootstrapProtocols(handoff, sessionId);
  const server = await startServer(handoff);
  t.after(async () => closeServer(server));
  const socket = new WebSocket(socketUrl(server, sessionId), protocols, { origin: ORIGIN });
  assert.deepEqual(JSON.parse((await nextMessage(socket)).data.toString()), { kind: "ready" });
  await nextMessage(socket);
  socket.send(JSON.stringify({ kind: "tap", x: 0.5, y: 0.5 }));
  await waitFor(() => calls.some((call) => call.kind === "tap"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.ok(diagnosticEvents.includes("input_dispatch_failure"));
  assert.ok(diagnosticEvents.includes("session_retained"));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.send(JSON.stringify({ kind: "done" }));
  await closed;
  assert.deepEqual(completed, [{ interventionId: intervention.id, epoch: intervention.epoch }]);
  assert.equal(await handoff.completeAfterVerification(intervention), true);
});

test("Generic Window WSS refreshes unchanged editable geometry before browser freshness expires", async (t) => {
  const { handoff, surface } = fixture();
  surface.editableRegionsSnapshot = () => [[1000, 2000, 3000, 1000]];
  const locator = handoff.start({
    intervention: { id: "window-editable-refresh", epoch: 1 },
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

  const observedAt: number[] = [];
  const deadline = Date.now() + 1_500;
  while (observedAt.length < 2 && Date.now() < deadline) {
    const message = await nextMessage(socket);
    if (message.isBinary) continue;
    const control = JSON.parse(message.data.toString()) as { kind?: string; regions?: unknown };
    if (control.kind !== "editableRegions") continue;
    assert.deepEqual(control.regions, [[1000, 2000, 3000, 1000]]);
    observedAt.push(Date.now());
  }

  assert.equal(observedAt.length, 2);
  assert.ok(observedAt[1]! - observedAt[0]! < 1_000);
  handoff.revoke("window-editable-refresh");
});

test("Generic Window WSS revokes the session when exact-window capture cannot be revalidated", async (t) => {
  const { handoff, calls, releases, diagnosticEvents } = fixture({ captureFails: true });
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
  assert.deepEqual(diagnosticEvents.filter((event) => event === "session_revoked"), ["session_revoked"]);
  assert.deepEqual(releases, [{
    interventionId: "window-capture-failure",
    epoch: 1,
    disposition: "revoked",
    reason: "authority_lost"
  }]);
});

test("Generic Window WSS keeps the same session across explicitly recoverable capture failures", async (t) => {
  const { handoff, calls, diagnosticEvents } = fixture({ recoverableCaptureFailures: 2 });
  const locator = handoff.start({
    intervention: { id: "window-recoverable-capture", epoch: 1 },
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

  const frame = await nextMessage(socket);
  assert.equal(frame.isBinary, true);
  assert.ok(calls.filter((call) => call.kind === "capture").length >= 3);
  assert.equal(handoff.ownsPath(`/takeover/ws/${sessionId}`), true);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.ok(diagnosticEvents.includes("session_retained"));
  assert.equal(diagnosticEvents.includes("session_revoked"), false);

  socket.send(JSON.stringify({ kind: "text", text: "still-active" }));
  await waitFor(() => calls.some((call) => call.kind === "text"));
  handoff.revoke("window-recoverable-capture");
});

test("Generic Window WSS consumer revoke does not masquerade as Human completion or authority loss", () => {
  const { handoff, releases } = fixture();
  handoff.start({
    intervention: { id: "window-consumer-revoke", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: TARGET,
    inputPolicy: POLICY
  });
  handoff.revoke("window-consumer-revoke");
  assert.deepEqual(releases, []);
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
