import type {
  TakeoverCompletionResult,
  TakeoverLocator,
  TakeoverSessionManager
} from "./session.js";

export interface ExperimentalWebSocketInterventionRef {
  id: string;
  epoch: number;
}

export interface ExperimentalWebSocketBrokerSession {
  locator: TakeoverLocator;
  url: string;
}

export interface ExperimentalWebSocketBrokerInternalPort {
  readonly sessions: TakeoverSessionManager;
  createSession(
    intervention: ExperimentalWebSocketInterventionRef,
    principalBinding: string | undefined
  ): ExperimentalWebSocketBrokerSession | undefined;
  attachRevokeHandler(
    sessionId: string,
    handler: () => void | Promise<void>
  ): boolean;
  completeSession(completion: TakeoverCompletionResult): Promise<void>;
  revokeSession(sessionId: string): void;
}

const PORTS = new WeakMap<object, ExperimentalWebSocketBrokerInternalPort>();

export function registerExperimentalWebSocketBrokerPort(
  broker: object,
  port: ExperimentalWebSocketBrokerInternalPort
): void {
  if (PORTS.has(broker)) throw new Error("experimental WebSocket broker port already registered");
  PORTS.set(broker, port);
}

export function experimentalWebSocketBrokerPort(
  broker: object
): ExperimentalWebSocketBrokerInternalPort {
  const port = PORTS.get(broker);
  if (!port) throw new Error("TakeoverBroker experimental WebSocket port is unavailable");
  return port;
}
