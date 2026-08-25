import assert from "node:assert/strict";
import test from "node:test";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import {
  TerminalHandoffAdapter,
  TerminalHandoffAdapterError,
  type TerminalHandoffInterventionRef,
} from "../src/terminal-takeover/terminal-handoff-adapter.js";

const ORIGIN = "https://handoff.example.test";
const PRINCIPAL = "a".repeat(64);
const CLIENT = "b".repeat(32);
const BINDING = {
  sessionId: "pty-session-component",
  sessionGeneration: 9,
  principalBinding: PRINCIPAL,
} as const;

async function waitFor(predicate: () => boolean, timeoutMs = 7_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("TerminalHandoffAdapter test timeout");
}

function fixture() {
  return new TerminalHandoffAdapter({
    binding: BINDING,
    takeover: { enabled: true, publicBaseUrl: `${ORIGIN}/`, ttlMs: 60_000, env: {} },
  });
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  headers.set("x-terminal-client", CLIENT);
  return new Request(new URL(path, `${ORIGIN}/`), { ...init, headers });
}

async function connect(
  adapter: TerminalHandoffAdapter,
  locator: string,
  awaiting: TerminalHandoffInterventionRef,
): Promise<{ client: RTCPeerConnection; channel: RTCDataChannel; messages: unknown[] }> {
  const id = new URL(locator).pathname.split("/").at(-1)!;
  const prep = await adapter.handle(request(`/takeover/terminal/api/prepare/${id}`, { method: "POST" }), PRINCIPAL);
  assert.equal(prep.status, 200);
  const prepared = await prep.json() as {
    capability: string;
    webrtcIce: { iceServers: RTCIceServer[] };
  };
  const client = new RTCPeerConnection({ iceServers: prepared.webrtcIce.iceServers, maxMessageSize: 8 * 1024 });
  const channel = client.createDataChannel("terminal-control", { ordered: true });
  const messages: unknown[] = [];
  channel.onMessage.subscribe((message) => {
    try { messages.push(JSON.parse(String(message))); } catch {}
  });
  const offer = await client.createOffer();
  await client.setLocalDescription(offer);
  assert.ok(client.localDescription?.sdp);
  const connected = await adapter.handle(request(`/takeover/terminal/api/connect/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-terminal-capability": prepared.capability },
    body: JSON.stringify({ type: "offer", sdp: client.localDescription.sdp }),
  }), PRINCIPAL);
  assert.equal(connected.status, 200);
  const answer = await connected.json() as { webrtc: { type: "answer"; sdp: string } };
  await client.setRemoteDescription(answer.webrtc);
  await waitFor(() => channel.readyState === "open" && adapter.transportStatus(awaiting).transportReady);
  return { client, channel, messages };
}

test("first-class Terminal Handoff composes authority and ordered WebRTC transport without restoring Agent early", async () => {
  const adapter = fixture();
  adapter.assertAgentInput();
  adapter.assertAgentObservation();

  const { intervention: awaiting, locator } = adapter.begin();
  assert.equal(awaiting.status, "awaiting_human");
  assert.equal(new URL(locator).origin, ORIGIN);
  const wrongPrincipal = await adapter.handle(new Request(locator), "c".repeat(64));
  assert.equal(wrongPrincipal.status, 404);
  assert.throws(() => adapter.assertAgentInput());
  assert.throws(
    () => adapter.claimHumanAfterAgentDrain(awaiting),
    (error: unknown) => error instanceof TerminalHandoffAdapterError
      && error.code === "TERMINAL_HANDOFF_TRANSPORT_NOT_READY",
  );

  const { client, channel, messages } = await connect(adapter, locator, awaiting);
  try {
    // The consumer acknowledges its already-fenced Agent writer drain only after it physically completes.
    const human = adapter.claimHumanAfterAgentDrain(awaiting);
    assert.equal(human.status, "human_active");
    assert.equal(adapter.status().authority, "human");
    await assert.rejects(() => adapter.cancelBeforeHuman(human));
    adapter.assertHumanInput(human);
    adapter.assertHumanObservation(human);
    adapter.assertHumanResize(human);
    assert.throws(() => adapter.assertAgentInput());
    assert.throws(() => adapter.assertAgentObservation());
    assert.throws(() => adapter.assertAgentResize());
    await waitFor(() => messages.some((value) => (value as { state?: string }).state === "human_active"));

    adapter.pushHumanOutput(human, Buffer.from("ready\n"));
    await waitFor(() => messages.some((value) => (value as { kind?: string }).kind === "output"));

    const line = Buffer.from("echo safe\n");
    channel.send(JSON.stringify({ kind: "input", dataBase64: line.toString("base64") }));
    channel.send(JSON.stringify({ kind: "resize", rows: 30, cols: 100 }));
    channel.send(JSON.stringify({ kind: "done" }));
    await waitFor(() => adapter.transportStatus(human).completed);

    const input = adapter.nextHumanEvent(human);
    assert.equal(input?.kind, "input");
    if (input?.kind === "input") assert.deepEqual(Buffer.from(input.data), line);
    assert.deepEqual(adapter.nextHumanEvent(human), { kind: "resize", rows: 30, cols: 100 });
    const done = adapter.nextHumanEvent(human);
    assert.equal(done?.kind, "done");
    if (!done || done.kind !== "done") throw new Error("Done event missing");
    assert.equal(done.verifying.status, "verifying");
    assert.equal(adapter.status().authority, "none");
    assert.throws(() => adapter.assertHumanInput(human));
    assert.throws(() => adapter.assertHumanObservation(human));
    assert.throws(() => adapter.assertHumanResize(human));
    assert.throws(() => adapter.assertAgentObservation());
    assert.throws(() => adapter.reportVerification(done.verifying, true));

    const drained = adapter.confirmHumanDrain(done.verifying);
    const ready = adapter.reportVerification(drained, true);
    assert.equal(ready.status, "ready_to_resume");
    assert.equal(adapter.status().authority, "none");
    const resume = adapter.resume(ready);
    assert.equal(resume.resumePolicy, "never_replay");
    assert.equal(resume.sessionAlive, true);
    assert.equal(resume.agentStateSynchronizationRequired, true);
    assert.throws(() => adapter.assertAgentInput());
    assert.throws(() => adapter.assertAgentObservation());
    assert.throws(() => adapter.assertAgentResize());

    // Consumer must first discard/re-read Human-period state/output before acknowledging this boundary.
    adapter.acknowledgeAgentStateSynchronization();
    adapter.assertAgentInput();
    adapter.assertAgentObservation();
    adapter.assertAgentResize();
    assert.equal(adapter.status().transport, null);

    // The same live PTY/session may start a later intervention only after the prior state sync boundary.
    const second = adapter.begin();
    assert.equal(second.intervention.status, "awaiting_human");
    const cancelled = await adapter.cancelBeforeHuman(second.intervention);
    assert.equal(cancelled.authority, "agent");
    assert.equal(cancelled.interventionStatus, null);
    assert.equal(cancelled.transport, null);
  } finally {
    await client.close().catch(() => undefined);
    await adapter.revokeTransport();
  }
});

test("Terminal Handoff status is privacy-bounded and exact PTY exit never synthesizes replacement authority", async () => {
  const adapter = fixture();
  const { intervention, locator } = adapter.begin();
  const encoded = JSON.stringify(adapter.status());
  assert.doesNotMatch(encoded, /pty-session-component|aaaaaaaaaaaaaaaa|takeover\/terminal|credential|token|secret/i);
  assert.equal(adapter.isPath(new URL(locator).pathname), true);
  assert.equal(adapter.transportStatus(intervention).humanActive, false);

  const exited = await adapter.noteSessionExit();
  assert.equal(exited.sessionAlive, false);
  assert.equal(exited.authority, "none");
  assert.equal(exited.interventionStatus, null);
  assert.equal(exited.transport, null);
  assert.throws(() => adapter.assertAgentInput());
});


test("Terminal Handoff rolls back only a setup failure that occurred before Human claim", () => {
  const adapter = new TerminalHandoffAdapter({
    binding: BINDING,
    takeover: { enabled: false, publicBaseUrl: `${ORIGIN}/`, ttlMs: 60_000, env: {} },
  });
  assert.throws(
    () => adapter.begin(),
    (error: unknown) => error instanceof TerminalHandoffAdapterError
      && error.code === "TERMINAL_HANDOFF_TRANSPORT_UNAVAILABLE",
  );
  assert.equal(adapter.status().authority, "agent");
  assert.equal(adapter.status().interventionStatus, null);
  adapter.assertAgentInput();
});

test("Terminal Handoff validates the transport principal binding before any Agent fence", () => {
  assert.throws(
    () => new TerminalHandoffAdapter({
      binding: { ...BINDING, principalBinding: "not-a-transport-binding" },
      takeover: { enabled: true, publicBaseUrl: `${ORIGIN}/`, ttlMs: 60_000, env: {} },
    }),
    (error: unknown) => error instanceof TerminalHandoffAdapterError
      && error.code === "TERMINAL_HANDOFF_BINDING_INVALID",
  );
});
