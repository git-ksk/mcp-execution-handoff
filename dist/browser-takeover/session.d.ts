export interface TakeoverLocator {
    id: string;
    interventionId: string;
    epoch: number;
    principalBinding: string;
    expiresAt: number;
}
export interface TakeoverGrant extends TakeoverLocator {
    capability: string;
    clientBinding: string;
}
export declare class TakeoverSessionError extends Error {
    readonly code: "TAKEOVER_NOT_FOUND" | "TAKEOVER_EXPIRED" | "TAKEOVER_FORBIDDEN";
    constructor(code: "TAKEOVER_NOT_FOUND" | "TAKEOVER_EXPIRED" | "TAKEOVER_FORBIDDEN", message: string);
}
export declare class TakeoverSessionManager {
    private readonly ttlMs;
    private readonly now;
    private readonly createId;
    private readonly signingKey;
    private readonly records;
    constructor(ttlMs: number, now?: () => number, createId?: () => string, signingKey?: Buffer);
    ensure(interventionId: string, epoch: number, principalBinding: string): TakeoverLocator;
    validateLocator(id: string, principalBinding: string): TakeoverLocator;
    claimClient(id: string, principalBinding: string, clientBinding: string): TakeoverGrant;
    verify(id: string, capability: string, principalBinding: string, clientBinding: string): Omit<TakeoverGrant, "capability">;
    revoke(id: string): void;
    revokeForIntervention(interventionId: string): void;
    private requireActive;
    private assertPrincipal;
    private assertClient;
    private assertClientBindingShape;
    private same;
    private locator;
    private grant;
    private capabilityFor;
    private pruneExpired;
}
//# sourceMappingURL=session.d.ts.map