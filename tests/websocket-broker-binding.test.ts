import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import {
  TakeoverBroker,
  type TakeoverBrowserAdapter,
  type TakeoverCompletionEvent
} from "../src/browser-takeover/broker.js";
import { ExperimentalWebSocketBrokerBinding } from "../src/experimental/websocket-broker-binding.js";

const PRINCIPAL = "principal-binding";
const ORIGIN = "https://takeover.example";
const POLICY = Object.freeze({ tap: true, scroll: true, text: false, key: false });

function browserAdapter(): TakeoverBrowserAdapter {
  return {
    async captureHumanTakeoverFrame() {
      return {
        data: Buffer.from("frame").toString("base64"),
        width: 800,
        height: 600,
        hostname: "Generic Browser",
        mimeType: "image/jpeg" as const
      };
    },
    async tapHumanTakeover() {},
    async scrollHumanTakeover() {},
    async insertHumanTakeoverText() {},
    async pressHumanTakeoverKey() {}
  };
}

function runtimeBroker(completed: TakeoverCompletionEvent[] = []) {
  const nativeRuntime = {
    async begin() { throw new Error("not used"); },
    async revoke() {},
    async revokeForIntervention() {}
  };
  const webRtcRuntime = {
    async prepare() { throw new Error("not used"); },
    async start() { throw new Error("not used"); },
    async reconnect() { throw new Error("not used"); },
    recordLatency() {},
    latencySnapshot() { return {} as never; },
    recordDiagnostic() {},
    diagnosticsSnapshot() { return { events: [] } as never; },
    async revoke() {},
    async revokeForIntervention() {}
  };
  return new TakeoverBroker(
    browserAdapter(),
    {
      enabled: true,
      publicBaseUrl: ORIGIN,
      ttlMs: 60_000,
      reconnectIdleMs: 250
    },
    nativeRuntime,
    webRtcRuntime,
    {
      completed(event) {
        completed.push(event);
      }
    }
  );
}

function sessionIdFrom(link: string): string {
  const id = new URL(link).pathname.split("/").at(-1);
  assert.ok(id);
  return id;
}

async function bootstrapProtocols(
  binding: ExperimentalWebSocketBrokerBinding,
  sessionId: string
): Promise<string[]> {
  const response = binding.handleBootstrap(new Request(
    `${ORIGIN}/takeover/api/websocket-bootstrap/${sessionId}`,
    { method: "POST", headers: { origin: ORIGIN } }
  ), PRINCIPAL);
  assert.ok(response);
  assert.equal(response.status, 200);
  const body = await response.json() as { protocols?: string[] };
  assert.equal(body.protocols?.length, 2);
  return body.protocols!;
}

async function startServer(binding: ExperimentalWebSocketBrokerBinding): Promise<Server> {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    if (!binding.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function socketUrl(server: Server, sessionId: string): string {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `ws://127.0.0.1:${address.port}/takeover/ws/${sessionId}`;
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => {
      try {
        assert.equal(isBinary, false);
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("WSS marker fences legacy HTTP, Native and WebRTC for the same broker locator", async () => {
  const broker = runtimeBroker();
  const binding = new ExperimentalWebSocketBrokerBinding(broker, {
    allowedOrigins: [ORIGIN],
    async onInput() {}
  });
  const intervention = { id: "wss-exclusive", epoch: 4 };
  const link = binding.createLink(intervention, PRINCIPAL, POLICY);
  assert.ok(link);
  const sessionId = sessionIdFrom(link);

  const page = await broker.handle(new Request(`${ORIGIN}/takeover/${sessionId}`), PRINCIPAL);
  assert.equal(page.status, 404);

  const legacyBootstrap = await broker.handle(new Request(`${ORIGIN}/takeover/api/bootstrap/${sessionId}`, {
    headers: {
      "sec-fetch-site": "same-origin",
      "x-takeover-client": "legacy-client-binding-123456"
    }
  }), PRINCIPAL);
  assert.equal(legacyBootstrap.status, 404);

  assert.equal(broker.createLink(intervention, PRINCIPAL), undefined);
  assert.equal(broker.createNativeLink(intervention, PRINCIPAL), undefined);
  assert.equal(broker.createWebRtcLink(intervention, PRINCIPAL), undefined);
});

test("WSS cannot replace a Native or WebRTC route selected for the same live locator", () => {
  const nativeBroker = runtimeBroker();
  const nativeBinding = new ExperimentalWebSocketBrokerBinding(nativeBroker, {
    allowedOrigins: [ORIGIN],
    async onInput() {}
  });
  const nativeIntervention = { id: "native-first", epoch: 2 };
  assert.ok(nativeBroker.createNativeLink(nativeIntervention, PRINCIPAL));
  assert.equal(nativeBinding.createLink(nativeIntervention, PRINCIPAL, POLICY), undefined);

  const webRtcBroker = runtimeBroker();
  const webRtcBinding = new ExperimentalWebSocketBrokerBinding(webRtcBroker, {
    allowedOrigins: [ORIGIN],
    async onInput() {}
  });
  const webRtcIntervention = { id: "webrtc-first", epoch: 3 };
  assert.ok(webRtcBroker.createWebRtcLink(webRtcIntervention, PRINCIPAL));
  assert.equal(webRtcBinding.createLink(webRtcIntervention, PRINCIPAL, POLICY), undefined);
});

test("WSS Done fences the shared generation before delivering the broker completion hook", async (t) => {
  const completed: TakeoverCompletionEvent[] = [];
  const broker = runtimeBroker(completed);
  const binding = new ExperimentalWebSocketBrokerBinding(broker, {
    allowedOrigins: [ORIGIN],
    async onInput() {}
  });
  const intervention = { id: "wss-done", epoch: 8 };
  const link = binding.createLink(intervention, PRINCIPAL, POLICY);
  assert.ok(link);
  const sessionId = sessionIdFrom(link);
  const protocols = await bootstrapProtocols(binding, sessionId);
  const server = await startServer(binding);
  t.after(async () => closeServer(server));

  const socket = new WebSocket(socketUrl(server, sessionId), protocols, { origin: ORIGIN });
  const ready = await nextJson(socket);
  assert.deepEqual(ready, { kind: "ready" });

  const completionMessages: string[] = [];
  const closed = new Promise<void>((resolve, reject) => {
    socket.on("message", (data, isBinary) => {
      try {
        assert.equal(isBinary, false);
        const message = JSON.parse(data.toString()) as { kind?: string };
        if (message.kind) completionMessages.push(message.kind);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ kind: "done" }));
  await closed;

  assert.deepEqual(completionMessages, ["closing", "closed"]);
  assert.deepEqual(completed, [{ interventionId: intervention.id, epoch: intervention.epoch }]);

  const stale = await broker.handle(new Request(`${ORIGIN}/takeover/api/bootstrap/${sessionId}`, {
    headers: {
      "sec-fetch-site": "same-origin",
      "x-takeover-client": "legacy-client-binding-123456"
    }
  }), PRINCIPAL);
  assert.equal(stale.status, 404);
});

test("broker intervention revoke closes the active WSS channel and makes its bootstrap stale", async (t) => {
  const broker = runtimeBroker();
  const binding = new ExperimentalWebSocketBrokerBinding(broker, {
    allowedOrigins: [ORIGIN],
    async onInput() {}
  });
  const intervention = { id: "wss-revoke", epoch: 5 };
  const link = binding.createLink(intervention, PRINCIPAL, POLICY);
  assert.ok(link);
  const sessionId = sessionIdFrom(link);
  const protocols = await bootstrapProtocols(binding, sessionId);
  const server = await startServer(binding);
  t.after(async () => closeServer(server));

  const socket = new WebSocket(socketUrl(server, sessionId), protocols, { origin: ORIGIN });
  assert.deepEqual(await nextJson(socket), { kind: "ready" });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  broker.revokeForIntervention(intervention.id);
  const close = await closed;
  assert.deepEqual(close, { code: 1000, reason: "revoked" });

  const staleBootstrap = binding.handleBootstrap(new Request(
    `${ORIGIN}/takeover/api/websocket-bootstrap/${sessionId}`,
    { method: "POST", headers: { origin: ORIGIN } }
  ), PRINCIPAL);
  assert.ok(staleBootstrap);
  assert.equal(staleBootstrap.status, 404);
});
