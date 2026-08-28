import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import { TakeoverSessionManager } from "../src/browser-takeover/session.js";
import {
  ExperimentalWebSocketTakeoverIngress,
  ExperimentalWebSocketTakeoverSessionAuthority
} from "../src/experimental/websocket-ingress.js";

const PRINCIPAL = "principal-binding";
const ORIGIN = "https://handoff.example";
const POLICY = Object.freeze({ tap: true, scroll: true, text: false, key: false });

function makeSession(now: () => number = Date.now) {
  let id = 0;
  const sessions = new TakeoverSessionManager(
    60_000,
    now,
    () => `session-${++id}-abcdefgh`,
    Buffer.alloc(32, 7),
    250,
    60_000
  );
  const locator = sessions.ensure("intervention", 4, PRINCIPAL);
  let ticketId = 0;
  let clientId = 0;
  const authority = new ExperimentalWebSocketTakeoverSessionAuthority(
    sessions,
    now,
    () => Buffer.alloc(32, ++ticketId).toString("base64url"),
    () => Buffer.alloc(24, ++clientId).toString("base64url")
  );
  return { sessions, locator, authority };
}

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function onceClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

async function openAndFirstMessage(socket: WebSocket): Promise<{ data: WebSocket.RawData; isBinary: boolean }> {
  const message = nextMessage(socket);
  await onceOpen(socket);
  return message;
}

function nextMessage(socket: WebSocket): Promise<{ data: WebSocket.RawData; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => resolve({ data, isBinary }));
    socket.once("error", reject);
  });
}

async function startIngress(
  ticket: string,
  authority: ExperimentalWebSocketTakeoverSessionAuthority,
  failInput = false
) {
  const inputs: Array<{ generation: number; input: object }> = [];
  const ingress = new ExperimentalWebSocketTakeoverIngress({
    authority,
    allowedOrigins: [ORIGIN],
    onInput(binding, input) {
      inputs.push({ generation: binding.clientGeneration, input });
      if (failInput) throw new Error("input failed");
    }
  });
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    if (!ingress.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}/takeover/ws/session-1-abcdefgh`;
  const connect = (origin = ORIGIN, auth = ticket) => new WebSocket(
    url,
    ["mcp-handoff.websocket.v1", `mcp-handoff-auth.${auth}`],
    { origin }
  );
  return { ingress, server, inputs, connect };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("HTTPS bootstrap derives WSS auth only from trusted principal and exact Origin", async () => {
  const { locator, authority } = makeSession();
  const ingress = new ExperimentalWebSocketTakeoverIngress({
    authority,
    allowedOrigins: [ORIGIN],
    onInput() {}
  });
  const url = `https://handoff.example/takeover/api/websocket-bootstrap/${locator.id}`;
  const response = ingress.handleBootstrap(
    new Request(url, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        principalBinding: "attacker",
        clientGeneration: 999,
        origin: "https://evil.example"
      })
    }),
    PRINCIPAL,
    POLICY
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  const body = await response.json() as { protocols: string[] };
  assert.equal(body.protocols[0], "mcp-handoff.websocket.v1");
  assert.match(body.protocols[1]!, /^mcp-handoff-auth\.[A-Za-z0-9_-]{32,128}$/);
  assert.equal(JSON.stringify(body).includes(PRINCIPAL), false);
  assert.equal(JSON.stringify(body).includes(locator.id), false);

  const wrongPrincipal = ingress.handleBootstrap(
    new Request(url, { method: "POST", headers: { origin: ORIGIN } }),
    "different-principal",
    POLICY
  );
  assert.ok(wrongPrincipal);
  assert.equal(wrongPrincipal.status, 404);

  const wrongOrigin = ingress.handleBootstrap(
    new Request(url, { method: "POST", headers: { origin: "https://evil.example" } }),
    PRINCIPAL,
    POLICY
  );
  assert.ok(wrongOrigin);
  assert.equal(wrongOrigin.status, 403);
});

test("WSS ingress authenticates a Handoff ticket before exposing trusted binding", async () => {
  const { locator, authority } = makeSession();
  const ticket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  const { server, inputs, connect } = await startIngress(ticket, authority);
  try {
    const socket = connect();
    const ready = await openAndFirstMessage(socket);
    assert.equal(ready.isBinary, false);
    assert.deepEqual(JSON.parse(ready.data.toString()), { kind: "ready" });
    socket.send(JSON.stringify({ kind: "tap", x: 0.25, y: 0.75 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(inputs, [{
      generation: 1,
      input: { kind: "tap", x: 0.25, y: 0.75 }
    }]);
    socket.close();
    await onceClose(socket);
  } finally {
    await closeServer(server);
  }
});

test("WSS ingress rejects missing or disallowed Origin before claim", async () => {
  const { locator, authority, sessions } = makeSession();
  const ticket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  const { server, connect } = await startIngress(ticket, authority);
  try {
    const rejected = connect("https://evil.example");
    const [error] = await new Promise<[Error]>((resolve) => rejected.once("error", (value) => resolve([value])));
    assert.match(error.message, /403/);

    const missingOrigin = new WebSocket(
      `ws://127.0.0.1:${(server.address() as { port: number }).port}/takeover/ws/${locator.id}`,
      ["mcp-handoff.websocket.v1", `mcp-handoff-auth.${ticket}`]
    );
    const [missingOriginError] = await new Promise<[Error]>((resolve) =>
      missingOrigin.once("error", (value) => resolve([value]))
    );
    assert.match(missingOriginError.message, /403/);

    const client = Buffer.alloc(24, 9).toString("base64url");
    const grant = sessions.claimClient(locator.id, PRINCIPAL, client);
    assert.equal(grant.clientGeneration, 1);
  } finally {
    await closeServer(server);
  }
});

test("fresh HTTPS bootstrap cannot widen a session-bound input policy", () => {
  const { locator, authority } = makeSession();
  authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  assert.throws(
    () => authority.issueHandshakeTicket(
      locator.id,
      PRINCIPAL,
      { tap: true, scroll: true, text: true, key: false }
    ),
    (error) => error instanceof Error && /unavailable/.test(error.message)
  );
});

test("WSS ingress rejects invalid tickets without consuming client authority", async () => {
  const { locator, authority, sessions } = makeSession();
  const ticket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  const { server, connect } = await startIngress(ticket, authority);
  try {
    const rejected = connect(ORIGIN, Buffer.alloc(32, 99).toString("base64url"));
    const [error] = await new Promise<[Error]>((resolve) => rejected.once("error", (value) => resolve([value])));
    assert.match(error.message, /404/);

    const client = Buffer.alloc(24, 8).toString("base64url");
    const grant = sessions.claimClient(locator.id, PRINCIPAL, client);
    assert.equal(grant.clientGeneration, 1);
  } finally {
    await closeServer(server);
  }
});

test("WSS clean disconnect reconnects with a fresh server-derived generation", async () => {
  const { locator, authority } = makeSession();
  const ticket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  const { ingress, server, inputs, connect } = await startIngress(ticket, authority);
  try {
    const first = connect();
    await openAndFirstMessage(first);
    first.close();
    await onceClose(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(ingress.diagnosticsSnapshot(), {
      disconnectKind: "peer_close",
      channelState: "closed",
      sentFrames: 0,
      droppedFrames: 0,
      lastFailure: "none",
      lastInputStage: "none",
      failureDisconnectKind: "none",
      failureChannelState: "none",
      failureCode: "none",
      failureInputStage: "none"
    });

    const second = connect();
    await openAndFirstMessage(second);
    second.send(JSON.stringify({ kind: "scroll", deltaY: 120 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(inputs, [{
      generation: 2,
      input: { kind: "scroll", deltaY: 120 }
    }]);
    second.close();
    await onceClose(second);
  } finally {
    await closeServer(server);
  }
});

test("WSS diagnostics keep the first input failure across close and fresh reconnect", async () => {
  const { locator, authority } = makeSession();
  const firstTicket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  const { ingress, server, connect } = await startIngress(firstTicket, authority, true);
  try {
    const first = connect();
    await openAndFirstMessage(first);
    first.send(JSON.stringify({ kind: "tap", x: 0.5, y: 0.5 }));
    await onceClose(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(ingress.diagnosticsSnapshot().failureDisconnectKind, "channel_failure");
    assert.equal(ingress.diagnosticsSnapshot().failureChannelState, "failed");
    assert.equal(ingress.diagnosticsSnapshot().failureCode, "transport_failure");
    assert.equal(ingress.diagnosticsSnapshot().failureInputStage, "dispatch_started");

    const secondTicket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
    const second = connect(ORIGIN, secondTicket);
    await openAndFirstMessage(second);
    second.close();
    await onceClose(second);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const diagnostics = ingress.diagnosticsSnapshot();
    assert.equal(diagnostics.disconnectKind, "peer_close");
    assert.equal(diagnostics.failureDisconnectKind, "channel_failure");
    assert.equal(diagnostics.failureChannelState, "failed");
    assert.equal(diagnostics.failureCode, "transport_failure");
    assert.equal(diagnostics.failureInputStage, "dispatch_started");
  } finally {
    await closeServer(server);
  }
});

test("fresh HTTPS ticket after disconnect preserves reconnect state and rotates generation", () => {
  const { locator, authority } = makeSession();
  const firstTicket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  const first = authority.accept(locator.id, firstTicket);
  assert.equal(first.binding.clientGeneration, 1);
  first.lease.release(first.binding);

  const secondTicket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  assert.notEqual(secondTicket, firstTicket);
  assert.throws(
    () => authority.accept(locator.id, firstTicket),
    (error) => error instanceof Error && /unavailable/.test(error.message)
  );
  const second = authority.accept(locator.id, secondTicket);
  assert.equal(second.binding.clientGeneration, 2);
  second.lease.release(second.binding);
});

test("WSS concurrent claimant is fenced while the first generation is active", async () => {
  const { locator, authority } = makeSession();
  const ticket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  const { server, connect } = await startIngress(ticket, authority);
  try {
    const first = connect();
    await openAndFirstMessage(first);

    const second = connect();
    const [error] = await new Promise<[Error]>((resolve) => second.once("error", (value) => resolve([value])));
    assert.match(error.message, /409/);

    first.close();
    await onceClose(first);
  } finally {
    await closeServer(server);
  }
});

test("WSS protocol identity injection fails closed and invalidates reconnect ticket", async () => {
  const { locator, authority } = makeSession();
  const ticket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  const { ingress, server, connect, inputs } = await startIngress(ticket, authority);
  try {
    const first = connect();
    await openAndFirstMessage(first);
    first.send(JSON.stringify({
      kind: "tap",
      x: 0.5,
      y: 0.5,
      principalBinding: "attacker"
    }));
    await onceClose(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(inputs, []);
    const diagnostics = ingress.diagnosticsSnapshot();
    assert.equal(diagnostics.disconnectKind, "channel_failure");
    assert.equal(diagnostics.channelState, "closed");
    assert.equal(diagnostics.lastFailure, "invalid_message");

    const second = connect();
    const [error] = await new Promise<[Error]>((resolve) => second.once("error", (value) => resolve([value])));
    assert.match(error.message, /404/);
  } finally {
    await closeServer(server);
  }
});

test("WSS ingress carries bounded binary frame envelopes without identifiers", async () => {
  const { locator, authority } = makeSession();
  const ticket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  const { ingress, server, connect } = await startIngress(ticket, authority);
  try {
    const socket = connect();
    await openAndFirstMessage(socket);
    const pending = nextMessage(socket);
    const pushed = await ingress.pushFrame(locator.id, {
      data: Uint8Array.from([1, 2, 3]),
      width: 640,
      height: 480,
      mimeType: "image/jpeg"
    });
    assert.equal(pushed, true);
    const message = await pending;
    assert.equal(message.isBinary, true);
    const bytes = Buffer.from(message.data as Buffer);
    assert.equal(bytes.readUInt32BE(0), 0x484f4631);
    assert.equal(bytes.readUInt8(4), 1);
    assert.equal(bytes.readUInt16BE(6), 640);
    assert.equal(bytes.readUInt16BE(8), 480);
    assert.equal(bytes.readUInt32BE(10), 3);
    assert.deepEqual([...bytes.subarray(16)], [1, 2, 3]);
    assert.equal(bytes.includes(Buffer.from(PRINCIPAL)), false);
    assert.equal(bytes.includes(Buffer.from(locator.id)), false);
    socket.close();
    await onceClose(socket);
  } finally {
    await closeServer(server);
  }
});


test("WSS Done completes only the current server-derived generation", () => {
  const { locator, authority, sessions } = makeSession();
  const ticket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  const first = authority.accept(locator.id, ticket);
  first.lease.release(first.binding);
  const second = authority.accept(locator.id, ticket);

  assert.throws(
    () => first.lease.complete(first.binding),
    (error) => error instanceof Error && /stale/.test(error.message)
  );
  second.lease.complete(second.binding);
  assert.throws(
    () => sessions.validateLocator(locator.id, PRINCIPAL),
    (error) => error instanceof Error && /not active/.test(error.message)
  );
});

test("WSS explicit revoke fences the session before a later reconnect", async () => {
  const { locator, authority } = makeSession();
  const ticket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  const { ingress, server, connect } = await startIngress(ticket, authority);
  try {
    const socket = connect();
    await openAndFirstMessage(socket);
    const closed = onceClose(socket);
    await ingress.revoke(locator.id);
    await closed;

    const retry = connect();
    const [error] = await new Promise<[Error]>((resolve) => retry.once("error", (value) => resolve([value])));
    assert.match(error.message, /404/);
  } finally {
    await closeServer(server);
  }
});

test("WSS ingress requires exact HTTPS origins and bounded parser configuration", () => {
  const { authority } = makeSession();
  assert.throws(
    () => new ExperimentalWebSocketTakeoverIngress({
      authority,
      allowedOrigins: ["*"],
      onInput() {}
    }),
    /exact HTTPS origins/
  );
  assert.throws(
    () => new ExperimentalWebSocketTakeoverIngress({
      authority,
      allowedOrigins: ["http://handoff.example"],
      onInput() {}
    }),
    /exact HTTPS origins/
  );
  assert.throws(
    () => new ExperimentalWebSocketTakeoverIngress({
      authority,
      allowedOrigins: [ORIGIN],
      maxInboundBytes: 64 * 1024 + 1,
      onInput() {}
    }),
    /maxInboundBytes/
  );
});
