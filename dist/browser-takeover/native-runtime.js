import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
export class NativeTakeoverRuntimeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "NativeTakeoverRuntimeError";
    }
}
function validPort(value) {
    return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}
function inheritedKeyPipe(child, label) {
    const pipe = child.stdio[3];
    if (!pipe || typeof pipe.end !== "function") {
        throw new Error(`missing ${label} inherited key pipe`);
    }
    return pipe;
}
export function parseNativeTakeoverClientEndpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new NativeTakeoverRuntimeError("NATIVE_ENDPOINT_INVALID", "native client endpoint is invalid");
    }
    const record = value;
    const clientHost = typeof record.clientHost === "string" ? record.clientHost.trim() : "";
    if (!clientHost || isIP(clientHost) === 0) {
        throw new NativeTakeoverRuntimeError("NATIVE_ENDPOINT_INVALID", "native client host must be an IP literal");
    }
    const videoPort = Number(record.videoPort);
    const inputFeedbackPort = Number(record.inputFeedbackPort);
    if (!validPort(videoPort) || !validPort(inputFeedbackPort) || videoPort === inputFeedbackPort) {
        throw new NativeTakeoverRuntimeError("NATIVE_ENDPOINT_INVALID", "native client ports are invalid");
    }
    return { clientHost, videoPort, inputFeedbackPort };
}
export function nativeBindingFromGrant(grant, targetProcessId, targetWindowId) {
    return {
        takeoverSessionId: grant.id,
        interventionId: grant.interventionId,
        epoch: grant.epoch,
        principalBinding: grant.principalBinding,
        clientGeneration: grant.clientGeneration,
        expiresAt: grant.expiresAt,
        ...(targetProcessId === undefined ? {} : { targetProcessId }),
        ...(targetWindowId === undefined ? {} : { targetWindowId })
    };
}
/**
 * Reference local-macOS launcher for the Thin Takeover Runtime.
 *
 * The transport root key is generated per TakeoverBroker client generation and is sent to the
 * macOS host through inherited FD 3. It never appears in argv, the child environment, or durable
 * provider state. The only retained copy is this process-local Buffer, which is zeroed on revoke.
 */
export class InheritedFdNativeRuntimeProvider {
    config;
    active = new Map();
    spawnProcess;
    inputPort;
    controlPort;
    videoFeedbackPort;
    constructor(config) {
        this.config = config;
        if (!config.hostExecutable.trim() || !config.revokeExecutable.trim()) {
            throw new Error("native runtime executables must be configured");
        }
        if (!config.advertisedHost.trim() || !config.inputBindHost.trim() || !config.feedbackBindHost.trim()) {
            throw new Error("native runtime network hosts must be configured");
        }
        if (isIP(config.advertisedHost) === 0 || isIP(config.inputBindHost) === 0 || isIP(config.feedbackBindHost) === 0) {
            throw new Error("native runtime network hosts must be IP literals");
        }
        const controlBindHost = config.controlBindHost ?? "127.0.0.1";
        if (isIP(controlBindHost) === 0)
            throw new Error("native runtime control bind host must be an IP literal");
        this.inputPort = config.inputPort ?? 45_556;
        this.controlPort = config.controlPort ?? 45_557;
        this.videoFeedbackPort = config.videoFeedbackPort ?? 45_558;
        for (const port of [this.inputPort, this.controlPort, this.videoFeedbackPort]) {
            if (!validPort(port))
                throw new Error("native runtime ports must be 1-65535");
        }
        if (new Set([this.inputPort, this.controlPort, this.videoFeedbackPort]).size !== 3) {
            throw new Error("native runtime input/control/video-feedback ports must be distinct");
        }
        this.spawnProcess = config.spawnProcess ?? spawn;
    }
    async begin(binding, endpoint) {
        if (binding.targetWindowId !== undefined && binding.targetProcessId === undefined) {
            throw new NativeTakeoverRuntimeError("NATIVE_RUNTIME_START_FAILED", "native target window requires a target process");
        }
        const existing = this.active.get(binding.takeoverSessionId);
        if (existing) {
            if (existing.binding.clientGeneration === binding.clientGeneration) {
                throw new NativeTakeoverRuntimeError("NATIVE_BOOTSTRAP_ALREADY_ISSUED", "native bootstrap for this client generation has already been issued");
            }
            await this.revoke(binding.takeoverSessionId);
        }
        const rootKey = randomBytes(32);
        const sessionHashHex = randomBytes(8).toString("hex");
        const env = {
            ...process.env,
            THIN_TAKEOVER_SESSION_KEY_FD: "3",
            THIN_TAKEOVER_SESSION_HASH_HEX: sessionHashHex,
            THIN_TAKEOVER_EPOCH: String(binding.epoch),
            THIN_TAKEOVER_GENERATION: String(binding.clientGeneration),
            THIN_TAKEOVER_EXPIRES_AT_UNIX_MS: String(binding.expiresAt),
            THIN_TAKEOVER_INPUT_BIND_HOST: this.config.inputBindHost,
            THIN_TAKEOVER_CONTROL_BIND_HOST: this.config.controlBindHost ?? "127.0.0.1",
            THIN_TAKEOVER_FEEDBACK_BIND_HOST: this.config.feedbackBindHost
        };
        if (this.config.displayId !== undefined)
            env.THIN_TAKEOVER_DISPLAY_ID = String(this.config.displayId);
        if (binding.targetProcessId !== undefined)
            env.THIN_TAKEOVER_TARGET_PID = String(binding.targetProcessId);
        if (binding.targetWindowId !== undefined)
            env.THIN_TAKEOVER_TARGET_WINDOW_ID = String(binding.targetWindowId);
        delete env.THIN_TAKEOVER_SESSION_KEY_HEX;
        const args = [
            endpoint.clientHost,
            String(endpoint.videoPort),
            String(this.inputPort),
            String(this.controlPort),
            String(this.videoFeedbackPort),
            String(endpoint.inputFeedbackPort)
        ];
        let child;
        try {
            child = this.spawnProcess(this.config.hostExecutable, args, {
                env,
                stdio: ["ignore", "ignore", "ignore", "pipe"]
            });
            await this.waitForSpawn(child);
            inheritedKeyPipe(child, "host").end(rootKey);
        }
        catch (error) {
            rootKey.fill(0);
            throw new NativeTakeoverRuntimeError("NATIVE_RUNTIME_START_FAILED", `native runtime failed to start: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        const active = {
            binding: { ...binding },
            rootKey,
            sessionHashHex,
            child
        };
        this.active.set(binding.takeoverSessionId, active);
        child.once("exit", () => {
            const current = this.active.get(binding.takeoverSessionId);
            if (current?.child === child) {
                current.rootKey.fill(0);
                this.active.delete(binding.takeoverSessionId);
            }
        });
        return {
            rootKeyBase64Url: rootKey.toString("base64url"),
            sessionHashHex,
            epoch: binding.epoch,
            network: {
                host: this.config.advertisedHost,
                videoPort: endpoint.videoPort,
                inputPort: this.inputPort,
                videoFeedbackPort: this.videoFeedbackPort,
                inputFeedbackPort: endpoint.inputFeedbackPort
            }
        };
    }
    async revoke(takeoverSessionId) {
        const active = this.active.get(takeoverSessionId);
        if (!active)
            return;
        this.active.delete(takeoverSessionId);
        try {
            await this.sendAuthenticatedRevoke(active);
            await this.waitForExitOrTerminate(active.child);
        }
        catch (error) {
            active.child.kill("SIGTERM");
            throw new NativeTakeoverRuntimeError("NATIVE_RUNTIME_REVOKE_FAILED", `native runtime revoke failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        finally {
            active.rootKey.fill(0);
        }
    }
    async revokeForIntervention(interventionId) {
        const ids = [...this.active]
            .filter(([, runtime]) => runtime.binding.interventionId === interventionId)
            .map(([sessionId]) => sessionId);
        for (const id of ids)
            await this.revoke(id);
    }
    async sendAuthenticatedRevoke(active) {
        const env = {
            ...process.env,
            THIN_TAKEOVER_SESSION_KEY_FD: "3",
            THIN_TAKEOVER_SESSION_HASH_HEX: active.sessionHashHex,
            THIN_TAKEOVER_EPOCH: String(active.binding.epoch),
            THIN_TAKEOVER_GENERATION: String(active.binding.clientGeneration)
        };
        delete env.THIN_TAKEOVER_SESSION_KEY_HEX;
        const child = this.spawnProcess(this.config.revokeExecutable, [this.config.controlBindHost ?? "127.0.0.1", String(this.controlPort)], { env, stdio: ["ignore", "ignore", "ignore", "pipe"] });
        await this.waitForSpawn(child);
        inheritedKeyPipe(child, "revoke").end(active.rootKey);
        await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`revoke sender exited with code ${String(code)}`)));
        });
    }
    async waitForSpawn(child) {
        await new Promise((resolve, reject) => {
            if (child.pid !== undefined) {
                resolve();
                return;
            }
            child.once("spawn", resolve);
            child.once("error", reject);
        });
    }
    async waitForExitOrTerminate(child) {
        if (child.exitCode !== null || child.signalCode !== null)
            return;
        const exited = await Promise.race([
            new Promise((resolve) => child.once("exit", () => resolve(true))),
            new Promise((resolve) => setTimeout(() => resolve(false), 750))
        ]);
        if (exited)
            return;
        child.kill("SIGTERM");
    }
}
//# sourceMappingURL=native-runtime.js.map