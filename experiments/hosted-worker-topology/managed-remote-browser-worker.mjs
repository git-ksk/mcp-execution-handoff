import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { HostedWorkerRouteGate } from "../../dist/core/index.js";

const baseUrl = process.env.HANDOFF_CONTROL_PLANE_URL;
const privateKeyPath = process.env.HANDOFF_WORKER_PRIVATE_KEY_PATH || "/run/handoff/private.pem";
const revision = process.env.HANDOFF_ACCEPTANCE_REVISION;
const profileDir = process.env.HANDOFF_BROWSER_PROFILE_DIR || "/state/profile";
const chromiumBinary = process.env.HANDOFF_CHROMIUM_BINARY || "chromium";

if (!baseUrl || !/^https:\/\//.test(baseUrl)) throw new Error("HTTPS control-plane URL required");
if (!/^[0-9a-f]{40}$/.test(revision || "")) throw new Error("exact revision required");
if (process.platform !== "linux") throw new Error("managed remote browser worker requires Linux");
if (!path.isAbsolute(profileDir) || !path.isAbsolute(privateKeyPath)) throw new Error("absolute worker paths required");

fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
const markerPath = path.join(profileDir, "handoff-profile-marker");
let marker;
if (fs.existsSync(markerPath)) {
  marker = fs.readFileSync(markerPath, "utf8").trim();
} else {
  marker = randomBytes(24).toString("base64url");
  fs.writeFileSync(markerPath, marker, { mode: 0o600 });
}

const privateKey = createPrivateKey(fs.readFileSync(privateKeyPath));
const publicKey = createPublicKey(privateKey);
const publicKeyText = publicKey.export({ format: "der", type: "spki" }).toString("base64url");

const remoteDebugPort = 9222;
const chromium = spawn(chromiumBinary, [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${profileDir}`,
  "--remote-debugging-address=127.0.0.1",
  `--remote-debugging-port=${remoteDebugPort}`,
  "data:text/html,<title>Handoff%20Remote%20Worker</title><body>bounded%20acceptance</body>"
], {
  stdio: ["ignore", "ignore", "ignore"],
  env: {
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: os.tmpdir()
  }
});

let chromiumExited = false;
chromium.once("exit", () => { chromiumExited = true; });

async function chromiumReady() {
  if (chromiumExited || !chromium.pid) return false;
  try {
    process.kill(chromium.pid, 0);
    const response = await fetch(`http://127.0.0.1:${remoteDebugPort}/json/version`, {
      signal: AbortSignal.timeout(1_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForChromium() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await chromiumReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chromium did not become ready");
}

await waitForChromium();
const initialPid = chromium.pid;
const initialMarker = fs.readFileSync(markerPath, "utf8").trim();
assert.equal(initialMarker, marker);

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

async function connectOnce(expectedGeneration, evidence) {
  const gate = new HostedWorkerRouteGate();
  const pending = new Map();
  let sequence = 0;
  let registeredGeneration;
  let appliedInputs = 0;
  let evidencePromise;
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
        if (message.message.type === "registered") {
          registeredGeneration = message.message.workerGeneration;
          if (evidence && !evidencePromise) {
            evidencePromise = sendRequest("worker_evidence", { evidence });
          }
        }
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
  if (evidencePromise) await evidencePromise;
  for (const waiter of pending.values()) waiter.reject();
  pending.clear();

  assert.equal(registeredGeneration, expectedGeneration);
  return { code, appliedInputs };
}

try {
  const first = await connectOnce(1);
  assert.equal(first.code, 4000);

  await new Promise((resolve) => setTimeout(resolve, 750));
  const processPersistent = !chromiumExited
    && chromium.pid === initialPid
    && await chromiumReady();
  const profilePersistent = fs.readFileSync(markerPath, "utf8").trim() === initialMarker;

  const second = await connectOnce(2, {
    browserProcessPersistent: processPersistent,
    profilePersistent,
    chromiumReady: await chromiumReady(),
    platform: "linux"
  });
  assert.equal(second.code, 1000);
  assert.equal(processPersistent, true);
  assert.equal(profilePersistent, true);

  process.stdout.write("MANAGED_REMOTE_STATEFUL_WORKER_OK:" + JSON.stringify({
    generations: [1, 2],
    humanInputsApplied: first.appliedInputs + second.appliedInputs,
    browserProcessPersistent: true,
    profilePersistent: true,
    chromiumReady: true
  }) + "\n");
} finally {
  if (!chromiumExited && chromium.pid) {
    try { chromium.kill("SIGTERM"); } catch {}
  }
}
