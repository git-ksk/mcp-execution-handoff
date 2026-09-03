/** Bounded reconnect policy for the Handoff-owned normal-browser WSS client. */
export const BROWSER_WSS_RECONNECT_MAX_ATTEMPTS = 5;
/** Only transport/lifecycle closes may mint a fresh WSS generation. Policy/server failures stay terminal. */
export function browserWssCloseIsReconnectable(code) {
    return code === 1001 || code === 1006;
}
/** Short bounded exponential retry: 250, 500, 1000, 2000, 2000 ms. */
export function browserWssReconnectDelayMs(attempt) {
    if (!Number.isSafeInteger(attempt) || attempt < 0)
        return 2_000;
    return Math.min(2_000, 250 * (2 ** Math.min(attempt, 3)));
}
/** Emit the same pure reconnect helpers into the isolated browser page. */
export function browserWssReconnectClientSource() {
    return [
        `const browserWssCloseIsReconnectable=${browserWssCloseIsReconnectable.toString()};`,
        `const browserWssReconnectDelayMs=${browserWssReconnectDelayMs.toString()};`,
        `const browserWssReconnectMaxAttempts=${BROWSER_WSS_RECONNECT_MAX_ATTEMPTS};`
    ].join("");
}
//# sourceMappingURL=browser-wss-reconnect.js.map