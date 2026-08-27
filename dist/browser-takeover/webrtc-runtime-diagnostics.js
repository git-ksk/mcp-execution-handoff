import { spawn } from "node:child_process";
import { SpawnedWebRtcRuntimeProvider as BaseSpawnedWebRtcRuntimeProvider } from "./webrtc-runtime.js";
export * from "./webrtc-runtime.js";
const HOST_EXIT_REASON = /^(stdin_eof|permission|window_resolution|capture_start|encoder|lease_expiry|explicit_stop|target_unavailable|unexpected)$/;
const HOST_EXIT_PREFIX = "MCP_HANDOFF_DIAGNOSTIC host_exit_reason=";
const MAX_DIAGNOSTIC_BUFFER_CHARS = 2_048;
/**
 * Public WebRTC runtime provider with a privacy-preserving observer around the helper process.
 *
 * The base runtime remains the sole owner of peer/media/input lifecycle. This subclass only wraps
 * the already-configurable spawn seam so an unexpected helper exit can be attributed without
 * logging raw stderr, SDP, candidate addresses, media, Human input, process targets, or secrets.
 */
export class SpawnedWebRtcRuntimeProvider extends BaseSpawnedWebRtcRuntimeProvider {
    constructor(config) {
        const spawnProcess = config.spawnProcess ?? spawn;
        super({
            ...config,
            spawnProcess: withHostExitDiagnostics(spawnProcess)
        });
    }
}
function withHostExitDiagnostics(spawnProcess) {
    return ((...args) => {
        const child = spawnProcess(...args);
        observeHostExit(child);
        return child;
    });
}
function observeHostExit(child) {
    const stderr = child.stderr;
    let reason;
    let buffer = "";
    if (stderr) {
        stderr.on("data", (chunk) => {
            buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
            if (buffer.length > MAX_DIAGNOSTIC_BUFFER_CHARS) {
                buffer = buffer.slice(-MAX_DIAGNOSTIC_BUFFER_CHARS);
            }
            for (;;) {
                const newline = buffer.indexOf("\n");
                if (newline < 0)
                    break;
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!line.startsWith(HOST_EXIT_PREFIX))
                    continue;
                const value = line.slice(HOST_EXIT_PREFIX.length);
                if (HOST_EXIT_REASON.test(value))
                    reason = value;
            }
        });
        stderr.once("end", () => { buffer = ""; });
    }
    child.once("close", (code, signal) => {
        // The base runtime uses SIGTERM for normal revoke/suspend cleanup. Keep routine successful
        // teardown silent unless the helper itself supplied a bounded reason before termination.
        if (!reason && signal === "SIGTERM")
            return;
        const exitCode = boundedExitCode(code);
        const exitSignal = boundedExitSignal(signal);
        console.error(`[mcp-execution-handoff] WebRTC host exited reason=${reason ?? "unexpected"} exit_code=${exitCode} signal=${exitSignal}`);
    });
}
function boundedExitCode(value) {
    if (value === null || !Number.isSafeInteger(value) || value < 0 || value > 255)
        return "none";
    return String(value);
}
function boundedExitSignal(value) {
    if (value === null)
        return "none";
    return /^SIG[A-Z0-9]{1,12}$/.test(value) ? value : "other";
}
//# sourceMappingURL=webrtc-runtime-diagnostics.js.map