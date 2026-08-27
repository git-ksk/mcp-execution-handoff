export {
  ExperimentalWebSocketTakeoverChannel as WebSocketTakeoverChannel,
  WebSocketTakeoverError
} from "../experimental/websocket-takeover.js";
export type {
  WebSocketTakeoverBinding,
  WebSocketTakeoverFailureCode,
  WebSocketTakeoverFrame,
  WebSocketTakeoverHumanInput,
  WebSocketTakeoverInputPolicy,
  WebSocketTakeoverLease,
  WebSocketTakeoverPeer,
  WebSocketTakeoverServerMessage,
  WebSocketTakeoverState
} from "../experimental/websocket-takeover.js";

export {
  ExperimentalWebSocketTakeoverIngress as WebSocketTakeoverIngress,
  ExperimentalWebSocketTakeoverSessionAuthority as WebSocketTakeoverSessionAuthority
} from "../experimental/websocket-ingress.js";
export type {
  ExperimentalWebSocketAcceptedSession as WebSocketAcceptedSession,
  ExperimentalWebSocketTakeoverIngressOptions as WebSocketTakeoverIngressOptions,
  ExperimentalWebSocketTakeoverSessionAuthorityHooks as WebSocketTakeoverSessionAuthorityHooks
} from "../experimental/websocket-ingress.js";

export {
  ExperimentalWebSocketBrokerBinding as WebSocketBrokerBinding
} from "../experimental/websocket-broker-binding.js";
export type {
  ExperimentalWebSocketBrokerBindingOptions as WebSocketBrokerBindingOptions
} from "../experimental/websocket-broker-binding.js";

export {
  ExperimentalWebSocketBrowserHandoff as WebSocketBrowserHandoff
} from "../experimental/websocket-browser-handoff.js";
export type {
  ExperimentalWebSocketBrowserHandoffConfig as WebSocketBrowserHandoffConfig,
  ExperimentalWebSocketBrowserStartRequest as WebSocketBrowserStartRequest
} from "../experimental/websocket-browser-handoff.js";

export {
  ExperimentalWebSocketWindowHandoff as WebSocketWindowHandoff,
  ExperimentalWebSocketWindowHandoffError as WebSocketWindowHandoffError
} from "../experimental/websocket-window-handoff.js";
export type {
  ExperimentalWebSocketWindowHandoffConfig as WebSocketWindowHandoffConfig,
  ExperimentalWebSocketWindowStartRequest as WebSocketWindowStartRequest,
  ExperimentalWebSocketWindowSurface as WebSocketWindowSurface
} from "../experimental/websocket-window-handoff.js";

export {
  ExperimentalLinuxWebSocketWindowSurface as LinuxWebSocketWindowSurface,
  LinuxWebSocketHostRecordParser
} from "../experimental/linux-websocket-window-surface.js";
export type {
  ExperimentalLinuxWebSocketWindowSurfaceConfig as LinuxWebSocketWindowSurfaceConfig,
  LinuxWebSocketJpegFrame
} from "../experimental/linux-websocket-window-surface.js";

/**
 * First-class internal WSS relay seam for Browser/Window Handoff.
 *
 * The implementation intentionally delegates to the #40-proven transport while #155 removes the
 * remaining experimental file ownership. Keeping this seam inside `browser-takeover` lets #156
 * integrate WSS without creating a second session/authority implementation or exposing provider
 * selection through the package entry point.
 */
