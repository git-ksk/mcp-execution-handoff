import { spawn } from "node:child_process";
import { once } from "node:events";
import { isAbsolute } from "node:path";
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, random16, useH264 } from "werift";
const MAX_SIGNALING_SDP_BYTES = 128 * 1024;
const MAX_DATA_CHANNEL_MESSAGE_BYTES = 4 * 1024;
const MAX_TEXT_BYTES = 4 * 1024;
const MAX_HOST_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_HOST_CRITICAL_BUFFER_BYTES = 32 * 1024;
const MAX_HOST_REALTIME_BUFFER_BYTES = 4 * 1024;
const RTP_PAYLOAD_BYTES = 1_200;
export class WebRtcTakeoverRuntimeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "WebRtcTakeoverRuntimeError";
    }
}
export function webRtcBindingFromGrant(grant) {
    return {
        takeoverSessionId: grant.id,
        interventionId: grant.interventionId,
        epoch: grant.epoch,
        principalBinding: grant.principalBinding,
        clientBinding: grant.clientBinding,
        clientGeneration: grant.clientGeneration,
        expiresAt: grant.expiresAt
    };
}
export function parseWebRtcOffer(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new WebRtcTakeoverRuntimeError("WEBRTC_OFFER_INVALID", "WebRTC offer is invalid");
    }
    const record = value;
    const type = record.type;
    const sdp = record.sdp;
    if (type !== "offer" || typeof sdp !== "string" || sdp.length < 1 || Buffer.byteLength(sdp, "utf8") > MAX_SIGNALING_SDP_BYTES) {
        throw new WebRtcTakeoverRuntimeError("WEBRTC_OFFER_INVALID", "WebRTC offer is invalid");
    }
    return { type, sdp };
}
/**
 * Browser WebRTC Human data plane.
 *
 * SDP/ICE/DTLS state, encoded frames and Human input exist only in process memory. The provider
 * deliberately has no persistence/logging hooks and never returns frame/input data to the broker.
 * ScreenCaptureKit H.264 arrives from a short-lived macOS helper over stdout; bounded Human input
 * is written to that helper over stdin. The only broker-visible state is the generation binding.
 */
export class SpawnedWebRtcRuntimeProvider {
    config;
    active = new Map();
    spawnProcess;
    constructor(config) {
        this.config = config;
        if (!config.hostExecutable.trim() || !isAbsolute(config.hostExecutable)) {
            throw new Error("WebRTC host executable must be an absolute path");
        }
        this.spawnProcess = config.spawnProcess ?? spawn;
    }
    async start(binding, offer, hooks) {
        if (offer.type !== "offer" || Buffer.byteLength(offer.sdp, "utf8") > MAX_SIGNALING_SDP_BYTES) {
            throw new WebRtcTakeoverRuntimeError("WEBRTC_OFFER_INVALID", "WebRTC offer is invalid");
        }
        const existing = this.active.get(binding.takeoverSessionId);
        if (existing?.binding.clientGeneration === binding.clientGeneration) {
            throw new WebRtcTakeoverRuntimeError("WEBRTC_RUNTIME_ALREADY_ACTIVE", "WebRTC runtime for this generation is already active");
        }
        if (existing)
            await this.end(binding.takeoverSessionId, false);
        const peer = new RTCPeerConnection({
            codecs: { video: [useH264()] },
            iceServers: [],
            maxMessageSize: MAX_DATA_CHANNEL_MESSAGE_BYTES
        });
        const track = new MediaStreamTrack({ kind: "video" });
        let host;
        try {
            host = this.spawnHost(binding);
            await this.waitForSpawn(host);
            const runtime = {
                binding: { ...binding },
                peer,
                track,
                host,
                hooks,
                closing: false,
                nextSequence: random16(),
                lastIdrRequestAt: 0
            };
            this.active.set(binding.takeoverSessionId, runtime);
            this.attachHost(runtime);
            this.attachPeer(runtime);
            await peer.setRemoteDescription(offer);
            const sender = peer.addTrack(track);
            sender.onPictureLossIndication.subscribe(() => {
                const now = Date.now();
                if (runtime.closing || now - runtime.lastIdrRequestAt < 250)
                    return;
                runtime.lastIdrRequestAt = now;
                this.writeHostCommand(runtime, { kind: "requestIDR" });
            });
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            const local = peer.localDescription;
            if (!local?.sdp)
                throw new Error("WebRTC answer missing local SDP");
            return { type: "answer", sdp: local.sdp };
        }
        catch (error) {
            if (host)
                host.kill("SIGTERM");
            await peer.close().catch(() => undefined);
            this.active.delete(binding.takeoverSessionId);
            throw error instanceof WebRtcTakeoverRuntimeError
                ? error
                : new WebRtcTakeoverRuntimeError("WEBRTC_RUNTIME_START_FAILED", "WebRTC runtime failed to start");
        }
    }
    async reconnect(binding, offer, hooks) {
        return this.start(binding, offer, hooks);
    }
    async revoke(takeoverSessionId) {
        await this.end(takeoverSessionId, false);
    }
    async revokeForIntervention(interventionId) {
        const ids = [...this.active]
            .filter(([, runtime]) => runtime.binding.interventionId === interventionId)
            .map(([id]) => id);
        for (const id of ids)
            await this.end(id, false);
    }
    spawnHost(binding) {
        const env = {
            TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS: String(binding.expiresAt)
        };
        if (this.config.displayId !== undefined)
            env.TAKEOVER_WEBRTC_DISPLAY_ID = String(this.config.displayId);
        return this.spawnProcess(this.config.hostExecutable, this.config.hostArgs ?? [], {
            env,
            stdio: ["pipe", "pipe", "ignore"]
        });
    }
    attachPeer(runtime) {
        runtime.peer.onDataChannel.subscribe((channel) => {
            if (channel.label !== "human-critical" && channel.label !== "human-realtime") {
                channel.close();
                return;
            }
            if (channel.label === "human-critical")
                runtime.critical = channel;
            channel.onMessage.subscribe((message) => {
                this.handleChannelMessage(runtime, channel.label, message);
            });
        });
        runtime.peer.connectionStateChange.subscribe((state) => {
            if (state === "failed" || state === "disconnected" || state === "closed") {
                void this.end(runtime.binding.takeoverSessionId, true);
            }
        });
    }
    attachHost(runtime) {
        const stdout = runtime.host.stdout;
        if (!stdout)
            throw new Error("WebRTC host stdout is unavailable");
        const parser = new HostRecordParser((frame) => this.writeFrame(runtime, frame), (editable) => this.sendEditableFeedback(runtime, editable), () => void this.end(runtime.binding.takeoverSessionId, true));
        stdout.on("data", (chunk) => parser.push(chunk));
        stdout.once("end", () => parser.end());
        runtime.host.once("exit", () => {
            if (!runtime.closing)
                void this.end(runtime.binding.takeoverSessionId, true);
        });
        runtime.host.once("error", () => {
            if (!runtime.closing)
                void this.end(runtime.binding.takeoverSessionId, true);
        });
    }
    writeFrame(runtime, frame) {
        if (runtime.closing || runtime.peer.connectionState !== "connected")
            return;
        const nalUnits = splitAvcc(frame.avcc);
        if (nalUnits.length === 0)
            return;
        let sequence = runtime.nextSequence;
        for (let nalIndex = 0; nalIndex < nalUnits.length; nalIndex += 1) {
            const nal = nalUnits[nalIndex];
            const isLastNal = nalIndex === nalUnits.length - 1;
            if (nal.length <= RTP_PAYLOAD_BYTES) {
                runtime.track.writeRtp(new RtpPacket(new RtpHeader({
                    sequenceNumber: sequence,
                    timestamp: frame.rtpTimestamp,
                    marker: isLastNal
                }), nal));
                sequence = (sequence + 1) & 0xffff;
                continue;
            }
            const nalHeader = nal[0];
            const fuIndicator = (nalHeader & 0xe0) | 28;
            const nalType = nalHeader & 0x1f;
            const fragment = nal.subarray(1);
            const size = RTP_PAYLOAD_BYTES - 2;
            for (let offset = 0; offset < fragment.length; offset += size) {
                const chunk = fragment.subarray(offset, Math.min(fragment.length, offset + size));
                const last = offset + chunk.length >= fragment.length;
                const fuHeader = (offset === 0 ? 0x80 : 0) | (last ? 0x40 : 0) | nalType;
                runtime.track.writeRtp(new RtpPacket(new RtpHeader({
                    sequenceNumber: sequence,
                    timestamp: frame.rtpTimestamp,
                    marker: isLastNal && last
                }), Buffer.concat([Buffer.from([fuIndicator, fuHeader]), chunk])));
                sequence = (sequence + 1) & 0xffff;
            }
        }
        runtime.nextSequence = sequence;
    }
    handleChannelMessage(runtime, label, message) {
        if (runtime.closing)
            return;
        const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_DATA_CHANNEL_MESSAGE_BYTES)
            return;
        let value;
        try {
            value = JSON.parse(bytes.toString("utf8"));
        }
        catch {
            return;
        }
        const input = parseHumanInput(value, label === "human-realtime");
        if (!input)
            return;
        let endUse;
        try {
            if (!this.canWriteHostInput(runtime, bytes.byteLength, label === "human-realtime"))
                return;
            endUse = runtime.hooks.beginInput();
            this.writeHostInput(runtime, input);
        }
        catch {
            // Stale/revoked generation or an unavailable local Human surface fails closed.
        }
        finally {
            endUse?.();
        }
    }
    canWriteHostInput(runtime, messageBytes, realtime) {
        const stdin = runtime.host.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable)
            return false;
        const limit = realtime ? MAX_HOST_REALTIME_BUFFER_BYTES : MAX_HOST_CRITICAL_BUFFER_BYTES;
        if (realtime && stdin.writableNeedDrain)
            return false;
        return stdin.writableLength + messageBytes + 1 <= limit;
    }
    writeHostInput(runtime, input) {
        const stdin = runtime.host.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable)
            throw new Error("WebRTC host input is unavailable");
        const line = JSON.stringify(input);
        if (Buffer.byteLength(line, "utf8") > MAX_DATA_CHANNEL_MESSAGE_BYTES)
            throw new Error("Human input is too large");
        stdin.write(`${line}\n`);
    }
    writeHostCommand(runtime, command) {
        const stdin = runtime.host.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable)
            return;
        const line = JSON.stringify(command);
        const bytes = Buffer.byteLength(line, "utf8") + 1;
        if (bytes > MAX_DATA_CHANNEL_MESSAGE_BYTES || stdin.writableLength + bytes > MAX_HOST_REALTIME_BUFFER_BYTES)
            return;
        stdin.write(`${line}\n`);
    }
    sendEditableFeedback(runtime, editable) {
        const channel = runtime.critical;
        if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 16 * 1024)
            return;
        channel.send(JSON.stringify({ kind: "focus", editable }));
    }
    async end(takeoverSessionId, notifyDisconnect) {
        const runtime = this.active.get(takeoverSessionId);
        if (!runtime || runtime.closing)
            return;
        runtime.closing = true;
        this.active.delete(takeoverSessionId);
        try {
            runtime.critical?.close();
            await runtime.peer.close().catch(() => undefined);
            // Broker authority is already fenced before explicit revoke reaches here. Terminate the
            // helper immediately so buffered Human input cannot drain after Done/suspend/revoke.
            if (runtime.host.exitCode === null && runtime.host.signalCode === null)
                runtime.host.kill("SIGTERM");
            await this.waitForExitOrTerminate(runtime.host);
        }
        catch (error) {
            runtime.host.kill("SIGTERM");
            if (!notifyDisconnect) {
                throw new WebRtcTakeoverRuntimeError("WEBRTC_RUNTIME_REVOKE_FAILED", "WebRTC runtime revoke failed");
            }
        }
        finally {
            if (notifyDisconnect)
                runtime.hooks.disconnected();
        }
    }
    async waitForSpawn(child) {
        if (child.pid !== undefined)
            return;
        await Promise.race([
            once(child, "spawn").then(() => undefined),
            once(child, "error").then(([error]) => Promise.reject(error))
        ]);
    }
    async waitForExitOrTerminate(child) {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = await Promise.race([
                once(child, "close").then(() => true),
                new Promise((resolve) => setTimeout(() => resolve(false), 500))
            ]);
            if (!exited) {
                child.kill("SIGTERM");
                const terminated = await Promise.race([
                    once(child, "close").then(() => true),
                    new Promise((resolve) => setTimeout(() => resolve(false), 500))
                ]);
                if (!terminated)
                    child.kill("SIGKILL");
            }
        }
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
    }
}
function parseHumanInput(value, realtime) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    if (realtime) {
        if (record.kind !== "scroll")
            return undefined;
        const deltaX = Number(record.deltaX);
        const deltaY = Number(record.deltaY);
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX) > 2_000 || Math.abs(deltaY) > 2_000)
            return undefined;
        return { kind: "scroll", deltaX, deltaY };
    }
    if (record.kind === "tap") {
        const x = Number(record.x);
        const y = Number(record.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)
            return undefined;
        return { kind: "tap", x, y };
    }
    if (record.kind === "text") {
        if (typeof record.text !== "string" || record.text.length === 0 || Buffer.byteLength(record.text, "utf8") > MAX_TEXT_BYTES)
            return undefined;
        return { kind: "text", text: record.text };
    }
    if (record.kind === "key" && (record.key === "Backspace" || record.key === "Enter")) {
        return { kind: "key", key: record.key };
    }
    return undefined;
}
function splitAvcc(sample) {
    const nalUnits = [];
    let offset = 0;
    while (offset + 4 <= sample.length) {
        const length = sample.readUInt32BE(offset);
        offset += 4;
        if (length < 1 || offset + length > sample.length)
            return [];
        nalUnits.push(sample.subarray(offset, offset + length));
        offset += length;
    }
    return offset === sample.length ? nalUnits : [];
}
class HostRecordParser {
    onFrame;
    onEditable;
    onFailure;
    buffer = Buffer.alloc(0);
    failed = false;
    constructor(onFrame, onEditable, onFailure) {
        this.onFrame = onFrame;
        this.onEditable = onEditable;
        this.onFailure = onFailure;
    }
    push(chunk) {
        if (this.failed || chunk.length === 0)
            return;
        this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 5) {
            const type = this.buffer[0];
            const length = this.buffer.readUInt32BE(1);
            if (length > MAX_HOST_FRAME_BYTES || (type === 2 && length !== 1))
                return this.fail();
            if (this.buffer.length < 5 + length)
                return;
            const payload = this.buffer.subarray(5, 5 + length);
            this.buffer = this.buffer.subarray(5 + length);
            if (type === 1) {
                if (payload.length < 9)
                    return this.fail();
                const rtpTimestamp = payload.readUInt32BE(0);
                const keyframe = payload[4] === 1;
                const width = payload.readUInt16BE(5);
                const height = payload.readUInt16BE(7);
                const avcc = payload.subarray(9);
                if (!width || !height || avcc.length === 0)
                    return this.fail();
                this.onFrame({ rtpTimestamp, keyframe, width, height, avcc });
            }
            else if (type === 2) {
                this.onEditable(payload[0] === 1);
            }
            else {
                return this.fail();
            }
        }
    }
    end() {
        if (!this.failed && this.buffer.length !== 0)
            this.fail();
    }
    fail() {
        if (this.failed)
            return;
        this.failed = true;
        this.buffer = Buffer.alloc(0);
        this.onFailure();
    }
}
//# sourceMappingURL=webrtc-runtime.js.map