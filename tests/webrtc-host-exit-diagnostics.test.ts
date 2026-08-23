import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { RTCPeerConnection, useH264 } from "werift";
import {
  SpawnedWebRtcRuntimeProvider,
  WebRtcTakeoverRuntimeError,
  type WebRtcTakeoverRuntimeBinding
} from "../src/browser-takeover/index.js";

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
      this.stdin.end();
      this.stdout.end();
      this.stderr.end();
      this.emit("close", null, signal);
    });
    return true;
  }

  exit(code: number, stderrLine: string): void {
    this.stderr.write(`${stderrLine}\n`);
    this.exitCode = code;
    this.emit("exit", code, null);
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }
}

function binding(): WebRtcTakeoverRuntimeBinding {
  return {
    takeoverSessionId: "host-diagnostic-session",
    interventionId: "host-diagnostic-intervention",
    epoch: 1,
    principalBinding: "host-diagnostic-principal",
    clientBinding: "host-diagnostic-client-1234567890",
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
    hostExecutable: "/fake/takeover-webrtc-host",
    displayName: ":99",
    spawnProcess: (() => child) as never
  });
}

const hooks = { beginInput: () => () => undefined, disconnected: () => undefined };

test("unexpected helper exit logs only bounded stdin_eof reason, exit code, and signal", async () => {
  const child = new FakeHostProcess();
  const provider = providerWith(child);
  const { client, offer } = await clientOffer();
  const logs: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const started = provider.start(binding(), offer, hooks);
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.exit(0, "MCP_HANDOFF_DIAGNOSTIC host_exit_reason=stdin_eof");

    await assert.rejects(started, (error: unknown) => {
      assert.ok(error instanceof WebRtcTakeoverRuntimeError);
      assert.equal(error.code, "WEBRTC_RUNTIME_START_FAILED");
      assert.equal(error.startEndCause, "host_exit");
      return true;
    });

    assert.deepEqual(logs.filter((line) => line.includes("WebRTC host exited")), [
      "[mcp-execution-handoff] WebRTC host exited reason=stdin_eof exit_code=0 signal=none"
    ]);
  } finally {
    console.error = originalConsoleError;
    await client.close().catch(() => undefined);
    await provider.revoke("host-diagnostic-session").catch(() => undefined);
  }
});

test("malformed helper stderr is never echoed by bounded exit diagnostics", async () => {
  const child = new FakeHostProcess();
  const provider = providerWith(child);
  const { client, offer } = await clientOffer();
  const logs: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const started = provider.start(binding(), offer, hooks);
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.exit(7, "MCP_HANDOFF_DIAGNOSTIC host_exit_reason=stdin_eof secret=must-not-appear");
    await assert.rejects(started, WebRtcTakeoverRuntimeError);

    const exitLogs = logs.filter((line) => line.includes("WebRTC host exited"));
    assert.deepEqual(exitLogs, [
      "[mcp-execution-handoff] WebRTC host exited reason=unexpected exit_code=7 signal=none"
    ]);
    assert.equal(logs.some((line) => line.includes("must-not-appear")), false);
  } finally {
    console.error = originalConsoleError;
    await client.close().catch(() => undefined);
    await provider.revoke("host-diagnostic-session").catch(() => undefined);
  }
});
