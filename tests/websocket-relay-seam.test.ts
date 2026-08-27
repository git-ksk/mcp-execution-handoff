import assert from "node:assert/strict";
import test from "node:test";
import {
  WebSocketBrokerBinding,
  WebSocketTakeoverChannel,
  WebSocketTakeoverIngress,
  WebSocketTakeoverSessionAuthority
} from "../src/browser-takeover/websocket-relay.js";
import { ExperimentalWebSocketBrokerBinding } from "../src/experimental/websocket-broker-binding.js";
import { ExperimentalWebSocketTakeoverChannel } from "../src/experimental/websocket-takeover.js";
import {
  ExperimentalWebSocketTakeoverIngress,
  ExperimentalWebSocketTakeoverSessionAuthority
} from "../src/experimental/websocket-ingress.js";

test("first-class WSS seam reuses the proven experimental authority and transport implementation", () => {
  assert.equal(WebSocketBrokerBinding, ExperimentalWebSocketBrokerBinding);
  assert.equal(WebSocketTakeoverChannel, ExperimentalWebSocketTakeoverChannel);
  assert.equal(WebSocketTakeoverIngress, ExperimentalWebSocketTakeoverIngress);
  assert.equal(WebSocketTakeoverSessionAuthority, ExperimentalWebSocketTakeoverSessionAuthority);
});
