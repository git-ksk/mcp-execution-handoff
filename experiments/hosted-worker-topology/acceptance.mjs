import assert from "node:assert/strict";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import {
  HostedHumanInputBridge,
  HostedLatestFrameBridge,
  HostedOperatorBindingError,
  HostedWorkerControlChannel,
  HostedWorkerFrameError,
  HostedWorkerFrameIngress,
  HostedWorkerRegistry,
  HostedWorkerRouteGate,
  assertHostedOperatorBindingCurrent,
  bindHostedOperatorSession,
  recoverHostedControlPlane
} from "../../dist/core/index.js";
import { TakeoverSessionManager } from "../../dist/browser-takeover/index.js";

const PRINCIPAL_A = "a".repeat(64);
const PRINCIPAL_B = "b".repeat(64);
const INTERVENTION_ID = "hosted-acceptance-intervention";
const EPOCH = 7;
const WORKER_A = "acceptance-worker-a";
const WORKER_B = "acceptance-worker-b";
const OPERATOR_CLIENT_A = "v".repeat(24);
const OPERATOR_CLIENT_B = "w".repeat(24);
const tokenA = randomBytes(32).toString("base64url");
const tokenB = randomBytes(32).toString("base64url");
const tokenWrongPrincipal = randomBytes(32).toString("base64url");
const auth = new Map([
  [tokenA, { workerId: WORKER_A, principalBinding: PRINCIPAL_A }],
  [tokenB, { workerId: WORKER_B, principalBinding: PRINCIPAL_A }],
  [tokenWrongPrincipal, { workerId: WORKER_A, principalBinding: PRINCIPAL_B }]
]);

const registry = new HostedWorkerRegistry();
const invalidations = [];
const contexts = [];
let serverSequence = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error("hosted topology acceptance timeout: " + label);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function resolveAuthorization(value) {
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return undefined;
  const supplied = value.slice("Bearer ".length);
  for (const [token, identity] of auth) {
    if (safeEqual(supplied, token)) return identity;
  }
  return undefined;
}

function sendJson(ws, value) {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("websocket unavailable");
  ws.send(JSON.stringify(value));
}

function deserializeFrameEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid frame envelope");
  }
  const frame = value.frame;
  if (!frame || typeof frame !== "object" || Array.isArray(frame)
    || typeof frame.dataBase64 !== "string") {
    throw new Error("invalid frame envelope");
  }
  return {
    version: value.version,
    type: value.type,
    interventionId: value.interventionId,
    epoch: value.epoch,
    workerGeneration: value.workerGeneration,
    frame: {
      data: new Uint8Array(Buffer.from(frame.dataBase64, "base64")),
      width: frame.width,
      height: frame.height,
      mimeType: frame.mimeType
    }
  };
}

function createServerContext(ws, identity) {
  const pending = new Map();
  let requestSequence = 0;
  let channel;
  let frameIngress;
  let disconnectComplete = false;
  let openError;

  const context = {
    ws,
    identity,
    pending,
    invalidations: [],
    channelPromise: undefined,
    get channel() { return channel; },
    get openError() { return openError; },
    set frameIngress(value) { frameIngress = value; },
    get disconnectComplete() { return disconnectComplete; },
    sendRequest(kind, payload) {
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("websocket unavailable"));
      const id = "server-" + (++requestSequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("worker acknowledgement timeout"));
        }, 3_000);
        pending.set(id, {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: () => {
            clearTimeout(timer);
            reject(new Error("worker rejected bounded message"));
          }
        });
        sendJson(ws, { kind, id, ...payload });
      });
    }
  };

  const peer = {
    send(message) {
      return context.sendRequest("control", { message });
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "control closed");
      }
    }
  };

  ws.on("message", async (data, isBinary) => {
    if (isBinary || Buffer.byteLength(data) > 128 * 1024) {
      ws.close(1008, "invalid message");
      return;
    }
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      ws.close(1008, "invalid message");
      return;
    }

    if (message.kind === "ack" || message.kind === "nack") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.kind === "ack") waiter.resolve();
      else waiter.reject();
      return;
    }

    if (message.kind === "frame") {
      try {
        if (!frameIngress) throw new Error("frame route unavailable");
        await frameIngress.accept(deserializeFrameEnvelope(message.envelope));
        sendJson(ws, { kind: "ack", id: message.id });
      } catch {
        sendJson(ws, { kind: "nack", id: message.id, code: "stale_route" });
      }
      return;
    }

    ws.close(1008, "invalid message");
  });

  context.channelPromise = HostedWorkerControlChannel.open(
    registry,
    {
      workerId: identity.workerId,
      principalBinding: identity.principalBinding,
      channelBinding: randomBytes(24).toString("base64url")
    },
    peer,
    {
      routesInvalidated(routes, reason) {
        const entry = {
          reason,
          count: routes.length,
          generations: routes.map((route) => route.workerGeneration)
        };
        context.invalidations.push(entry);
        invalidations.push(entry);
      }
    }
  ).then((opened) => {
    channel = opened;
    return opened;
  }).catch((error) => {
    openError = error;
    if (ws.readyState === WebSocket.OPEN) ws.close(1008, "registration rejected");
    return undefined;
  });

  ws.on("close", () => {
    for (const waiter of pending.values()) waiter.reject();
    pending.clear();
    void (async () => {
      try {
        const opened = await context.channelPromise;
        if (opened) await opened.disconnect();
      } catch {}
      disconnectComplete = true;
    })();
  });

  return context;
}

const httpServer = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404);
  response.end();
});
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const identity = request.url === "/worker"
    ? resolveAuthorization(request.headers.authorization)
    : undefined;
  if (!identity) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  request.handoffWorkerIdentity = identity;
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws, request) => {
  const identity = request.handoffWorkerIdentity;
  assert.ok(identity);
  const context = createServerContext(ws, identity);
  context.sequence = ++serverSequence;
  contexts.push(context);
});

await new Promise((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1", resolve);
});
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const workerUrl = "ws://127.0.0.1:" + address.port + "/worker";

async function expectAuthRejected() {
  const ws = new WebSocket(workerUrl, {
    headers: { authorization: "Bearer invalid" }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("unauthorized worker was not rejected")), 3_000);
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      assert.equal(response.statusCode, 401);
      response.resume();
      resolve();
    });
    ws.once("open", () => {
      clearTimeout(timer);
      reject(new Error("unauthorized worker connected"));
    });
    ws.on("error", () => undefined);
  });
}

function connectWorker(token) {
  const gate = new HostedWorkerRouteGate();
  const appliedInputs = [];
  const pending = new Map();
  let sequence = 0;
  let registeredGeneration;

  const ws = new WebSocket(workerUrl, {
    headers: { authorization: "Bearer " + token }
  });

  function sendRequest(kind, payload) {
    const id = "worker-" + (++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("control-plane acknowledgement timeout"));
      }, 3_000);
      pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: () => {
          clearTimeout(timer);
          reject(new Error("control plane rejected worker message"));
        }
      });
      sendJson(ws, { kind, id, ...payload });
    });
  }

  ws.on("message", async (data, isBinary) => {
    if (isBinary || Buffer.byteLength(data) > 128 * 1024) {
      ws.close(1008, "invalid message");
      return;
    }
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      ws.close(1008, "invalid message");
      return;
    }

    if (message.kind === "ack" || message.kind === "nack") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.kind === "ack") waiter.resolve();
      else waiter.reject();
      return;
    }

    if (message.kind === "control") {
      try {
        gate.applyControl(message.message);
        if (message.message.type === "registered") {
          registeredGeneration = message.message.workerGeneration;
        }
        sendJson(ws, { kind: "ack", id: message.id });
      } catch {
        sendJson(ws, { kind: "nack", id: message.id, code: "stale_route" });
      }
      return;
    }

    if (message.kind === "human_input") {
      try {
        await gate.applyHumanInput(message.envelope, (input) => {
          appliedInputs.push(input);
        });
        sendJson(ws, { kind: "ack", id: message.id });
      } catch {
        sendJson(ws, { kind: "nack", id: message.id, code: "stale_route" });
      }
      return;
    }

    ws.close(1008, "invalid message");
  });

  ws.on("close", () => {
    for (const waiter of pending.values()) waiter.reject();
    pending.clear();
  });

  return {
    ws,
    gate,
    appliedInputs,
    get registeredGeneration() { return registeredGeneration; },
    async opened() {
      await once(ws, "open");
      await waitFor("worker registration", () => registeredGeneration !== undefined);
    },
    frameEnvelope(interventionId, epoch, marker) {
      return gate.frameEnvelope(
        interventionId,
        epoch,
        {
          data: new Uint8Array([marker]),
          width: 64,
          height: 48,
          mimeType: "image/jpeg"
        }
      );
    },
    async sendFrame(interventionId, epoch, marker) {
      const envelope = this.frameEnvelope(interventionId, epoch, marker);
      await sendRequest("frame", {
        envelope: {
          version: envelope.version,
          type: envelope.type,
          interventionId: envelope.interventionId,
          epoch: envelope.epoch,
          workerGeneration: envelope.workerGeneration,
          frame: {
            dataBase64: Buffer.from(envelope.frame.data).toString("base64"),
            width: envelope.frame.width,
            height: envelope.frame.height,
            mimeType: envelope.frame.mimeType
          }
        }
      });
      return envelope;
    }
  };
}

try {
  await expectAuthRejected();
  assert.equal(registry.get(WORKER_A), undefined);

  const worker1 = connectWorker(tokenA);
  await worker1.opened();
  await waitFor("first server context", () => contexts.length >= 1);
  const context1 = contexts.at(-1);
  const channel1 = await context1.channelPromise;
  assert.ok(channel1);
  assert.equal(channel1.registration().generation, 1);
  assert.equal(worker1.registeredGeneration, 1);

  const route1 = await channel1.bindIntervention({
    interventionId: INTERVENTION_ID,
    epoch: EPOCH,
    principalBinding: PRINCIPAL_A
  });

  const duplicate = new WebSocket(workerUrl, {
    headers: { authorization: "Bearer " + tokenA }
  });
  const duplicateOpened = once(duplicate, "open");
  const duplicateClosed = once(duplicate, "close");
  duplicate.on("error", () => undefined);
  await duplicateOpened;
  await duplicateClosed;
  assert.equal(registry.get(WORKER_A)?.generation, 1);

  const operatorSessions = new TakeoverSessionManager(
    60_000,
    Date.now,
    () => "operator-session-hosted-acceptance",
    randomBytes(32),
    250,
    60_000
  );
  const operatorLocator = operatorSessions.ensure(
    INTERVENTION_ID,
    EPOCH,
    PRINCIPAL_A
  );
  const operatorGrant1 = operatorSessions.claimClient(
    operatorLocator.id,
    PRINCIPAL_A,
    OPERATOR_CLIENT_A
  );
  let currentOperator = {
    sessionId: operatorGrant1.id,
    interventionId: operatorGrant1.interventionId,
    epoch: operatorGrant1.epoch,
    principalBinding: operatorGrant1.principalBinding,
    expiresAt: operatorGrant1.expiresAt,
    viewerGeneration: operatorGrant1.clientGeneration
  };

  const binding1 = bindHostedOperatorSession(
    currentOperator,
    route1,
    registry
  );
  const deliveredFrames = [];
  const frameBridge1 = new HostedLatestFrameBridge({
    binding: binding1,
    registry,
    currentOperator: () => currentOperator,
    peer: {
      bufferedAmount: () => 0,
      sendFrame(frame) {
        deliveredFrames.push(frame.data[0]);
      }
    }
  });
  const frameIngress1 = new HostedWorkerFrameIngress(
    binding1,
    registry,
    () => currentOperator,
    frameBridge1
  );
  context1.frameIngress = frameIngress1;

  const inputBridge1 = new HostedHumanInputBridge(
    binding1,
    registry,
    () => currentOperator,
    {
      sendInput(envelope) {
        return context1.sendRequest("human_input", { envelope });
      }
    }
  );

  await worker1.sendFrame(INTERVENTION_ID, EPOCH, 1);
  assert.deepEqual(deliveredFrames, [1]);
  await inputBridge1.dispatch({ kind: "tap", x: 0.5, y: 0.5 });
  assert.deepEqual(worker1.appliedInputs, [{ kind: "tap", x: 0.5, y: 0.5 }]);
  const staleFrame = worker1.frameEnvelope(INTERVENTION_ID, EPOCH, 9);

  const worker1Closed = once(worker1.ws, "close");
  worker1.ws.close(1000, "acceptance reconnect");
  await worker1Closed;
  await waitFor("first worker disconnect fencing", () => context1.disconnectComplete);
  assert.equal(registry.get(WORKER_A), undefined);
  assert.ok(context1.invalidations.some((entry) =>
    entry.reason === "worker_disconnect" && entry.count === 1
  ));

  const wrongPrincipal = connectWorker(tokenWrongPrincipal);
  const wrongPrincipalOpened = once(wrongPrincipal.ws, "open");
  const wrongPrincipalClosed = once(wrongPrincipal.ws, "close");
  wrongPrincipal.ws.on("error", () => undefined);
  await wrongPrincipalOpened;
  await wrongPrincipalClosed;
  assert.equal(registry.get(WORKER_A), undefined);

  const workerB = connectWorker(tokenB);
  await workerB.opened();
  const contextB = contexts.at(-1);
  const channelB = await contextB.channelPromise;
  assert.ok(channelB);
  await assert.rejects(
    channelB.bindIntervention({
      interventionId: INTERVENTION_ID,
      epoch: EPOCH,
      principalBinding: PRINCIPAL_A
    })
  );
  const workerBClosed = once(workerB.ws, "close");
  workerB.ws.close(1000, "acceptance no reassignment");
  await workerBClosed;
  await waitFor("alternate worker disconnect", () => contextB.disconnectComplete);

  const worker2 = connectWorker(tokenA);
  await worker2.opened();
  const context2 = contexts.at(-1);
  const channel2 = await context2.channelPromise;
  assert.ok(channel2);
  assert.equal(channel2.registration().generation, 2);
  assert.equal(worker2.registeredGeneration, 2);

  const route2 = await channel2.bindIntervention({
    interventionId: INTERVENTION_ID,
    epoch: EPOCH,
    principalBinding: PRINCIPAL_A
  });
  const binding2 = bindHostedOperatorSession(currentOperator, route2, registry);
  const frameBridge2 = new HostedLatestFrameBridge({
    binding: binding2,
    registry,
    currentOperator: () => currentOperator,
    peer: {
      bufferedAmount: () => 0,
      sendFrame(frame) {
        deliveredFrames.push(frame.data[0]);
      }
    }
  });
  const frameIngress2 = new HostedWorkerFrameIngress(
    binding2,
    registry,
    () => currentOperator,
    frameBridge2
  );
  context2.frameIngress = frameIngress2;

  await assert.rejects(
    frameIngress2.accept(staleFrame),
    (error) => error instanceof HostedWorkerFrameError
      && error.code === "HOSTED_WORKER_FRAME_STALE_ROUTE"
  );
  await assert.rejects(inputBridge1.dispatch({ kind: "key", key: "Enter" }));

  await worker2.sendFrame(INTERVENTION_ID, EPOCH, 2);
  assert.deepEqual(deliveredFrames, [1, 2]);

  operatorSessions.releaseClientGeneration(
    operatorGrant1.id,
    PRINCIPAL_A,
    operatorGrant1.clientBinding,
    operatorGrant1.clientGeneration
  );
  const operatorGrant2 = operatorSessions.reconnectClient(
    operatorGrant1.id,
    PRINCIPAL_A,
    operatorGrant1.reconnectHandle,
    OPERATOR_CLIENT_B
  );
  currentOperator = {
    sessionId: operatorGrant2.id,
    interventionId: operatorGrant2.interventionId,
    epoch: operatorGrant2.epoch,
    principalBinding: operatorGrant2.principalBinding,
    expiresAt: operatorGrant2.expiresAt,
    viewerGeneration: operatorGrant2.clientGeneration
  };

  assert.throws(
    () => assertHostedOperatorBindingCurrent(binding2, currentOperator, registry),
    (error) => error instanceof HostedOperatorBindingError
      && error.code === "HOSTED_OPERATOR_VIEWER_STALE"
  );

  const binding3 = bindHostedOperatorSession(currentOperator, route2, registry);
  const inputBridge2 = new HostedHumanInputBridge(
    binding3,
    registry,
    () => currentOperator,
    {
      sendInput(envelope) {
        return context2.sendRequest("human_input", { envelope });
      }
    }
  );
  await inputBridge2.dispatch({ kind: "text", text: "acceptance-text" });
  assert.equal(worker2.appliedInputs.length, 1);
  assert.deepEqual(worker2.appliedInputs[0], { kind: "text", text: "acceptance-text" });

  await channel2.revokeIntervention(route2);
  assert.ok(context2.invalidations.some((entry) =>
    entry.reason === "explicit_revoke" && entry.count === 1
  ));
  assert.throws(
    () => worker2.frameEnvelope(INTERVENTION_ID, EPOCH, 3),
    /route is stale/
  );
  await assert.rejects(inputBridge2.dispatch({ kind: "key", key: "Enter" }));

  const recoveryHint = recoverHostedControlPlane({
    version: 1,
    adapterKind: "hosted_acceptance",
    interventionId: INTERVENTION_ID,
    status: "human_active",
    epoch: EPOCH,
    resumePolicy: "revalidate",
    principalBinding: PRINCIPAL_A,
    updatedAt: Date.now(),
    expiresAt: Date.now() + 60_000
  }, Date.now());
  assert.equal(recoveryHint.workerRoute, "reconnect_required");
  assert.equal(recoveryHint.operatorSession, "reissue_required");
  const restartedRegistry = new HostedWorkerRegistry();
  assert.equal(restartedRegistry.get(WORKER_A), undefined);

  const worker2Closed = once(worker2.ws, "close");
  worker2.ws.close(1000, "acceptance complete");
  await worker2Closed;
  await waitFor("second worker disconnect", () => context2.disconnectComplete);

  process.stdout.write("HOSTED_TOPOLOGY_ACCEPTANCE:" + JSON.stringify({
    outboundWorkerOnly: true,
    authenticatedRegistration: true,
    firstWorkerGeneration: 1,
    successorWorkerGeneration: 2,
    operatorViewerGenerations: [1, 2],
    framesDelivered: deliveredFrames.length,
    humanInputsApplied: worker1.appliedInputs.length + worker2.appliedInputs.length,
    staleWorkerFrameRejected: true,
    staleViewerRejected: true,
    duplicateWorkerRejected: true,
    principalRebindRejected: true,
    alternateWorkerReassignmentRejected: true,
    recoveryRequiresReissue: true
  }) + "\n");
  process.stdout.write("HOSTED_TOPOLOGY_ACCEPTANCE_OK\n");
} finally {
  for (const context of contexts) {
    try {
      if (context.ws.readyState === WebSocket.OPEN) context.ws.close(1000, "acceptance cleanup");
    } catch {}
  }
  await delay(20);
  wss.close();
  await new Promise((resolve) => httpServer.close(resolve));
}
