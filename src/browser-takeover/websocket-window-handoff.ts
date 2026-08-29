import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  TakeoverBroker,
  type TakeoverBrokerConfig,
  type TakeoverBrowserAdapter,
  type TakeoverCompletionEvent,
  type TakeoverHostTarget,
  type TakeoverInterventionRef
} from "../browser-takeover/broker.js";
import {
  validWindowHandoffInputPolicy,
  validWindowHandoffTarget
} from "../window-takeover/window-handoff-core.js";
import { ExperimentalWebSocketBrokerBinding } from "./websocket-broker-binding.js";
import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";
import type {
  WebSocketTakeoverFrame,
  WebSocketTakeoverHumanInput,
  WebSocketTakeoverInputPolicy
} from "./websocket-takeover.js";

export type ExperimentalWebSocketWindowCaptureFailureDisposition = "recoverable" | "authority_lost";

export interface ExperimentalWebSocketWindowSurface {
  /**
   * Capture only the supplied exact process/window boundary. Implementations must fail closed when
   * the target is missing, ambiguous, moved outside the authorized boundary, or otherwise cannot
   * be revalidated. They must never widen to a display/desktop capture.
   */
  captureExactWindow(target: Readonly<TakeoverHostTarget>): Promise<WebSocketTakeoverFrame>;
  /** Unknown failures default to authority_lost so generic surfaces remain fail closed. */
  captureFailureDisposition?(error: unknown): ExperimentalWebSocketWindowCaptureFailureDisposition;
  tapExactWindow(target: Readonly<TakeoverHostTarget>, x: number, y: number): Promise<void>;
  scrollExactWindow(target: Readonly<TakeoverHostTarget>, deltaY: number): Promise<void>;
  insertExactWindowText(target: Readonly<TakeoverHostTarget>, text: string): Promise<void>;
  pressExactWindowKey(target: Readonly<TakeoverHostTarget>, key: string): Promise<void>;
}

export interface ExperimentalWebSocketWindowHandoffConfig {
  takeover: TakeoverBrokerConfig;
  allowedOrigins: readonly string[];
  surface: ExperimentalWebSocketWindowSurface;
  frameIntervalMs?: number;
  maxInboundBytes?: number;
  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;
  /** Called only after the shared Human generation has been fenced. */
  onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
}

export interface ExperimentalWebSocketWindowStartRequest {
  intervention: TakeoverInterventionRef;
  principalBinding: string;
  target: TakeoverHostTarget;
  inputPolicy: WebSocketTakeoverInputPolicy;
}

export class ExperimentalWebSocketWindowHandoffError extends Error {
  constructor(
    public readonly code:
      | "WINDOW_HANDOFF_UNAVAILABLE"
      | "WINDOW_HANDOFF_TARGET_INVALID"
      | "WINDOW_HANDOFF_INPUT_POLICY_INVALID",
    message: string
  ) {
    super(message);
    this.name = "ExperimentalWebSocketWindowHandoffError";
  }
}

interface ActiveWindowSession {
  readonly interventionId: string;
  readonly epoch: number;
  readonly principalBinding: string;
  readonly sessionId: string;
  readonly locator: string;
  readonly target: TakeoverHostTarget;
  readonly inputPolicy: WebSocketTakeoverInputPolicy;
  readonly timer: NodeJS.Timeout;
  captureInFlight: boolean;
}

/**
 * Private Generic Window composition for the #40 WSS experiment.
 *
 * Consumers still provide only Handoff semantics plus an exact Window target. WSS framing,
 * bootstrap tickets, connection state and frame pumping remain Handoff-owned. The exact target is
 * retained only in process memory and is never sent to the browser or stored in transport messages.
 */
export class ExperimentalWebSocketWindowHandoff {
  readonly #broker: TakeoverBroker;
  readonly #binding: ExperimentalWebSocketBrokerBinding;
  readonly #surface: ExperimentalWebSocketWindowSurface;
  readonly #frameIntervalMs: number;
  readonly #sessionsByIntervention = new Map<string, ActiveWindowSession>();
  readonly #sessionsById = new Map<string, ActiveWindowSession>();
  readonly #onDiagnosticEvent: ((kind: ManagedOperatorDiagnosticEventKind) => void) | undefined;

  constructor(config: ExperimentalWebSocketWindowHandoffConfig) {
    this.#surface = config.surface;
    this.#onDiagnosticEvent = config.onDiagnosticEvent;
    this.#frameIntervalMs = boundedFrameInterval(config.frameIntervalMs);
    this.#broker = new TakeoverBroker(
      unavailableHttpSurface(),
      config.takeover,
      undefined,
      undefined,
      config.onComplete
        ? {
            completed: async (event) => {
              this.#forgetMatchingSession(event.interventionId, event.epoch);
              await config.onComplete!(event);
            }
          }
        : {
            completed: (event) => {
              this.#forgetMatchingSession(event.interventionId, event.epoch);
            }
          }
    );
    this.#binding = new ExperimentalWebSocketBrokerBinding(this.#broker, {
      allowedOrigins: config.allowedOrigins,
      onInput: (binding, input) => this.#dispatchInput(binding.interventionId, binding.epoch, input),
      ...(config.maxInboundBytes === undefined ? {} : { maxInboundBytes: config.maxInboundBytes }),
      ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {})
    });
  }

  start(request: ExperimentalWebSocketWindowStartRequest): string {
    if (!validWindowHandoffTarget(request.target)) {
      throw new ExperimentalWebSocketWindowHandoffError(
        "WINDOW_HANDOFF_TARGET_INVALID",
        "bounded Window WSS Handoff requires a positive process id and an optional positive window id"
      );
    }
    if (!validWindowHandoffInputPolicy(request.inputPolicy)) {
      throw new ExperimentalWebSocketWindowHandoffError(
        "WINDOW_HANDOFF_INPUT_POLICY_INVALID",
        "bounded Window WSS Handoff requires an explicit Human input policy"
      );
    }

    const existing = this.#sessionsByIntervention.get(request.intervention.id);
    if (existing) {
      if (request.intervention.epoch < existing.epoch) {
        throw new ExperimentalWebSocketWindowHandoffError(
          "WINDOW_HANDOFF_UNAVAILABLE",
          "stale Window WSS Handoff epoch is unavailable"
        );
      }
      if (request.intervention.epoch === existing.epoch) {
        if (
          existing.principalBinding !== request.principalBinding
          || !sameTarget(existing.target, request.target)
          || !sameInputPolicy(existing.inputPolicy, request.inputPolicy)
        ) {
          throw new ExperimentalWebSocketWindowHandoffError(
            "WINDOW_HANDOFF_UNAVAILABLE",
            "active Window WSS Handoff binding cannot be widened or replaced"
          );
        }
        return existing.locator;
      }
      this.revoke(request.intervention.id);
    }

    const locator = this.#binding.createLink(
      request.intervention,
      request.principalBinding,
      request.inputPolicy
    );
    if (!locator) {
      throw new ExperimentalWebSocketWindowHandoffError(
        "WINDOW_HANDOFF_UNAVAILABLE",
        "bounded Window WSS Handoff is unavailable"
      );
    }
    const sessionId = sessionIdFromLocator(locator);
    if (!sessionId) {
      this.#broker.revokeForIntervention(request.intervention.id);
      throw new ExperimentalWebSocketWindowHandoffError(
        "WINDOW_HANDOFF_UNAVAILABLE",
        "bounded Window WSS locator is invalid"
      );
    }

    const target = { ...request.target };
    const inputPolicy = { ...request.inputPolicy };
    let state!: ActiveWindowSession;
    const timer = setInterval(() => void this.#pumpFrame(state), this.#frameIntervalMs);
    timer.unref();
    state = {
      interventionId: request.intervention.id,
      epoch: request.intervention.epoch,
      principalBinding: request.principalBinding,
      sessionId,
      locator,
      target,
      inputPolicy,
      timer,
      captureInFlight: false
    };
    this.#sessionsByIntervention.set(state.interventionId, state);
    this.#sessionsById.set(state.sessionId, state);
    return locator;
  }

  authorizeClientPage(sessionId: string, boundPrincipal: string | undefined): boolean {
    return this.#sessionsById.has(sessionId) && this.#binding.validateLocator(sessionId, boundPrincipal);
  }

  /** @internal Content-free WSS ingress diagnostics for managed physical acceptance. */
  diagnosticsSnapshot(): ReturnType<ExperimentalWebSocketBrokerBinding["diagnosticsSnapshot"]> {
    return this.#binding.diagnosticsSnapshot();
  }

  handle(request: Request, boundPrincipal: string | undefined): Promise<Response> | Response {
    return this.#binding.handleBootstrap(request, boundPrincipal)
      ?? this.#broker.handle(request, boundPrincipal);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    return this.#binding.handleUpgrade(request, socket, head);
  }

  ownsPath(pathname: string): boolean {
    const sessionId = sessionIdFromPath(pathname);
    return sessionId !== undefined && this.#sessionsById.has(sessionId);
  }

  revoke(interventionId: string): void {
    if (this.#sessionsByIntervention.has(interventionId)) this.#onDiagnosticEvent?.("session_revoked");
    this.#forgetIntervention(interventionId);
    this.#broker.revokeForIntervention(interventionId);
  }

  async #pumpFrame(state: ActiveWindowSession): Promise<void> {
    if (state.captureInFlight || this.#sessionsById.get(state.sessionId) !== state) return;
    if (!this.#binding.hasActiveConnection(state.sessionId)) return;
    state.captureInFlight = true;
    let frame: WebSocketTakeoverFrame;
    try {
      frame = await this.#surface.captureExactWindow(state.target);
    } catch (error) {
      const disposition = this.#surface.captureFailureDisposition?.(error) ?? "authority_lost";
      if (disposition === "recoverable") {
        this.#onDiagnosticEvent?.("session_retained");
        return;
      }
      this.revoke(state.interventionId);
      return;
    } finally {
      state.captureInFlight = false;
    }
    if (this.#sessionsById.get(state.sessionId) !== state) return;
    try {
      await this.#binding.pushFrame(state.sessionId, frame);
    } catch {
      // The channel itself fails closed and releases the generation on transport/backpressure
      // failure. A later authenticated reconnect may claim only a fresh generation.
    }
  }

  async #dispatchInput(
    interventionId: string,
    epoch: number,
    input: WebSocketTakeoverHumanInput
  ): Promise<void> {
    const state = this.#sessionsByIntervention.get(interventionId);
    if (!state || state.epoch !== epoch || this.#sessionsById.get(state.sessionId) !== state) {
      throw new ExperimentalWebSocketWindowHandoffError(
        "WINDOW_HANDOFF_UNAVAILABLE",
        "bounded Window WSS target binding is stale"
      );
    }
    switch (input.kind) {
      case "tap":
        await this.#surface.tapExactWindow(state.target, input.x, input.y);
        return;
      case "scroll":
        await this.#surface.scrollExactWindow(state.target, input.deltaY);
        return;
      case "text":
        await this.#surface.insertExactWindowText(state.target, input.text);
        return;
      case "key":
        await this.#surface.pressExactWindowKey(state.target, input.key);
        return;
    }
  }

  #forgetMatchingSession(interventionId: string, epoch: number): void {
    const state = this.#sessionsByIntervention.get(interventionId);
    if (state?.epoch === epoch) this.#forgetSession(state);
  }

  #forgetIntervention(interventionId: string): void {
    const state = this.#sessionsByIntervention.get(interventionId);
    if (state) this.#forgetSession(state);
  }

  #forgetSession(state: ActiveWindowSession): void {
    if (this.#sessionsByIntervention.get(state.interventionId) === state) {
      this.#sessionsByIntervention.delete(state.interventionId);
    }
    if (this.#sessionsById.get(state.sessionId) === state) this.#sessionsById.delete(state.sessionId);
    clearInterval(state.timer);
  }
}

function unavailableHttpSurface(): TakeoverBrowserAdapter {
  const unavailable = async (): Promise<never> => {
    throw new ExperimentalWebSocketWindowHandoffError(
      "WINDOW_HANDOFF_UNAVAILABLE",
      "legacy HTTP frame/input is unavailable through bounded Window WSS Handoff"
    );
  };
  return {
    captureHumanTakeoverFrame: unavailable,
    tapHumanTakeover: unavailable,
    scrollHumanTakeover: unavailable,
    insertHumanTakeoverText: unavailable,
    pressHumanTakeoverKey: unavailable
  };
}

function boundedFrameInterval(value: number | undefined): number {
  const resolved = value ?? 150;
  if (!Number.isInteger(resolved) || resolved < 50 || resolved > 2_000) {
    throw new Error("Window WSS frame interval must be an integer between 50ms and 2000ms");
  }
  return resolved;
}

function sameTarget(left: TakeoverHostTarget, right: TakeoverHostTarget): boolean {
  return left.processId === right.processId && left.windowId === right.windowId;
}

function sameInputPolicy(
  left: WebSocketTakeoverInputPolicy,
  right: WebSocketTakeoverInputPolicy
): boolean {
  return left.tap === right.tap
    && left.scroll === right.scroll
    && left.text === right.text
    && left.key === right.key;
}

function sessionIdFromLocator(locator: string): string | undefined {
  try {
    return sessionIdFromPath(new URL(locator).pathname);
  } catch {
    return undefined;
  }
}

function sessionIdFromPath(pathname: string): string | undefined {
  const page = /^\/takeover\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
  if (page) return page[1];
  const api = /^\/takeover\/api\/[a-z0-9-]+\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
  if (api) return api[1];
  const ws = /^\/takeover\/ws\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
  return ws?.[1];
}
