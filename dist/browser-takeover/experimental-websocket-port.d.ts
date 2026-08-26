import type { TakeoverCompletionResult, TakeoverLocator, TakeoverSessionManager } from "./session.js";
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
    createSession(intervention: ExperimentalWebSocketInterventionRef, principalBinding: string | undefined): ExperimentalWebSocketBrokerSession | undefined;
    attachRevokeHandler(sessionId: string, handler: () => void | Promise<void>): boolean;
    completeSession(completion: TakeoverCompletionResult): Promise<void>;
    revokeSession(sessionId: string): void;
}
export declare function registerExperimentalWebSocketBrokerPort(broker: object, port: ExperimentalWebSocketBrokerInternalPort): void;
export declare function experimentalWebSocketBrokerPort(broker: object): ExperimentalWebSocketBrokerInternalPort;
//# sourceMappingURL=experimental-websocket-port.d.ts.map