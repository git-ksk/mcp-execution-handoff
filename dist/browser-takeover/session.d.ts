export interface TakeoverLocator {
    id: string;
    interventionId: string;
    epoch: number;
    principalBinding: string;
    expiresAt: number;
}
export interface TakeoverGrant extends TakeoverLocator {
    capability: string;
    reconnectHandle: string;
    clientBinding: string;
    clientGeneration: number;
}
export declare class TakeoverSessionError extends Error {
    readonly code: "TAKEOVER_NOT_FOUND" | "TAKEOVER_EXPIRED" | "TAKEOVER_FORBIDDEN" | "TAKEOVER_CLIENT_ACTIVE";
    constructor(code: "TAKEOVER_NOT_FOUND" | "TAKEOVER_EXPIRED" | "TAKEOVER_FORBIDDEN" | "TAKEOVER_CLIENT_ACTIVE", message: string);
}
export declare class TakeoverSessionManager {
    private readonly ttlMs;
    private readonly now;
    private readonly createId;
    private readonly signingKey;
    private readonly reconnectIdleMs;
    private readonly records;
    constructor(ttlMs: number, now?: () => number, createId?: () => string, signingKey?: Buffer, reconnectIdleMs?: number);
    ensure(interventionId: string, epoch: number, principalBinding: string): TakeoverLocator;
    validateLocator(id: string, principalBinding: string): TakeoverLocator;
    claimClient(id: string, principalBinding: string, clientBinding: string): TakeoverGrant;
    reconnectClient(id: string, principalBinding: string, reconnectHandle: string, nextClientBinding: string): TakeoverGrant;
    releaseClientGeneration(id: string, principalBinding: string, clientBinding: string, clientGeneration: number): void;
    beginBoundUse(id: string, principalBinding: string, clientBinding: string, clientGeneration: number): Omit<TakeoverGrant, "capability" | "reconnectHandle">;
    beginUse(id: string, capability: string, principalBinding: string, clientBinding: string): Omit<TakeoverGrant, "capability" | "reconnectHandle">;
    endUse(id: string, principalBinding: string, clientBinding: string, clientGeneration: number): void;
    verify(id: string, capability: string, principalBinding: string, clientBinding: string): Omit<TakeoverGrant, "capability" | "reconnectHandle">;
    revoke(id: string): void;
    revokeForIntervention(interventionId: string): void;
    private requireActive;
    private assertPrincipal;
    private assertClient;
    private assertClientBindingShape;
    private assertReconnectHandleShape;
    private assertReconnectHandle;
    private same;
    private locator;
    private grant;
    private capabilityFor;
    private reconnectHandleFor;
    private pruneExpired;
}
//# sourceMappingURL=session.d.ts.map