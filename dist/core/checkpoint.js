import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);
function syncCheckpointFile(filePath) {
    const descriptor = fs.openSync(filePath, "r+");
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function syncCheckpointDirectoryIfSupported(directory) {
    // Node does not expose a portable Windows directory-handle fsync contract. File fsync remains
    // mandatory there; the weaker rename power-loss boundary is documented by the local provider.
    if (process.platform === "win32")
        return;
    let descriptor;
    try {
        descriptor = fs.openSync(directory, "r");
    }
    catch (error) {
        if (UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(error.code ?? ""))
            return;
        throw error;
    }
    try {
        fs.fsyncSync(descriptor);
    }
    catch (error) {
        if (!UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(error.code ?? ""))
            throw error;
    }
    finally {
        fs.closeSync(descriptor);
    }
}
export class HandoffCheckpointError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "HandoffCheckpointError";
    }
}
const CHECKPOINT_KEYS = new Set([
    "version", "adapterKind", "interventionId", "status", "epoch", "resumePolicy",
    "principalBinding", "actionDigest", "updatedAt", "expiresAt"
]);
/** Handoff-owned strict schema validation. Extra fields fail closed. */
export function parseHandoffCheckpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Invalid handoff checkpoint");
    }
    const record = value;
    if (Object.keys(record).some((key) => !CHECKPOINT_KEYS.has(key))) {
        throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Invalid handoff checkpoint");
    }
    const v = record;
    if (!(v.version === 1
        && typeof v.adapterKind === "string" && v.adapterKind.length > 0 && v.adapterKind.length <= 80
        && typeof v.interventionId === "string" && v.interventionId.length > 0 && v.interventionId.length <= 160
        && ["awaiting_human", "human_active", "verifying", "ready_to_resume"].includes(v.status ?? "")
        && Number.isSafeInteger(v.epoch) && Number(v.epoch) >= 0
        && ["replay_safe", "revalidate", "confirm_before_execute", "never_replay"].includes(v.resumePolicy ?? "")
        && typeof v.principalBinding === "string" && v.principalBinding.length >= 16 && v.principalBinding.length <= 160
        && (v.actionDigest === undefined || (typeof v.actionDigest === "string" && v.actionDigest.length >= 16 && v.actionDigest.length <= 160))
        && Number.isSafeInteger(v.updatedAt) && Number.isSafeInteger(v.expiresAt))) {
        throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Invalid handoff checkpoint");
    }
    return { ...v };
}
export function recoverHandoffCheckpoint(value, now) {
    const checkpoint = parseHandoffCheckpoint(value);
    if (!Number.isSafeInteger(now)) {
        throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Invalid checkpoint recovery time");
    }
    if (checkpoint.expiresAt <= now) {
        throw new HandoffCheckpointError("CHECKPOINT_EXPIRED", "Handoff checkpoint expired");
    }
    return { ...checkpoint, recovery: "reissue_and_revalidate" };
}
export class SignedFileHandoffCheckpointStore {
    filePath;
    signingKey;
    now;
    constructor(filePath, signingKey, now = Date.now) {
        this.filePath = filePath;
        this.signingKey = signingKey;
        this.now = now;
        if (!path.isAbsolute(filePath))
            throw new Error("handoff checkpoint path must be absolute");
        if (signingKey.byteLength < 32)
            throw new Error("handoff checkpoint signing key must contain at least 32 bytes");
    }
    write(checkpoint) {
        const validated = parseHandoffCheckpoint(checkpoint);
        const directory = path.dirname(this.filePath);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const envelope = { checkpoint: validated, mac: this.mac(validated) };
        const temp = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
        try {
            fs.writeFileSync(temp, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
            // Apply the final private mode before the durability barrier so the renamed inode already has
            // the intended metadata. A barrier failure is a write failure and must propagate.
            fs.chmodSync(temp, 0o600);
            syncCheckpointFile(temp);
            fs.renameSync(temp, this.filePath);
            syncCheckpointDirectoryIfSupported(directory);
        }
        finally {
            try {
                fs.unlinkSync(temp);
            }
            catch { }
        }
    }
    loadVerified() {
        if (!fs.existsSync(this.filePath))
            return undefined;
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        }
        catch {
            throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Handoff checkpoint is unreadable");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Handoff checkpoint envelope is invalid");
        }
        const envelope = parsed;
        if (typeof envelope.mac !== "string") {
            throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Handoff checkpoint envelope is invalid");
        }
        const checkpoint = parseHandoffCheckpoint(envelope.checkpoint);
        const expected = Buffer.from(this.mac(checkpoint), "utf8");
        const supplied = Buffer.from(envelope.mac, "utf8");
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
            throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Handoff checkpoint integrity check failed");
        }
        return checkpoint;
    }
    /** Provider-neutral store method: integrity-verified value, with expiry enforced by the runtime. */
    read() { return this.loadVerified(); }
    /** Existing local-file compatibility API. */
    load() {
        const checkpoint = this.loadVerified();
        if (!checkpoint)
            return undefined;
        if (checkpoint.expiresAt <= this.now()) {
            throw new HandoffCheckpointError("CHECKPOINT_EXPIRED", "Handoff checkpoint expired");
        }
        return checkpoint;
    }
    /** Existing local-file compatibility API. */
    recover() {
        const checkpoint = this.loadVerified();
        return checkpoint ? recoverHandoffCheckpoint(checkpoint, this.now()) : undefined;
    }
    /**
     * Read a MAC-verified checkpoint for an explicit local operator revalidation flow even after its
     * normal recovery TTL elapsed. This never restores Agent or Human authority; consumers must
     * independently prove the original owner binding and reissue/revalidate before any resume.
     */
    recoverForOperatorRevalidation() {
        const checkpoint = this.loadVerified();
        return checkpoint ? { ...checkpoint, recovery: "reissue_and_revalidate" } : undefined;
    }
    clear() {
        let removed = false;
        try {
            fs.unlinkSync(this.filePath);
            removed = true;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (removed)
            syncCheckpointDirectoryIfSupported(path.dirname(this.filePath));
    }
    mac(checkpoint) {
        return createHmac("sha256", this.signingKey)
            .update("mcp-execution-handoff/checkpoint/v1\0")
            .update(JSON.stringify(checkpoint))
            .digest("base64url");
    }
}
//# sourceMappingURL=checkpoint.js.map