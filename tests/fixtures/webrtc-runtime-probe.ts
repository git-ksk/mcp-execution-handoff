import { RTCPeerConnection, useH264 } from "werift";
import {
  SpawnedWebRtcRuntimeProvider,
  type WebRtcTakeoverRuntimeBinding
} from "../../src/browser-takeover/webrtc-runtime.js";

const HOST_SCRIPT = String.raw`
process.stdin.resume();
let timestamp = 0;
const timer = setInterval(() => {
  const avcc = Buffer.from([0, 0, 0, 1, 0x65]);
  const payload = Buffer.alloc(9 + avcc.length);
  payload.writeUInt32BE(timestamp >>> 0, 0);
  payload[4] = 1;
  payload.writeUInt16BE(640, 5);
  payload.writeUInt16BE(360, 7);
  avcc.copy(payload, 9);
  const record = Buffer.alloc(5 + payload.length);
  record[0] = 1;
  record.writeUInt32BE(payload.length, 1);
  payload.copy(record, 5);
  process.stdout.write(record);
  timestamp = (timestamp + 3000) >>> 0;
}, 75);
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
process.stdin.on('end', () => { clearInterval(timer); process.exit(0); });
`;

function binding(generation = 1): WebRtcTakeoverRuntimeBinding {
  return {
    takeoverSessionId: "runtime-session-1",
    interventionId: "runtime-intervention-1",
    epoch: 4,
    principalBinding: "principal-runtime",
    clientBinding: `runtime-client-${generation}-1234567890`,
    clientGeneration: generation,
    expiresAt: Date.now() + 60_000
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 7_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("probe timeout");
}

async function main(): Promise<void> {
  const provider = new SpawnedWebRtcRuntimeProvider({ hostExecutable: process.execPath, hostArgs: ["-e", HOST_SCRIPT] });
  const client = new RTCPeerConnection({ codecs: { video: [useH264()] }, iceServers: [], maxMessageSize: 4_096 });
  client.addTransceiver("video", { direction: "recvonly" });
  const critical = client.createDataChannel("human-critical", { ordered: true });
  client.createDataChannel("human-realtime", { ordered: false, maxRetransmits: 0 });
  let rtpPackets = 0;
  let inputUses = 0;
  let endedUses = 0;
  let disconnected = 0;
  client.onTrack.subscribe((track) => track.onReceiveRtp.subscribe(() => { rtpPackets += 1; }));

  try {
    const offer = await client.createOffer();
    await client.setLocalDescription(offer);
    if (!client.localDescription?.sdp) throw new Error("client offer missing SDP");
    const answer = await provider.start(binding(), { type: "offer", sdp: client.localDescription.sdp }, {
      beginInput() { inputUses += 1; return () => { endedUses += 1; }; },
      disconnected() { disconnected += 1; }
    });
    await client.setRemoteDescription(answer);
    await waitFor(() => client.connectionState === "connected" && critical.readyState === "open");
    await waitFor(() => rtpPackets > 0);
    critical.send(JSON.stringify({ kind: "tap", x: 0.25, y: 0.75 }));
    await waitFor(() => inputUses === 1 && endedUses === 1);
    critical.send(JSON.stringify({ kind: "tap", x: 2, y: 0.5 }));
    await new Promise((resolve) => setTimeout(resolve, 75));
    if (inputUses !== 1) throw new Error("invalid Human input reached authority gate");
    if (disconnected !== 0) throw new Error("unexpected disconnect during live probe");
  } finally {
    await client.close().catch(() => undefined);
    await provider.revoke("runtime-session-1").catch(() => undefined);
  }

  const reconnectProvider = new SpawnedWebRtcRuntimeProvider({ hostExecutable: process.execPath, hostArgs: ["-e", HOST_SCRIPT] });
  const peer = new RTCPeerConnection({ codecs: { video: [useH264()] }, iceServers: [] });
  peer.addTransceiver("video", { direction: "recvonly" });
  peer.createDataChannel("human-critical");
  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const description = { type: "offer" as const, sdp: peer.localDescription!.sdp };
    await reconnectProvider.start(binding(1), description, { beginInput: () => () => undefined, disconnected: () => undefined });
    let rejected = false;
    try {
      await reconnectProvider.reconnect(binding(1), description, { beginInput: () => () => undefined, disconnected: () => undefined });
    } catch (error) {
      rejected = error instanceof Error && /already active/i.test(error.message);
    }
    if (!rejected) throw new Error("same-generation reconnect was not rejected");
  } finally {
    await peer.close().catch(() => undefined);
    await reconnectProvider.revoke("runtime-session-1").catch(() => undefined);
  }

  process.stdout.write("PROBE_PASS\n");
}

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`PROBE_FAIL ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exit(1);
});
