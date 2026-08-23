import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { RTCPeerConnection, useH264 } from "werift";
import {
  SpawnedWebRtcRuntimeProvider,
  WebRtcTakeoverRuntimeError,
  type WebRtcTakeoverRuntimeBinding
} from "../src/browser-takeover/webrtc-runtime.js";

class FakeHostProcess extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
    });
    return true;
  }
}

function binding(): WebRtcTakeoverRuntimeBinding {
  return {
    takeoverSessionId: "host-ready-session",
    interventionId: "host-ready-intervention",
    epoch: 1,
    principalBinding: "host-ready-principal",
    clientBinding: "host-ready-client-1234567890",
    clientGeneration: 1,
    expiresAt: Date.now() + 60_000,
    targetProcessId: 31337,
    targetWindowId: 42424
  };
}

async function clientOffer(): Promise<{ client: RTCPeerConnection; offer: { type: "offer"; sdp: string } }> {
  const client = new RTCPeerConnection({ codecs: { video: [useH264()] }, iceServers: [] });
  client.addTransceiver("video", { direction: "recvonly" });
  client.createDataChannel("human-critical", { ordered: true });
  client.createDataChannel("human-realtime", { ordered: false, maxRetransmits: 0 });
  const offer = await client.createOffer();
  await client.setLocalDescription(offer);
  assert.ok(client.localDescription?.sdp);
  return { client, offer: { type: "offer", sdp: client.localDescription.sdp } };
}

function providerWith(child: FakeHostProcess): SpawnedWebRtcRuntimeProvider {
  return new SpawnedWebRtcRuntimeProvider({
    hostExecutable: "/fake/handoff-linux-webrtc-host",
    displayName: ":99",
    spawnProcess: (() => child) as never
  });
}

const hooks = { beginInput: () => () => undefined, disconnected: () => undefined };

test("Linux WebRTC runtime waits for exact host window readiness before creating an answer", async () => {
  const child = new FakeHostProcess();
  const provider = providerWith(child);
  const { client, offer } = await clientOffer();
  let settled = false;
  try {
    const started = provider.start(binding(), offer, hooks).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false);

    child.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=target_alive\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false);

    child.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=window_ready\n");
    const answer = await started;
    assert.equal(answer.type, "answer");
    assert.match(answer.sdp, /^v=0/m);
    assert.deepEqual(provider.diagnosticsSnapshot().events.map((event) => event.stage).slice(0, 2), [
      "host.target.alive",
      "host.window.ready"
    ]);
  } finally {
    await client.close().catch(() => undefined);
    await provider.revoke("host-ready-session").catch(() => undefined);
  }
});

test("Linux WebRTC runtime fails closed before answer creation when the target window cannot become ready", async () => {
  const child = new FakeHostProcess();
  const provider = providerWith(child);
  const { client, offer } = await clientOffer();
  try {
    const started = provider.start(binding(), offer, hooks);
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=target_missing\n");
    await assert.rejects(started, (error: unknown) => {
      assert.ok(error instanceof WebRtcTakeoverRuntimeError);
      assert.equal(error.code, "WEBRTC_RUNTIME_START_FAILED");
      assert.equal(error.startStage, "host_ready");
      assert.equal(error.startReason, "host_not_ready");
      return true;
    });
    assert.equal(provider.diagnosticsSnapshot().events.some((event) => event.stage === "host.target.missing"), true);
  } finally {
    await client.close().catch(() => undefined);
    await provider.revoke("host-ready-session").catch(() => undefined);
  }
});

test("runtime start error preserves the explicit end cause after expiry cleanup", async () => {
  const child = new FakeHostProcess();
  const provider = providerWith(child);
  const { client, offer } = await clientOffer();
  const expiringBinding = { ...binding(), expiresAt: Date.now() + 40 };
  try {
    await assert.rejects(provider.start(expiringBinding, offer, hooks), (error: unknown) => {
      assert.ok(error instanceof WebRtcTakeoverRuntimeError);
      assert.equal(error.code, "WEBRTC_RUNTIME_START_FAILED");
      assert.equal(error.startStage, "host_ready");
      assert.equal(error.startEndCause, "expiry");
      return true;
    });
  } finally {
    await client.close().catch(() => undefined);
    await provider.revoke("host-ready-session").catch(() => undefined);
  }
});

test("spawned WebRTC host receives only bounded runtime env plus the Node executable directory", async () => {
  const child = new FakeHostProcess();
  const expectedBinding = binding();
  let capturedExecutable: string | undefined;
  let capturedArgs: readonly string[] | undefined;
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const provider = new SpawnedWebRtcRuntimeProvider({
    hostExecutable: "/fake/handoff-linux-webrtc-host",
    displayName: ":99",
    spawnProcess: ((executable: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      capturedExecutable = executable;
      capturedArgs = args;
      capturedEnv = options.env;
      return child;
    }) as never
  });
  const { client, offer } = await clientOffer();
  try {
    const started = provider.start(expectedBinding, offer, hooks);
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=target_missing\n");
    await assert.rejects(started, WebRtcTakeoverRuntimeError);

    assert.equal(capturedExecutable, "/fake/handoff-linux-webrtc-host");
    assert.deepEqual(capturedArgs, []);
    assert.ok(capturedEnv);
    assert.equal(capturedEnv.PATH, dirname(process.execPath));
    assert.equal(capturedEnv.TAKEOVER_WEBRTC_DISPLAY_NAME, ":99");
    assert.equal(capturedEnv.TAKEOVER_WEBRTC_TARGET_PID, "31337");
    assert.equal(capturedEnv.TAKEOVER_WEBRTC_TARGET_WINDOW_ID, "42424");
    assert.equal(capturedEnv.TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS, String(expectedBinding.expiresAt));
    assert.deepEqual(
      Object.keys(capturedEnv).sort(),
      ["PATH", "TAKEOVER_WEBRTC_DISPLAY_NAME", "TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS", "TAKEOVER_WEBRTC_TARGET_PID", "TAKEOVER_WEBRTC_TARGET_WINDOW_ID"].sort()
    );
  } finally {
    await client.close().catch(() => undefined);
    await provider.revoke("host-ready-session").catch(() => undefined);
  }
});
