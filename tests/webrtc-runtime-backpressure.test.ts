import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SpawnedWebRtcRuntimeProvider } from "../src/browser-takeover/webrtc-runtime.js";

function frame(timestamp: number, keyframe: boolean) {
  const nal = Buffer.from([keyframe ? 0x65 : 0x41]);
  const avcc = Buffer.alloc(4 + nal.length);
  avcc.writeUInt32BE(nal.length, 0);
  nal.copy(avcc, 4);
  return { rtpTimestamp: timestamp, keyframe, width: 640, height: 360, avcc };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("backpressure test timeout");
}

test("WebRTC host video applies awaited latest-frame backpressure instead of fire-and-forget RTP", async () => {
  const source = readFileSync("src/browser-takeover/webrtc-runtime.ts", "utf8");
  const hostSource = readFileSync("experiments/thin-takeover-runtime/Sources/takeover-webrtc-host/main.swift", "utf8");
  assert.match(source, /await sender\.sendRtp\(/);
  assert.doesNotMatch(source, /runtime\.track\.writeRtp\(/);
  assert.match(source, /preconnectKeyframe/);
  assert.match(source, /this\.enqueueConnectedFrame\(runtime, keyframe\)/);
  assert.match(source, /HostMetricParser/);
  assert.match(source, /lastRtpDrainMs/);
  assert.match(hostSource, /MCP_HANDOFF_METRIC encode_tenths=/);
  assert.match(hostSource, /MCP_HANDOFF_CONTROL editable_regions=/);
  assert.match(hostSource, /AXUIElementCopyElementAtPosition/);
  assert.match(hostSource, /AXWebArea/);
  assert.match(hostSource, /regions\.prefix\(32\)/);
  assert.doesNotMatch(hostSource, /editable_probe/);
  assert.doesNotMatch(hostSource, /AXUIElementIsAttributeSettable/);
  assert.match(hostSource, /standardError/);
  assert.match(hostSource, /Darwin\.read\(/);
  assert.match(source, /editable_regions=\(\.\*\)/);
  assert.doesNotMatch(hostSource, /read\(upToCount:\s*2_048\)/);
  assert.doesNotMatch(hostSource, /Data\(\[3\]\)/);
  assert.match(hostSource, /private func editableAfterTap\(\) -> Bool/);
  assert.match(hostSource, /for attempt in 0\.\.<5/);
  assert.match(hostSource, /usleep\(20_000\)/);

  const provider = new SpawnedWebRtcRuntimeProvider({ hostExecutable: process.execPath });
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const sent: number[] = [];
  let calls = 0;
  const sender = {
    async sendRtp(packet: { header: { timestamp: number } }) {
      sent.push(packet.header.timestamp);
      calls += 1;
      if (calls === 1) await firstBlocked;
    }
  };
  let idrRequests = 0;
  (provider as unknown as { requestIdr(runtime: unknown): void }).requestIdr = () => { idrRequests += 1; };
  const runtime = {
    binding: { takeoverSessionId: "bp-session" },
    peer: { connectionState: "connected" },
    sender,
    closing: false,
    nextSequence: 1,
    lastIdrRequestAt: 0,
    videoDrainActive: false,
    awaitingVideoKeyframe: false
  };
  const write = (provider as unknown as { writeFrame(runtime: unknown, frame: unknown): void }).writeFrame.bind(provider);

  const preconnectRuntime = {
    ...runtime,
    peer: { connectionState: "connecting" },
    pendingFrame: undefined,
    preconnectKeyframe: undefined
  };
  write(preconnectRuntime, frame(99, true));
  write(preconnectRuntime, frame(100, false));
  assert.equal((preconnectRuntime.preconnectKeyframe as { rtpTimestamp?: number } | undefined)?.rtpTimestamp, 99);

  write(runtime, frame(1, true));
  await waitFor(() => sent.length === 1);
  write(runtime, frame(2, false));
  write(runtime, frame(3, false)); // supersedes pending P-frame: must request IDR and drop dependent chain
  write(runtime, frame(4, false)); // ignored while waiting for resync
  write(runtime, frame(5, true));  // newest independent restart point
  releaseFirst();
  await waitFor(() => sent.length === 2);

  assert.deepEqual(sent, [1, 5]);
  assert.equal(idrRequests, 1);
  assert.equal(runtime.awaitingVideoKeyframe, false);
  assert.equal(runtime.videoDrainActive, false);
});
