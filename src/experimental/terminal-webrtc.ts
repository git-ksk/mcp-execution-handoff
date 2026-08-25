import { randomBytes } from "node:crypto";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { TakeoverSessionError, TakeoverSessionManager, type TakeoverGrant } from "../browser-takeover/session.js";
import {
  CloudflareRealtimeTurnCredentialProvider,
  CoturnRestTurnCredentialProvider,
  cloneIceServers,
  directOnlyIceSession,
  type WebRtcBrowserIceConfiguration,
  type WebRtcIceCredentialProvider,
  type WebRtcPreparedIceSession,
  type WebRtcTakeoverRuntimeBinding
} from "../browser-takeover/webrtc-ice.js";
import { parseWebRtcOffer, webRtcBindingFromGrant, type WebRtcSessionDescription } from "../browser-takeover/webrtc-runtime.js";

const MAX_SIGNALING_SDP_BYTES = 128 * 1024;
const MAX_CHANNEL_MESSAGE_BYTES = 8 * 1024;
const MAX_TERMINAL_INPUT_BYTES = 2 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES = 16 * 1024;
const MAX_EVENT_QUEUE_ITEMS = 64;
const MAX_EVENT_QUEUE_BYTES = 64 * 1024;
const CHANNEL_LABEL = "terminal-control";

export type ExperimentalTerminalWebRtcEvent =
  | { kind: "input"; dataBase64: string }
  | { kind: "resize"; rows: number; cols: number }
  | { kind: "done" };

export interface ExperimentalTerminalWebRtcStatus {
  transportReady: boolean;
  humanActive: boolean;
  disconnected: boolean;
  completed: boolean;
  faulted: boolean;
  clientGeneration?: number;
  queuedEvents: number;
}

export interface ExperimentalTerminalWebRtcConfig {
  enabled: boolean;
  publicBaseUrl?: string;
  ttlMs: number;
  reconnectIdleMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface TerminalSession {
  id: string;
  interventionId: string;
  epoch: number;
  principalBinding: string;
  humanActive: boolean;
  disconnected: boolean;
  completed: boolean;
  faulted: boolean;
  queue: ExperimentalTerminalWebRtcEvent[];
  queuedBytes: number;
  clientGeneration?: number;
}

interface RuntimeHooks {
  ready(generation: number): void;
  message(generation: number, message: string): void;
  disconnected(generation: number): void;
  faulted(generation: number): void;
}

interface PreparedRuntime {
  binding: WebRtcTakeoverRuntimeBinding;
  ice: WebRtcPreparedIceSession;
  expiry: NodeJS.Timeout;
}

interface ActiveRuntime {
  binding: WebRtcTakeoverRuntimeBinding;
  ice: WebRtcPreparedIceSession;
  expiry: NodeJS.Timeout;
  peer: RTCPeerConnection;
  hooks: RuntimeHooks;
  channel?: RTCDataChannel;
  inputEnabled: boolean;
  closing: boolean;
}

class TerminalDataChannelRuntime {
  readonly #prepared = new Map<string, PreparedRuntime>();
  readonly #active = new Map<string, ActiveRuntime>();
  readonly #iceProvider: WebRtcIceCredentialProvider | undefined;

  constructor(env: NodeJS.ProcessEnv) {
    this.#iceProvider = iceCredentialProviderFromEnvironment(env);
  }

  async prepare(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcBrowserIceConfiguration> {
    await this.revokePrepared(binding.takeoverSessionId);
    const ice = this.#iceProvider
      ? await this.#iceProvider.issue(binding).catch(() => directOnlyIceSession("unavailable"))
      : directOnlyIceSession();
    const expiry = setTimeout(() => {
      void this.revoke(binding.takeoverSessionId);
    }, Math.max(0, binding.expiresAt - Date.now()));
    expiry.unref();
    this.#prepared.set(binding.takeoverSessionId, { binding: { ...binding }, ice, expiry });
    return { iceServers: cloneIceServers(ice.browser.iceServers), relay: ice.browser.relay };
  }

  async start(
    binding: WebRtcTakeoverRuntimeBinding,
    offer: WebRtcSessionDescription,
    hooks: RuntimeHooks
  ): Promise<WebRtcSessionDescription> {
    if (offer.type !== "offer" || Buffer.byteLength(offer.sdp, "utf8") > MAX_SIGNALING_SDP_BYTES) {
      throw new Error("terminal WebRTC offer invalid");
    }
    const existing = this.#active.get(binding.takeoverSessionId);
    if (existing?.binding.clientGeneration === binding.clientGeneration) {
      throw new Error("terminal WebRTC generation already active");
    }
    if (existing) await this.revokeActive(binding.takeoverSessionId);

    let prepared = this.#prepared.get(binding.takeoverSessionId);
    if (!prepared && !this.#iceProvider) {
      await this.prepare(binding);
      prepared = this.#prepared.get(binding.takeoverSessionId);
    }
    if (!prepared || !sameBinding(prepared.binding, binding)) {
      throw new Error("terminal WebRTC ICE session unavailable");
    }
    this.#prepared.delete(binding.takeoverSessionId);
    clearTimeout(prepared.expiry);

    const peer = new RTCPeerConnection({
      iceServers: cloneIceServers(prepared.ice.serverIceServers),
      iceTransportPolicy: "all",
      maxMessageSize: MAX_CHANNEL_MESSAGE_BYTES
    });
    const expiry = setTimeout(() => {
      void this.revoke(binding.takeoverSessionId);
    }, Math.max(0, binding.expiresAt - Date.now()));
    expiry.unref();
    const runtime: ActiveRuntime = {
      binding: { ...binding },
      ice: prepared.ice,
      expiry,
      peer,
      hooks,
      inputEnabled: false,
      closing: false
    };
    this.#active.set(binding.takeoverSessionId, runtime);
    this.attachPeer(runtime);
    try {
      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      const local = peer.localDescription;
      if (!local?.sdp || Buffer.byteLength(local.sdp, "utf8") > MAX_SIGNALING_SDP_BYTES) {
        throw new Error("terminal WebRTC answer invalid");
      }
      return { type: "answer", sdp: local.sdp };
    } catch {
      await this.revokeActive(binding.takeoverSessionId).catch(() => undefined);
      throw new Error("terminal WebRTC runtime unavailable");
    }
  }

  activate(takeoverSessionId: string, generation: number): void {
    const runtime = this.requireGeneration(takeoverSessionId, generation);
    if (!runtime.channel || runtime.channel.readyState !== "open") throw new Error("terminal WebRTC channel unavailable");
    runtime.inputEnabled = true;
    this.sendState(runtime, "human_active");
  }

  fence(takeoverSessionId: string): void {
    const runtime = this.#active.get(takeoverSessionId);
    if (!runtime) return;
    runtime.inputEnabled = false;
    this.sendState(runtime, "fenced");
  }

  sendOutput(takeoverSessionId: string, generation: number, dataBase64: string): void {
    const runtime = this.requireGeneration(takeoverSessionId, generation);
    if (!runtime.inputEnabled || !runtime.channel || runtime.channel.readyState !== "open") {
      throw new Error("terminal WebRTC output unavailable");
    }
    const bytes = decodeBase64(dataBase64, MAX_TERMINAL_OUTPUT_BYTES);
    const payload = JSON.stringify({ kind: "output", dataBase64: bytes.toString("base64") });
    if (Buffer.byteLength(payload, "utf8") > MAX_CHANNEL_MESSAGE_BYTES || runtime.channel.bufferedAmount > 64 * 1024) {
      throw new Error("terminal WebRTC output backpressure");
    }
    runtime.channel.send(payload);
  }

  async revoke(takeoverSessionId: string): Promise<void> {
    await this.revokePrepared(takeoverSessionId);
    await this.revokeActive(takeoverSessionId);
  }

  private attachPeer(runtime: ActiveRuntime): void {
    runtime.peer.onDataChannel.subscribe((channel) => {
      if (runtime.channel || channel.label !== CHANNEL_LABEL || channel.protocol !== "") {
        channel.close();
        return;
      }
      runtime.channel = channel;
      channel.stateChanged.subscribe((state) => {
        if (state === "open") {
          runtime.hooks.ready(runtime.binding.clientGeneration);
          this.sendState(runtime, runtime.inputEnabled ? "human_active" : "connected");
        }
        if (state === "closed" && !runtime.closing) runtime.hooks.disconnected(runtime.binding.clientGeneration);
      });
      channel.onMessage.subscribe((message) => {
        if (!runtime.inputEnabled || runtime.closing) return;
        const text = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
        if (Buffer.byteLength(text, "utf8") > MAX_CHANNEL_MESSAGE_BYTES) {
          runtime.inputEnabled = false;
          runtime.hooks.faulted(runtime.binding.clientGeneration);
          void this.revoke(runtime.binding.takeoverSessionId);
          return;
        }
        runtime.hooks.message(runtime.binding.clientGeneration, text);
      });
    });
    runtime.peer.connectionStateChange.subscribe((state) => {
      if ((state === "failed" || state === "disconnected" || state === "closed") && !runtime.closing) {
        runtime.inputEnabled = false;
        runtime.hooks.disconnected(runtime.binding.clientGeneration);
      }
    });
  }

  private sendState(runtime: ActiveRuntime, state: "connected" | "human_active" | "fenced"): void {
    if (!runtime.channel || runtime.channel.readyState !== "open") return;
    const payload = JSON.stringify({ kind: "state", state });
    if (runtime.channel.bufferedAmount <= 64 * 1024) runtime.channel.send(payload);
  }

  private requireGeneration(takeoverSessionId: string, generation: number): ActiveRuntime {
    const runtime = this.#active.get(takeoverSessionId);
    if (!runtime || runtime.binding.clientGeneration !== generation || runtime.closing) {
      throw new Error("terminal WebRTC generation unavailable");
    }
    return runtime;
  }

  private async revokePrepared(takeoverSessionId: string): Promise<void> {
    const prepared = this.#prepared.get(takeoverSessionId);
    if (!prepared) return;
    this.#prepared.delete(takeoverSessionId);
    clearTimeout(prepared.expiry);
    await prepared.ice.revoke().catch(() => undefined);
  }

  private async revokeActive(takeoverSessionId: string): Promise<void> {
    const runtime = this.#active.get(takeoverSessionId);
    if (!runtime) return;
    this.#active.delete(takeoverSessionId);
    runtime.closing = true;
    runtime.inputEnabled = false;
    clearTimeout(runtime.expiry);
    runtime.channel?.close();
    await runtime.peer.close().catch(() => undefined);
    await runtime.ice.revoke().catch(() => undefined);
  }
}

export class ExperimentalTerminalWebRtcTakeover {
  readonly #sessions: TakeoverSessionManager;
  readonly #runtime: TerminalDataChannelRuntime;
  readonly #publicOrigin: string | undefined;
  readonly #publicBaseUrl: string | undefined;
  #session: TerminalSession | undefined;

  constructor(private readonly config: ExperimentalTerminalWebRtcConfig) {
    this.#sessions = new TakeoverSessionManager(
      config.ttlMs,
      undefined,
      undefined,
      undefined,
      config.reconnectIdleMs ?? 5_000
    );
    this.#runtime = new TerminalDataChannelRuntime(config.env ?? process.env);
    this.#publicBaseUrl = config.publicBaseUrl;
    this.#publicOrigin = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : undefined;
  }

  isPath(pathname: string): boolean {
    return pathname.startsWith("/takeover/terminal/");
  }

  start(interventionId: string, epoch: number, principalBinding: string): string {
    if (!this.config.enabled || !this.#publicBaseUrl || !validIntervention(interventionId, epoch) || !validBinding(principalBinding)) {
      throw new Error("terminal WebRTC takeover unavailable");
    }
    if (this.#session && !this.#session.completed) throw new Error("terminal WebRTC takeover already active");
    const locator = this.#sessions.ensure(interventionId, epoch, principalBinding);
    this.#session = {
      id: locator.id,
      interventionId,
      epoch,
      principalBinding,
      humanActive: false,
      disconnected: false,
      completed: false,
      faulted: false,
      queue: [],
      queuedBytes: 0
    };
    return new URL(`/takeover/terminal/${encodeURIComponent(locator.id)}`, this.#publicBaseUrl).toString();
  }

  status(interventionId: string, epoch: number): ExperimentalTerminalWebRtcStatus {
    const session = this.requireIntervention(interventionId, epoch);
    return {
      transportReady: session.clientGeneration !== undefined && !session.disconnected && !session.faulted,
      humanActive: session.humanActive,
      disconnected: session.disconnected,
      completed: session.completed,
      faulted: session.faulted,
      ...(session.clientGeneration === undefined ? {} : { clientGeneration: session.clientGeneration }),
      queuedEvents: session.queue.length
    };
  }

  activateHuman(interventionId: string, epoch: number): void {
    const session = this.requireIntervention(interventionId, epoch);
    if (session.completed || session.disconnected || session.faulted || session.clientGeneration === undefined) {
      throw new Error("terminal WebRTC transport unavailable");
    }
    this.#runtime.activate(session.id, session.clientGeneration);
    session.humanActive = true;
  }

  fenceHuman(interventionId: string, epoch: number): void {
    const session = this.requireIntervention(interventionId, epoch);
    session.humanActive = false;
    this.#runtime.fence(session.id);
  }

  /**
   * Transport-adapter callback only. A stale generation cannot fence the current Human peer, and
   * disconnect never advances the Handoff lifecycle or implies Done.
   */
  noteTransportDisconnect(interventionId: string, epoch: number, generation: number): void {
    const session = this.requireIntervention(interventionId, epoch);
    if (!Number.isSafeInteger(generation) || generation < 1 || session.completed || session.clientGeneration !== generation) return;
    session.humanActive = false;
    session.disconnected = true;
  }

  drainEvents(interventionId: string, epoch: number): ExperimentalTerminalWebRtcEvent[] {
    const session = this.requireIntervention(interventionId, epoch);
    const events = session.queue;
    session.queue = [];
    session.queuedBytes = 0;
    return events;
  }

  nextEvent(interventionId: string, epoch: number): ExperimentalTerminalWebRtcEvent | undefined {
    const session = this.requireIntervention(interventionId, epoch);
    const event = session.queue.shift();
    if (!event) return undefined;
    session.queuedBytes = Math.max(0, session.queuedBytes - terminalEventCost(event));
    return event;
  }

  pushOutput(interventionId: string, epoch: number, dataBase64: string): void {
    const session = this.requireIntervention(interventionId, epoch);
    if (!session.humanActive || session.clientGeneration === undefined) throw new Error("terminal Human output unavailable");
    this.#runtime.sendOutput(session.id, session.clientGeneration, dataBase64);
  }

  /** Release only a transport already fenced/completed by ordered Human Done. */
  releaseCompleted(interventionId: string, epoch: number): void {
    const session = this.requireIntervention(interventionId, epoch);
    if (!session.completed || session.humanActive) {
      throw new Error("terminal WebRTC transport is not completed");
    }
    this.#session = undefined;
  }

  async revoke(interventionId: string, epoch: number): Promise<void> {
    const session = this.requireIntervention(interventionId, epoch);
    session.humanActive = false;
    await this.#runtime.revoke(session.id);
    this.#sessions.revoke(session.id);
    this.#session = undefined;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const page = /^\/takeover\/terminal\/([A-Za-z0-9_-]{8,100})$/.exec(url.pathname);
    if (page) return this.handlePage(request, page[1]!);
    const api = /^\/takeover\/terminal\/api\/(prepare|connect)\/([A-Za-z0-9_-]{8,100})$/.exec(url.pathname);
    if (!api) return json(404, { error: "not_found" });
    const [, operation, id] = api;
    const session = this.#session;
    if (!session || id !== session.id) return json(404, { error: "takeover_unavailable" });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (!this.sameOriginMutation(request)) return json(403, { error: "origin_not_allowed" });
    const clientBinding = readClientBinding(request.headers.get("x-terminal-client"));
    if (!clientBinding) return json(404, { error: "takeover_unavailable" });
    if (operation === "prepare") return this.handlePrepare(request, session, clientBinding);
    return this.handleConnect(request, session, clientBinding);
  }

  private handlePage(request: Request, id: string): Response {
    if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" });
    const session = this.#session;
    if (!session || id !== session.id || session.completed) return json(404, { error: "takeover_unavailable" });
    try {
      this.#sessions.validateLocator(id, session.principalBinding);
    } catch {
      return json(404, { error: "takeover_unavailable" });
    }
    const nonce = randomBytes(18).toString("base64url");
    const headers = new Headers(privateHeaders("text/html; charset=utf-8"));
    headers.set(
      "content-security-policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    );
    return new Response(request.method === "HEAD" ? null : terminalPage(nonce), { status: 200, headers });
  }

  private async handlePrepare(request: Request, session: TerminalSession, clientBinding: string): Promise<Response> {
    if (session.completed) return json(404, { error: "takeover_unavailable" });
    let grant: TakeoverGrant;
    try {
      grant = this.#sessions.claimClient(session.id, session.principalBinding, clientBinding);
    } catch (error) {
      if (error instanceof TakeoverSessionError && error.code === "TAKEOVER_CLIENT_ACTIVE") {
        return json(409, { error: "takeover_client_active" });
      }
      return json(404, { error: "takeover_unavailable" });
    }
    try {
      const ice = await this.#runtime.prepare(webRtcBindingFromGrant(grant));
      return json(200, {
        capability: grant.capability,
        reconnectHandle: grant.reconnectHandle,
        clientGeneration: grant.clientGeneration,
        webrtcIce: ice
      });
    } catch {
      try {
        this.#sessions.releaseClientGeneration(session.id, session.principalBinding, clientBinding, grant.clientGeneration);
      } catch {}
      await this.#runtime.revoke(session.id).catch(() => undefined);
      return json(503, { error: "webrtc_ice_unavailable" });
    }
  }

  private async handleConnect(request: Request, session: TerminalSession, clientBinding: string): Promise<Response> {
    const capability = readCapability(request.headers.get("x-terminal-capability"));
    if (!capability) return json(404, { error: "takeover_unavailable" });
    let offer: WebRtcSessionDescription;
    try {
      offer = parseWebRtcOffer(await readBoundedJson(request, MAX_SIGNALING_SDP_BYTES));
    } catch {
      return json(400, { error: "webrtc_offer_invalid" });
    }
    let verified: ReturnType<TakeoverSessionManager["verify"]>;
    try {
      verified = this.#sessions.verify(session.id, capability, session.principalBinding, clientBinding);
    } catch {
      return json(404, { error: "takeover_unavailable" });
    }
    const binding: WebRtcTakeoverRuntimeBinding = {
      takeoverSessionId: verified.id,
      interventionId: verified.interventionId,
      epoch: verified.epoch,
      principalBinding: verified.principalBinding,
      clientBinding: verified.clientBinding,
      clientGeneration: verified.clientGeneration,
      expiresAt: verified.expiresAt
    };
    try {
      const answer = await this.#runtime.start(binding, offer, {
        ready: (generation) => {
          if (this.#session === session && !session.completed && generation === binding.clientGeneration) {
            session.clientGeneration = generation;
            session.disconnected = false;
          }
        },
        message: (generation, message) => this.acceptMessage(session, generation, message),
        disconnected: (generation) => {
          this.noteTransportDisconnect(session.interventionId, session.epoch, generation);
        },
        faulted: (generation) => {
          if (this.#session === session && generation === session.clientGeneration) {
            session.humanActive = false;
            session.faulted = true;
          }
        }
      });
      return json(200, { webrtc: answer });
    } catch {
      try {
        this.#sessions.releaseClientGeneration(session.id, session.principalBinding, clientBinding, binding.clientGeneration);
      } catch {}
      await this.#runtime.revoke(session.id).catch(() => undefined);
      return json(503, { error: "webrtc_runtime_unavailable" });
    }
  }

  private acceptMessage(session: TerminalSession, generation: number, message: string): void {
    if (this.#session !== session || session.completed || session.disconnected || session.faulted || !session.humanActive) return;
    if (session.clientGeneration !== generation) return;
    let value: unknown;
    try { value = JSON.parse(message); } catch { return this.faultSession(session); }
    const event = parseTerminalEvent(value);
    if (!event) return this.faultSession(session);
    const cost = terminalEventCost(event);
    if (session.queue.length >= MAX_EVENT_QUEUE_ITEMS || session.queuedBytes + cost > MAX_EVENT_QUEUE_BYTES) {
      return this.faultSession(session);
    }
    session.queue.push(event);
    session.queuedBytes += cost;
    if (event.kind === "done") {
      session.humanActive = false;
      session.completed = true;
      this.#runtime.fence(session.id);
      this.#sessions.revoke(session.id);
      void this.#runtime.revoke(session.id);
    }
  }

  private faultSession(session: TerminalSession): void {
    session.humanActive = false;
    session.faulted = true;
    this.#runtime.fence(session.id);
    void this.#runtime.revoke(session.id);
  }

  private requireIntervention(interventionId: string, epoch: number): TerminalSession {
    const session = this.#session;
    if (!session || session.interventionId !== interventionId || session.epoch !== epoch) {
      throw new Error("terminal WebRTC intervention mismatch");
    }
    return session;
  }

  private sameOriginMutation(request: Request): boolean {
    return Boolean(this.#publicOrigin && request.headers.get("origin") === this.#publicOrigin);
  }
}

function terminalEventCost(event: ExperimentalTerminalWebRtcEvent): number {
  return event.kind === "input" ? decodeBase64(event.dataBase64, MAX_TERMINAL_INPUT_BYTES).length : 16;
}

function parseTerminalEvent(value: unknown): ExperimentalTerminalWebRtcEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "input" && typeof record.dataBase64 === "string") {
    decodeBase64(record.dataBase64, MAX_TERMINAL_INPUT_BYTES);
    return { kind: "input", dataBase64: record.dataBase64 };
  }
  if (record.kind === "resize") {
    const rows = Number(record.rows);
    const cols = Number(record.cols);
    if (Number.isSafeInteger(rows) && Number.isSafeInteger(cols) && rows >= 2 && rows <= 200 && cols >= 2 && cols <= 400) {
      return { kind: "resize", rows, cols };
    }
  }
  if (record.kind === "done" && Object.keys(record).length === 1) return { kind: "done" };
  return undefined;
}

function terminalPage(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>Terminal takeover</title><style nonce="${nonce}">:root{font-family:system-ui,-apple-system,sans-serif;color-scheme:dark}body{margin:0;background:#080a0d;color:#f5f5f5}main{max-width:900px;margin:auto;padding:14px}pre{min-height:52vh;max-height:62vh;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#020304;border:1px solid #333;border-radius:12px;padding:12px;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}.row{display:flex;gap:8px}input{flex:1;min-width:0}input,button{font:inherit;min-height:44px;border-radius:9px;border:1px solid #555;padding:8px;background:#171a1f;color:#fff}button:disabled,input:disabled{opacity:.45}.done{width:100%;margin-top:10px}small{display:block;opacity:.72;line-height:1.4;margin-top:10px}</style></head><body><main><h3>Terminal takeover</h3><div id="status">Connecting…</div><pre id="terminal"></pre><div class="row"><input id="line" disabled autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="1024" placeholder="Type harmless terminal input"><button id="send" disabled>Send</button></div><button id="done" class="done" disabled>Done</button><small>This controls only the current bounded PTY. Do not enter passwords, tokens, 2FA codes, or other secrets during this acceptance. Terminal escape sequences are rendered as plain text and are not executed by this page.</small><script nonce="${nonce}">(()=>{const parts=location.pathname.split('/').filter(Boolean);const id=parts[parts.length-1]||'';const status=document.querySelector('#status');const term=document.querySelector('#terminal');const field=document.querySelector('#line');const sendButton=document.querySelector('#send');const doneButton=document.querySelector('#done');const decoder=new TextDecoder();let pc=null,channel=null,cap='',human=false,stopped=false;function client(){const b=new Uint8Array(16);crypto.getRandomValues(b);return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('')}const clientBinding=client();function b64(bytes){let s='';for(let i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);return btoa(s)}function unb64(s){const raw=atob(s);const b=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)b[i]=raw.charCodeAt(i);return b}function originHeaders(){return {'x-terminal-client':clientBinding}}async function api(op,options){const o=options||{};const h=Object.assign({},o.headers||{},originHeaders());const r=await fetch('/takeover/terminal/api/'+op+'/'+encodeURIComponent(id),Object.assign({cache:'no-store'},o,{headers:h}));if(!r.ok)throw new Error('unavailable');return r}function waitIce(peer){if(peer.iceGatheringState==='complete')return Promise.resolve();return new Promise(resolve=>{const finish=()=>{if(peer.iceGatheringState==='complete'){peer.removeEventListener('icegatheringstatechange',finish);resolve()}};peer.addEventListener('icegatheringstatechange',finish);setTimeout(()=>{peer.removeEventListener('icegatheringstatechange',finish);resolve()},10000)})}function setHuman(active){human=active;field.disabled=!active;sendButton.disabled=!active;doneButton.disabled=!active;status.textContent=active?'Human authority active':'Connected · waiting for Human authority'}function message(event){try{const m=JSON.parse(String(event.data));if(m.kind==='state'){if(m.state==='human_active')setHuman(true);else if(m.state==='fenced')setHuman(false);return}if(m.kind==='output'&&typeof m.dataBase64==='string'){term.textContent+=decoder.decode(unb64(m.dataBase64));if(term.textContent.length>65536)term.textContent=term.textContent.slice(-65536);term.scrollTop=term.scrollHeight}}catch{}}async function connect(){const prep=await (await api('prepare',{method:'POST'})).json();cap=prep.capability;pc=new RTCPeerConnection({iceServers:prep.webrtcIce.iceServers,iceTransportPolicy:'all'});channel=pc.createDataChannel('terminal-control',{ordered:true});channel.onopen=()=>{status.textContent='Connected · waiting for Human authority'};channel.onmessage=message;channel.onclose=()=>{if(!stopped){setHuman(false);status.textContent='Connection closed'}};pc.onconnectionstatechange=()=>{if(!stopped&&(pc.connectionState==='failed'||pc.connectionState==='disconnected')){setHuman(false);status.textContent='Connection unavailable'}};const offer=await pc.createOffer();const ice=waitIce(pc);await pc.setLocalDescription(offer);await ice;const r=await api('connect',{method:'POST',headers:{'content-type':'application/json','x-terminal-capability':cap},body:JSON.stringify({type:'offer',sdp:pc.localDescription.sdp})});const answer=await r.json();await pc.setRemoteDescription(answer.webrtc)}async function send(){if(!human||!channel||channel.readyState!=='open')return;const line=field.value;if(!line)return;const bytes=new TextEncoder().encode(line+'\\n');if(bytes.length>2048)return;field.value='';channel.send(JSON.stringify({kind:'input',dataBase64:b64(bytes)}))}sendButton.onclick=()=>void send();field.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void send()}});doneButton.onclick=()=>{if(!human||!channel||channel.readyState!=='open')return;setHuman(false);try{channel.send(JSON.stringify({kind:'done'}));status.textContent='Done. Return to ChatGPT for verification/resume.';stopped=true;setTimeout(()=>{try{channel&&channel.close();pc&&pc.close()}catch{}},150)}catch{status.textContent='Done rejected or session closed'}};void connect().catch(()=>{setHuman(false);status.textContent='Session unavailable or connection failed';stopped=true})})();</script></main></body></html>`;
}

function validIntervention(id: string, epoch: number): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) && Number.isSafeInteger(epoch) && epoch > 0;
}

function validBinding(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function readClientBinding(value: string | null): string | undefined {
  return /^[a-f0-9]{32}$/.exec(value ?? "")?.[0];
}

function readCapability(value: string | null): string | undefined {
  return /^[A-Za-z0-9_-]{24,128}$/.exec(value ?? "")?.[0];
}


async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("request too large");
  return JSON.parse(text);
}

function decodeBase64(value: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error("terminal bytes invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > maxBytes || bytes.toString("base64") !== value) {
    throw new Error("terminal bytes invalid");
  }
  return bytes;
}

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: privateHeaders("application/json; charset=utf-8") });
}

function privateHeaders(contentType: string): HeadersInit {
  return {
    "content-type": contentType,
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  };
}

function iceCredentialProviderFromEnvironment(env: NodeJS.ProcessEnv): WebRtcIceCredentialProvider | undefined {
  const turnKeyId = env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID?.trim();
  const turnKeyApiToken = env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN?.trim();
  const coturnSharedSecret = env.MCP_HANDOFF_COTURN_SHARED_SECRET?.trim();
  const coturnTurnUrls = env.MCP_HANDOFF_COTURN_TURN_URLS?.trim();
  const coturnStunUrls = env.MCP_HANDOFF_COTURN_STUN_URLS?.trim();
  const hasCloudflare = Boolean(turnKeyId || turnKeyApiToken);
  const hasCoturn = Boolean(coturnSharedSecret || coturnTurnUrls || coturnStunUrls);
  if (hasCloudflare && hasCoturn) throw new Error("Multiple TURN providers are configured");
  if (hasCloudflare) {
    if (!turnKeyId || !turnKeyApiToken) throw new Error("Cloudflare TURN configuration is incomplete");
    return new CloudflareRealtimeTurnCredentialProvider({ turnKeyId, turnKeyApiToken });
  }
  if (hasCoturn) {
    if (!coturnSharedSecret || !coturnTurnUrls) throw new Error("coturn TURN configuration is incomplete");
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
  if (values.length < 1 || values.some((entry) => entry.length === 0)) throw new Error("TURN URL configuration is invalid");
  return values;
}

function sameBinding(left: WebRtcTakeoverRuntimeBinding, right: WebRtcTakeoverRuntimeBinding): boolean {
  return left.takeoverSessionId === right.takeoverSessionId
    && left.interventionId === right.interventionId
    && left.epoch === right.epoch
    && left.principalBinding === right.principalBinding
    && left.clientBinding === right.clientBinding
    && left.clientGeneration === right.clientGeneration
    && left.expiresAt === right.expiresAt;
}
