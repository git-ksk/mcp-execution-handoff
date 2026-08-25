import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RTCPeerConnection, useH264 } from "werift";
import { SpawnedWebRtcRuntimeProvider } from "../../../src/browser-takeover/webrtc-runtime.ts";

const TEST_TEXTS = Array.from({ length: 20 }, (_, index) =>
  `HUMAN_INPUT_OK_${String(index + 1).padStart(2, "0")}`
);
const packageRoot = resolve("experiments/thin-takeover-runtime");
const helper = resolve(packageRoot, ".build/release/takeover-webrtc-host");
const fixture = resolve(packageRoot, ".build/release/takeover-macos-text-input-fixture");
const statePath = resolve(tmpdir(), `handoff-native-text-${process.pid}-${Date.now()}.json`);

type FixtureState = {
  pid: number;
  windowId: number;
  focused: boolean;
  text: string;
  tapX: number;
  tapY: number;
};

async function readState(): Promise<FixtureState | undefined> {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8")) as Partial<FixtureState>;
    if (
      Number.isInteger(value.pid) &&
      Number.isInteger(value.windowId) &&
      typeof value.focused === "boolean" &&
      typeof value.text === "string" &&
      typeof value.tapX === "number" &&
      Number.isFinite(value.tapX) &&
      value.tapX >= 0 &&
      value.tapX <= 1 &&
      typeof value.tapY === "number" &&
      Number.isFinite(value.tapY) &&
      value.tapY >= 0 &&
      value.tapY <= 1
    ) {
      return value as FixtureState;
    }
  } catch {
    // The fixture replaces the state file atomically; retry until the next complete snapshot.
  }
  return undefined;
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string,
  pollMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(pollMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    sleep(1_000).then(() => undefined)
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

await access(helper);
await access(fixture);

let fixtureProcess: ChildProcess | undefined;
let provider: SpawnedWebRtcRuntimeProvider | undefined;
let peer: RTCPeerConnection | undefined;
let sessionId: string | undefined;
let failure: unknown;

try {
  fixtureProcess = spawn(fixture, [statePath], { stdio: ["ignore", "ignore", "pipe"] });
  fixtureProcess.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  let initial: FixtureState | undefined;
  await waitFor(async () => {
    initial = await readState();
    return initial !== undefined;
  }, 5_000, "fixture state");
  assert(initial);
  assert.equal(initial.text, "AUTO_BASELINE\n");
  assert.equal(initial.focused, false, "fixture must require the Human tap to establish focus");

  provider = new SpawnedWebRtcRuntimeProvider({ hostExecutable: helper });
  peer = new RTCPeerConnection({ codecs: { video: [useH264()] }, iceServers: [], maxMessageSize: 4_096 });
  peer.addTransceiver("video", { direction: "recvonly" });
  const critical = peer.createDataChannel("human-critical", { ordered: true });
  peer.createDataChannel("human-realtime", { ordered: false, maxRetransmits: 0 });

  sessionId = `native-text-${process.pid}`;
  const binding = {
    takeoverSessionId: sessionId,
    interventionId: `native-text-intervention-${process.pid}`,
    epoch: 1,
    principalBinding: "native-text-acceptance",
    clientBinding: "native-text-client-1234567890123456",
    clientGeneration: 1,
    expiresAt: Date.now() + 45_000,
    targetProcessId: initial.pid,
    targetWindowId: initial.windowId
  };

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  const answer = await provider.start(
    binding,
    { type: "offer", sdp: peer.localDescription!.sdp },
    { beginInput: () => () => {}, disconnected: () => {} }
  );
  await peer.setRemoteDescription(answer);
  await waitFor(
    () => peer!.connectionState === "connected" && critical.readyState === "open",
    8_000,
    "WebRTC Human channel"
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    critical.send(JSON.stringify({ kind: "tap", x: initial.tapX, y: initial.tapY }));
    try {
      await waitFor(async () => (await readState())?.focused === true, 1_000, "native text focus");
      break;
    } catch {
      // Retry the same fixture-derived editable point; never broaden to an unverified window area.
    }
  }

  const focused = await readState();
  assert.equal(focused?.focused, true, "Human tap must make the NSTextView the first responder");
  let beforeText = focused.text;
  const commitLatencyMs: number[] = [];
  for (const testText of TEST_TEXTS) {
    const startedAt = performance.now();
    critical.send(JSON.stringify({ kind: "text", text: testText }));
    await waitFor(async () => {
      const state = await readState();
      return state?.text.includes(testText) === true;
    }, 4_000, `native text content change for ${testText}`, 10);
    commitLatencyMs.push(performance.now() - startedAt);

    const current = await readState();
    assert(current);
    assert.equal(current.pid, initial.pid);
    assert.equal(current.windowId, initial.windowId);
    assert.equal(current.focused, true);
    assert.notEqual(current.text, beforeText);
    assert(current.text.includes(testText));
    beforeText = current.text;
  }

  const after = await readState();
  assert(after);
  for (const testText of TEST_TEXTS) assert(after.text.includes(testText));
  const textRouteStages = provider.diagnosticsSnapshot().events
    .map((event) => event.stage)
    .filter((stage) => stage.startsWith("host.input.text."));
  assert.equal(textRouteStages.length, TEST_TEXTS.length);
  assert.equal(textRouteStages.every((stage) => stage === "host.input.text.native_ax"), true);
  console.log(
    "native_appkit_text_commit_observed_ms " +
      `p50=${percentile(commitLatencyMs, 0.50).toFixed(3)} ` +
      `p95=${percentile(commitLatencyMs, 0.95).toFixed(3)} ` +
      `p99=${percentile(commitLatencyMs, 0.99).toFixed(3)} samples=${commitLatencyMs.length}`
  );
  console.log(
    `macOS native-window text acceptance passed pid=${after.pid} window_id=${after.windowId} ` +
      `focus=true content_changed=true commits=${TEST_TEXTS.length}`
  );
} catch (error) {
  failure = error;
} finally {
  if (provider && sessionId) {
    await Promise.race([provider.revoke(sessionId).catch(() => undefined), sleep(1_000)]);
  }
  if (peer) await Promise.race([peer.close().catch(() => undefined), sleep(1_000)]);
  await stopChild(fixtureProcess);
  await rm(statePath, { force: true });
}

if (failure) {
  console.error(failure instanceof Error ? (failure.stack ?? failure.message) : String(failure));
  process.exit(1);
}
process.exit(0);
