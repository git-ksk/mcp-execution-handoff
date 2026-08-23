import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export class HandoffCheckpointError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "HandoffCheckpointError";
    }
}
function isCheckpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const v = value;
    return v.version === 1 && typeof v.adapterKind === "string" && v.adapterKind.length > 0 && v.adapterKind.length <= 80 &&
        typeof v.interventionId === "string" && v.interventionId.length > 0 && v.interventionId.length <= 160 &&
        ["awaiting_human", "human_active", "verifying", "ready_to_resume"].includes(v.status ?? "") && Number.isSafeInteger(v.epoch) && Number(v.epoch) >= 0 &&
        ["replay_safe", "revalidate", "confirm_before_execute", "never_replay"].includes(v.resumePolicy ?? "") &&
        typeof v.principalBinding === "string" && v.principalBinding.length >= 16 && v.principalBinding.length <= 160 &&
        (v.actionDigest === undefined || (typeof v.actionDigest === "string" && v.actionDigest.length >= 16 && v.actionDigest.length <= 160)) &&
        Number.isSafeInteger(v.updatedAt) && Number.isSafeInteger(v.expiresAt);
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
        if (!isCheckpoint(checkpoint))
            throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Invalid handoff checkpoint");
        const directory = path.dirname(this.filePath);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const envelope = { checkpoint: { ...checkpoint }, mac: this.mac(checkpoint) };
        const temp = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
        try {
            fs.writeFileSync(temp, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
            fs.renameSync(temp, this.filePath);
            fs.chmodSync(this.filePath, 0o600);
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
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Handoff checkpoint envelope is invalid");
        const envelope = parsed;
        if (!isCheckpoint(envelope.checkpoint) || typeof envelope.mac !== "string")
            throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Handoff checkpoint envelope is invalid");
        const expected = Buffer.from(this.mac(envelope.checkpoint), "utf8");
        const supplied = Buffer.from(envelope.mac, "utf8");
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
            throw new HandoffCheckpointError("CHECKPOINT_INVALID", "Handoff checkpoint integrity check failed");
        return { ...envelope.checkpoint };
    }
    load() {
        const checkpoint = this.loadVerified();
        if (checkpoint && checkpoint.expiresAt <= this.now())
            throw new HandoffCheckpointError("CHECKPOINT_EXPIRED", "Handoff checkpoint expired");
        return checkpoint;
    }
    recover() { const checkpoint = this.load(); return checkpoint ? { ...checkpoint, recovery: "reissue_and_revalidate" } : undefined; }
    /**
     * Read a MAC-verified checkpoint for an explicit local operator revalidation flow even after its
     * normal recovery TTL elapsed. This never restores Agent or Human authority; consumers must
     * independently prove the original owner binding and reissue/revalidate before any resume.
     */
    recoverForOperatorRevalidation() {
        const checkpoint = this.loadVerified();
        return checkpoint ? { ...checkpoint, recovery: "reissue_and_revalidate" } : undefined;
    }
    clear() { try {
        fs.unlinkSync(this.filePath);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    } }
    mac(checkpoint) { return createHmac("sha256", this.signingKey).update("mcp-execution-handoff/checkpoint/v1\0").update(JSON.stringify(checkpoint)).digest("base64url"); }
}
//# sourceMappingURL=checkpoint.js.map