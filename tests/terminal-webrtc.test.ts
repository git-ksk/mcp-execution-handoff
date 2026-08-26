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


class FakeTerminalElement {
  textContent = "";
  value = "";
  disabled = true;
  scrollTop = 0;
  scrollHeight = 0;
  onclick: (() => void) | undefined;
  readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();

  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
    const items = this.listeners.get(type) ?? [];
    items.push(listener);
    this.listeners.set(type, items);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const value = { preventDefault() {}, ...event };
    for (const listener of this.listeners.get(type) ?? []) listener(value);
  }
}

class FakeTerminalChannel {
  readyState = "connecting";
  onopen: (() => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
  onclose: (() => void) | undefined;
  readonly sent: string[] = [];

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  message(value: object): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  send(value: string): void {
    if (this.readyState !== "open") throw new Error("channel closed");
    this.sent.push(value);
  }

  close(): void {
    this.readyState = "closed";
    this.onclose?.();
  }
}

class FakeTerminalPeer {
  static latest: FakeTerminalPeer | undefined;
  readonly channel = new FakeTerminalChannel();
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription: { type: "offer"; sdp: string } | undefined;
  onconnectionstatechange: (() => void) | undefined;

  constructor(_config: unknown) { FakeTerminalPeer.latest = this; }
  createDataChannel(): FakeTerminalChannel { return this.channel; }
  async createOffer(): Promise<{ type: "offer"; sdp: string }> { return { type: "offer", sdp: "v=0\\r\\n" }; }
  async setLocalDescription(offer: { type: "offer"; sdp: string }): Promise<void> { this.localDescription = offer; }
  async setRemoteDescription(_answer: unknown): Promise<void> {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.connectionState = "closed"; this.onconnectionstatechange?.(); }
  fail(): void { this.connectionState = "failed"; this.onconnectionstatechange?.(); }
}

type TerminalPageHarness = {
  status: FakeTerminalElement;
  field: FakeTerminalElement;
  send: FakeTerminalElement;
  done: FakeTerminalElement;
  peer: FakeTerminalPeer;
};

async function terminalPageHarness(takeover: ExperimentalTerminalWebRtcTakeover, locator: string): Promise<TerminalPageHarness> {
  const page = await takeover.handle(new Request(locator));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="status" role="status" aria-live="polite">Connecting…<\/div>/);
  const script = /<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));

  const elements = new Map<string, FakeTerminalElement>();
  for (const selector of ["#status", "#terminal", "#line", "#send", "#done"]) {
    elements.set(selector, new FakeTerminalElement());
  }
  const status = elements.get("#status")!;
  status.textContent = "Connecting…";
  const field = elements.get("#line")!;
  const send = elements.get("#send")!;
  const done = elements.get("#done")!;
  const documentStub = { querySelector(selector: string) { return elements.get(selector); } };
  const fetchStub = async (url: string): Promise<{ ok: boolean; json(): Promise<unknown> }> => {
    if (url.includes("/prepare/")) {
      return { ok: true, async json() { return { capability: "c".repeat(32), webrtcIce: { iceServers: [] } }; } };
    }
    if (url.includes("/connect/")) {
      return { ok: true, async json() { return { webrtc: { type: "answer", sdp: "v=0\\r\\n" } }; } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  FakeTerminalPeer.latest = undefined;
  const run = new Function(
    "location", "document", "crypto", "btoa", "atob", "fetch", "RTCPeerConnection",
    "TextDecoder", "TextEncoder", "setTimeout", script
  );
  run(
    { pathname: new URL(locator).pathname },
    documentStub,
    { getRandomValues(bytes: Uint8Array) { bytes.fill(4); return bytes; } },
    (value: string) => Buffer.from(value, "binary").toString("base64"),
    (value: string) => Buffer.from(value, "base64").toString("binary"),
    fetchStub,
    FakeTerminalPeer,
    TextDecoder,
    TextEncoder,
    (callback: () => void) => { callback(); return 1; },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const peer = FakeTerminalPeer.latest;
  assert.ok(peer);
  return { status, field, send, done, peer };
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


test("Terminal mobile UI distinguishes transport readiness, Human authority and verifying without stale labels", async () => {
  const takeover = new ExperimentalTerminalWebRtcTakeover({ enabled: true, publicBaseUrl: `${ORIGIN}/`, ttlMs: 60_000, env: {} });
  const locator = takeover.start("terminal-intervention", 1, PRINCIPAL);
  const ui = await terminalPageHarness(takeover, locator);

  assert.equal(ui.status.textContent, "Connecting…");
  assert.equal(ui.field.disabled, true);
  assert.equal(ui.send.disabled, true);
  assert.equal(ui.done.disabled, true);

  ui.peer.channel.open();
  assert.equal(ui.status.textContent, "Connected · waiting for Human authority");
  assert.equal(ui.field.disabled, true);
  assert.equal(ui.done.disabled, true);

  ui.peer.channel.message({ kind: "state", state: "connected" });
  assert.equal(ui.status.textContent, "Connected · waiting for Human authority");
  ui.peer.channel.message({ kind: "state", state: "human_active" });
  assert.equal(ui.status.textContent, "Human authority active");
  assert.equal(ui.field.disabled, false);
  assert.equal(ui.send.disabled, false);
  assert.equal(ui.done.disabled, false);

  ui.done.onclick?.();
  assert.equal(ui.status.textContent, "Done · verifying");
  assert.equal(ui.field.disabled, true);
  assert.equal(ui.send.disabled, true);
  assert.equal(ui.done.disabled, true);
  assert.deepEqual(ui.peer.channel.sent.map((value) => JSON.parse(value)), [{ kind: "done" }]);

  ui.peer.channel.message({ kind: "state", state: "fenced" });
  ui.peer.channel.close();
  ui.peer.fail();
  assert.equal(ui.status.textContent, "Done · verifying", "post-Done transport events must not overwrite verifying");
});

test("Terminal mobile UI reports disconnect as unavailable and never implies Done or Agent resume", async () => {
  const takeover = new ExperimentalTerminalWebRtcTakeover({ enabled: true, publicBaseUrl: `${ORIGIN}/`, ttlMs: 60_000, env: {} });
  const locator = takeover.start("terminal-intervention", 1, PRINCIPAL);
  const ui = await terminalPageHarness(takeover, locator);
  ui.peer.channel.open();
  ui.peer.channel.message({ kind: "state", state: "human_active" });
  ui.peer.fail();
  assert.equal(ui.status.textContent, "Connection unavailable");
  assert.equal(ui.field.disabled, true);
  assert.equal(ui.send.disabled, true);
  assert.equal(ui.done.disabled, true);
  assert.doesNotMatch(ui.status.textContent, /Done|resume/i);
});

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
