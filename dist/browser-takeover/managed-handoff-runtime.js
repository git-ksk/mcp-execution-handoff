import { randomBytes, timingSafeEqual } from "node:crypto";
import { createPhysicalDesktopSessionBoundary } from "../desktop-session/desktop-session.js";
import { WindowHandoffCore, WindowHandoffCoreError } from "../window-takeover/window-handoff-core.js";
import { ManagedBrowserHandoffTransportCoordinator, ManagedBrowserHandoffTransportCoordinatorError } from "./managed-transport-coordinator.js";
import { WebRtcLatencyTracker } from "./webrtc-latency.js";
import { WebSocketLatencyTracker, emptyWebSocketLatencySnapshot } from "./websocket-latency.js";
import { webRtcRelayEnvironmentConfigured, withDirectOnlyWebRtcEnvironment } from "./webrtc-runtime-attempt.js";
import { WebSocketBrowserHandoff } from "./websocket-relay.js";
import { createManagedWindowWebSocketSurface, resolveManagedWindowWebSocketPlatform } from "./managed-window-websocket-surface.js";
import { browserHandoffTransportAttemptOrder } from "./transport-fallback-policy.js";
import { ManagedOperatorDiagnosticEvents, emptyManagedOperatorDiagnosticsSnapshot, parseManagedOperatorDiagnosticsSnapshot } from "./managed-operator-diagnostics.js";
const FALLBACK_CAPABILITY_BYTES = 32;
const FALLBACK_HEADER = "x-mcp-handoff-fallback";
const FALLBACK_ROUTE = /^\/takeover\/api\/transport-fallback\/([A-Za-z0-9-]{8,100})$/;
/**
 * Internal first-class Browser/Window transport composition.
 *
 * Consumers still receive one ordinary Handoff locator. The browser page asks this runtime for the
 * next locator only after a bounded transport failure; Handoff revokes/fences the active attempt,
 * rotates generation/capability state and then redirects the same Human browser. No Human input is
 * replayed across the boundary and transport/provider credentials never cross this class.
 */
export class ManagedWindowHandoffRuntime {
    #config;
    #publicOrigin;
    #transportOrder;
    #sessionsByIntervention = new Map();
    #sessionsByTransportSession = new Map();
    #emptyLatency = new WebRtcLatencyTracker();
    #lastSession;
    constructor(config) {
        if (!config.takeover.publicBaseUrl) {
            throw new WindowHandoffCoreError("UNAVAILABLE", "Managed Browser Handoff requires a public base URL");
        }
        const defaultOrder = config.managedFallback
            ? [
                "webrtc_direct",
                "websocket_relay",
                ...(webRtcRelayEnvironmentConfigured() ? ["webrtc_relay"] : [])
            ]
            : ["webrtc_direct"];
        this.#transportOrder = browserHandoffTransportAttemptOrder(config.transportPolicy ?? { order: defaultOrder });
        const needsWebSocket = this.#transportOrder.includes("websocket_relay");
        const webSocketPlatform = needsWebSocket
            ? resolveManagedWindowWebSocketPlatform(config.managedFallback ?? {})
            : undefined;
        if (needsWebSocket && config.successorWindowPolicy && webSocketPlatform !== "macos") {
            throw new WindowHandoffCoreError("SUCCESSOR_POLICY_INVALID", "successor-window lineage over managed WSS requires the macOS exact-window backend");
        }
        if (needsWebSocket && config.successorWindowPolicy
            && (this.#transportOrder.length !== 1 || this.#transportOrder[0] !== "websocket_relay")) {
            throw new WindowHandoffCoreError("SUCCESSOR_POLICY_INVALID", "macOS WSS successor lineage requires an explicit WSS-only transport plan");
        }
        if (needsWebSocket && config.successorWindowPolicy && config.initialSecureWindowPolicy) {
            throw new WindowHandoffCoreError("INITIAL_SECURE_WINDOW_POLICY_INVALID", "initial secure Window policy cannot be combined with successor-window lineage");
        }
        if (needsWebSocket && config.initialSecureWindowPolicy && webSocketPlatform !== "macos") {
            throw new WindowHandoffCoreError("INITIAL_SECURE_WINDOW_POLICY_INVALID", "LocalAuthentication managed WSS requires the macOS exact-window backend");
        }
        if (this.#transportOrder.includes("webrtc_relay") && !webRtcRelayEnvironmentConfigured()) {
            throw new WindowHandoffCoreError("UNAVAILABLE", "Managed Browser Handoff relay-capable WebRTC was requested without Handoff relay configuration");
        }
        this.#config = config;
        this.#publicOrigin = new URL(config.takeover.publicBaseUrl).origin;
    }
    isEnabled() { return this.#config.takeover.enabled; }
    isPath(pathname) { return pathname.startsWith("/takeover/"); }
    ownsPath(pathname) {
        if (FALLBACK_ROUTE.test(pathname)) {
            return this.#sessionsByTransportSession.has(FALLBACK_ROUTE.exec(pathname)?.[1] ?? "");
        }
        if (pathname === "/takeover/webrtc-client.js") {
            return [...this.#sessionsByIntervention.values()].some((session) => isWebRtc(session.state.current));
        }
        const sessionId = takeoverSessionIdFromPath(pathname);
        return sessionId !== undefined && this.#sessionsByTransportSession.has(sessionId);
    }
    start(request) {
        if (this.#transportOrder.includes("websocket_relay")) {
            const webSocketPlatform = resolveManagedWindowWebSocketPlatform(this.#config.managedFallback ?? {});
            const secureLocalAuthentication = webSocketPlatform === "macos" && Boolean(this.#config.initialSecureWindowPolicy);
            if (secureLocalAuthentication) {
                if (request.target.windowId !== undefined) {
                    throw new WindowHandoffCoreError("TARGET_INVALID", "LocalAuthentication managed WSS resolves the exact secure Window from PID only");
                }
                if (!localAuthenticationInputPolicy(request.inputPolicy)) {
                    throw new WindowHandoffCoreError("INPUT_POLICY_INVALID", "LocalAuthentication managed WSS permits Human tap plus secure text/backspace only");
                }
            }
            else if (request.target.windowId === undefined) {
                throw new WindowHandoffCoreError("TARGET_INVALID", "The configured managed WSS transport requires one exact target window id");
            }
        }
        if (this.#sessionsByIntervention.has(request.intervention.id)) {
            throw new ManagedBrowserHandoffTransportCoordinatorError("MANAGED_TRANSPORT_ALREADY_STARTED", "Managed Browser Handoff intervention is already active");
        }
        const desktopSession = this.#config.desktopSessionBoundary === "physical_window"
            ? createPhysicalDesktopSessionBoundary({
                kind: "bounded_window",
                processId: request.target.processId,
                ...(request.target.windowId === undefined ? {} : { windowId: request.target.windowId })
            })
            : undefined;
        let sessionRef;
        const state = { current: undefined };
        const diagnosticEvents = new ManagedOperatorDiagnosticEvents(this.#config.onManagedOperatorDiagnosticEvent);
        let pendingSessionDisposition = "none";
        const noteDiagnosticEvent = (kind) => {
            if (kind === "session_retained")
                pendingSessionDisposition = "retained";
            if (kind === "session_revoked")
                pendingSessionDisposition = "revoked";
            if (kind === "wss_failed" && pendingSessionDisposition !== "revoked") {
                pendingSessionDisposition = "retained";
            }
            if (sessionRef)
                sessionRef.sessionDisposition = pendingSessionDisposition;
            diagnosticEvents.record(kind);
            if (kind === "wss_failed" && pendingSessionDisposition === "retained") {
                diagnosticEvents.record("session_retained");
            }
        };
        const authorityReleased = async (event) => {
            const session = sessionRef;
            if (!session || session.intervention.id !== event.interventionId || session.intervention.epoch !== event.epoch)
                return;
            if (session.sessionDisposition !== "revoked") {
                session.sessionDisposition = "revoked";
                diagnosticEvents.record("session_revoked");
            }
            session.desktopSession?.detachCurrentViewer();
            await this.#config.onAuthorityReleased?.(event);
        };
        const completion = async (event) => {
            const session = sessionRef;
            if (!session || session.intervention.id !== event.interventionId)
                return;
            session.completed = true;
            await this.#config.onComplete?.(event);
        };
        const directCore = this.#transportOrder.includes("webrtc_direct")
            ? withDirectOnlyWebRtcEnvironment(() => new WindowHandoffCore({
                takeover: this.#config.takeover,
                runtime: this.#config.runtime,
                ...(this.#config.mediaProfile ? { mediaProfile: this.#config.mediaProfile } : {}),
                ...(this.#config.successorWindowPolicy
                    ? { successorWindowPolicy: this.#config.successorWindowPolicy }
                    : {}),
                ...(this.#config.initialSecureWindowPolicy
                    ? { initialSecureWindowPolicy: this.#config.initialSecureWindowPolicy }
                    : {}),
                onComplete: completion,
                onAuthorityReleased: authorityReleased
            }))
            : undefined;
        const relayCore = this.#transportOrder.includes("webrtc_relay")
            ? new WindowHandoffCore({
                takeover: this.#config.takeover,
                runtime: this.#config.runtime,
                ...(this.#config.mediaProfile ? { mediaProfile: this.#config.mediaProfile } : {}),
                ...(this.#config.successorWindowPolicy
                    ? { successorWindowPolicy: this.#config.successorWindowPolicy }
                    : {}),
                ...(this.#config.initialSecureWindowPolicy
                    ? { initialSecureWindowPolicy: this.#config.initialSecureWindowPolicy }
                    : {}),
                onComplete: completion,
                onAuthorityReleased: authorityReleased
            })
            : undefined;
        let surface;
        let wss;
        if (this.#transportOrder.includes("websocket_relay")) {
            const wssLatencyTracker = new WebSocketLatencyTracker();
            try {
                surface = createManagedWindowWebSocketSurface({
                    host: this.#config.managedFallback ?? {},
                    runtime: this.#config.runtime,
                    helperTtlMs: this.#config.takeover.ttlMs,
                    ...(this.#config.initialSecureWindowPolicy
                        ? { initialSecureWindowPolicy: this.#config.initialSecureWindowPolicy }
                        : {}),
                    ...(this.#config.successorWindowPolicy
                        ? { successorWindowPolicy: this.#config.successorWindowPolicy }
                        : {}),
                    onDiagnosticEvent: noteDiagnosticEvent,
                    latencyTracker: wssLatencyTracker
                });
            }
            catch (error) {
                throw new WindowHandoffCoreError("UNAVAILABLE", error instanceof Error ? error.message : "Managed Window WSS backend is unavailable");
            }
            wss = new WebSocketBrowserHandoff({
                takeover: this.#config.takeover,
                allowedOrigins: [this.#publicOrigin],
                surface,
                latencyTracker: wssLatencyTracker,
                onDiagnosticEvent: noteDiagnosticEvent,
                onComplete: completion,
                onAuthorityReleased: authorityReleased
            });
        }
        const drivers = this.#transportOrder.map((attempt) => {
            switch (attempt) {
                case "webrtc_direct": {
                    if (!directCore)
                        throw new WindowHandoffCoreError("UNAVAILABLE", "Direct WebRTC transport is unavailable");
                    return {
                        kind: attempt,
                        start: (generation) => {
                            desktopSession?.assertSameTarget({
                                kind: "bounded_window",
                                processId: request.target.processId,
                                ...(request.target.windowId === undefined ? {} : { windowId: request.target.windowId })
                            });
                            desktopSession?.attachViewer(generation);
                            try {
                                const locator = directCore.start(request);
                                state.current = { kind: attempt, core: directCore };
                                return locator;
                            }
                            catch (error) {
                                desktopSession?.detachCurrentViewer();
                                throw error;
                            }
                        },
                        revoke: async () => {
                            try {
                                await directCore.revoke(request.intervention.id);
                            }
                            finally {
                                desktopSession?.detachCurrentViewer();
                                if (state.current?.kind === attempt)
                                    state.current = undefined;
                            }
                        }
                    };
                }
                case "websocket_relay": {
                    if (!wss || !surface)
                        throw new WindowHandoffCoreError("UNAVAILABLE", "WebSocket transport is unavailable");
                    return {
                        kind: attempt,
                        start: (generation) => {
                            desktopSession?.assertSameTarget({
                                kind: "bounded_window",
                                processId: request.target.processId,
                                ...(request.target.windowId === undefined ? {} : { windowId: request.target.windowId })
                            });
                            desktopSession?.attachViewer(generation);
                            try {
                                const locator = wss.start(request);
                                state.current = { kind: attempt, handoff: wss, surface };
                                return locator;
                            }
                            catch (error) {
                                desktopSession?.detachCurrentViewer();
                                throw error;
                            }
                        },
                        revoke: async () => {
                            try {
                                wss.revoke(request.intervention.id);
                                await surface.close();
                            }
                            finally {
                                desktopSession?.detachCurrentViewer();
                                if (state.current?.kind === attempt)
                                    state.current = undefined;
                            }
                        }
                    };
                }
                case "webrtc_relay": {
                    if (!relayCore)
                        throw new WindowHandoffCoreError("UNAVAILABLE", "Relay-capable WebRTC transport is unavailable");
                    return {
                        kind: attempt,
                        start: (generation) => {
                            desktopSession?.assertSameTarget({
                                kind: "bounded_window",
                                processId: request.target.processId,
                                ...(request.target.windowId === undefined ? {} : { windowId: request.target.windowId })
                            });
                            desktopSession?.attachViewer(generation);
                            try {
                                const locator = relayCore.start(request);
                                state.current = { kind: attempt, core: relayCore };
                                return locator;
                            }
                            catch (error) {
                                desktopSession?.detachCurrentViewer();
                                throw error;
                            }
                        },
                        revoke: async () => {
                            try {
                                await relayCore.revoke(request.intervention.id);
                            }
                            finally {
                                desktopSession?.detachCurrentViewer();
                                if (state.current?.kind === attempt)
                                    state.current = undefined;
                            }
                        }
                    };
                }
            }
        });
        const coordinator = new ManagedBrowserHandoffTransportCoordinator({ order: this.#transportOrder }, drivers);
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
        const session = {
            intervention: { ...request.intervention },
            ...(desktopSession ? { desktopSession } : {}),
            principalBinding: request.principalBinding,
            coordinator,
            state,
            ...(surface ? { surface } : {}),
            ...(wss ? { webSocketHandoff: wss } : {}),
            cleanupTimer,
            lease,
            activeSessionId: sessionId,
            fallbackCapability: freshFallbackCapability(),
            completed: false,
            diagnosticEvents,
            sessionDisposition: pendingSessionDisposition
        };
        sessionRef = session;
        this.#sessionsByIntervention.set(session.intervention.id, session);
        this.#sessionsByTransportSession.set(sessionId, session);
        this.#lastSession = session;
        return lease.locator;
    }
    /** @internal Content-free managed WSS surface diagnostics for physical acceptance. */
    managedSurfaceDiagnosticsSnapshot() {
        return this.#lastSession?.surface?.managedDiagnosticsSnapshot() ?? {
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
            failureHelperCrashMessageClass: "none",
            authorityBoundary: "valid"
        };
    }
    /** @internal Content-free managed WSS ingress diagnostics for physical acceptance. */
    managedWebSocketDiagnosticsSnapshot() {
        return this.#lastSession?.webSocketHandoff?.diagnosticsSnapshot() ?? {
            disconnectKind: "none",
            channelState: "none",
            sentFrames: 0,
            droppedFrames: 0,
            backpressureEvents: 0,
            currentBufferedBytes: 0,
            maxBufferedBytesObserved: 0,
            lastFailure: "none",
            lastInputStage: "none",
            failureDisconnectKind: "none",
            failureChannelState: "none",
            failureCode: "none",
            failureInputStage: "none",
            peerCloseCode: 0
        };
    }
    /** @internal Content-free managed WSS latency evidence for #160. */
    managedWebSocketLatencySnapshot() {
        return this.#lastSession?.webSocketHandoff?.latencySnapshot() ?? emptyWebSocketLatencySnapshot();
    }
    async revoke(interventionId) {
        const session = this.#sessionsByIntervention.get(interventionId);
        if (!session)
            return;
        this.#forgetSession(session);
        try {
            await session.coordinator.revoke(session.lease).catch(() => undefined);
        }
        finally {
            session.desktopSession?.close();
        }
    }
    revokeUnclaimed(interventionId) {
        const session = this.#sessionsByIntervention.get(interventionId);
        if (!session)
            return;
        const current = session.state.current;
        if (current?.kind === "websocket_relay") {
            current.handoff.revoke(interventionId);
            void current.surface.close().catch(() => undefined);
        }
        else if (current) {
            current.core.revokeUnclaimed(interventionId);
        }
        this.#forgetSession(session);
        session.desktopSession?.close();
        void session.coordinator.revoke(session.lease).catch(() => undefined);
    }
    async completeAfterVerification(intervention) {
        const session = this.#sessionsByIntervention.get(intervention.id);
        if (!session || session.intervention.epoch !== intervention.epoch)
            return false;
        const current = session.state.current;
        if (!current)
            return false;
        const completed = current.kind === "websocket_relay"
            ? await current.handoff.completeAfterVerification(intervention)
            : await current.core.completeAfterVerification(intervention);
        if (completed) {
            session.completed = true;
            session.desktopSession?.close();
        }
        return completed;
    }
    async handle(request, boundPrincipal) {
        const pathname = new URL(request.url).pathname;
        const fallback = FALLBACK_ROUTE.exec(pathname);
        if (fallback)
            return this.#handleFallback(request, boundPrincipal, fallback[1]);
        if (pathname === "/takeover/webrtc-client.js") {
            const current = [...this.#sessionsByIntervention.values()]
                .map((session) => session.state.current)
                .find((candidate) => isWebRtc(candidate));
            if (!current)
                return json(404, { error: "not_found" });
            const response = await current.core.handle(request, boundPrincipal);
            return this.#patchWebRtcClient(response);
        }
        const sessionId = takeoverSessionIdFromPath(pathname);
        const session = sessionId ? this.#sessionsByTransportSession.get(sessionId) : undefined;
        if (!session)
            return json(404, { error: "not_found" });
        const current = session.state.current;
        if (!current)
            return json(404, { error: "takeover_unavailable" });
        const response = current.kind === "websocket_relay"
            ? await current.handoff.handle(request, boundPrincipal)
            : await current.core.handle(request, boundPrincipal);
        if (request.method !== "GET"
            || pathname !== `/takeover/${sessionId}`
            || response.status !== 200
            || session.completed) {
            return response;
        }
        return current.kind === "websocket_relay"
            ? this.#patchWebSocketPage(response, session)
            : this.#patchWebRtcPage(response, session);
    }
    handleUpgrade(request, socket, head) {
        const pathname = safeIncomingPath(request.url);
        const sessionId = pathname ? takeoverSessionIdFromPath(pathname) : undefined;
        const session = sessionId ? this.#sessionsByTransportSession.get(sessionId) : undefined;
        const current = session?.state.current;
        return current?.kind === "websocket_relay"
            ? current.handoff.handleUpgrade(request, socket, head)
            : false;
    }
    diagnosticsSnapshot() {
        const current = this.#lastSession?.state.current;
        return current && current.kind !== "websocket_relay"
            ? current.core.diagnosticsSnapshot()
            : { events: [] };
    }
    /** Stable, strict, content-free managed takeover diagnostics for production troubleshooting. */
    managedOperatorDiagnosticsSnapshot(source) {
        const session = this.#lastSession;
        if (!session)
            return emptyManagedOperatorDiagnosticsSnapshot(source);
        const transport = session.coordinator.diagnosticsSnapshot();
        const surface = session.surface?.managedDiagnosticsSnapshot() ?? this.managedSurfaceDiagnosticsSnapshot();
        const channel = session.webSocketHandoff?.diagnosticsSnapshot() ?? this.managedWebSocketDiagnosticsSnapshot();
        const channelFailure = channel.failureCode !== "none" ? channel.failureCode : channel.lastFailure;
        const channelState = channel.failureCode !== "none" ? channel.failureChannelState : channel.channelState;
        const disconnectKind = channel.failureCode !== "none"
            ? channel.failureDisconnectKind
            : channel.disconnectKind;
        const surfaceFailure = surface.failure !== "none" ? surface.failure : surface.lastFailure;
        const helperStopReason = surface.failureHelperStopReason !== "none"
            ? surface.failureHelperStopReason : surface.lastHelperStopReason;
        const helperCrashReason = surface.failureHelperCrashReason !== "none"
            ? surface.failureHelperCrashReason : surface.lastHelperCrashReason;
        const helperExitKind = surface.failureHelperExitKind !== "none"
            ? surface.failureHelperExitKind : surface.lastHelperExitKind;
        const helperCrashClass = surface.failureHelperCrashClass !== "none"
            ? surface.failureHelperCrashClass : surface.lastHelperCrashClass;
        const helperCrashOrigin = surface.failureHelperCrashOrigin !== "none"
            ? surface.failureHelperCrashOrigin : surface.lastHelperCrashOrigin;
        const helperCrashErrorKind = surface.failureHelperCrashErrorKind !== "none"
            ? surface.failureHelperCrashErrorKind : surface.lastHelperCrashErrorKind;
        const helperCrashMessageClass = surface.failureHelperCrashMessageClass !== "none"
            ? surface.failureHelperCrashMessageClass : surface.lastHelperCrashMessageClass;
        const wssCurrent = transport.currentTransport === "websocket_relay";
        const failed = surface.authorityBoundary === "lost"
            || (wssCurrent && (session.sessionDisposition === "revoked" || channelFailure !== "none"))
            || (transport.currentTransport === "none" && !session.completed);
        const degraded = !failed && wssCurrent && (disconnectKind !== "none"
            || surfaceFailure !== "none"
            || session.sessionDisposition === "retained");
        return parseManagedOperatorDiagnosticsSnapshot({
            version: 1,
            source,
            namespace: "managed_handoff",
            health: session.completed ? "idle" : failed ? "failed" : degraded ? "degraded" : "available",
            currentTransport: transport.currentTransport,
            previousTransport: transport.previousTransport,
            generation: transport.generation,
            transitionCount: transport.transitionCount,
            fallbackReason: transport.lastFallbackReason ?? "none",
            wss: {
                namespace: "managed_wss",
                channelState,
                channelFailure,
                disconnectKind,
                framesObserved: surface.framesObserved,
                framesSent: channel.sentFrames,
                framesDropped: channel.droppedFrames,
                surfaceFailure,
                inputAttempts: surface.inputAttempts,
                lastInputStage: surface.lastInputStage,
                lastInputBoundaryStage: surface.lastInputBoundaryStage,
                helperStopReason,
                helperCrashReason,
                helperExitKind,
                helperCrashClass,
                helperCrashOrigin,
                helperCrashErrorKind,
                helperCrashMessageClass,
                authorityBoundary: surface.authorityBoundary,
                sessionDisposition: session.sessionDisposition
            },
            events: session.diagnosticEvents.snapshot()
        });
    }
    /** @internal Content-free Desktop Session / Display Backend lifecycle evidence for #161. */
    desktopSessionSnapshot() {
        return this.#lastSession?.desktopSession?.snapshot();
    }
    latencySnapshot() {
        const current = this.#lastSession?.state.current;
        return current && current.kind !== "websocket_relay"
            ? current.core.latencySnapshot()
            : this.#emptyLatency.snapshot();
    }
    operatorDiagnosticsSnapshot(source) {
        const session = this.#lastSession;
        const snapshot = session?.coordinator.diagnosticsSnapshot() ?? {
            currentTransport: "none",
            lastTransport: "none",
            previousTransport: "none",
            generation: 0,
            transitionCount: 0,
            lastFallbackReason: undefined
        };
        const surface = session?.surface?.managedDiagnosticsSnapshot();
        const channel = session?.webSocketHandoff?.diagnosticsSnapshot();
        const hasWssEvidence = snapshot.currentTransport === "websocket_relay"
            || (surface !== undefined && (surface.framesObserved > 0
                || surface.inputAttempts > 0
                || surface.failure !== "none"
                || surface.lastFailure !== "none"))
            || (channel !== undefined && (channel.failureCode !== "none" || channel.lastFailure !== "none"));
        const wss = hasWssEvidence && surface && channel
            ? {
                namespace: "managed_wss",
                surfaceFailure: surface.failure === "none" ? surface.lastFailure : surface.failure,
                channelFailure: channel.failureCode === "none" ? channel.lastFailure : channel.failureCode,
                framesObserved: surface.framesObserved,
                inputAttempts: surface.inputAttempts,
                inputStage: surface.lastInputStage,
                inputBoundaryStage: surface.lastInputBoundaryStage
            }
            : undefined;
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
                    : { lastFallbackReason: snapshot.lastFallbackReason }),
                ...(wss ? { wss } : {})
            }
        };
    }
    async #handleFallback(request, boundPrincipal, sessionId) {
        const session = this.#sessionsByTransportSession.get(sessionId);
        if (!session || session.completed || boundPrincipal !== session.principalBinding) {
            return json(404, { error: "takeover_unavailable" });
        }
        if (request.method !== "POST")
            return json(405, { error: "method_not_allowed" });
        if (request.headers.get("origin") !== this.#publicOrigin) {
            return json(403, { error: "origin_not_allowed" });
        }
        const capability = request.headers.get(FALLBACK_HEADER);
        if (!safeCapabilityEqual(capability, session.fallbackCapability)) {
            return json(404, { error: "takeover_unavailable" });
        }
        const oldLease = session.lease;
        let next;
        try {
            next = await session.coordinator.fallback(oldLease, "transport_unavailable");
        }
        catch (error) {
            if (error instanceof ManagedBrowserHandoffTransportCoordinatorError
                && error.code === "MANAGED_TRANSPORT_STALE") {
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
        session.diagnosticEvents.record("transport_transition");
        this.#sessionsByTransportSession.set(nextSessionId, session);
        return json(200, { path: new URL(next.locator).pathname });
    }
    async #patchWebRtcPage(response, session) {
        const html = await response.text();
        const marker = 'id="done" class="done" data-completion="';
        if (!html.includes(marker))
            return cloneResponse(response, html);
        const patched = html.replace(marker, `id="done" class="done" data-fallback="${session.fallbackCapability}" data-completion="`);
        return cloneResponse(response, patched);
    }
    async #patchWebRtcClient(response) {
        if (response.status !== 200)
            return response;
        let script = await response.text();
        const helperMarker = "const touchEventsAvailable=('ontouchstart' in window)||(Number(navigator.maxTouchPoints)||0)>0;";
        const failedMarker = "status(finalStatus);failureInProgress=false}";
        const firstFrameMarker = "if(!fired){fired=true;clearFirstFrameTimer();recoveryReconnectUsed=false;";
        const initialMarker = "resetKeyboardSession();resetViewTransform();armKeyboardFallback();void connect('claim').catch(function(){closePeer();if(relayState==='unavailable')status('Secure relay unavailable');else status('Session unavailable or connection failed');stopped=true});";
        if (!script.includes(helperMarker)
            || !script.includes(failedMarker)
            || !script.includes(firstFrameMarker)
            || !script.includes(initialMarker)) {
            return json(500, { error: "managed_webrtc_client_incompatible" });
        }
        script = script.replace(helperMarker, `${helperMarker}${managedWebRtcFallbackHelper()}`);
        script = script.replace(failedMarker, "failureInProgress=false;if(await managedTransportFallback())return;status(finalStatus)}");
        script = script.replace(firstFrameMarker, "if(!fired){fired=true;clearManagedReadyTimeout();clearFirstFrameTimer();recoveryReconnectUsed=false;");
        script = script.replace(initialMarker, "resetKeyboardSession();resetViewTransform();armKeyboardFallback();armManagedReadyTimeout();void connect('claim').catch(async function(){closePeer();if(await managedTransportFallback())return;if(relayState==='unavailable')status('Secure relay unavailable');else status('Session unavailable or connection failed');stopped=true});");
        return cloneResponse(response, script);
    }
    async #patchWebSocketPage(response, session) {
        let html = await response.text();
        const appMarker = '<main id="app" ';
        const helperMarker = "function setStatus(value){status.textContent=value}";
        const disconnectHookMarker = "function onWebSocketDisconnected(ws,event){if(stopped||terminalPending)return;if(browserWssCloseIsReconnectable(event.code)){scheduleReconnect();return}stopped=true;resetViewTransform();setStatus('Connection closed')}";
        const initialFailureHookMarker = "function onInitialWebSocketConnectFailure(){scheduleReconnect()}";
        const errorMarker = "ws.onerror=()=>{if(socket!==ws||stopped||terminalPending)return;ready=false;setStatus('Connection unavailable')}";
        const readyMarker = "if(message.kind==='ready'){ready=true;noteFirstReady();flushFirstFrameLatency();";
        const frameLoadedMarker = "lastFrameLoadedAt=loadedAt;if(currentUrl)";
        const initialMarker = "controls();resetViewTransform();window.addEventListener('orientationchange',scheduleOrientationReset);void connect().catch(()=>onInitialWebSocketConnectFailure())";
        if (!html.includes(appMarker)
            || !html.includes(helperMarker)
            || !html.includes(disconnectHookMarker)
            || !html.includes(initialFailureHookMarker)
            || !html.includes(errorMarker)
            || !html.includes(readyMarker)
            || !html.includes(frameLoadedMarker)
            || !html.includes(initialMarker)) {
            return json(500, { error: "managed_websocket_client_incompatible" });
        }
        html = html.replace(appMarker, `<main id="app" data-fallback="${session.fallbackCapability}" `);
        html = html.replace(helperMarker, `${helperMarker}${managedWebSocketFallbackHelper()}`);
        html = html.replace(readyMarker, "if(message.kind==='ready'){ready=true;noteFirstReady();flushFirstFrameLatency();managedWebSocketReady();");
        html = html.replace(frameLoadedMarker, "lastFrameLoadedAt=loadedAt;managedWebSocketFrameLoaded(loadedAt);if(currentUrl)");
        html = html.replace(disconnectHookMarker, "function onWebSocketDisconnected(ws,event){if(stopped||terminalPending)return;resetViewTransform();void managedWebSocketDisconnected(ws,event)}");
        html = html.replace(initialFailureHookMarker, "function onInitialWebSocketConnectFailure(){if(!stopped&&!terminalPending)void managedTransportFallback()}");
        html = html.replace(errorMarker, "ws.onerror=()=>{if(socket!==ws||stopped||terminalPending)return;ready=false;setStatus('Connection unavailable')}");
        html = html.replace(initialMarker, "controls();resetViewTransform();window.addEventListener('orientationchange',scheduleOrientationReset);armManagedReadyTimeout();void connect().catch(()=>onInitialWebSocketConnectFailure())");
        return cloneResponse(response, html);
    }
    #forgetSession(session) {
        clearTimeout(session.cleanupTimer);
        if (this.#sessionsByIntervention.get(session.intervention.id) === session) {
            this.#sessionsByIntervention.delete(session.intervention.id);
        }
        if (session.activeSessionId
            && this.#sessionsByTransportSession.get(session.activeSessionId) === session) {
            this.#sessionsByTransportSession.delete(session.activeSessionId);
        }
    }
}
function localAuthenticationInputPolicy(policy) {
    return policy.tap === true && policy.scroll === false && policy.text === true && policy.key === true;
}
function emptyManagedWindowWebSocketSurfaceDiagnostics() {
    return {
        lastFailure: "none", framesObserved: 0, lastInputStage: "none", lastInputBoundaryStage: "none",
        inputAttempts: 0, failure: "none", failureInputStage: "none", failureInputBoundaryStage: "none",
        lastInputFailureDetail: "none", failureInputFailureDetail: "none", lastHelperStopReason: "none",
        failureHelperStopReason: "none", lastHelperCrashReason: "none", failureHelperCrashReason: "none",
        lastHelperExitKind: "none", failureHelperExitKind: "none", lastHelperCrashClass: "none",
        failureHelperCrashClass: "none", lastHelperCrashOrigin: "none", failureHelperCrashOrigin: "none",
        lastHelperCrashErrorKind: "none", failureHelperCrashErrorKind: "none",
        lastHelperCrashMessageClass: "none", failureHelperCrashMessageClass: "none", authorityBoundary: "valid"
    };
}
function isWebRtc(value) {
    return value?.kind === "webrtc_direct" || value?.kind === "webrtc_relay";
}
function takeoverSessionIdFromLocator(locator) {
    try {
        return takeoverSessionIdFromPath(new URL(locator).pathname);
    }
    catch {
        return undefined;
    }
}
function takeoverSessionIdFromPath(pathname) {
    const page = /^\/takeover\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
    if (page)
        return page[1];
    const api = /^\/takeover\/api\/[a-z0-9-]+\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
    if (api)
        return api[1];
    const ws = /^\/takeover\/ws\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
    return ws?.[1];
}
function safeIncomingPath(value) {
    if (!value)
        return undefined;
    try {
        return new URL(value, "http://handoff.invalid").pathname;
    }
    catch {
        return undefined;
    }
}
function freshFallbackCapability() {
    return randomBytes(FALLBACK_CAPABILITY_BYTES).toString("base64url");
}
function safeCapabilityEqual(candidate, expected) {
    if (!candidate || !/^[A-Za-z0-9_-]{32,128}$/.test(candidate))
        return false;
    const left = Buffer.from(candidate);
    const right = Buffer.from(expected);
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function managedWebRtcFallbackHelper() {
    return "let managedFallbackStarted=false,managedReadyTimer=0;function clearManagedReadyTimeout(){if(managedReadyTimer){clearTimeout(managedReadyTimer);managedReadyTimer=0}}function armManagedReadyTimeout(){clearManagedReadyTimeout();managedReadyTimer=setTimeout(()=>{managedReadyTimer=0;if(!stopped)void managedTransportFallback()},4000)}async function managedTransportFallback(){const b=document.querySelector('#done');const f=b&&b.dataset?b.dataset.fallback||'':'';if(!f||managedFallbackStarted||stopped)return false;managedFallbackStarted=true;clearManagedReadyTimeout();try{const r=await fetch('/takeover/api/transport-fallback/'+encodeURIComponent(sessionId),{method:'POST',cache:'no-store',headers:{'x-mcp-handoff-fallback':f}});if(!r.ok)return false;const d=await r.json();if(!d||typeof d.path!=='string'||!d.path.startsWith('/takeover/'))return false;location.replace(d.path);return true}catch{return false}}";
}
function managedWebSocketFallbackHelper() {
    return "let managedFallbackStarted=false,managedReadyTimer=0,managedReconnectAttempts=0,managedReconnectDeadline=0,managedStabilityTimer=0,managedReconnectStartedAt=0,managedReconnectFrameLoadedAt=0,managedReconnectReadyReported=false;const managedReconnectLimit=4,managedReconnectWindowMs=8000,managedReconnectStableMs=1500,managedHandledSockets=new WeakSet();function clearManagedReadyTimeout(){if(managedReadyTimer){clearTimeout(managedReadyTimer);managedReadyTimer=0}}function clearManagedStabilityTimer(){if(managedStabilityTimer){clearTimeout(managedStabilityTimer);managedStabilityTimer=0}}function flushManagedReconnectFrameLatency(){if(!managedReconnectStartedAt||!managedReconnectFrameLoadedAt||!ready)return;if(latency('client_reconnect_frame',managedReconnectFrameLoadedAt-managedReconnectStartedAt)){managedReconnectStartedAt=0;managedReconnectFrameLoadedAt=0;managedReconnectReadyReported=false}}function managedWebSocketFrameLoaded(loadedAt){if(!managedReconnectStartedAt||managedReconnectFrameLoadedAt)return;managedReconnectFrameLoadedAt=loadedAt;flushManagedReconnectFrameLatency()}function managedWebSocketReady(){clearManagedReadyTimeout();clearManagedStabilityTimer();if(managedReconnectStartedAt&&!managedReconnectReadyReported&&latency('client_reconnect_ready',performance.now()-managedReconnectStartedAt))managedReconnectReadyReported=true;flushManagedReconnectFrameLatency();managedStabilityTimer=setTimeout(()=>{managedStabilityTimer=0;if(ready&&!stopped){managedReconnectAttempts=0;managedReconnectDeadline=0}},managedReconnectStableMs)}function armManagedReadyTimeout(){clearManagedReadyTimeout();managedReadyTimer=setTimeout(()=>{managedReadyTimer=0;if(!ready&&!stopped)void managedTransportFallback()},10000)}function managedWebSocketDisconnected(ws,event){if(stopped||managedFallbackStarted||managedHandledSockets.has(ws))return;managedHandledSockets.add(ws);clearManagedReadyTimeout();clearManagedStabilityTimer();ready=false;const terminal=!!event&&(event.code===1008||event.code===1011);if(terminal){void managedTransportFallback();return}if(!managedReconnectStartedAt){managedReconnectStartedAt=performance.now();managedReconnectFrameLoadedAt=0;managedReconnectReadyReported=false}const now=Date.now();if(!managedReconnectDeadline)managedReconnectDeadline=now+managedReconnectWindowMs;if(now>=managedReconnectDeadline||managedReconnectAttempts>=managedReconnectLimit){void managedTransportFallback();return}managedReconnectAttempts+=1;const delay=Math.min(1000,600+200*(managedReconnectAttempts-1));setStatus('Reconnecting…');setTimeout(()=>{if(stopped||managedFallbackStarted)return;if(Date.now()>=managedReconnectDeadline){void managedTransportFallback();return}armManagedReadyTimeout();void connect().catch(()=>{if(!stopped)void managedTransportFallback()})},delay)}async function managedTransportFallback(){const f=app.dataset.fallback||'';if(!f||managedFallbackStarted||stopped)return false;managedFallbackStarted=true;clearManagedReadyTimeout();clearManagedStabilityTimer();try{const r=await fetch('/takeover/api/transport-fallback/'+encodeURIComponent(id),{method:'POST',cache:'no-store',headers:{'x-mcp-handoff-fallback':f}});if(r.ok){const d=await r.json();if(d&&typeof d.path==='string'&&d.path.startsWith('/takeover/')){location.replace(d.path);return true}}}catch{}stopped=true;setStatus('Session unavailable');return false}";
}
function cloneResponse(response, body) {
    return new Response(body, { status: response.status, headers: new Headers(response.headers) });
}
function json(status, body) {
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
//# sourceMappingURL=managed-handoff-runtime.js.map