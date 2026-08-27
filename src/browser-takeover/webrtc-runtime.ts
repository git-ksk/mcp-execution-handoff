import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { dirname, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  random16,
  useH264,
  type RTCDataChannel,
  type RTCRtpSender
} from "werift";
import type { TakeoverGrant } from "./session.js";
import {
  CloudflareRealtimeTurnCredentialProvider,
  CoturnRestTurnCredentialProvider,
  cloneIceServers,
  directOnlyIceSession,
  relayCredentialFailureReason,
  type WebRtcBrowserIceConfiguration,
  type WebRtcIceCredentialProvider,
  type WebRtcPreparedIceSession,
  type WebRtcTakeoverRuntimeBinding
} from "./webrtc-ice.js";
import {
  WebRtcLatencyTracker,
  type WebRtcLatencyComparison,
  type WebRtcLatencySample
} from "./webrtc-latency.js";
import {
  WebRtcDiagnosticsTracker,
  webRtcCandidateCountsFromSdp,
  type WebRtcDiagnosticEvent,
  type WebRtcDiagnosticMedia,
  type WebRtcDiagnosticStage,
  type WebRtcDiagnosticsSnapshot
} from "./webrtc-diagnostics.js";
export type { WebRtcTakeoverRuntimeBinding } from "./webrtc-ice.js";

const MAX_SIGNALING_SDP_BYTES = 128 * 1024;
const MAX_DATA_CHANNEL_MESSAGE_BYTES = 4 * 1024;
const MAX_TEXT_BYTES = 4 * 1024;
const MAX_HOST_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_HOST_CRITICAL_BUFFER_BYTES = 32 * 1024;
const MAX_HOST_REALTIME_BUFFER_BYTES = 4 * 1024;
const RTP_PAYLOAD_BYTES = 1_200;

export interface WebRtcSessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

export type WebRtcHumanInput =
  | { kind: "tap"; x: number; y: number }
  | { kind: "pointer_button"; button: "primary"; state: "down" | "up"; x: number; y: number }
  | { kind: "scroll"; deltaX: number; deltaY: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: "Backspace" | "Enter" };

export interface WebRtcHumanInputPolicy {
  tap: boolean;
  scroll: boolean;
  text: boolean;
  key: boolean;
}

export interface WebRtcRuntimeHooks {
  beginInput(input: WebRtcHumanInput): () => void;
  disconnected(): void;
}

export interface WebRtcTakeoverRuntimeProvider {
  prepare(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcBrowserIceConfiguration>;
  start(
    binding: WebRtcTakeoverRuntimeBinding,
    offer: WebRtcSessionDescription,
    hooks: WebRtcRuntimeHooks
  ): Promise<WebRtcSessionDescription>;
  reconnect(
    binding: WebRtcTakeoverRuntimeBinding,
    offer: WebRtcSessionDescription,
    hooks: WebRtcRuntimeHooks
  ): Promise<WebRtcSessionDescription>;
  recordLatency(takeoverSessionId: string, sample: WebRtcLatencySample): void;
  latencySnapshot(): WebRtcLatencyComparison;
  recordDiagnostic(event: WebRtcDiagnosticEvent): void;
  diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot;
  revoke(takeoverSessionId: string): Promise<void>;
  revokeForIntervention(interventionId: string): Promise<void>;
}

export type WebRtcRuntimeStartStage =
  | "host_spawn"
  | "host_ready"
  | "media_ready"
  | "remote_description"
  | "track_setup"
  | "answer_create"
  | "local_description"
  | "answer_finalize";

export type WebRtcRuntimeStartReason =
  | "peer_closed"
  | "host_not_ready"
  | "media_not_ready"
  | "answer_signaling_state"
  | "answer_remote_description_missing"
  | "transceiver_missing"
  | "sctp_missing"
  | "invalid_media_kind"
  | "other";

export type WebRtcRuntimeSignalingState =
  | "stable"
  | "have-local-offer"
  | "have-remote-offer"
  | "have-local-pranswer"
  | "have-remote-pranswer"
  | "closed";

export type WebRtcRuntimeEndCause =
  | "expiry"
  | "generation_replace"
  | "explicit_revoke"
  | "peer_state"
  | "host_protocol"
  | "host_exit"
  | "host_error"
  | "video_drain";

export class WebRtcTakeoverRuntimeError extends Error {
  constructor(
    public readonly code:
      | "WEBRTC_OFFER_INVALID"
      | "WEBRTC_RUNTIME_ALREADY_ACTIVE"
      | "WEBRTC_ICE_NOT_PREPARED"
      | "WEBRTC_RUNTIME_START_FAILED"
      | "WEBRTC_RUNTIME_REVOKE_FAILED",
    message: string,
    public readonly startStage?: WebRtcRuntimeStartStage,
    public readonly startReason?: WebRtcRuntimeStartReason,
    public readonly startSignalingState?: WebRtcRuntimeSignalingState,
    public readonly startEndCause?: WebRtcRuntimeEndCause
  ) {
    super(message);
    this.name = "WebRtcTakeoverRuntimeError";
  }
}

export function webRtcBindingFromGrant(
  grant: TakeoverGrant,
  targetProcessId?: number,
  targetWindowId?: number
): WebRtcTakeoverRuntimeBinding {
  if (targetWindowId !== undefined && targetProcessId === undefined) {
    throw new WebRtcTakeoverRuntimeError("WEBRTC_OFFER_INVALID", "WebRTC target window requires a target process");
  }
  return {
    takeoverSessionId: grant.id,
    interventionId: grant.interventionId,
    epoch: grant.epoch,
    principalBinding: grant.principalBinding,
    clientBinding: grant.clientBinding,
    clientGeneration: grant.clientGeneration,
    expiresAt: grant.expiresAt,
    ...(targetProcessId === undefined ? {} : { targetProcessId }),
    ...(targetWindowId === undefined ? {} : { targetWindowId })
  };
}

export function parseWebRtcOffer(value: unknown): WebRtcSessionDescription {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebRtcTakeoverRuntimeError("WEBRTC_OFFER_INVALID", "WebRTC offer is invalid");
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  const sdp = record.sdp;
  if (type !== "offer" || typeof sdp !== "string" || sdp.length < 1 || Buffer.byteLength(sdp, "utf8") > MAX_SIGNALING_SDP_BYTES) {
    throw new WebRtcTakeoverRuntimeError("WEBRTC_OFFER_INVALID", "WebRTC offer is invalid");
  }
  return { type, sdp };
}

interface EncodedHostFrame {
  rtpTimestamp: number;
  keyframe: boolean;
  width: number;
  height: number;
  avcc: Buffer;
}

interface HostReadyGate {
  promise: Promise<void>;
  resolve(): void;
  reject(): void;
  settled: boolean;
}

interface ActiveWebRtcRuntime {
  binding: WebRtcTakeoverRuntimeBinding;
  iceSession: WebRtcPreparedIceSession;
  expiryTimer: NodeJS.Timeout;
  peer: RTCPeerConnection;
  track: MediaStreamTrack;
  sender?: RTCRtpSender;
  host: ChildProcess;
  hooks: WebRtcRuntimeHooks;
  closing: boolean;
  critical?: RTCDataChannel;
  nextSequence: number;
  lastIdrRequestAt: number;
  lastHostEncodeMs?: number;
  lastRtpDrainMs?: number;
  videoDrainActive: boolean;
  awaitingVideoKeyframe: boolean;
  pendingFrame?: EncodedHostFrame;
  preconnectKeyframe?: EncodedHostFrame;
  hostReady?: HostReadyGate;
  mediaReady: HostReadyGate;
  endCause?: WebRtcRuntimeEndCause;
}

interface PreparedWebRtcRuntime {
  binding: WebRtcTakeoverRuntimeBinding;
  iceSession: WebRtcPreparedIceSession;
  expiryTimer: NodeJS.Timeout;
}

export interface SpawnedWebRtcRuntimeProviderConfig {
  hostExecutable: string;
  hostArgs?: string[];
  displayId?: number;
  displayName?: string;
  spawnProcess?: typeof spawn;
}

/**
 * Browser WebRTC Human data plane.
 *
 * SDP/ICE/DTLS state, encoded frames and Human input exist only in process memory. The provider
 * deliberately has no persistence/logging hooks and never returns frame/input data to the broker.
 * ScreenCaptureKit H.264 arrives from a short-lived macOS helper over stdout; bounded Human input
 * is written to that helper over stdin. The only broker-visible state is the generation binding.
 */
export class SpawnedWebRtcRuntimeProvider implements WebRtcTakeoverRuntimeProvider {
  private readonly active = new Map<string, ActiveWebRtcRuntime>();
  private readonly prepared = new Map<string, PreparedWebRtcRuntime>();
  private readonly latency = new WebRtcLatencyTracker();
  private readonly diagnostics = new WebRtcDiagnosticsTracker();
  private readonly spawnProcess: typeof spawn;
  #iceCredentialProvider: WebRtcIceCredentialProvider | undefined;

  constructor(private readonly config: SpawnedWebRtcRuntimeProviderConfig) {
    if (!config.hostExecutable.trim() || !isAbsolute(config.hostExecutable)) {
      throw new Error("WebRTC host executable must be an absolute path");
    }
    if (config.displayName !== undefined && !/^:\d+(?:\.\d+)?$/.test(config.displayName)) {
      throw new Error("WebRTC Linux display name must be a local X11 display such as :99");
    }
    this.spawnProcess = config.spawnProcess ?? spawn;
    this.#iceCredentialProvider = iceCredentialProviderFromEnvironment(process.env);
  }

  async prepare(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcBrowserIceConfiguration> {
    const existing = this.active.get(binding.takeoverSessionId);
    if (existing?.binding.clientGeneration === binding.clientGeneration) {
      throw new WebRtcTakeoverRuntimeError(
        "WEBRTC_RUNTIME_ALREADY_ACTIVE",
        "WebRTC runtime for this generation is already active"
      );
    }
    if (existing) {
      // A broker-authorized fresh generation must fence and close the previous peer before new
      // ICE material exists. This also covers reconnect after the broker's idle threshold.
      await this.end(binding.takeoverSessionId, false, "generation_replace");
    }
    await this.revokePrepared(binding.takeoverSessionId);

    let iceSession: WebRtcPreparedIceSession;
    if (!this.#iceCredentialProvider) {
      iceSession = directOnlyIceSession("disabled");
    } else {
      try {
        iceSession = await this.#iceCredentialProvider.issue(binding);
      } catch (error) {
        // Credential-provider failure does not silently widen trust. Keep LAN/direct eligibility,
        // but make relay unavailable so a WAN failure is explicit and safe. Record only a bounded
        // reason code: never provider payloads, credentials, identifiers, candidate data, or URLs.
        this.diagnostics.record({
          stage: "relay.credential.unavailable",
          reason: relayCredentialFailureReason(error)
        });
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

  recordLatency(takeoverSessionId: string, sample: WebRtcLatencySample): void {
    const runtime = this.active.get(takeoverSessionId);
    this.latency.record({
      ...sample,
      ...(runtime?.lastHostEncodeMs === undefined ? {} : { hostEncodeMs: runtime.lastHostEncodeMs }),
      ...(runtime?.lastRtpDrainMs === undefined ? {} : { rtpDrainMs: runtime.lastRtpDrainMs })
    });
  }

  latencySnapshot(): WebRtcLatencyComparison {
    return this.latency.snapshot();
  }

  recordDiagnostic(event: WebRtcDiagnosticEvent): void {
    this.diagnostics.record(event);
  }

  diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot {
    return this.diagnostics.snapshot();
  }

  async start(
    binding: WebRtcTakeoverRuntimeBinding,
    offer: WebRtcSessionDescription,
    hooks: WebRtcRuntimeHooks
  ): Promise<WebRtcSessionDescription> {
    if (offer.type !== "offer" || Buffer.byteLength(offer.sdp, "utf8") > MAX_SIGNALING_SDP_BYTES) {
      throw new WebRtcTakeoverRuntimeError("WEBRTC_OFFER_INVALID", "WebRTC offer is invalid");
    }
    const existing = this.active.get(binding.takeoverSessionId);
    if (existing?.binding.clientGeneration === binding.clientGeneration) {
      throw new WebRtcTakeoverRuntimeError(
        "WEBRTC_RUNTIME_ALREADY_ACTIVE",
        "WebRTC runtime for this generation is already active"
      );
    }
    if (existing) await this.end(binding.takeoverSessionId, false, "generation_replace");

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
    let host: ChildProcess | undefined;
    let runtime: ActiveWebRtcRuntime | undefined;
    let startStage: WebRtcRuntimeStartStage = "host_spawn";
    try {
      host = this.spawnHost(binding);
      await this.waitForSpawn(host);
      const expiryTimer = setTimeout(() => {
        void this.end(binding.takeoverSessionId, true, "expiry");
      }, Math.max(0, binding.expiresAt - Date.now()));
      expiryTimer.unref();
      const hostReady = this.config.displayName === undefined ? undefined : createHostReadyGate();
      const mediaReady = createReadyGate("WebRTC host media is unavailable");
      runtime = {
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
        awaitingVideoKeyframe: false,
        mediaReady,
        ...(hostReady ? { hostReady } : {})
      };
      const activeRuntime = runtime;
      this.active.set(binding.takeoverSessionId, activeRuntime);
      this.attachHost(activeRuntime);
      this.attachPeer(activeRuntime);

      if (activeRuntime.hostReady) {
        startStage = "host_ready";
        await Promise.race([
          activeRuntime.hostReady.promise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Linux WebRTC host window is unavailable")), 8_000))
        ]);
      }

      startStage = "media_ready";
      await Promise.race([
        activeRuntime.mediaReady.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("WebRTC host media is unavailable")), 8_000))
      ]);

      const answerStartedAt = Date.now();
      startStage = "remote_description";
      await peer.setRemoteDescription(offer);
      startStage = "track_setup";
      const sender = peer.addTrack(track);
      activeRuntime.sender = sender;
      sender.onPictureLossIndication.subscribe(() => {
        this.requestIdr(activeRuntime);
      });
      startStage = "answer_create";
      const answer = await peer.createAnswer();
      startStage = "local_description";
      await peer.setLocalDescription(answer);
      startStage = "answer_finalize";
      const local = peer.localDescription;
      if (!local?.sdp) throw new Error("WebRTC answer missing local SDP");
      this.recordDiagnostic({
        stage: "server.answer.ready",
        candidateCounts: webRtcCandidateCountsFromSdp(local.sdp),
        durationMs: Date.now() - answerStartedAt
      });
      return { type: "answer", sdp: local.sdp };
    } catch (error) {
      // Snapshot the failure state before cleanup. peer.close() changes signalingState to `closed`,
      // which would otherwise erase the state that actually caused createAnswer() to fail.
      const failedSignalingState = runtimeSignalingState(peer.signalingState);
      const failedEndCause = runtime?.endCause;
      if (host) host.kill("SIGTERM");
      await peer.close().catch(() => undefined);
      const active = this.active.get(binding.takeoverSessionId);
      if (active) clearTimeout(active.expiryTimer);
      this.active.delete(binding.takeoverSessionId);
      await prepared.iceSession.revoke().catch(() => undefined);
      throw error instanceof WebRtcTakeoverRuntimeError
        ? error
        : new WebRtcTakeoverRuntimeError(
            "WEBRTC_RUNTIME_START_FAILED",
            "WebRTC runtime failed to start",
            startStage,
            classifyRuntimeStartReason(error),
            failedSignalingState,
            failedEndCause
          );
    }
  }

  async reconnect(
    binding: WebRtcTakeoverRuntimeBinding,
    offer: WebRtcSessionDescription,
    hooks: WebRtcRuntimeHooks
  ): Promise<WebRtcSessionDescription> {
    return this.start(binding, offer, hooks);
  }

  async revoke(takeoverSessionId: string): Promise<void> {
    await this.revokePrepared(takeoverSessionId);
    await this.end(takeoverSessionId, false, "explicit_revoke");
  }

  async revokeForIntervention(interventionId: string): Promise<void> {
    const ids = new Set<string>();
    for (const [id, runtime] of this.active) if (runtime.binding.interventionId === interventionId) ids.add(id);
    for (const [id, runtime] of this.prepared) if (runtime.binding.interventionId === interventionId) ids.add(id);
    for (const id of ids) await this.revoke(id);
  }

  private async revokePrepared(takeoverSessionId: string): Promise<void> {
    const prepared = this.prepared.get(takeoverSessionId);
    if (!prepared) return;
    this.prepared.delete(takeoverSessionId);
    clearTimeout(prepared.expiryTimer);
    try {
      await prepared.iceSession.revoke();
    } catch {
      throw new WebRtcTakeoverRuntimeError(
        "WEBRTC_RUNTIME_REVOKE_FAILED",
        "WebRTC ICE credential revoke failed"
      );
    }
  }

  private spawnHost(binding: WebRtcTakeoverRuntimeBinding): ChildProcess {
    const env: NodeJS.ProcessEnv = {
      // Keep the helper environment bounded while allowing packaged Node entrypoints that use
      // `#!/usr/bin/env node` to resolve the exact runtime family that spawned this provider.
      // Never inherit the parent PATH: it can contain user-controlled shims or unrelated tools.
      PATH: dirname(process.execPath),
      TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS: String(binding.expiresAt)
    };
    if (this.config.displayId !== undefined) env.TAKEOVER_WEBRTC_DISPLAY_ID = String(this.config.displayId);
    if (this.config.displayName !== undefined) env.TAKEOVER_WEBRTC_DISPLAY_NAME = this.config.displayName;
    if (binding.targetProcessId !== undefined) env.TAKEOVER_WEBRTC_TARGET_PID = String(binding.targetProcessId);
    if (binding.targetWindowId !== undefined) env.TAKEOVER_WEBRTC_TARGET_WINDOW_ID = String(binding.targetWindowId);
    return this.spawnProcess(this.config.hostExecutable, this.config.hostArgs ?? [], {
      env,
      // stdout is the stable frame/control wire. stderr is a bounded, never-forwarded diagnostic
      // side channel so timing instrumentation does not change the media wire consumed by older hosts/runtimes.
      stdio: ["pipe", "pipe", "pipe"]
    });
  }

  private attachPeer(runtime: ActiveWebRtcRuntime): void {
    runtime.peer.onDataChannel.subscribe((channel) => {
      if (channel.label !== "human-critical" && channel.label !== "human-realtime") {
        channel.close();
        return;
      }
      if (channel.label === "human-critical") runtime.critical = channel;
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
        } else {
          runtime.awaitingVideoKeyframe = true;
          this.requestIdr(runtime);
        }
        return;
      }
      if (state === "failed" || state === "disconnected" || state === "closed") {
        void this.end(runtime.binding.takeoverSessionId, true, "peer_state");
      }
    });
  }

  private attachHost(runtime: ActiveWebRtcRuntime): void {
    const stdout = runtime.host.stdout as Readable | null;
    const stderr = runtime.host.stderr as Readable | null;
    if (!stdout || !stderr) throw new Error("WebRTC host pipes are unavailable");
    const parser = new HostRecordParser(
      (frame) => {
        runtime.mediaReady.resolve();
        this.writeFrame(runtime, frame);
      },
      (editable) => this.sendEditableFeedback(runtime, editable, "tap"),
      () => {
        runtime.mediaReady.reject();
        void this.end(runtime.binding.takeoverSessionId, true, "host_protocol");
      }
    );
    const metricParser = new HostMetricParser(
      (hostEncodeMs) => { runtime.lastHostEncodeMs = hostEncodeMs; },
      (regions) => this.sendEditableRegions(runtime, regions),
      (media) => this.recordDiagnostic({ stage: "host.media.window_text", media }),
      (stage) => {
        this.recordDiagnostic({ stage });
        if (stage === "host.window.ready") runtime.hostReady?.resolve();
        if (stage === "host.target.missing" || stage === "host.window.failure.none" || stage === "host.window.failure.multiple") {
          runtime.hostReady?.reject();
        }
      }
    );
    stdout.on("data", (chunk: Buffer) => parser.push(chunk));
    stdout.once("end", () => parser.end());
    stderr.on("data", (chunk: Buffer) => metricParser.push(chunk));
    stderr.once("end", () => metricParser.end());
    runtime.host.once("exit", () => {
      runtime.hostReady?.reject();
      runtime.mediaReady.reject();
      if (!runtime.closing) void this.end(runtime.binding.takeoverSessionId, true, "host_exit");
    });
    runtime.host.once("error", () => {
      runtime.hostReady?.reject();
      runtime.mediaReady.reject();
      if (!runtime.closing) void this.end(runtime.binding.takeoverSessionId, true, "host_error");
    });
  }

  private writeFrame(runtime: ActiveWebRtcRuntime, frame: EncodedHostFrame): void {
    if (runtime.closing) return;
    if (runtime.peer.connectionState !== "connected" || !runtime.sender) {
      // ScreenCaptureKit may produce the only useful static-screen IDR before ICE/DTLS is connected.
      // Keep exactly one pre-connect keyframe so the receiver can initialize without retaining a
      // stale video queue. Dependent P-frames are never retained across this boundary.
      if (frame.keyframe) runtime.preconnectKeyframe = frame;
      return;
    }
    this.enqueueConnectedFrame(runtime, frame);
  }

  private enqueueConnectedFrame(runtime: ActiveWebRtcRuntime, frame: EncodedHostFrame): void {
    if (runtime.closing || runtime.peer.connectionState !== "connected" || !runtime.sender) return;

    // Video is a latest-state stream, not a reliable queue. Werift's MediaStreamTrack.writeRtp()
    // dispatches async sender work without awaiting it, so pumping every encoded frame through the
    // track can accumulate stale SRTP/ICE sends when a TURN path is congested. Keep at most one
    // frame in flight plus the newest pending frame and drop superseded pending frames.
    if (runtime.awaitingVideoKeyframe) {
      if (!frame.keyframe) return;
      runtime.awaitingVideoKeyframe = false;
      runtime.pendingFrame = frame;
    } else if (runtime.pendingFrame) {
      if (runtime.pendingFrame.keyframe) {
        // Preserve the resynchronization point over newer dependent P-frames. A newer keyframe may
        // safely replace it because either keyframe independently restarts decoder state.
        if (frame.keyframe) runtime.pendingFrame = frame;
        else return;
      } else {
        // Superseding an already-encoded dependent frame creates a reference gap. Drop the stale
        // pending chain, request a fresh IDR, and do not resume media until that keyframe arrives.
        delete runtime.pendingFrame;
        runtime.awaitingVideoKeyframe = true;
        this.requestIdr(runtime);
        if (!frame.keyframe) return;
        runtime.awaitingVideoKeyframe = false;
        runtime.pendingFrame = frame;
      }
    } else {
      runtime.pendingFrame = frame;
    }
    if (runtime.videoDrainActive) return;
    runtime.videoDrainActive = true;
    void this.drainLatestFrames(runtime).catch(() => {
      if (!runtime.closing) void this.end(runtime.binding.takeoverSessionId, true, "video_drain");
    });
  }

  private async drainLatestFrames(runtime: ActiveWebRtcRuntime): Promise<void> {
    try {
      while (!runtime.closing && runtime.peer.connectionState === "connected" && runtime.sender) {
        const frame = runtime.pendingFrame;
        if (!frame) break;
        delete runtime.pendingFrame;
        await this.sendFrame(runtime, runtime.sender, frame);
      }
    } finally {
      runtime.videoDrainActive = false;
      if (
        runtime.pendingFrame &&
        !runtime.closing &&
        runtime.peer.connectionState === "connected" &&
        runtime.sender
      ) {
        runtime.videoDrainActive = true;
        void this.drainLatestFrames(runtime).catch(() => {
          if (!runtime.closing) void this.end(runtime.binding.takeoverSessionId, true, "video_drain");
        });
      }
    }
  }

  private async sendFrame(
    runtime: ActiveWebRtcRuntime,
    sender: RTCRtpSender,
    frame: EncodedHostFrame
  ): Promise<void> {
    const drainStartedAt = process.hrtime.bigint();
    const nalUnits = splitAvcc(frame.avcc);
    if (nalUnits.length === 0) return;
    let sequence = runtime.nextSequence;
    for (let nalIndex = 0; nalIndex < nalUnits.length; nalIndex += 1) {
      if (runtime.closing || runtime.peer.connectionState !== "connected") return;
      const nal = nalUnits[nalIndex]!;
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
      const nalHeader = nal[0]!;
      const fuIndicator = (nalHeader & 0xe0) | 28;
      const nalType = nalHeader & 0x1f;
      const fragment = nal.subarray(1);
      const size = RTP_PAYLOAD_BYTES - 2;
      for (let offset = 0; offset < fragment.length; offset += size) {
        if (runtime.closing || runtime.peer.connectionState !== "connected") return;
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

  private requestIdr(runtime: ActiveWebRtcRuntime): void {
    const now = Date.now();
    if (runtime.closing || now - runtime.lastIdrRequestAt < 250) return;
    runtime.lastIdrRequestAt = now;
    this.writeHostCommand(runtime, { kind: "requestIDR" });
  }

  private handleChannelMessage(
    runtime: ActiveWebRtcRuntime,
    label: string,
    message: string | Buffer
  ): void {
    if (runtime.closing) return;
    const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DATA_CHANNEL_MESSAGE_BYTES) return;
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return;
    }
    const input = parseHumanInput(value, label === "human-realtime");
    if (!input) return;

    let endUse: (() => void) | undefined;
    try {
      if (!this.canWriteHostInput(runtime, bytes.byteLength, label === "human-realtime")) return;
      endUse = runtime.hooks.beginInput(input);
      this.writeHostInput(runtime, input);
    } catch {
      // Stale/revoked generation or an unavailable local Human-control session fails closed.
    } finally {
      endUse?.();
    }
  }

  private canWriteHostInput(runtime: ActiveWebRtcRuntime, messageBytes: number, realtime: boolean): boolean {
    const stdin = runtime.host.stdin as Writable | null;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    const limit = realtime ? MAX_HOST_REALTIME_BUFFER_BYTES : MAX_HOST_CRITICAL_BUFFER_BYTES;
    if (realtime && stdin.writableNeedDrain) return false;
    return stdin.writableLength + messageBytes + 1 <= limit;
  }

  private writeHostInput(runtime: ActiveWebRtcRuntime, input: WebRtcHumanInput): void {
    const stdin = runtime.host.stdin as Writable | null;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("WebRTC host input is unavailable");
    const line = JSON.stringify(input);
    if (Buffer.byteLength(line, "utf8") > MAX_DATA_CHANNEL_MESSAGE_BYTES) throw new Error("Human input is too large");
    stdin.write(`${line}\n`);
  }

  private writeHostCommand(runtime: ActiveWebRtcRuntime, command: object): void {
    const stdin = runtime.host.stdin as Writable | null;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    const line = JSON.stringify(command);
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes > MAX_DATA_CHANNEL_MESSAGE_BYTES || stdin.writableLength + bytes > MAX_HOST_REALTIME_BUFFER_BYTES) return;
    stdin.write(`${line}\n`);
  }

  private sendEditableFeedback(runtime: ActiveWebRtcRuntime, editable: boolean, phase: "tap"): void {
    const channel = runtime.critical;
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 16 * 1024) return;
    channel.send(JSON.stringify({ kind: "focus", editable, phase }));
  }

  private sendEditableRegions(runtime: ActiveWebRtcRuntime, regions: number[][]): void {
    const channel = runtime.critical;
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 16 * 1024) return;
    channel.send(JSON.stringify({ kind: "editableRegions", regions }));
  }

  private async end(
    takeoverSessionId: string,
    notifyDisconnect: boolean,
    cause: WebRtcRuntimeEndCause
  ): Promise<void> {
    const runtime = this.active.get(takeoverSessionId);
    if (!runtime || runtime.closing) return;
    runtime.endCause = cause;
    runtime.closing = true;
    this.active.delete(takeoverSessionId);
    clearTimeout(runtime.expiryTimer);
    // Fence broker authority before any OS cleanup or third-party TURN revocation can block.
    // Relay credential revocation is defense-in-depth after the exact client generation is stale.
    if (notifyDisconnect) runtime.hooks.disconnected();
    try {
      runtime.critical?.close();
      await runtime.peer.close().catch(() => undefined);
      // Broker authority is already fenced before explicit revoke reaches here. Terminate the
      // helper immediately so buffered Human input cannot drain after Done/suspend/revoke.
      if (runtime.host.exitCode === null && runtime.host.signalCode === null) runtime.host.kill("SIGTERM");
      await this.waitForExitOrTerminate(runtime.host);
    } catch (error) {
      runtime.host.kill("SIGTERM");
      if (!notifyDisconnect) {
        throw new WebRtcTakeoverRuntimeError(
          "WEBRTC_RUNTIME_REVOKE_FAILED",
          "WebRTC runtime revoke failed"
        );
      }
    } finally {
      await runtime.iceSession.revoke().catch(() => undefined);
    }
  }

  private async waitForSpawn(child: ChildProcess): Promise<void> {
    if (child.pid !== undefined) return;
    await Promise.race([
      once(child, "spawn").then(() => undefined),
      once(child, "error").then(([error]) => Promise.reject(error))
    ]);
  }

  private async waitForExitOrTerminate(child: ChildProcess): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = await Promise.race([
        once(child, "close").then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))
      ]);
      if (!exited) {
        child.kill("SIGTERM");
        const terminated = await Promise.race([
          once(child, "close").then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))
        ]);
        if (!terminated) child.kill("SIGKILL");
      }
    }
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}


function createHostReadyGate(): HostReadyGate {
  return createReadyGate("Linux WebRTC host window is unavailable");
}

function createReadyGate(errorMessage: string): HostReadyGate {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  // A prior startup gate may fail before this gate is awaited. Observe rejection immediately so
  // cleanup-triggered rejection never escapes as an unhandled promise while preserving the same
  // rejected promise for the stage that does await it.
  void promise.catch(() => undefined);
  const gate: HostReadyGate = {
    settled: false,
    promise,
    resolve() {
      if (gate.settled) return;
      gate.settled = true;
      resolvePromise();
    },
    reject() {
      if (gate.settled) return;
      gate.settled = true;
      rejectPromise(new Error(errorMessage));
    }
  };
  return gate;
}

function classifyRuntimeStartReason(error: unknown): WebRtcRuntimeStartReason {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (message === "Linux WebRTC host window is unavailable") return "host_not_ready";
  if (message === "WebRTC host media is unavailable") return "media_not_ready";
  if (name === "InvalidStateError" || /peer closed|RTCPeerConnection is closed/i.test(message)) return "peer_closed";
  if (message === "createAnswer failed") return "answer_signaling_state";
  if (message === "wrong state") return "answer_remote_description_missing";
  if (/^Transceiver with mid=.* not found$/.test(message)) return "transceiver_missing";
  if (message === "sctpTransport not found") return "sctp_missing";
  if (message === "invalid kind") return "invalid_media_kind";
  return "other";
}

function runtimeSignalingState(value: string): WebRtcRuntimeSignalingState | undefined {
  switch (value) {
    case "stable":
    case "have-local-offer":
    case "have-remote-offer":
    case "have-local-pranswer":
    case "have-remote-pranswer":
    case "closed":
      return value;
    default:
      return undefined;
  }
}

function iceCredentialProviderFromEnvironment(env: NodeJS.ProcessEnv): WebRtcIceCredentialProvider | undefined {
  const turnKeyId = env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID?.trim();
  const turnKeyApiToken = env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN?.trim();
  const coturnSharedSecret = env.MCP_HANDOFF_COTURN_SHARED_SECRET?.trim();
  const coturnTurnUrls = env.MCP_HANDOFF_COTURN_TURN_URLS?.trim();
  const coturnStunUrls = env.MCP_HANDOFF_COTURN_STUN_URLS?.trim();
  const hasCloudflare = Boolean(turnKeyId || turnKeyApiToken);
  const hasCoturn = Boolean(coturnSharedSecret || coturnTurnUrls || coturnStunUrls);
  if (hasCloudflare && hasCoturn) {
    throw new Error("Multiple TURN providers are configured");
  }
  if (hasCloudflare) {
    if (!turnKeyId || !turnKeyApiToken) {
      throw new Error("Cloudflare TURN configuration is incomplete");
    }
    return new CloudflareRealtimeTurnCredentialProvider({ turnKeyId, turnKeyApiToken });
  }
  if (hasCoturn) {
    if (!coturnSharedSecret || !coturnTurnUrls) {
      throw new Error("coturn TURN configuration is incomplete");
    }
    const turnUrls = parseCommaSeparatedIceUrls(coturnTurnUrls);
    const stunUrls = coturnStunUrls ? parseCommaSeparatedIceUrls(coturnStunUrls) : undefined;
    return new CoturnRestTurnCredentialProvider({
      turnUrls,
      ...(stunUrls ? { stunUrls } : {}),
      sharedSecret: coturnSharedSecret
    });
  }
  return undefined;
}

function parseCommaSeparatedIceUrls(value: string): string[] {
  const values = value.split(",").map((entry) => entry.trim());
  if (values.length < 1 || values.some((entry) => entry.length === 0)) {
    throw new Error("TURN URL configuration is invalid");
  }
  return values;
}

function sameBinding(left: WebRtcTakeoverRuntimeBinding, right: WebRtcTakeoverRuntimeBinding): boolean {
  return left.takeoverSessionId === right.takeoverSessionId
    && left.interventionId === right.interventionId
    && left.epoch === right.epoch
    && left.principalBinding === right.principalBinding
    && left.clientBinding === right.clientBinding
    && left.clientGeneration === right.clientGeneration
    && left.expiresAt === right.expiresAt
    && left.targetProcessId === right.targetProcessId
    && left.targetWindowId === right.targetWindowId;
}

function parseHumanInput(value: unknown, realtime: boolean): WebRtcHumanInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (realtime) {
    if (record.kind !== "scroll") return undefined;
    const deltaX = Number(record.deltaX);
    const deltaY = Number(record.deltaY);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX) > 2_000 || Math.abs(deltaY) > 2_000) return undefined;
    return { kind: "scroll", deltaX, deltaY };
  }
  if (record.kind === "tap") {
    const x = Number(record.x);
    const y = Number(record.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return undefined;
    return { kind: "tap", x, y };
  }
  if (record.kind === "pointer_button" && record.button === "primary" && (record.state === "down" || record.state === "up")) {
    const x = Number(record.x);
    const y = Number(record.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return undefined;
    return { kind: "pointer_button", button: "primary", state: record.state, x, y };
  }
  if (record.kind === "text") {
    if (typeof record.text !== "string" || record.text.length === 0 || Buffer.byteLength(record.text, "utf8") > MAX_TEXT_BYTES) return undefined;
    return { kind: "text", text: record.text };
  }
  if (record.kind === "key" && (record.key === "Backspace" || record.key === "Enter")) {
    return { kind: "key", key: record.key };
  }
  return undefined;
}

function splitAvcc(sample: Buffer): Buffer[] {
  const nalUnits: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= sample.length) {
    const length = sample.readUInt32BE(offset);
    offset += 4;
    if (length < 1 || offset + length > sample.length) return [];
    nalUnits.push(sample.subarray(offset, offset + length));
    offset += length;
  }
  return offset === sample.length ? nalUnits : [];
}

class HostMetricParser {
  private text = "";

  constructor(
    private readonly onHostEncode: (hostEncodeMs: number) => void,
    private readonly onEditableRegions: (regions: number[][]) => void,
    private readonly onHostMedia: (media: WebRtcDiagnosticMedia) => void,
    private readonly onHostStage: (stage: Extract<WebRtcDiagnosticStage, `host.${string}`>) => void
  ) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.text += chunk.toString("utf8");
    if (this.text.length > 8_192) this.text = this.text.slice(-2_048);
    for (;;) {
      const newline = this.text.indexOf("\n");
      if (newline < 0) return;
      const line = this.text.slice(0, newline).trim();
      this.text = this.text.slice(newline + 1);
      const matched = /^MCP_HANDOFF_METRIC encode_tenths=(\d{1,5})$/.exec(line);
      if (matched) {
        const tenths = Number(matched[1]);
        if (Number.isSafeInteger(tenths) && tenths >= 0 && tenths <= 65_535) this.onHostEncode(tenths / 10);
        continue;
      }
      const media = /^MCP_HANDOFF_DIAGNOSTIC media_profile=window_text width=(\d{1,4}) height=(\d{1,4}) bitrate_kbps=(\d{3,5}) speed_priority=(0|1)$/.exec(line);
      if (media) {
        this.onHostMedia({
          width: Number(media[1]),
          height: Number(media[2]),
          bitrateKbps: Number(media[3]),
          speedPriority: media[4] === "1"
        });
        continue;
      }
      const diagnostic = /^MCP_HANDOFF_DIAGNOSTIC linux_stage=(target_alive|target_missing|window_ready|window_failure_none|window_failure_multiple|capture_started|frame_ready|input_focus_ready|input_tap_sent|input_pointer_helper_ready|input_pointer_helper_failure|input_pointer_move_ready|input_pointer_authority_ready|input_pointer_down_sent|input_pointer_post_authority_ready|input_pointer_delivery_helper_ready|input_pointer_delivery_helper_failure|input_pointer_delivery_arm_failure|input_pointer_delivery_wait_no_from_server_creator_match|input_pointer_delivery_wait_no_from_server_creator_mismatch|input_pointer_delivery_wait_no_from_server_creator_unknown|input_pointer_delivery_wait_swapped|input_pointer_delivery_wait_short_data|input_pointer_delivery_wait_no_event|input_pointer_delivery_wait_event_mismatch|input_pointer_delivery_wait_xi2_mismatch|input_pointer_delivery_wait_window_mismatch|input_pointer_delivery_wait_coord_mismatch|input_pointer_delivery_wait_io_failure|input_pointer_delivery_wait_failure|input_pointer_delivery_ready|input_failure|capture_failure|capture_failure_x11|capture_failure_encoder|capture_failure_option|capture_failure_other)$/.exec(line);
      if (diagnostic) {
        const stages = {
          target_alive: "host.target.alive",
          target_missing: "host.target.missing",
          window_ready: "host.window.ready",
          window_failure_none: "host.window.failure.none",
          window_failure_multiple: "host.window.failure.multiple",
          capture_started: "host.capture.started",
          frame_ready: "host.frame.ready",
          input_focus_ready: "host.input.focus.ready",
          input_tap_sent: "host.input.tap.sent",
          input_pointer_helper_ready: "host.input.pointer.helper_ready",
          input_pointer_helper_failure: "host.input.pointer.helper_failure",
          input_pointer_move_ready: "host.input.pointer.move_ready",
          input_pointer_authority_ready: "host.input.pointer.authority_ready",
          input_pointer_down_sent: "host.input.pointer.down_sent",
          input_pointer_post_authority_ready: "host.input.pointer.post_authority_ready",
          input_pointer_delivery_helper_ready: "host.input.pointer.delivery_helper_ready",
          input_pointer_delivery_helper_failure: "host.input.pointer.delivery_helper_failure",
          input_pointer_delivery_arm_failure: "host.input.pointer.delivery_arm_failure",
          input_pointer_delivery_wait_no_from_server_creator_match: "host.input.pointer.delivery_wait_no_from_server_creator_match",
          input_pointer_delivery_wait_no_from_server_creator_mismatch: "host.input.pointer.delivery_wait_no_from_server_creator_mismatch",
          input_pointer_delivery_wait_no_from_server_creator_unknown: "host.input.pointer.delivery_wait_no_from_server_creator_unknown",
          input_pointer_delivery_wait_swapped: "host.input.pointer.delivery_wait_swapped",
          input_pointer_delivery_wait_short_data: "host.input.pointer.delivery_wait_short_data",
          input_pointer_delivery_wait_no_event: "host.input.pointer.delivery_wait_no_event",
          input_pointer_delivery_wait_event_mismatch: "host.input.pointer.delivery_wait_event_mismatch",
          input_pointer_delivery_wait_xi2_mismatch: "host.input.pointer.delivery_wait_xi2_mismatch",
          input_pointer_delivery_wait_window_mismatch: "host.input.pointer.delivery_wait_window_mismatch",
          input_pointer_delivery_wait_coord_mismatch: "host.input.pointer.delivery_wait_coord_mismatch",
          input_pointer_delivery_wait_io_failure: "host.input.pointer.delivery_wait_io_failure",
          input_pointer_delivery_wait_failure: "host.input.pointer.delivery_wait_failure",
          input_pointer_delivery_ready: "host.input.pointer.delivery_ready",
          input_failure: "host.input.failure",
          capture_failure: "host.capture.failure",
          capture_failure_x11: "host.capture.failure.x11",
          capture_failure_encoder: "host.capture.failure.encoder",
          capture_failure_option: "host.capture.failure.option",
          capture_failure_other: "host.capture.failure.other"
        } as const;
        this.onHostStage(stages[diagnostic[1] as keyof typeof stages]);
        continue;
      }
      const macPointer = /^MCP_HANDOFF_DIAGNOSTIC input_stage=(activation_failed|primary_down_rejected|primary_down_sent|primary_up_rejected|primary_up_sent)$/.exec(line);
      if (macPointer) {
        const stages = {
          activation_failed: "host.input.failure",
          primary_down_rejected: "host.input.failure",
          primary_down_sent: "host.input.pointer.down_sent",
          primary_up_rejected: "host.input.failure",
          primary_up_sent: "host.input.tap.sent"
        } as const;
        this.onHostStage(stages[macPointer[1] as keyof typeof stages]);
        continue;
      }
      const successor = /^MCP_HANDOFF_DIAGNOSTIC successor_stage=(probe_started|admitted|returned|none|ambiguous|unsupported|failure)$/.exec(line);
      if (successor) {
        const stages = {
          probe_started: "host.window.successor.probe",
          admitted: "host.window.successor.admitted",
          returned: "host.window.successor.returned",
          none: "host.window.successor.none",
          ambiguous: "host.window.successor.ambiguous",
          unsupported: "host.window.successor.unsupported",
          failure: "host.window.successor.failure"
        } as const;
        this.onHostStage(stages[successor[1] as keyof typeof stages]);
        continue;
      }
      const textRoute = /^MCP_HANDOFF_DIAGNOSTIC input_text_route=(native_ax|pid_keyboard|event_creation_failure|activation_rejected|native_boundary_rejected)$/.exec(line);
      if (textRoute) {
        const stages = {
          native_ax: "host.input.text.native_ax",
          pid_keyboard: "host.input.text.pid_keyboard",
          event_creation_failure: "host.input.text.event_creation_failure",
          activation_rejected: "host.input.text.activation_rejected",
          native_boundary_rejected: "host.input.text.native_boundary_rejected"
        } as const;
        this.onHostStage(stages[textRoute[1] as keyof typeof stages]);
        continue;
      }
      const regionsLine = /^MCP_HANDOFF_CONTROL editable_regions=(.*)$/.exec(line);
      if (regionsLine) {
        const payload = regionsLine[1] ?? "";
        if (payload.length > 1_024) continue;
        if (payload === "") { this.onEditableRegions([]); continue; }
        const encoded = payload.split(";");
        if (encoded.length > 32) continue;
        const regions: number[][] = [];
        let valid = true;
        for (const item of encoded) {
          const match = /^(\d{1,5}),(\d{1,5}),(\d{1,5}),(\d{1,5})$/.exec(item);
          if (!match) { valid = false; break; }
          const region = match.slice(1).map(Number);
          const [x, y, width, height] = region;
          if (!region.every(Number.isSafeInteger) || width! < 1 || height! < 1 || x! < 0 || y! < 0 || x! + width! > 10_000 || y! + height! > 10_000) { valid = false; break; }
          regions.push(region);
        }
        if (valid) this.onEditableRegions(regions);
      }
    }
  }

  end(): void {
    this.text = "";
  }
}

class HostRecordParser {
  private buffer = Buffer.alloc(0);
  private failed = false;

  constructor(
    private readonly onFrame: (frame: EncodedHostFrame) => void,
    private readonly onEditable: (editable: boolean) => void,
    private readonly onFailure: () => void
  ) {}

  push(chunk: Buffer): void {
    if (this.failed || chunk.length === 0) return;
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const type = this.buffer[0]!;
      const length = this.buffer.readUInt32BE(1);
      if (length > MAX_HOST_FRAME_BYTES || (type === 2 && length !== 1)) return this.fail();
      if (this.buffer.length < 5 + length) return;
      const payload = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);
      if (type === 1) {
        if (payload.length < 9) return this.fail();
        const rtpTimestamp = payload.readUInt32BE(0);
        const keyframe = payload[4] === 1;
        const width = payload.readUInt16BE(5);
        const height = payload.readUInt16BE(7);
        const avcc = payload.subarray(9);
        if (!width || !height || avcc.length === 0) return this.fail();
        this.onFrame({ rtpTimestamp, keyframe, width, height, avcc });
      } else if (type === 2) {
        this.onEditable(payload[0] === 1);
      } else {
        return this.fail();
      }
    }
  }

  end(): void {
    if (!this.failed && this.buffer.length !== 0) this.fail();
  }

  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    this.onFailure();
  }
}
