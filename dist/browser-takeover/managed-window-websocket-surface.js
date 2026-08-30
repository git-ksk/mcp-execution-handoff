import { ExperimentalLinuxWebSocketWindowSurface as LinuxWebSocketWindowSurface } from "./linux-websocket-window-surface.js";
import { MacOSWebSocketWindowSurface } from "./macos-websocket-window-surface.js";
export function resolveManagedWindowWebSocketPlatform(host) {
    const configured = host.platform ?? "auto";
    if (configured !== "auto" && configured !== "macos" && configured !== "linux") {
        throw new Error("Managed Window WSS platform is invalid");
    }
    if (configured === "macos" || configured === "linux")
        return configured;
    if (process.platform === "darwin")
        return "macos";
    if (process.platform === "linux")
        return "linux";
    throw new Error("Managed Window WSS is unsupported on this host platform");
}
/** Construct one exact-window WSS surface without exposing a concrete OS class to consumers. */
export function createManagedWindowWebSocketSurface(config) {
    const platform = resolveManagedWindowWebSocketPlatform(config.host);
    if (platform === "macos") {
        return new MacOSWebSocketWindowSurface({
            hostExecutable: config.host.macosHostExecutable ?? config.runtime.hostExecutable,
            helperTtlMs: config.helperTtlMs,
            ...(config.initialSecureWindowPolicy
                ? { initialSecureWindowPolicy: config.initialSecureWindowPolicy }
                : {}),
            ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {})
        });
    }
    if (config.initialSecureWindowPolicy) {
        throw new Error("Managed Linux WSS does not support macOS LocalAuthentication authority");
    }
    const displayName = config.host.displayName ?? config.runtime.displayName;
    if (!config.host.linuxHostScript || !displayName) {
        throw new Error("Managed Linux WSS requires an exact-window host script and local X11 display");
    }
    return new LinuxWebSocketWindowSurface({
        hostScript: config.host.linuxHostScript,
        displayName,
        helperTtlMs: config.helperTtlMs,
        ...(config.host.xdotoolExecutable ? { xdotoolExecutable: config.host.xdotoolExecutable } : {}),
        ...(config.host.authorityHelperExecutable
            ? { authorityHelperExecutable: config.host.authorityHelperExecutable }
            : {}),
        ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {}),
        ...(config.latencyTracker ? { latencyTracker: config.latencyTracker } : {})
    });
}
//# sourceMappingURL=managed-window-websocket-surface.js.map