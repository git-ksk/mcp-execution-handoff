import assert from "node:assert/strict";
import test from "node:test";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { ExperimentalTerminalWebRtcTakeover } from "../src/experimental/terminal-webrtc.js";

const ORIGIN = "https://handoff.example.test";
const PRINCIPAL = "a".repeat(64);
const CLIENT = "b".repeat(32);

async function waitFor(predicate: () => boolean, timeoutMs = 7_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("terminal WebRTC test timeout");
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  headers.set("x-terminal-client", CLIENT);
  return new Request(new URL(path, `${ORIGIN}/`), { ...init, headers });
}

async function connect(
  takeover: ExperimentalTerminalWebRtcTakeover,
  locator: string,
  clientBinding = CLIENT
): Promise<{ client: RTCPeerConnection; channel: RTCDataChannel; messages: unknown[] }> {
  const id = new URL(locator).pathname.split("/").at(-1)!;
  const prepRequest = request(`/takeover/terminal/api/prepare/${id}`, {
    method: "POST",
    headers: { "x-terminal-client": clientBinding }
  });
  const prepResponse = await takeover.handle(prepRequest);
  assert.equal(prepResponse.status, 200);
  const prep = await prepResponse.json() as {
    capability: string;
    clientGeneration: number;
    webrtcIce: { iceServers: RTCIceServer[] };
  };
  assert.equal(prep.clientGeneration, 1);

  const client = new RTCPeerConnection({ iceServers: prep.webrtcIce.iceServers, maxMessageSize: 8 * 1024 });
  const channel = client.createDataChannel("terminal-control", { ordered: true });
  const messages: unknown[] = [];
  channel.onMessage.subscribe((message) => {
    try { messages.push(JSON.parse(String(message))); } catch {}
  });
  const offer = await client.createOffer();
  await client.setLocalDescription(offer);
  assert.ok(client.localDescription?.sdp);
  const connectResponse = await takeover.handle(request(`/takeover/terminal/api/connect/${id}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-terminal-client": clientBinding,
      "x-terminal-capability": prep.capability
    },
    body: JSON.stringify({ type: "offer", sdp: client.localDescription.sdp })
  }));
  assert.equal(connectResponse.status, 200);
  const answer = await connectResponse.json() as { webrtc: { type: "answer"; sdp: string } };
  await client.setRemoteDescription(answer.webrtc);
  await waitFor(() => channel.readyState === "open" && takeover.status("terminal-intervention", 1).transportReady);
  return { client, channel, messages };
}

test("Terminal WebRTC keeps input fenced until Human activation and orders Done after input", async () => {
  const takeover = new ExperimentalTerminalWebRtcTakeover({ enabled: true, publicBaseUrl: `${ORIGIN}/`, ttlMs: 60_000, env: {} });
  const locator = takeover.start("terminal-intervention", 1, PRINCIPAL);
  const { client, channel, messages } = await connect(takeover, locator);
  try {
    const line = Buffer.from("echo safe\n").toString("base64");
    channel.send(JSON.stringify({ kind: "input", dataBase64: line }));
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepEqual(takeover.drainEvents("terminal-intervention", 1), []);

    takeover.activateHuman("terminal-intervention", 1);
    await waitFor(() => messages.some((message) => (message as { state?: string }).state === "human_active"));
    takeover.pushOutput("terminal-intervention", 1, Buffer.from("ready\n").toString("base64"));
    await waitFor(() => messages.some((message) => (message as { kind?: string }).kind === "output"));

    channel.send(JSON.stringify({ kind: "input", dataBase64: line }));
    channel.send(JSON.stringify({ kind: "resize", rows: 30, cols: 100 }));
    channel.send(JSON.stringify({ kind: "done" }));
    await waitFor(() => takeover.status("terminal-intervention", 1).completed);
    assert.deepEqual(takeover.drainEvents("terminal-intervention", 1), [
      { kind: "input", dataBase64: line },
      { kind: "resize", rows: 30, cols: 100 },
      { kind: "done" }
    ]);
    assert.equal(takeover.status("terminal-intervention", 1).humanActive, false);
    assert.throws(
      () => takeover.pushOutput("terminal-intervention", 1, Buffer.from("late\n").toString("base64")),
      /unavailable/
    );
  } finally {
    await client.close().catch(() => undefined);
    await takeover.revoke("terminal-intervention", 1).catch(() => undefined);
  }
});

test("Terminal WebRTC disconnect callback fences transport input without implying Done", async () => {
  const takeover = new ExperimentalTerminalWebRtcTakeover({ enabled: true, publicBaseUrl: `${ORIGIN}/`, ttlMs: 60_000, env: {} });
  const locator = takeover.start("terminal-intervention", 1, PRINCIPAL);
  const { client } = await connect(takeover, locator);
  try {
    takeover.activateHuman("terminal-intervention", 1);
    const generation = takeover.status("terminal-intervention", 1).clientGeneration;
    assert.equal(generation, 1);

    takeover.noteTransportDisconnect("terminal-intervention", 1, generation! + 1);
    assert.equal(takeover.status("terminal-intervention", 1).humanActive, true);

    takeover.noteTransportDisconnect("terminal-intervention", 1, generation!);
    const status = takeover.status("terminal-intervention", 1);
    assert.equal(status.disconnected, true);
    assert.equal(status.completed, false);
    assert.equal(status.humanActive, false);
  } finally {
    await client.close().catch(() => undefined);
    await takeover.revoke("terminal-intervention", 1).catch(() => undefined);
  }
});
