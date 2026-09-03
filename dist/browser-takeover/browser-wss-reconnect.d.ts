/** Bounded reconnect policy for the Handoff-owned normal-browser WSS client. */
export declare const BROWSER_WSS_RECONNECT_MAX_ATTEMPTS = 5;
/** Only transport/lifecycle closes may mint a fresh WSS generation. Policy/server failures stay terminal. */
export declare function browserWssCloseIsReconnectable(code: number): boolean;
/** Short bounded exponential retry: 250, 500, 1000, 2000, 2000 ms. */
export declare function browserWssReconnectDelayMs(attempt: number): number;
/** Emit the same pure reconnect helpers into the isolated browser page. */
export declare function browserWssReconnectClientSource(): string;
//# sourceMappingURL=browser-wss-reconnect.d.ts.map