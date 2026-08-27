import { type NativeTakeoverRuntimeProvider } from "./native-runtime.js";
import { type WebRtcHumanInputPolicy, type WebRtcTakeoverRuntimeProvider } from "./webrtc-runtime.js";
export interface TakeoverInterventionRef {
    id: string;
    epoch: number;
}
export interface TakeoverHostTarget {
    processId: number;
    windowId?: number;
}
export interface TakeoverBrowserAdapter {
    captureHumanTakeoverFrame(interventionId: string, epoch: number): Promise<{
        data: string;
        width: number;
        height: number;
        hostname: string;
        mimeType?: "image/jpeg" | "image/png";
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
    reconnectIdleMs?: number;
    completionGraceMs?: number;
}
export interface TakeoverCompletionEvent {
    interventionId: string;
    epoch: number;
}
export interface TakeoverBrokerHooks {
    completed?(event: TakeoverCompletionEvent): void | Promise<void>;
}
export declare class TakeoverBroker {
    private readonly browser;
    private readonly config;
    private readonly nativeRuntime?;
    private readonly webRtcRuntime?;
    private readonly hooks;
    private readonly sessions;
    private readonly publicOrigin;
    private readonly nativeOnlySessions;
    private readonly webRtcOnlySessions;
    private readonly webSocketOnlySessions;
    private readonly webSocketRevokeHandlers;
    private readonly nativeTargetProcessIds;
    private readonly nativeTargetWindowIds;
    private readonly webRtcTargetProcessIds;
    private readonly webRtcTargetWindowIds;
    private readonly webRtcInputPolicies;
    private readonly completionDelivered;
    private readonly completionGraceMs;
    private readonly webRtcConnectInFlight;
    constructor(browser: TakeoverBrowserAdapter, config: TakeoverBrokerConfig, nativeRuntime?: NativeTakeoverRuntimeProvider | undefined, webRtcRuntime?: WebRtcTakeoverRuntimeProvider | undefined, hooks?: TakeoverBrokerHooks);
    isEnabled(): boolean;
    isPath(pathname: string): boolean;
    createLink(intervention: TakeoverInterventionRef, principalBinding: string | undefined): string | undefined;
    createNativeLink(intervention: TakeoverInterventionRef, principalBinding: string | undefined, target?: TakeoverHostTarget): string | undefined;
    createWebRtcLink(intervention: TakeoverInterventionRef, principalBinding: string | undefined, target?: TakeoverHostTarget, inputPolicy?: WebRtcHumanInputPolicy): string | undefined;
    revokeForIntervention(interventionId: string): void;
    revokeNativeForIntervention(interventionId: string): Promise<void>;
    revokeWebRtcForIntervention(interventionId: string): Promise<void>;
    completeWebRtcAfterVerification(intervention: TakeoverInterventionRef): Promise<boolean>;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    private createExperimentalWebSocketSession;
    private attachExperimentalWebSocketRevokeHandler;
    private completeExperimentalWebSocketSession;
    private revokeExperimentalWebSocketSession;
    private forgetWebSocketOnlySession;
    private forgetWebSocketOnlyIntervention;
    private webRtcHooks;
    private forgetNativeOnlyIntervention;
    private forgetWebRtcOnlyIntervention;
    private webRtcInputPolicy;
    private publicGrant;
    private readBoundedJson;
    private readCapability;
    private readClientBinding;
    private readReconnectHandle;
    private readCompletionCapability;
    private nativeMutationAllowed;
    private sameOriginMutation;
    private dispatchInput;
}
//# sourceMappingURL=broker.d.ts.map