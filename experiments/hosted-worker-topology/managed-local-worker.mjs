import assert from "node:assert/strict";
import fs from "node:fs";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { HostedWorkerRouteGate } from "../../dist/core/index.js";

const baseUrl = process.argv[2];
const privateKeyPath = process.argv[3];
const revision = process.argv[4];

if (!baseUrl || !/^https:\/\//.test(baseUrl)) throw new Error("HTTPS control-plane URL required");
if (!privateKeyPath) throw new Error("private key path required");
if (!/^[0-9a-f]{40}$/.test(revision || "")) throw new Error("exact revision required");
if (process.platform !== "darwin") throw new Error("managed local-worker acceptance requires physical macOS host");

const privateKey = createPrivateKey(fs.readFileSync(privateKeyPath));
const publicKey = createPublicKey(privateKey);
const publicKeyText = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const workerUrl = new URL(baseUrl);
workerUrl.protocol = "wss:";
workerUrl.pathname = "/worker";
workerUrl.search = "";
workerUrl.hash = "";

function sendJson(ws, value) {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("worker websocket unavailable");
  ws.send(JSON.stringify(value));
}

function serializeFrameEnvelope(envelope) {
  return {
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
  };
}

async function connectOnce(expectedGeneration) {
  const gate = new HostedWorkerRouteGate();
  const pending = new Map();
  let sequence = 0;
  let registeredGeneration;
  let appliedInputs = 0;
  const ws = new WebSocket(workerUrl);
  ws.on("error", () => undefined);

  function sendRequest(kind, payload = {}) {
    const id = "worker-" + (++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("control-plane acknowledgement timeout"));
      }, 5_000);
      pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
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

    if (message.kind === "challenge") {
      if (message.revision !== revision || typeof message.nonce !== "string") {
        ws.close(1008, "invalid challenge");
        return;
      }
      const payload = Buffer.from("handoff-managed-split/v1\0" + revision + "\0" + message.nonce, "utf8");
      const signature = sign(null, payload, privateKey).toString("base64url");
      sendJson(ws, { kind: "auth", publicKey: publicKeyText, signature });
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

    if (message.kind === "control") {
      try {
        gate.applyControl(message.message);
        if (message.message.type === "registered") registeredGeneration = message.message.workerGeneration;
        sendJson(ws, { kind: "ack", id: message.id });
      } catch {
        sendJson(ws, { kind: "nack", id: message.id });
      }
      return;
    }

    if (message.kind === "human_input") {
      try {
        await gate.applyHumanInput(message.envelope, () => {
          appliedInputs += 1;
        });
        sendJson(ws, { kind: "ack", id: message.id });
      } catch {
        sendJson(ws, { kind: "nack", id: message.id });
      }
      return;
    }

    if (message.kind === "request_frame") {
      try {
        const envelope = gate.frameEnvelope(
          message.interventionId,
          message.epoch,
          {
            data: new Uint8Array([Number(message.marker) & 0xff]),
            width: 64,
            height: 48,
            mimeType: "image/jpeg"
          }
        );
        await sendRequest("frame", { envelope: serializeFrameEnvelope(envelope) });
        sendJson(ws, { kind: "ack", id: message.id });
      } catch {
        sendJson(ws, { kind: "nack", id: message.id });
      }
      return;
    }

    if (message.kind === "probe_revoked") {
      let rejected = false;
      try {
        gate.frameEnvelope(message.interventionId, message.epoch, {
          data: new Uint8Array([9]),
          width: 64,
          height: 48,
          mimeType: "image/jpeg"
        });
      } catch {
        rejected = true;
      }
      sendJson(ws, { kind: "ack", id: message.id, data: { rejected } });
      return;
    }

    ws.close(1008, "invalid message");
  });

  await once(ws, "open");
  const [code] = await once(ws, "close");
  for (const waiter of pending.values()) waiter.reject();
  pending.clear();

  assert.equal(registeredGeneration, expectedGeneration);
  return { code, appliedInputs };
}

const first = await connectOnce(1);
assert.equal(first.code, 4000);
await new Promise((resolve) => setTimeout(resolve, 750));
const second = await connectOnce(2);
assert.equal(second.code, 1000);

process.stdout.write("MANAGED_SPLIT_LOCAL_WORKER_OK:" + JSON.stringify({
  platform: "darwin",
  generations: [1, 2],
  humanInputsApplied: first.appliedInputs + second.appliedInputs
}) + "\n");
