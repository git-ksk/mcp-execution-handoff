import type { ExternalHumanSurfaceGrant, ExternalHumanSurfaceProvider, ExternalHumanSurfaceRequest } from "../core/human-surface.js";
import { TakeoverBroker } from "./broker.js";
export declare class HostedBrowserTakeoverProvider implements ExternalHumanSurfaceProvider {
    private readonly broker;
    readonly kind = "hosted-browser-takeover";
    private readonly active;
    constructor(broker: TakeoverBroker);
    begin(request: ExternalHumanSurfaceRequest): Promise<ExternalHumanSurfaceGrant>;
    revoke(sessionId: string): Promise<void>;
    private sessionIdFromLocator;
    private assertRequest;
}
//# sourceMappingURL=hosted-browser-provider.d.ts.map