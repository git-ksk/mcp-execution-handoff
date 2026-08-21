import { spawn } from "node:child_process";
import { once } from "node:events";
import { isAbsolute } from "node:path";
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, random16, useH264 } from "werift";
import { CloudflareRealtimeTurnCredentialProvider, cloneIceServers, directOnlyIceSession } from "./webrtc-ice.js";
import { WebRtcLatencyTracker } from "./webrtc-latency.js";
import { WebRtcDiagnosticsTracker, webRtcCandidateCountsFromSdp } from "./webrtc-diagnostics.js";
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
export function webRtcBindingFromGrant(grant, targetProcessId) {
    return {
        takeoverSessionId: grant.id,
        interventionId: grant.interventionId,
        epoch: grant.epoch,
        principalBinding: grant.principalBinding,
        clientBinding: grant.clientBinding,
        clientGeneration: grant.clientGeneration,
        expiresAt: grant.expiresAt,
        ...(targetProcessId === undefined ? {} : { targetProcessId })
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
    prepared = new Map();
    latency = new WebRtcLatencyTracker();
    diagnostics = new WebRtcDiagnosticsTracker();
    spawnProcess;
    #iceCredentialProvider;
    constructor(config) {
        this.config = config;
        if (!config.hostExecutable.trim() || !isAbsolute(config.hostExecutable)) {
            throw new Error("WebRTC host executable must be an absolute path");
        }
        if (config.displayName !== undefined && !/^:\d+(?:\.\d+)?$/.test(config.displayName)) {
            throw new Error("WebRTC Linux display name must be a local X11 display such as :99");
        }
        this.spawnProcess = config.spawnProcess ?? spawn;
        this.#iceCredentialProvider = iceCredentialProviderFromEnvironment(process.env);
    }
    async prepare(binding) {
        const existing = this.active.get(binding.takeoverSessionId);
        if (existing?.binding.clientGeneration === binding.clientGeneration) {
            throw new WebRtcTakeoverRuntimeError("WEBRTC_RUNTIME_ALREADY_ACTIVE", "WebRTC runtime for this generation is already active");
        }
        if (existing) {
            // A broker-authorized fresh generation must fence and close the previous peer before new
            // ICE material exists. This also covers reconnect after the broker's idle threshold.
            await this.end(binding.takeoverSessionId, false);
        }
        await this.revokePrepared(binding.takeoverSessionId);
        let iceSession;
        if (!this.#iceCredentialProvider) {
            iceSession = directOnlyIceSession("disabled");
        }
        else {
            try {
                iceSession = await this.#iceCredentialProvider.issue(binding);
            }
            catch {
                // Credential-provider failure does not silently widen trust. Keep LAN/direct eligibility,
                // but make relay unavailable so a WAN failure is explicit and safe.
                iceSession = directOnlyIceSession("unavailable");
            }
        }
        const delay = Math.max(0, binding.expiresAt - Date.now());
        const expiryTimer = setTimeout(() => { void this.revokePrepared(binding.takeoverSessionId); }, delay);
        expiryTimer.unref();
        this.prepared.set(binding.takeoverSessionId, { binding: { ...binding }, iceSession, expiryTimer });
        return {
            iceServers: cloneIceServers(iceSession.browser.iceServers),
            relay: iceSession.browser.relay
        };
    }
    recordLatency(takeoverSessionId, sample) {
        const runtime = this.active.get(takeoverSessionId);
        this.latency.record({
            ...sample,
            ...(runtime?.lastHostEncodeMs === undefined ? {} : { hostEncodeMs: runtime.lastHostEncodeMs }),
            ...(runtime?.lastRtpDrainMs === undefined ? {} : { rtpDrainMs: runtime.lastRtpDrainMs })
        });
    }
    latencySnapshot() {
        return this.latency.snapshot();
    }
    recordDiagnostic(event) {
        this.diagnostics.record(event);
    }
    diagnosticsSnapshot() {
        return this.diagnostics.snapshot();
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
        let prepared = this.prepared.get(binding.takeoverSessionId);
        if (!prepared && !this.#iceCredentialProvider) {
            await this.prepare(binding);
            prepared = this.prepared.get(binding.takeoverSessionId);
        }
        if (!prepared || !sameBinding(prepared.binding, binding)) {
            throw new WebRtcTakeoverRuntimeError("WEBRTC_ICE_NOT_PREPARED", "WebRTC ICE session is unavailable");
        }
        this.prepared.delete(binding.takeoverSessionId);
        clearTimeout(prepared.expiryTimer);
        const peer = new RTCPeerConnection({
            codecs: { video: [useH264()] },
            iceServers: cloneIceServers(prepared.iceSession.serverIceServers),
            iceTransportPolicy: "all",
            maxMessageSize: MAX_DATA_CHANNEL_MESSAGE_BYTES
        });
        const track = new MediaStreamTrack({ kind: "video" });
        let host;
        try {
            host = this.spawnHost(binding);
            await this.waitForSpawn(host);
            const expiryTimer = setTimeout(() => { void this.end(binding.takeoverSessionId, true); }, Math.max(0, binding.expiresAt - Date.now()));
            expiryTimer.unref();
            const runtime = {
                binding: { ...binding },
                iceSession: prepared.iceSession,
                expiryTimer,
                peer,
                track,
                host,
                hooks,
                closing: false,
                nextSequence: random16(),
                lastIdrRequestAt: 0,
                videoDrainActive: false,
                awaitingVideoKeyframe: false
            };
            this.active.set(binding.takeoverSessionId, runtime);
            this.attachHost(runtime);
            this.attachPeer(runtime);
            const answerStartedAt = Date.now();
            await peer.setRemoteDescription(offer);
            const sender = peer.addTrack(track);
            runtime.sender = sender;
            sender.onPictureLossIndication.subscribe(() => {
                this.requestIdr(runtime);
            });
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            const local = peer.localDescription;
            if (!local?.sdp)
                throw new Error("WebRTC answer missing local SDP");
            this.recordDiagnostic({
                stage: "server.answer.ready",
                candidateCounts: webRtcCandidateCountsFromSdp(local.sdp),
                durationMs: Date.now() - answerStartedAt
            });
            return { type: "answer", sdp: local.sdp };
        }
        catch (error) {
            if (host)
                host.kill("SIGTERM");
            await peer.close().catch(() => undefined);
            const active = this.active.get(binding.takeoverSessionId);
            if (active)
                clearTimeout(active.expiryTimer);
            this.active.delete(binding.takeoverSessionId);
            await prepared.iceSession.revoke().catch(() => undefined);
            throw error instanceof WebRtcTakeoverRuntimeError
                ? error
                : new WebRtcTakeoverRuntimeError("WEBRTC_RUNTIME_START_FAILED", "WebRTC runtime failed to start");
        }
    }
    async reconnect(binding, offer, hooks) {
        return this.start(binding, offer, hooks);
    }
    async revoke(takeoverSessionId) {
        await this.revokePrepared(takeoverSessionId);
        await this.end(takeoverSessionId, false);
    }
    async revokeForIntervention(interventionId) {
        const ids = new Set();
        for (const [id, runtime] of this.active)
            if (runtime.binding.interventionId === interventionId)
                ids.add(id);
        for (const [id, runtime] of this.prepared)
            if (runtime.binding.interventionId === interventionId)
                ids.add(id);
        for (const id of ids)
            await this.revoke(id);
    }
    async revokePrepared(takeoverSessionId) {
        const prepared = this.prepared.get(takeoverSessionId);
        if (!prepared)
            return;
        this.prepared.delete(takeoverSessionId);
        clearTimeout(prepared.expiryTimer);
        try {
            await prepared.iceSession.revoke();
        }
        catch {
            throw new WebRtcTakeoverRuntimeError("WEBRTC_RUNTIME_REVOKE_FAILED", "WebRTC ICE credential revoke failed");
        }
    }
    spawnHost(binding) {
        const env = {
            TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS: String(binding.expiresAt)
        };
        if (this.config.displayId !== undefined)
            env.TAKEOVER_WEBRTC_DISPLAY_ID = String(this.config.displayId);
        if (this.config.displayName !== undefined)
            env.TAKEOVER_WEBRTC_DISPLAY_NAME = this.config.displayName;
        if (binding.targetProcessId !== undefined)
            env.TAKEOVER_WEBRTC_TARGET_PID = String(binding.targetProcessId);
        return this.spawnProcess(this.config.hostExecutable, this.config.hostArgs ?? [], {
            env,
            // stdout is the stable frame/control wire. stderr is a bounded, never-forwarded diagnostic
            // side channel so timing instrumentation does not change the media wire consumed by older hosts/runtimes.
            stdio: ["pipe", "pipe", "pipe"]
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
            if (state === "new" || state === "connecting" || state === "connected" || state === "disconnected" || state === "failed" || state === "closed") {
                this.recordDiagnostic({ stage: "server.peer.state", state });
            }
            if (state === "connected") {
                const keyframe = runtime.preconnectKeyframe;
                delete runtime.preconnectKeyframe;
                if (keyframe && runtime.sender) {
                    this.enqueueConnectedFrame(runtime, keyframe);
                }
                else {
                    runtime.awaitingVideoKeyframe = true;
                    this.requestIdr(runtime);
                }
                return;
            }
            if (state === "failed" || state === "disconnected" || state === "closed") {
                void this.end(runtime.binding.takeoverSessionId, true);
            }
        });
    }
    attachHost(runtime) {
        const stdout = runtime.host.stdout;
        const stderr = runtime.host.stderr;
        if (!stdout || !stderr)
            throw new Error("WebRTC host pipes are unavailable");
        const parser = new HostRecordParser((frame) => this.writeFrame(runtime, frame), (editable) => this.sendEditableFeedback(runtime, editable, "tap"), () => void this.end(runtime.binding.takeoverSessionId, true));
        const metricParser = new HostMetricParser((hostEncodeMs) => { runtime.lastHostEncodeMs = hostEncodeMs; }, (regions) => this.sendEditableRegions(runtime, regions), (stage) => this.recordDiagnostic({ stage }));
        stdout.on("data", (chunk) => parser.push(chunk));
        stdout.once("end", () => parser.end());
        stderr.on("data", (chunk) => metricParser.push(chunk));
        stderr.once("end", () => metricParser.end());
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
        if (runtime.closing)
            return;
        if (runtime.peer.connectionState !== "connected" || !runtime.sender) {
            // ScreenCaptureKit may produce the only useful static-screen IDR before ICE/DTLS is connected.
            // Keep exactly one pre-connect keyframe so the receiver can initialize without retaining a
            // stale video queue. Dependent P-frames are never retained across this boundary.
            if (frame.keyframe)
                runtime.preconnectKeyframe = frame;
            return;
        }
        this.enqueueConnectedFrame(runtime, frame);
    }
    enqueueConnectedFrame(runtime, frame) {
        if (runtime.closing || runtime.peer.connectionState !== "connected" || !runtime.sender)
            return;
        // Video is a latest-state stream, not a reliable queue. Werift's MediaStreamTrack.writeRtp()
        // dispatches async sender work without awaiting it, so pumping every encoded frame through the
        // track can accumulate stale SRTP/ICE sends when a TURN path is congested. Keep at most one
        // frame in flight plus the newest pending frame and drop superseded pending frames.
        if (runtime.awaitingVideoKeyframe) {
            if (!frame.keyframe)
                return;
            runtime.awaitingVideoKeyframe = false;
            runtime.pendingFrame = frame;
        }
        else if (runtime.pendingFrame) {
            if (runtime.pendingFrame.keyframe) {
                // Preserve the resynchronization point over newer dependent P-frames. A newer keyframe may
                // safely replace it because either keyframe independently restarts decoder state.
                if (frame.keyframe)
                    runtime.pendingFrame = frame;
                else
                    return;
            }
            else {
                // Superseding an already-encoded dependent frame creates a reference gap. Drop the stale
                // pending chain, request a fresh IDR, and do not resume media until that keyframe arrives.
                delete runtime.pendingFrame;
                runtime.awaitingVideoKeyframe = true;
                this.requestIdr(runtime);
                if (!frame.keyframe)
                    return;
                runtime.awaitingVideoKeyframe = false;
                runtime.pendingFrame = frame;
            }
        }
        else {
            runtime.pendingFrame = frame;
        }
        if (runtime.videoDrainActive)
            return;
        runtime.videoDrainActive = true;
        void this.drainLatestFrames(runtime).catch(() => {
            if (!runtime.closing)
                void this.end(runtime.binding.takeoverSessionId, true);
        });
    }
    async drainLatestFrames(runtime) {
        try {
            while (!runtime.closing && runtime.peer.connectionState === "connected" && runtime.sender) {
                const frame = runtime.pendingFrame;
                if (!frame)
                    break;
                delete runtime.pendingFrame;
                await this.sendFrame(runtime, runtime.sender, frame);
            }
        }
        finally {
            runtime.videoDrainActive = false;
            if (runtime.pendingFrame &&
                !runtime.closing &&
                runtime.peer.connectionState === "connected" &&
                runtime.sender) {
                runtime.videoDrainActive = true;
                void this.drainLatestFrames(runtime).catch(() => {
                    if (!runtime.closing)
                        void this.end(runtime.binding.takeoverSessionId, true);
                });
            }
        }
    }
    async sendFrame(runtime, sender, frame) {
        const drainStartedAt = process.hrtime.bigint();
        const nalUnits = splitAvcc(frame.avcc);
        if (nalUnits.length === 0)
            return;
        let sequence = runtime.nextSequence;
        for (let nalIndex = 0; nalIndex < nalUnits.length; nalIndex += 1) {
            if (runtime.closing || runtime.peer.connectionState !== "connected")
                return;
            const nal = nalUnits[nalIndex];
            const isLastNal = nalIndex === nalUnits.length - 1;
            if (nal.length <= RTP_PAYLOAD_BYTES) {
                await sender.sendRtp(new RtpPacket(new RtpHeader({
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
                if (runtime.closing || runtime.peer.connectionState !== "connected")
                    return;
                const chunk = fragment.subarray(offset, Math.min(fragment.length, offset + size));
                const last = offset + chunk.length >= fragment.length;
                const fuHeader = (offset === 0 ? 0x80 : 0) | (last ? 0x40 : 0) | nalType;
                await sender.sendRtp(new RtpPacket(new RtpHeader({
                    sequenceNumber: sequence,
                    timestamp: frame.rtpTimestamp,
                    marker: isLastNal && last
                }), Buffer.concat([Buffer.from([fuIndicator, fuHeader]), chunk])));
                sequence = (sequence + 1) & 0xffff;
            }
        }
        runtime.nextSequence = sequence;
        const elapsedNs = process.hrtime.bigint() - drainStartedAt;
        runtime.lastRtpDrainMs = Math.min(120_000, Math.max(0, Number(elapsedNs) / 1_000_000));
    }
    requestIdr(runtime) {
        const now = Date.now();
        if (runtime.closing || now - runtime.lastIdrRequestAt < 250)
            return;
        runtime.lastIdrRequestAt = now;
        this.writeHostCommand(runtime, { kind: "requestIDR" });
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
    sendEditableFeedback(runtime, editable, phase) {
        const channel = runtime.critical;
        if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 16 * 1024)
            return;
        channel.send(JSON.stringify({ kind: "focus", editable, phase }));
    }
    sendEditableRegions(runtime, regions) {
        const channel = runtime.critical;
        if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 16 * 1024)
            return;
        channel.send(JSON.stringify({ kind: "editableRegions", regions }));
    }
    async end(takeoverSessionId, notifyDisconnect) {
        const runtime = this.active.get(takeoverSessionId);
        if (!runtime || runtime.closing)
            return;
        runtime.closing = true;
        this.active.delete(takeoverSessionId);
        clearTimeout(runtime.expiryTimer);
        // Fence broker authority before any OS cleanup or third-party TURN revocation can block.
        // Relay credential revocation is defense-in-depth after the exact client generation is stale.
        if (notifyDisconnect)
            runtime.hooks.disconnected();
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
            await runtime.iceSession.revoke().catch(() => undefined);
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
function iceCredentialProviderFromEnvironment(env) {
    const turnKeyId = env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID;
    const turnKeyApiToken = env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN;
    if (!turnKeyId && !turnKeyApiToken)
        return undefined;
    if (!turnKeyId || !turnKeyApiToken) {
        throw new Error("Cloudflare TURN configuration is incomplete");
    }
    return new CloudflareRealtimeTurnCredentialProvider({ turnKeyId, turnKeyApiToken });
}
function sameBinding(left, right) {
    return left.takeoverSessionId === right.takeoverSessionId
        && left.interventionId === right.interventionId
        && left.epoch === right.epoch
        && left.principalBinding === right.principalBinding
        && left.clientBinding === right.clientBinding
        && left.clientGeneration === right.clientGeneration
        && left.expiresAt === right.expiresAt
        && left.targetProcessId === right.targetProcessId;
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
class HostMetricParser {
    onHostEncode;
    onEditableRegions;
    onHostStage;
    text = "";
    constructor(onHostEncode, onEditableRegions, onHostStage) {
        this.onHostEncode = onHostEncode;
        this.onEditableRegions = onEditableRegions;
        this.onHostStage = onHostStage;
    }
    push(chunk) {
        if (chunk.length === 0)
            return;
        this.text += chunk.toString("utf8");
        if (this.text.length > 8_192)
            this.text = this.text.slice(-2_048);
        for (;;) {
            const newline = this.text.indexOf("\n");
            if (newline < 0)
                return;
            const line = this.text.slice(0, newline).trim();
            this.text = this.text.slice(newline + 1);
            const matched = /^MCP_HANDOFF_METRIC encode_tenths=(\d{1,5})$/.exec(line);
            if (matched) {
                const tenths = Number(matched[1]);
                if (Number.isSafeInteger(tenths) && tenths >= 0 && tenths <= 65_535)
                    this.onHostEncode(tenths / 10);
                continue;
            }
            const diagnostic = /^MCP_HANDOFF_DIAGNOSTIC linux_stage=(window_ready|capture_started|frame_ready|input_focus_ready|input_tap_sent|input_failure|capture_failure|capture_failure_x11|capture_failure_encoder|capture_failure_option|capture_failure_other)$/.exec(line);
            if (diagnostic) {
                const stages = {
                    window_ready: "host.window.ready",
                    capture_started: "host.capture.started",
                    frame_ready: "host.frame.ready",
                    input_focus_ready: "host.input.focus.ready",
                    input_tap_sent: "host.input.tap.sent",
                    input_failure: "host.input.failure",
                    capture_failure: "host.capture.failure",
                    capture_failure_x11: "host.capture.failure.x11",
                    capture_failure_encoder: "host.capture.failure.encoder",
                    capture_failure_option: "host.capture.failure.option",
                    capture_failure_other: "host.capture.failure.other"
                };
                this.onHostStage(stages[diagnostic[1]]);
                continue;
            }
            const regionsLine = /^MCP_HANDOFF_CONTROL editable_regions=(.*)$/.exec(line);
            if (regionsLine) {
                const payload = regionsLine[1] ?? "";
                if (payload.length > 1_024)
                    continue;
                if (payload === "") {
                    this.onEditableRegions([]);
                    continue;
                }
                const encoded = payload.split(";");
                if (encoded.length > 32)
                    continue;
                const regions = [];
                let valid = true;
                for (const item of encoded) {
                    const match = /^(\d{1,5}),(\d{1,5}),(\d{1,5}),(\d{1,5})$/.exec(item);
                    if (!match) {
                        valid = false;
                        break;
                    }
                    const region = match.slice(1).map(Number);
                    const [x, y, width, height] = region;
                    if (!region.every(Number.isSafeInteger) || width < 1 || height < 1 || x < 0 || y < 0 || x + width > 10_000 || y + height > 10_000) {
                        valid = false;
                        break;
                    }
                    regions.push(region);
                }
                if (valid)
                    this.onEditableRegions(regions);
            }
        }
    }
    end() {
        this.text = "";
    }
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