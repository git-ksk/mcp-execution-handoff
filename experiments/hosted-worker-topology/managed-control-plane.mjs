import assert from "node:assert/strict";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  HostedHumanInputBridge,
  HostedLatestFrameBridge,
  HostedOperatorBindingError,
  HostedWorkerControlChannel,
  HostedWorkerFrameError,
  HostedWorkerFrameIngress,
  HostedWorkerRegistry,
  assertHostedOperatorBindingCurrent,
  bindHostedOperatorSession,
  recoverHostedControlPlane
} from "../../dist/core/index.js";
import { TakeoverSessionManager } from "../../dist/browser-takeover/index.js";

const REVISION = process.env.HANDOFF_ACCEPTANCE_REVISION || "";
const EXPECTED_PUBLIC_KEY = process.env.HANDOFF_ACCEPTANCE_WORKER_PUBLIC_KEY || "";
const PORT = Number(process.env.PORT || "8080");
const PRINCIPAL = "a".repeat(64);
const INTERVENTION_ID = "managed-split-intervention";
const EPOCH = 11;
const WORKER_ID = "managed-split-worker";
const OPERATOR_CLIENT_A = "v".repeat(24);
const OPERATOR_CLIENT_B = "w".repeat(24);

if (!/^[0-9a-f]{40}$/.test(REVISION)) throw new Error("exact acceptance revision required");
if (!/^[A-Za-z0-9_-]{40,256}$/.test(EXPECTED_PUBLIC_KEY)) throw new Error("worker public key required");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("invalid PORT");

const expectedKey = createPublicKey({
  key: Buffer.from(EXPECTED_PUBLIC_KEY, "base64url"),
  format: "der",
  type: "spki"
});
const registry = new HostedWorkerRegistry();
const operatorSessions = new TakeoverSessionManager(
  120_000,
  Date.now,
  () => "managed-split-operator-session",
  randomBytes(32),
  250,
  120_000
);
let currentOperator;
let firstBinding;
let staleFrame;
let generationOneContext;
let generationTwoContext;
let acceptanceRunning = false;
let acceptanceDone = false;
let acceptanceFailure;
const result = {
  revision: REVISION,
  cloudControlPlane: true,
  outboundWorkerOnly: true,
  authenticatedRegistration: false,
  firstWorkerGeneration: 0,
  successorWorkerGeneration: 0,
  humanInputsApplied: 0,
  framesDelivered: 0,
  staleWorkerFrameRejected: false,
  staleViewerRejected: false,
  explicitRevokeObserved: false,
  revokedWorkerRouteRejected: false,
  recoveryRequiresReissue: false,
  workerReconnectObserved: false,
  remoteBrowserProcessPersistent: false,
  remoteProfilePersistent: false,
  remoteChromiumReady: false,
  remoteWorkerLinux: false
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("managed split acceptance timeout: " + label);
}

function sendJson(ws, value) {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("websocket unavailable");
  ws.send(JSON.stringify(value));
}

function deserializeFrameEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid frame envelope");
  const frame = value.frame;
  if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.dataBase64 !== "string") {
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

function verifyWorkerAuth(nonce, publicKeyText, signatureText) {
  if (publicKeyText !== EXPECTED_PUBLIC_KEY) return false;
  if (typeof signatureText !== "string" || !/^[A-Za-z0-9_-]{40,256}$/.test(signatureText)) return false;
  const message = Buffer.from("handoff-managed-split/v1\0" + REVISION + "\0" + nonce, "utf8");
  try {
    return verify(null, message, expectedKey, Buffer.from(signatureText, "base64url"));
  } catch {
    return false;
  }
}

function operatorRef() {
  return {
    sessionId: currentOperator.sessionId,
    interventionId: currentOperator.interventionId,
    epoch: currentOperator.epoch,
    principalBinding: currentOperator.principalBinding,
    expiresAt: currentOperator.expiresAt,
    viewerGeneration: currentOperator.viewerGeneration
  };
}

function createContext(ws) {
  const pending = new Map();
  let requestSequence = 0;
  let frameIngress;
  let channel;
  let closed = false;

  const context = {
    ws,
    pending,
    channelPromise: undefined,
    get channel() { return channel; },
    set frameIngress(value) { frameIngress = value; },
    get frameIngress() { return frameIngress; },
    get closed() { return closed; },
    sendRequest(kind, payload = {}) {
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("websocket unavailable"));
      const id = "control-" + (++requestSequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("worker acknowledgement timeout"));
        }, 5_000);
        pending.set(id, {
          resolve: (data) => {
            clearTimeout(timer);
            resolve(data);
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
    if (isBinary || Buffer.byteLength(data) > 256 * 1024) {
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
      if (message.kind === "ack") waiter.resolve(message.data);
      else waiter.reject();
      return;
    }

    if (message.kind === "worker_evidence") {
      const evidence = message.evidence;
      const valid = evidence
        && typeof evidence === "object"
        && !Array.isArray(evidence)
        && Object.keys(evidence).every((key) => [
          "browserProcessPersistent",
          "profilePersistent",
          "chromiumReady",
          "platform"
        ].includes(key))
        && typeof evidence.browserProcessPersistent === "boolean"
        && typeof evidence.profilePersistent === "boolean"
        && typeof evidence.chromiumReady === "boolean"
        && evidence.platform === "linux";
      if (!valid) {
        sendJson(ws, { kind: "nack", id: message.id, code: "invalid_evidence" });
        return;
      }
      result.remoteBrowserProcessPersistent = evidence.browserProcessPersistent;
      result.remoteProfilePersistent = evidence.profilePersistent;
      result.remoteChromiumReady = evidence.chromiumReady;
      result.remoteWorkerLinux = true;
      sendJson(ws, { kind: "ack", id: message.id });
      return;
    }

    if (message.kind === "frame") {
      try {
        if (!frameIngress) throw new Error("frame route unavailable");
        const envelope = deserializeFrameEnvelope(message.envelope);
        if (!staleFrame) staleFrame = envelope;
        await frameIngress.accept(envelope);
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
      workerId: WORKER_ID,
      principalBinding: PRINCIPAL,
      channelBinding: randomBytes(24).toString("base64url")
    },
    peer,
    {
      routesInvalidated(routes, reason) {
        if (reason === "explicit_revoke" && routes.length === 1) result.explicitRevokeObserved = true;
      }
    }
  ).then((opened) => {
    channel = opened;
    return opened;
  });

  ws.on("close", () => {
    for (const waiter of pending.values()) waiter.reject();
    pending.clear();
    void (async () => {
      try {
        const opened = await context.channelPromise;
        await opened.disconnect();
      } catch {}
      closed = true;
    })();
  });

  return context;
}

async function prepareOperator(route) {
  if (!currentOperator) {
    const locator = operatorSessions.ensure(INTERVENTION_ID, EPOCH, PRINCIPAL);
    const grant = operatorSessions.claimClient(locator.id, PRINCIPAL, OPERATOR_CLIENT_A);
    currentOperator = {
      sessionId: grant.id,
      interventionId: grant.interventionId,
      epoch: grant.epoch,
      principalBinding: grant.principalBinding,
      expiresAt: grant.expiresAt,
      viewerGeneration: grant.clientGeneration,
      reconnectHandle: grant.reconnectHandle,
      clientBinding: grant.clientBinding
    };
  }
  return bindHostedOperatorSession(operatorRef(), route, registry);
}

function createFrameIngress(binding, context) {
  const frameBridge = new HostedLatestFrameBridge({
    binding,
    registry,
    currentOperator: operatorRef,
    peer: {
      bufferedAmount: () => 0,
      sendFrame(frame) {
        result.framesDelivered += 1;
        assert.ok(frame.data instanceof Uint8Array && frame.data.byteLength > 0);
      }
    }
  });
  context.frameIngress = new HostedWorkerFrameIngress(
    binding,
    registry,
    operatorRef,
    frameBridge
  );
}

function createInputBridge(binding, context) {
  return new HostedHumanInputBridge(
    binding,
    registry,
    operatorRef,
    {
      sendInput(envelope) {
        return context.sendRequest("human_input", { envelope });
      }
    }
  );
}

async function runGenerationOne(context) {
  const channel = await context.channelPromise;
  result.authenticatedRegistration = true;
  result.firstWorkerGeneration = channel.registration().generation;
  assert.equal(result.firstWorkerGeneration, 1);

  const route = await channel.bindIntervention({
    interventionId: INTERVENTION_ID,
    epoch: EPOCH,
    principalBinding: PRINCIPAL
  });
  const binding = await prepareOperator(route);
  firstBinding = binding;
  createFrameIngress(binding, context);
  const input = createInputBridge(binding, context);

  await input.dispatch({ kind: "tap", x: 0.5, y: 0.5 });
  result.humanInputsApplied += 1;
  await context.sendRequest("request_frame", { interventionId: INTERVENTION_ID, epoch: EPOCH, marker: 1 });
  await waitFor("first frame", () => result.framesDelivered >= 1);

  context.ws.close(4000, "acceptance_reconnect");
  await waitFor("first worker disconnect", () => context.closed && registry.get(WORKER_ID) === undefined);
}

async function runGenerationTwo(context) {
  const channel = await context.channelPromise;
  result.successorWorkerGeneration = channel.registration().generation;
  assert.equal(result.successorWorkerGeneration, 2);
  result.workerReconnectObserved = true;

  const route = await channel.bindIntervention({
    interventionId: INTERVENTION_ID,
    epoch: EPOCH,
    principalBinding: PRINCIPAL
  });

  const binding = await prepareOperator(route);
  createFrameIngress(binding, context);

  if (!staleFrame) throw new Error("stale frame evidence missing");
  try {
    await context.frameIngress.accept(staleFrame);
  } catch (error) {
    if (error instanceof HostedWorkerFrameError && error.code === "HOSTED_WORKER_FRAME_STALE_ROUTE") {
      result.staleWorkerFrameRejected = true;
    } else {
      throw error;
    }
  }
  assert.equal(result.staleWorkerFrameRejected, true);

  operatorSessions.releaseClientGeneration(
    currentOperator.sessionId,
    PRINCIPAL,
    currentOperator.clientBinding,
    currentOperator.viewerGeneration
  );
  const grant2 = operatorSessions.reconnectClient(
    currentOperator.sessionId,
    PRINCIPAL,
    currentOperator.reconnectHandle,
    OPERATOR_CLIENT_B
  );
  currentOperator = {
    sessionId: grant2.id,
    interventionId: grant2.interventionId,
    epoch: grant2.epoch,
    principalBinding: grant2.principalBinding,
    expiresAt: grant2.expiresAt,
    viewerGeneration: grant2.clientGeneration,
    reconnectHandle: grant2.reconnectHandle,
    clientBinding: grant2.clientBinding
  };

  try {
    assertHostedOperatorBindingCurrent(firstBinding, operatorRef(), registry);
  } catch (error) {
    if (error instanceof HostedOperatorBindingError && error.code === "HOSTED_OPERATOR_VIEWER_STALE") {
      result.staleViewerRejected = true;
    } else {
      throw error;
    }
  }
  assert.equal(result.staleViewerRejected, true);

  const freshBinding = bindHostedOperatorSession(operatorRef(), route, registry);
  createFrameIngress(freshBinding, context);
  const input = createInputBridge(freshBinding, context);
  await input.dispatch({ kind: "text", text: "managed-split-acceptance" });
  result.humanInputsApplied += 1;
  await context.sendRequest("request_frame", { interventionId: INTERVENTION_ID, epoch: EPOCH, marker: 2 });
  await waitFor("second frame", () => result.framesDelivered >= 2);

  await channel.revokeIntervention(route);
  const probe = await context.sendRequest("probe_revoked", { interventionId: INTERVENTION_ID, epoch: EPOCH });
  result.revokedWorkerRouteRejected = probe?.rejected === true;
  assert.equal(result.revokedWorkerRouteRejected, true);

  const recovery = recoverHostedControlPlane({
    version: 1,
    adapterKind: "managed_split_acceptance",
    interventionId: INTERVENTION_ID,
    status: "human_active",
    epoch: EPOCH,
    resumePolicy: "revalidate",
    principalBinding: PRINCIPAL,
    updatedAt: Date.now(),
    expiresAt: Date.now() + 60_000
  }, Date.now());
  result.recoveryRequiresReissue =
    recovery.workerRoute === "reconnect_required" &&
    recovery.operatorSession === "reissue_required";
  assert.equal(result.recoveryRequiresReissue, true);

  acceptanceDone = true;
  context.ws.close(1000, "acceptance complete");
}

async function maybeRunAcceptance(context) {
  if (acceptanceDone || acceptanceFailure) return;
  try {
    const channel = await context.channelPromise;
    const generation = channel.registration().generation;
    if (generation === 1) {
      if (acceptanceRunning) return;
      acceptanceRunning = true;
      generationOneContext = context;
      await runGenerationOne(context);
      acceptanceRunning = false;
      return;
    }
    if (generation === 2) {
      generationTwoContext = context;
      await runGenerationTwo(context);
      return;
    }
    throw new Error("unexpected worker generation");
  } catch (error) {
    acceptanceFailure = error instanceof Error ? error.message : "acceptance failed";
  }
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/ready") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true, revision: REVISION, workerConnected: registry.get(WORKER_ID) !== undefined }));
    return;
  }
  if (request.method === "GET" && request.url === "/acceptance-result") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      ...result,
      acceptanceDone,
      failure: acceptanceFailure ? "failed" : "none"
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/worker") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws) => {
  const nonce = randomBytes(32).toString("base64url");
  const authTimer = setTimeout(() => ws.close(1008, "authentication timeout"), 5_000);
  let authenticated = false;

  const onAuth = (data, isBinary) => {
    if (authenticated || isBinary || Buffer.byteLength(data) > 8 * 1024) {
      ws.close(1008, "invalid authentication");
      return;
    }
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      ws.close(1008, "invalid authentication");
      return;
    }
    if (message.kind !== "auth" || !verifyWorkerAuth(nonce, message.publicKey, message.signature)) {
      ws.close(1008, "authentication failed");
      return;
    }
    authenticated = true;
    clearTimeout(authTimer);
    ws.off("message", onAuth);
    const context = createContext(ws);
    void maybeRunAcceptance(context);
  };

  ws.on("message", onAuth);
  sendJson(ws, { kind: "challenge", nonce, revision: REVISION });
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write("MANAGED_SPLIT_CONTROL_READY\n");
});

process.on("SIGTERM", () => {
  try { generationOneContext?.ws.close(1001, "shutdown"); } catch {}
  try { generationTwoContext?.ws.close(1001, "shutdown"); } catch {}
  server.close(() => process.exit(0));
});
