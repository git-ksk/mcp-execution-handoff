export interface TakeoverInterventionRef {
    id: string;
    epoch: number;
}
export interface TakeoverBrowserAdapter {
    captureHumanTakeoverFrame(interventionId: string, epoch: number): Promise<{
        data: string;
        width: number;
        height: number;
        hostname: string;
    }>;
    tapHumanTakeover(interventionId: string, epoch: number, x: number, y: number): Promise<void>;
    scrollHumanTakeover(interventionId: string, epoch: number, deltaY: number): Promise<void>;
    insertHumanTakeoverText(interventionId: string, epoch: number, text: string): Promise<void>;
    pressHumanTakeoverKey(interventionId: string, epoch: number, key: string): Promise<void>;
}
export interface TakeoverBrokerConfig {
    enabled: boolean;
    publicBaseUrl?: string;
    ttlMs: number;
}
export declare class TakeoverBroker {
    private readonly browser;
    private readonly config;
    private readonly sessions;
    private readonly publicOrigin;
    constructor(browser: TakeoverBrowserAdapter, config: TakeoverBrokerConfig);
    isEnabled(): boolean;
    isPath(pathname: string): boolean;
    createLink(intervention: TakeoverInterventionRef, principalBinding: string | undefined): string | undefined;
    revokeForIntervention(interventionId: string): void;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    private readCapability;
    private readClientBinding;
    private sameOriginMutation;
    private dispatchInput;
}
//# sourceMappingURL=broker.d.ts.map