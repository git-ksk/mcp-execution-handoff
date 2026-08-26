export type ExperimentalTerminalWebRtcEvent = {
    kind: "input";
    dataBase64: string;
} | {
    kind: "resize";
    rows: number;
    cols: number;
} | {
    kind: "done";
};
export interface ExperimentalTerminalWebRtcStatus {
    transportReady: boolean;
    humanActive: boolean;
    disconnected: boolean;
    completed: boolean;
    faulted: boolean;
    clientGeneration?: number;
    queuedEvents: number;
}
export interface ExperimentalTerminalWebRtcConfig {
    enabled: boolean;
    publicBaseUrl?: string;
    ttlMs: number;
    reconnectIdleMs?: number;
    env?: NodeJS.ProcessEnv;
}
export declare class ExperimentalTerminalWebRtcTakeover {
    #private;
    private readonly config;
    constructor(config: ExperimentalTerminalWebRtcConfig);
    isPath(pathname: string): boolean;
    start(interventionId: string, epoch: number, principalBinding: string): string;
    status(interventionId: string, epoch: number): ExperimentalTerminalWebRtcStatus;
    activateHuman(interventionId: string, epoch: number): void;
    fenceHuman(interventionId: string, epoch: number): void;
    /**
     * Transport-adapter callback only. A stale generation cannot fence the current Human peer, and
     * disconnect never advances the Handoff lifecycle or implies Done.
     */
    noteTransportDisconnect(interventionId: string, epoch: number, generation: number): void;
    drainEvents(interventionId: string, epoch: number): ExperimentalTerminalWebRtcEvent[];
    nextEvent(interventionId: string, epoch: number): ExperimentalTerminalWebRtcEvent | undefined;
    pushOutput(interventionId: string, epoch: number, dataBase64: string): void;
    /** Release only a transport already fenced/completed by ordered Human Done. */
    releaseCompleted(interventionId: string, epoch: number): void;
    revoke(interventionId: string, epoch: number): Promise<void>;
    handle(request: Request): Promise<Response>;
    private handlePage;
    private handlePrepare;
    private handleConnect;
    private acceptMessage;
    private faultSession;
    private requireIntervention;
    private sameOriginMutation;
}
//# sourceMappingURL=terminal-webrtc.d.ts.map