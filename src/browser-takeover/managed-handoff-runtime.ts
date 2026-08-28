import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { OperatorDiagnosticsSnapshot, OperatorDiagnosticsSource } from "../core/operator-diagnostics.js";
import {
  WindowHandoffCore,
  WindowHandoffCoreError,
  type WindowHandoffCoreInitialSecureWindowPolicy,
  type WindowHandoffCoreStartRequest,
  type WindowHandoffCoreSuccessorPolicy
} from "../window-takeover/window-handoff-core.js";
import type {
  TakeoverBrokerConfig,
  TakeoverCompletionEvent,
  TakeoverInterventionRef
} from "./broker.js";
import {
  ManagedBrowserHandoffTransportCoordinator,
  ManagedBrowserHandoffTransportCoordinatorError,
  type ManagedBrowserHandoffTransportDriver,
  type ManagedBrowserHandoffTransportLease
} from "./managed-transport-coordinator.js";
import type { WebRtcDiagnosticsSnapshot } from "./webrtc-diagnostics.js";
import { WebRtcLatencyTracker, type WebRtcLatencyComparison } from "./webrtc-latency.js";
import type { SpawnedWebRtcRuntimeProviderConfig } from "./webrtc-runtime.js";
import {
  webRtcRelayEnvironmentConfigured,
  withDirectOnlyWebRtcEnvironment
} from "./webrtc-runtime-attempt.js";
import {
  LinuxWebSocketWindowSurface,
  WebSocketBrowserHandoff,
  type LinuxWebSocketWindowSurfaceConfig
} from "./websocket-relay.js";
import type { BrowserHandoffTransportAttempt } from "./transport-fallback-policy.js";

const FALLBACK_CAPABILITY_BYTES = 32;
const FALLBACK_HEADER = "x-mcp-handoff-fallback";
const FALLBACK_ROUTE = /^\/takeover\/api\/transport-fallback\/([A-Za-z0-9-]{8,100})$/;

export interface BrowserHandoffManagedFallbackConfig {
  /** Built Handoff Linux exact-window host script used by the managed Cloud/container fallback. */
  linuxHostScript: string;
  /** Local X11 display. Defaults to `runtime.displayName` when present. */
  displayName?: string;
  /** Optional absolute xdotool path for the exact-window revalidation boundary. */
  xdotoolExecutable?: string;
}

export interface ManagedWindowHandoffRuntimeConfig {
  takeover: TakeoverBrokerConfig;
  runtime: SpawnedWebRtcRuntimeProviderConfig;
  managedFallback: BrowserHandoffManagedFallbackConfig;
  mediaProfile?: "window_text";
  successorWindowPolicy?: WindowHandoffCoreSuccessorPolicy;
  initialSecureWindowPolicy?: WindowHandoffCoreInitialSecureWindowPolicy;
  onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
}

type WebRtcManagedTransport = {
  readonly kind: "webrtc_direct" | "webrtc_relay";
  readonly core: WindowHandoffCore;
};

type WebSocketManagedTransport = {
  readonly kind: "websocket_relay";
  readonly handoff: WebSocketBrowserHandoff;
  readonly surface: LinuxWebSocketWindowSurface;
};

type ActiveManagedTransport = WebRtcManagedTransport | WebSocketManagedTransport;

interface ManagedDriverState {
  current: ActiveManagedTransport | undefined;
}

interface ManagedHandoffSession {
  readonly intervention: TakeoverInterventionRef;
  readonly principalBinding: string;
  readonly coordinator: ManagedBrowserHandoffTransportCoordinator;
  readonly state: ManagedDriverState;
  readonly surface: LinuxWebSocketWindowSurface;
  readonly webSocketHandoff: WebSocketBrowserHandoff;
  readonly cleanupTimer: NodeJS.Timeout;
  lease: ManagedBrowserHandoffTransportLease;
  activeSessionId: string | undefined;
  fallbackCapability: string;
  completed: boolean;
}

/**
 * Internal first-class Browser/Window transport composition.
 *
 * Consumers still receive one ordinary Handoff locator. The browser page asks this runtime for the
 * next locator only after a bounded transport failure; Handoff revokes/fences the active attempt,
 * rotates generation/capability state and then redirects the same Human browser. No Human input is
 * replayed across the boundary and transport/provider credentials never cross this class.
 */
export class ManagedWindowHandoffRuntime {
  readonly #config: ManagedWindowHandoffRuntimeConfig;
  readonly #publicOrigin: string;
  readonly #displayName: string;
  readonly #sessionsByIntervention = new Map<string, ManagedHandoffSession>();
  readonly #sessionsByTransportSession = new Map<string, ManagedHandoffSession>();
  readonly #emptyLatency = new WebRtcLatencyTracker();
  #lastSession: ManagedHandoffSession | undefined;

  constructor(config: ManagedWindowHandoffRuntimeConfig) {
    if (config.successorWindowPolicy) {
      throw new WindowHandoffCoreError(
        "SUCCESSOR_POLICY_INVALID",
        "Managed transport fallback does not widen successor-window lineage"
      );
    }
    if (config.initialSecureWindowPolicy) {
      throw new WindowHandoffCoreError(
        "INITIAL_SECURE_WINDOW_POLICY_INVALID",
        "Managed transport fallback does not widen initial secure-window authority"
      );
    }
    if (!config.takeover.publicBaseUrl) {
      throw new WindowHandoffCoreError("UNAVAILABLE", "Managed Browser Handoff requires a public base URL");
    }
    const displayName = config.managedFallback.displayName ?? config.runtime.displayName;
    if (!displayName) {
      throw new WindowHandoffCoreError(
        "UNAVAILABLE",
        "Managed Browser Handoff Linux fallback requires an exact local X11 display"
      );
    }
    this.#config = config;
    this.#publicOrigin = new URL(config.takeover.publicBaseUrl).origin;
    this.#displayName = displayName;
  }

  isEnabled(): boolean { return this.#config.takeover.enabled; }
  isPath(pathname: string): boolean { return pathname.startsWith("/takeover/"); }

  ownsPath(pathname: string): boolean {
    if (FALLBACK_ROUTE.test(pathname)) {
      return this.#sessionsByTransportSession.has(FALLBACK_ROUTE.exec(pathname)?.[1] ?? "");
    }
    if (pathname === "/takeover/webrtc-client.js") {
      return [...this.#sessionsByIntervention.values()].some((session) => isWebRtc(session.state.current));
    }
    const sessionId = takeoverSessionIdFromPath(pathname);
    return sessionId !== undefined && this.#sessionsByTransportSession.has(sessionId);
  }

  start(request: WindowHandoffCoreStartRequest): string {
    if (request.target.windowId === undefined) {
      throw new WindowHandoffCoreError(
        "TARGET_INVALID",
        "Managed Browser Handoff fallback requires one exact target window id"
      );
    }
    if (this.#sessionsByIntervention.has(request.intervention.id)) {
      throw new ManagedBrowserHandoffTransportCoordinatorError(
        "MANAGED_TRANSPORT_ALREADY_STARTED",
        "Managed Browser Handoff intervention is already active"
      );
    }

    let sessionRef: ManagedHandoffSession | undefined;
    const state: ManagedDriverState = { current: undefined };
    const completion = async (event: TakeoverCompletionEvent): Promise<void> => {
      const session = sessionRef;
      if (!session || session.intervention.id !== event.interventionId) return;
      await this.#config.onComplete?.(event);
      session.completed = true;
    };

    const directCore = withDirectOnlyWebRtcEnvironment(() => new WindowHandoffCore({
      takeover: this.#config.takeover,
      runtime: this.#config.runtime,
      ...(this.#config.mediaProfile ? { mediaProfile: this.#config.mediaProfile } : {}),
      onComplete: completion
    }));
    const relayCore = webRtcRelayEnvironmentConfigured()
      ? new WindowHandoffCore({
          takeover: this.#config.takeover,
          runtime: this.#config.runtime,
          ...(this.#config.mediaProfile ? { mediaProfile: this.#config.mediaProfile } : {}),
          onComplete: completion
        })
      : undefined;
    const surfaceConfig: LinuxWebSocketWindowSurfaceConfig = {
      hostScript: this.#config.managedFallback.linuxHostScript,
      displayName: this.#displayName,
      helperTtlMs: this.#config.takeover.ttlMs,
      ...(this.#config.managedFallback.xdotoolExecutable
        ? { xdotoolExecutable: this.#config.managedFallback.xdotoolExecutable }
        : {})
    };
    const surface = new LinuxWebSocketWindowSurface(surfaceConfig);
    const wss = new WebSocketBrowserHandoff({
      takeover: this.#config.takeover,
      allowedOrigins: [this.#publicOrigin],
      surface,
      onComplete: completion
    });

    const drivers: ManagedBrowserHandoffTransportDriver[] = [
      {
        kind: "webrtc_direct",
        start: () => {
          const locator = directCore.start(request);
          state.current = { kind: "webrtc_direct", core: directCore };
          return locator;
        },
        revoke: async () => {
          await directCore.revoke(request.intervention.id);
          if (state.current?.kind === "webrtc_direct") state.current = undefined;
        }
      },
      {
        kind: "websocket_relay",
        start: () => {
          const locator = wss.start(request);
          state.current = { kind: "websocket_relay", handoff: wss, surface };
          return locator;
        },
        revoke: async () => {
          wss.revoke(request.intervention.id);
          await surface.close();
          if (state.current?.kind === "websocket_relay") state.current = undefined;
        }
      }
    ];
    if (relayCore) {
      drivers.push({
        kind: "webrtc_relay",
        start: () => {
          const locator = relayCore.start(request);
          state.current = { kind: "webrtc_relay", core: relayCore };
          return locator;
        },
        revoke: async () => {
          await relayCore.revoke(request.intervention.id);
          if (state.current?.kind === "webrtc_relay") state.current = undefined;
        }
      });
    }

    const coordinator = new ManagedBrowserHandoffTransportCoordinator(
      { websocketRelayEnabled: true, webrtcRelayEnabled: relayCore !== undefined },
      drivers
    );
    const lease = coordinator.startSync();
    const sessionId = takeoverSessionIdFromLocator(lease.locator);
    if (!sessionId) {
      void coordinator.revoke(lease).catch(() => undefined);
      throw new WindowHandoffCoreError("UNAVAILABLE", "Managed Browser Handoff locator is invalid");
    }
    const completionGraceMs = this.#config.takeover.completionGraceMs ?? this.#config.takeover.ttlMs;
    const cleanupTimer = setTimeout(() => {
      void this.revoke(request.intervention.id).catch(() => undefined);
    }, this.#config.takeover.ttlMs + (2 * completionGraceMs) + 2_000);
    cleanupTimer.unref();
    const session: ManagedHandoffSession = {
      intervention: { ...request.intervention },
      principalBinding: request.principalBinding,
      coordinator,
      state,
      surface,
      webSocketHandoff: wss,
      cleanupTimer,
      lease,
      activeSessionId: sessionId,
      fallbackCapability: freshFallbackCapability(),
      completed: false
    };
    sessionRef = session;
    this.#sessionsByIntervention.set(session.intervention.id, session);
    this.#sessionsByTransportSession.set(sessionId, session);
    this.#lastSession = session;
    return lease.locator;
  }

  /** @internal Content-free managed WSS surface diagnostics for physical acceptance. */
  managedSurfaceDiagnosticsSnapshot(): ReturnType<LinuxWebSocketWindowSurface["diagnosticsSnapshot"]> {
    return this.#lastSession?.surface.diagnosticsSnapshot() ?? {
      lastFailure: "none",
      framesObserved: 0,
      lastInputStage: "none",
      lastInputBoundaryStage: "none",
      inputAttempts: 0,
      failure: "none",
      failureInputStage: "none",
      failureInputBoundaryStage: "none",
      lastInputFailureDetail: "none",
      failureInputFailureDetail: "none",
      lastHelperStopReason: "none",
      failureHelperStopReason: "none",
      lastHelperCrashReason: "none",
      failureHelperCrashReason: "none",
      lastHelperExitKind: "none",
      failureHelperExitKind: "none",
      lastHelperCrashClass: "none",
      failureHelperCrashClass: "none",
      lastHelperCrashOrigin: "none",
      failureHelperCrashOrigin: "none",
      lastHelperCrashErrorKind: "none",
      failureHelperCrashErrorKind: "none",
      lastHelperCrashMessageClass: "none",
      failureHelperCrashMessageClass: "none"
    };
  }

  /** @internal Content-free managed WSS ingress diagnostics for physical acceptance. */
  managedWebSocketDiagnosticsSnapshot(): ReturnType<WebSocketBrowserHandoff["diagnosticsSnapshot"]> {
    return this.#lastSession?.webSocketHandoff.diagnosticsSnapshot() ?? {
      disconnectKind: "none",
      channelState: "none",
      sentFrames: 0,
      droppedFrames: 0,
      lastFailure: "none",
      lastInputStage: "none",
      failureDisconnectKind: "none",
      failureChannelState: "none",
      failureCode: "none",
      failureInputStage: "none"
    };
  }

  async revoke(interventionId: string): Promise<void> {
    const session = this.#sessionsByIntervention.get(interventionId);
    if (!session) return;
    this.#forgetSession(session);
    await session.coordinator.revoke(session.lease).catch(() => undefined);
  }

  revokeUnclaimed(interventionId: string): void {
    const session = this.#sessionsByIntervention.get(interventionId);
    if (!session) return;
    const current = session.state.current;
    if (current?.kind === "websocket_relay") {
      current.handoff.revoke(interventionId);
      void current.surface.close().catch(() => undefined);
    } else if (current) {
      current.core.revokeUnclaimed(interventionId);
    }
    this.#forgetSession(session);
    void session.coordinator.revoke(session.lease).catch(() => undefined);
  }

  async completeAfterVerification(intervention: TakeoverInterventionRef): Promise<boolean> {
    const session = this.#sessionsByIntervention.get(intervention.id);
    if (!session || session.intervention.epoch !== intervention.epoch) return false;
    const current = session.state.current;
    if (!current || current.kind === "websocket_relay") return false;
    const completed = await current.core.completeAfterVerification(intervention);
    if (completed) session.completed = true;
    return completed;
  }

  async handle(request: Request, boundPrincipal: string | undefined): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const fallback = FALLBACK_ROUTE.exec(pathname);
    if (fallback) return this.#handleFallback(request, boundPrincipal, fallback[1]!);

    if (pathname === "/takeover/webrtc-client.js") {
      const current = [...this.#sessionsByIntervention.values()]
        .map((session) => session.state.current)
        .find((candidate): candidate is WebRtcManagedTransport => isWebRtc(candidate));
      if (!current) return json(404, { error: "not_found" });
      const response = await current.core.handle(request, boundPrincipal);
      return this.#patchWebRtcClient(response);
    }

    const sessionId = takeoverSessionIdFromPath(pathname);
    const session = sessionId ? this.#sessionsByTransportSession.get(sessionId) : undefined;
    if (!session) return json(404, { error: "not_found" });
    const current = session.state.current;
    if (!current) return json(404, { error: "takeover_unavailable" });

    const response = current.kind === "websocket_relay"
      ? await current.handoff.handle(request, boundPrincipal)
      : await current.core.handle(request, boundPrincipal);
    if (
      request.method !== "GET"
      && request.method !== "HEAD"
      || pathname !== `/takeover/${sessionId}`
      || response.status !== 200
      || session.completed
    ) {
      return response;
    }
    return current.kind === "websocket_relay"
      ? this.#patchWebSocketPage(response, session)
      : this.#patchWebRtcPage(response, session);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const pathname = safeIncomingPath(request.url);
    const sessionId = pathname ? takeoverSessionIdFromPath(pathname) : undefined;
    const session = sessionId ? this.#sessionsByTransportSession.get(sessionId) : undefined;
    const current = session?.state.current;
    return current?.kind === "websocket_relay"
      ? current.handoff.handleUpgrade(request, socket, head)
      : false;
  }

  diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot {
    const current = this.#lastSession?.state.current;
    return current && current.kind !== "websocket_relay"
      ? current.core.diagnosticsSnapshot()
      : { events: [] };
  }

  latencySnapshot(): WebRtcLatencyComparison {
    const current = this.#lastSession?.state.current;
    return current && current.kind !== "websocket_relay"
      ? current.core.latencySnapshot()
      : this.#emptyLatency.snapshot();
  }

  operatorDiagnosticsSnapshot(source: Extract<OperatorDiagnosticsSource, "browser_handoff" | "window_handoff">): OperatorDiagnosticsSnapshot {
    const session = this.#lastSession;
    const snapshot = session?.coordinator.diagnosticsSnapshot() ?? {
      currentTransport: "none" as const,
      lastTransport: "none" as const,
      generation: 0,
      transitionCount: 0
    };
    return {
      version: 1,
      source,
      health: session?.completed
        ? "idle"
        : snapshot.currentTransport === "none"
          ? (session ? "failed" : "idle")
          : "available",
      transport: {
        namespace: "managed_handoff",
        currentTransport: snapshot.currentTransport,
        lastTransport: snapshot.lastTransport,
        generation: snapshot.generation,
        transitionCount: snapshot.transitionCount,
        ...(snapshot.lastFallbackReason === undefined
          ? {}
          : { lastFallbackReason: snapshot.lastFallbackReason })
      }
    };
  }

  async #handleFallback(
    request: Request,
    boundPrincipal: string | undefined,
    sessionId: string
  ): Promise<Response> {
    const session = this.#sessionsByTransportSession.get(sessionId);
    if (!session || session.completed || boundPrincipal !== session.principalBinding) {
      return json(404, { error: "takeover_unavailable" });
    }
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (request.headers.get("origin") !== this.#publicOrigin) {
      return json(403, { error: "origin_not_allowed" });
    }
    const capability = request.headers.get(FALLBACK_HEADER);
    if (!safeCapabilityEqual(capability, session.fallbackCapability)) {
      return json(404, { error: "takeover_unavailable" });
    }

    const oldLease = session.lease;
    let next: ManagedBrowserHandoffTransportLease | undefined;
    try {
      next = await session.coordinator.fallback(oldLease, "transport_unavailable");
    } catch (error) {
      if (
        error instanceof ManagedBrowserHandoffTransportCoordinatorError
        && error.code === "MANAGED_TRANSPORT_STALE"
      ) {
        return json(409, { error: "transport_transition_stale" });
      }
      return json(503, { error: "transport_transition_unavailable" });
    }

    if (this.#sessionsByTransportSession.get(sessionId) === session) {
      this.#sessionsByTransportSession.delete(sessionId);
    }
    session.fallbackCapability = freshFallbackCapability();
    if (!next) {
      session.activeSessionId = undefined;
      return json(503, { error: "transport_fallback_exhausted" });
    }
    const nextSessionId = takeoverSessionIdFromLocator(next.locator);
    if (!nextSessionId) {
      await session.coordinator.revoke(next).catch(() => undefined);
      session.activeSessionId = undefined;
      return json(503, { error: "transport_transition_unavailable" });
    }
    session.lease = next;
    session.activeSessionId = nextSessionId;
    this.#sessionsByTransportSession.set(nextSessionId, session);
    return json(200, { path: new URL(next.locator).pathname });
  }

  async #patchWebRtcPage(response: Response, session: ManagedHandoffSession): Promise<Response> {
    const html = await response.text();
    const marker = 'id="done" class="done" data-completion="';
    if (!html.includes(marker)) return cloneResponse(response, html);
    const patched = html.replace(
      marker,
      `id="done" class="done" data-fallback="${session.fallbackCapability}" data-completion="`
    );
    return cloneResponse(response, patched);
  }

  async #patchWebRtcClient(response: Response): Promise<Response> {
    if (response.status !== 200) return response;
    let script = await response.text();
    const helperMarker = "const MARK='_';";
    const failedMarker = "status(finalStatus);failureInProgress=false}";
    const firstFrameMarker = "if(!fired){fired=true;clearFirstFrameTimer();recoveryReconnectUsed=false;";
    const initialMarker = "resetKeyboard();resetViewTransform();armKeyboardFallback();void connect('claim').catch(function(){closePeer();if(relayState==='unavailable')status('Secure relay unavailable');else status('Session unavailable or connection failed');stopped=true});";
    if (
      !script.includes(helperMarker)
      || !script.includes(failedMarker)
      || !script.includes(firstFrameMarker)
      || !script.includes(initialMarker)
    ) {
      return json(500, { error: "managed_webrtc_client_incompatible" });
    }
    script = script.replace(helperMarker, `${helperMarker}${managedWebRtcFallbackHelper()}`);
    script = script.replace(
      failedMarker,
      "failureInProgress=false;if(await managedTransportFallback())return;status(finalStatus)}"
    );
    script = script.replace(
      firstFrameMarker,
      "if(!fired){fired=true;clearManagedReadyTimeout();clearFirstFrameTimer();recoveryReconnectUsed=false;"
    );
    script = script.replace(
      initialMarker,
      "resetKeyboard();resetViewTransform();armKeyboardFallback();armManagedReadyTimeout();void connect('claim').catch(async function(){closePeer();if(await managedTransportFallback())return;if(relayState==='unavailable')status('Secure relay unavailable');else status('Session unavailable or connection failed');stopped=true});"
    );
    return cloneResponse(response, script);
  }

  async #patchWebSocketPage(response: Response, session: ManagedHandoffSession): Promise<Response> {
    let html = await response.text();
    const appMarker = '<main id="app" ';
    const helperMarker = "function setStatus(value){status.textContent=value}";
    const closeMarker = "ws.onclose=()=>{ready=false;if(!stopped)setStatus('Connection closed')};";
    const errorMarker = "ws.onerror=()=>{ready=false;if(!stopped)setStatus('Connection unavailable')}";
    const readyMarker = "if(message.kind==='ready'){ready=true;";
    const initialMarker = "controls();void connect().catch(()=>{ready=false;stopped=true;setStatus('Session unavailable')})";
    if (
      !html.includes(appMarker)
      || !html.includes(helperMarker)
      || !html.includes(closeMarker)
      || !html.includes(errorMarker)
      || !html.includes(readyMarker)
      || !html.includes(initialMarker)
    ) {
      return json(500, { error: "managed_websocket_client_incompatible" });
    }
    html = html.replace(
      appMarker,
      `<main id="app" data-fallback="${session.fallbackCapability}" `
    );
    html = html.replace(helperMarker, `${helperMarker}${managedWebSocketFallbackHelper()}`);
    html = html.replace(readyMarker, "if(message.kind==='ready'){clearManagedReadyTimeout();ready=true;");
    html = html.replace(closeMarker, "ws.onclose=event=>{ready=false;if(!stopped)void managedWebSocketDisconnected(ws,event)};");
    html = html.replace(errorMarker, "ws.onerror=()=>{ready=false;if(!stopped)setStatus('Connection unavailable')}");
    html = html.replace(
      initialMarker,
      "controls();armManagedReadyTimeout();void connect().catch(()=>{ready=false;if(!stopped)void managedTransportFallback()})"
    );
    return cloneResponse(response, html);
  }

  #forgetSession(session: ManagedHandoffSession): void {
    clearTimeout(session.cleanupTimer);
    if (this.#sessionsByIntervention.get(session.intervention.id) === session) {
      this.#sessionsByIntervention.delete(session.intervention.id);
    }
    if (
      session.activeSessionId
      && this.#sessionsByTransportSession.get(session.activeSessionId) === session
    ) {
      this.#sessionsByTransportSession.delete(session.activeSessionId);
    }
  }
}

function isWebRtc(value: ActiveManagedTransport | undefined): value is WebRtcManagedTransport {
  return value?.kind === "webrtc_direct" || value?.kind === "webrtc_relay";
}

function takeoverSessionIdFromLocator(locator: string): string | undefined {
  try { return takeoverSessionIdFromPath(new URL(locator).pathname); } catch { return undefined; }
}

function takeoverSessionIdFromPath(pathname: string): string | undefined {
  const page = /^\/takeover\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
  if (page) return page[1];
  const api = /^\/takeover\/api\/[a-z0-9-]+\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
  if (api) return api[1];
  const ws = /^\/takeover\/ws\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
  return ws?.[1];
}

function safeIncomingPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(value, "http://handoff.invalid").pathname; } catch { return undefined; }
}

function freshFallbackCapability(): string {
  return randomBytes(FALLBACK_CAPABILITY_BYTES).toString("base64url");
}

function safeCapabilityEqual(candidate: string | null, expected: string): boolean {
  if (!candidate || !/^[A-Za-z0-9_-]{32,128}$/.test(candidate)) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function managedWebRtcFallbackHelper(): string {
  return "let managedFallbackStarted=false,managedReadyTimer=0;function clearManagedReadyTimeout(){if(managedReadyTimer){clearTimeout(managedReadyTimer);managedReadyTimer=0}}function armManagedReadyTimeout(){clearManagedReadyTimeout();managedReadyTimer=setTimeout(()=>{managedReadyTimer=0;if(!stopped)void managedTransportFallback()},4000)}async function managedTransportFallback(){const b=document.querySelector('#done');const f=b&&b.dataset?b.dataset.fallback||'':'';if(!f||managedFallbackStarted||stopped)return false;managedFallbackStarted=true;clearManagedReadyTimeout();try{const r=await fetch('/takeover/api/transport-fallback/'+encodeURIComponent(sessionId),{method:'POST',cache:'no-store',headers:{'x-mcp-handoff-fallback':f}});if(!r.ok)return false;const d=await r.json();if(!d||typeof d.path!=='string'||!d.path.startsWith('/takeover/'))return false;location.replace(d.path);return true}catch{return false}}";
}

function managedWebSocketFallbackHelper(): string {
  return "let managedFallbackStarted=false,managedReadyTimer=0,managedReconnectAttempts=0;const managedReconnectLimit=2,managedHandledSockets=new WeakSet();function clearManagedReadyTimeout(){if(managedReadyTimer){clearTimeout(managedReadyTimer);managedReadyTimer=0}}function armManagedReadyTimeout(){clearManagedReadyTimeout();managedReadyTimer=setTimeout(()=>{managedReadyTimer=0;if(!ready&&!stopped)void managedTransportFallback()},10000)}function managedWebSocketDisconnected(ws,event){if(stopped||managedFallbackStarted||managedHandledSockets.has(ws))return;managedHandledSockets.add(ws);clearManagedReadyTimeout();ready=false;const terminal=!!event&&(event.code===1008||event.code===1011);if(!terminal&&managedReconnectAttempts<managedReconnectLimit){managedReconnectAttempts+=1;setStatus('Reconnecting…');setTimeout(()=>{if(stopped||managedFallbackStarted)return;armManagedReadyTimeout();void connect().catch(()=>{if(!stopped)void managedTransportFallback()})},300);return}void managedTransportFallback()}async function managedTransportFallback(){const f=app.dataset.fallback||'';if(!f||managedFallbackStarted||stopped)return false;managedFallbackStarted=true;clearManagedReadyTimeout();try{const r=await fetch('/takeover/api/transport-fallback/'+encodeURIComponent(id),{method:'POST',cache:'no-store',headers:{'x-mcp-handoff-fallback':f}});if(r.ok){const d=await r.json();if(d&&typeof d.path==='string'&&d.path.startsWith('/takeover/')){location.replace(d.path);return true}}}catch{}stopped=true;setStatus('Session unavailable');return false}";
}

function cloneResponse(response: Response, body: string): Response {
  return new Response(body, { status: response.status, headers: new Headers(response.headers) });
}

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    }
  });
}

export type ManagedTransportKind = BrowserHandoffTransportAttempt;
