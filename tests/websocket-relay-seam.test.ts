import assert from "node:assert/strict";
import test from "node:test";
import {
  LinuxWebSocketWindowSurface,
  WebSocketBrokerBinding,
  WebSocketBrowserHandoff,
  WebSocketTakeoverChannel,
  WebSocketTakeoverIngress,
  WebSocketTakeoverSessionAuthority,
  WebSocketWindowHandoff
} from "../src/browser-takeover/websocket-relay.js";
import { ExperimentalWebSocketBrokerBinding } from "../src/experimental/websocket-broker-binding.js";
import { ExperimentalWebSocketBrowserHandoff } from "../src/experimental/websocket-browser-handoff.js";
import { ExperimentalLinuxWebSocketWindowSurface } from "../src/experimental/linux-websocket-window-surface.js";
import { ExperimentalWebSocketTakeoverChannel } from "../src/experimental/websocket-takeover.js";
import {
  ExperimentalWebSocketTakeoverIngress,
  ExperimentalWebSocketTakeoverSessionAuthority
} from "../src/experimental/websocket-ingress.js";
import { ExperimentalWebSocketWindowHandoff } from "../src/experimental/websocket-window-handoff.js";

test("first-class WSS seam reuses the proven experimental authority and transport implementation", () => {
  assert.equal(WebSocketBrokerBinding, ExperimentalWebSocketBrokerBinding);
  assert.equal(WebSocketTakeoverChannel, ExperimentalWebSocketTakeoverChannel);
  assert.equal(WebSocketTakeoverIngress, ExperimentalWebSocketTakeoverIngress);
  assert.equal(WebSocketTakeoverSessionAuthority, ExperimentalWebSocketTakeoverSessionAuthority);
  assert.equal(WebSocketBrowserHandoff, ExperimentalWebSocketBrowserHandoff);
  assert.equal(WebSocketWindowHandoff, ExperimentalWebSocketWindowHandoff);
  assert.equal(LinuxWebSocketWindowSurface, ExperimentalLinuxWebSocketWindowSurface);
});
