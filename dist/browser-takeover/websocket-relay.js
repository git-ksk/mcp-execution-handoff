export { ExperimentalWebSocketTakeoverChannel as WebSocketTakeoverChannel, WebSocketTakeoverError } from "./websocket-takeover.js";
export { ExperimentalWebSocketTakeoverIngress as WebSocketTakeoverIngress, ExperimentalWebSocketTakeoverSessionAuthority as WebSocketTakeoverSessionAuthority } from "./websocket-ingress.js";
export { ExperimentalWebSocketBrokerBinding as WebSocketBrokerBinding } from "./websocket-broker-binding.js";
export { ExperimentalWebSocketBrowserHandoff as WebSocketBrowserHandoff } from "./websocket-browser-handoff.js";
export { ExperimentalWebSocketWindowHandoff as WebSocketWindowHandoff, ExperimentalWebSocketWindowHandoffError as WebSocketWindowHandoffError } from "./websocket-window-handoff.js";
export { ExperimentalLinuxWebSocketWindowSurface as LinuxWebSocketWindowSurface, LinuxWebSocketHostRecordParser } from "./linux-websocket-window-surface.js";
/**
 * First-class internal WSS relay seam for Browser/Window Handoff.
 *
 * Stable Handoff internals import only from this directory. The temporary modules under
 * `src/experimental` remain implementation-compatible while #155 completes the ownership move;
 * #156 can therefore integrate WSS without exposing transport/provider selection to consumers.
 */
//# sourceMappingURL=websocket-relay.js.map