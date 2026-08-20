import { randomBytes } from "node:crypto";
import { TakeoverSessionError, TakeoverSessionManager } from "./session.js";
function privateHeaders(contentType) {
    return {
        "content-type": contentType,
        "cache-control": "no-store, max-age=0",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "permissions-policy": "camera=(), microphone=(), geolocation=()"
    };
}
function json(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: privateHeaders("application/json; charset=utf-8")
    });
}
function clientScript() {
    return `(() => {
const parts=location.pathname.split('/').filter(Boolean);const sessionId=parts.length?parts[parts.length-1]:'';
const statusEl=document.querySelector('#status');
const frame=document.querySelector('#frame');
const screen=document.querySelector('#screen');
let cap='';let viewport={width:1,height:1};let stopped=false;let objectUrl='';let streaming=false;
function status(text){statusEl.textContent=text}
function randomClientBinding(){const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);let binary='';for(let i=0;i<bytes.length;i+=1)binary+=String.fromCharCode(bytes[i]);return btoa(binary).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
const clientBinding=randomClientBinding();
async function bootstrap(){const response=await fetch('/takeover/api/bootstrap/'+encodeURIComponent(sessionId),{cache:'no-store',headers:{'x-takeover-client':clientBinding}});if(!response.ok)throw new Error('bootstrap unavailable');const data=await response.json();if(!data.capability)throw new Error('missing capability');cap=data.capability}
async function api(path,options){const opts=options||{};const headers=Object.assign({},opts.headers||{}, {'x-mcp-takeover-capability':cap,'x-takeover-client':clientBinding});const response=await fetch('/takeover/api/'+path+'/'+encodeURIComponent(sessionId),Object.assign({},opts,{headers:headers,cache:'no-store'}));if(!response.ok)throw new Error('takeover unavailable');return response}
function showFrame(bytes,meta){viewport={width:Number(meta.width)||1,height:Number(meta.height)||1};const next=URL.createObjectURL(new Blob([bytes],{type:meta.mimeType||'image/jpeg'}));frame.onload=function(){if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=next};frame.src=next;status((meta.hostname||'Browser')+' · live')}
async function refresh(){if(stopped||streaming)return;try{const r=await api('frame');viewport={width:Number(r.headers.get('x-takeover-width'))||1,height:Number(r.headers.get('x-takeover-height'))||1};const host=r.headers.get('x-takeover-host')||'Browser';const blob=await r.blob();const next=URL.createObjectURL(blob);frame.onload=function(){if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=next};frame.src=next;status(host+' · live')}catch(e){status('Session unavailable, expired, or already active elsewhere');stopped=true;return}setTimeout(refresh,700)}
function concat(a,b){const out=new Uint8Array(a.length+b.length);out.set(a);out.set(b,a.length);return out}
async function stream(){let response;try{response=await api('stream')}catch(e){return false}if(!response.body)return false;streaming=true;let pending=new Uint8Array(0);const reader=response.body.getReader();const decoder=new TextDecoder();try{while(!stopped){const part=await reader.read();if(part.done)break;if(part.value)pending=concat(pending,part.value);for(;;){if(pending.length<8)break;const view=new DataView(pending.buffer,pending.byteOffset,pending.byteLength);const metaLength=view.getUint32(0);const imageLength=view.getUint32(4);if(metaLength<2||metaLength>2048||imageLength<1||imageLength>2000000)throw new Error('invalid stream frame');const total=8+metaLength+imageLength;if(pending.length<total)break;const meta=JSON.parse(decoder.decode(pending.slice(8,8+metaLength)));const image=pending.slice(8+metaLength,total);pending=pending.slice(total);showFrame(image,meta)}}}catch(e){if(!stopped){streaming=false;return false}}finally{try{reader.releaseLock()}catch{}}if(!stopped)streaming=false;return false}
async function input(body){try{await api('input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!streaming)setTimeout(refresh,60)}catch(e){status('Input rejected or session active elsewhere');stopped=true}}
function remotePoint(event){const r=frame.getBoundingClientRect();if(!r.width||!r.height)return null;return{x:Math.max(0,Math.min(viewport.width,(event.clientX-r.left)*viewport.width/r.width)),y:Math.max(0,Math.min(viewport.height,(event.clientY-r.top)*viewport.height/r.height)),scaleY:viewport.height/r.height}}
let gesture=null;
screen.addEventListener('pointerdown',function(event){if(stopped)return;const point=remotePoint(event);if(!point)return;gesture={id:event.pointerId,startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,point:point};try{screen.setPointerCapture(event.pointerId)}catch{}event.preventDefault()});
screen.addEventListener('pointermove',function(event){if(!gesture||gesture.id!==event.pointerId)return;gesture.lastX=event.clientX;gesture.lastY=event.clientY;event.preventDefault()});
function finishGesture(event){if(!gesture||gesture.id!==event.pointerId)return;const current=gesture;gesture=null;try{screen.releasePointerCapture(event.pointerId)}catch{}const dx=event.clientX-current.startX;const dy=event.clientY-current.startY;const distance=Math.hypot(dx,dy);if(distance<12){void input({kind:'tap',x:current.point.x,y:current.point.y})}else if(Math.abs(dy)>=Math.abs(dx)*0.55){const deltaY=Math.max(-1800,Math.min(1800,-dy*current.point.scaleY));if(Math.abs(deltaY)>=8)void input({kind:'scroll',deltaY:deltaY})}event.preventDefault()}
screen.addEventListener('pointerup',finishGesture);
screen.addEventListener('pointercancel',function(event){if(gesture&&gesture.id===event.pointerId)gesture=null});
const keyboard=document.querySelector('#keyboard');
keyboard.addEventListener('beforeinput',function(event){if(stopped)return;const type=event.inputType||'';if(type==='insertText'&&event.data){event.preventDefault();keyboard.value='';void input({kind:'text',text:event.data});return}if(type==='insertLineBreak'){event.preventDefault();keyboard.value='';void input({kind:'key',key:'Enter'});return}if(type==='deleteContentBackward'){event.preventDefault();keyboard.value='';void input({kind:'key',key:'Backspace'})}});
keyboard.addEventListener('input',function(){const text=keyboard.value;if(text){keyboard.value='';void input({kind:'text',text:text})}});
keyboard.addEventListener('keydown',function(event){const allowed={Enter:'Enter',Tab:'Tab',Escape:'Escape',Backspace:'Backspace',ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight'};const key=allowed[event.key];if(key){event.preventDefault();keyboard.value='';void input({kind:'key',key:key})}});
document.querySelector('#done').addEventListener('click',async function(){try{await api('done',{method:'POST'});status('Remote control closed. Return to the requesting workflow.');stopped=true}catch(e){status('Session already closed')}});
void bootstrap().then(async function(){const active=await stream();if(!active&&!stopped)refresh()}).catch(function(){status('Session unavailable, expired, or already active elsewhere');stopped=true});
})();`;
}
function pageHtml(nonce) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Human takeover</title>
<style nonce="${nonce}">
:root{font-family:system-ui,-apple-system,sans-serif;color-scheme:light dark}body{margin:0;background:Canvas;color:CanvasText}main{max-width:760px;margin:auto;padding:12px}.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.status{font-size:13px;opacity:.8;flex:1}.screen{margin:10px 0;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:12px;overflow:hidden;background:#111;touch-action:none;user-select:none;-webkit-user-select:none}.screen img{display:block;width:100%;height:auto;min-height:180px;object-fit:contain;pointer-events:none}.controls{display:grid;grid-template-columns:1fr;gap:8px}.keyboard{font:inherit;min-height:44px;border-radius:10px;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);padding:8px;min-width:0}.done{font:inherit;min-height:44px;border-radius:10px;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);padding:8px;cursor:pointer}.hint{font-size:13px;opacity:.72;margin-top:4px}small{display:block;line-height:1.4;opacity:.75;margin-top:10px}
</style>
</head>
<body><main>
<div class="bar"><strong>Human takeover</strong><span id="status" class="status">Connecting…</span></div>
<div id="screen" class="screen"><img id="frame" alt="Live browser view"></div>
<div class="controls">
<input id="keyboard" class="keyboard" type="text" inputmode="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Keyboard — type into the focused browser field">
<button id="done" class="done">Done — return to the requesting workflow</button>
</div>
<div class="hint">Tap the live view directly. Swipe on it to scroll. Use the keyboard field only after focusing a text field in the remote browser.</div>
<small>This page controls only the current dedicated browser surface. One remote page owns the takeover lease at a time. Reloading or opening the same URL elsewhere cannot reclaim an active lease; return to the requesting workflow for a fresh Human round instead. It does not expose a native automation protocol, an address bar, cookies, DOM, or network data. Passwords, 2FA codes and CAPTCHA responses stay in the browser interaction and are not sent to the requesting agent or workflow.</small>
</main>
<script nonce="${nonce}" src="/takeover/client.js" defer></script>
</body></html>`;
}
export class TakeoverBroker {
    browser;
    config;
    sessions;
    publicOrigin;
    activeStreams = new Map();
    constructor(browser, config) {
        this.browser = browser;
        this.config = config;
        this.sessions = new TakeoverSessionManager(config.ttlMs, undefined, undefined, undefined, config.reconnectIdleMs ?? 5_000);
        this.publicOrigin = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : undefined;
    }
    isEnabled() {
        return this.config.enabled;
    }
    isPath(pathname) {
        return pathname.startsWith("/takeover/");
    }
    createLink(intervention, principalBinding) {
        if (!this.config.enabled || !this.config.publicBaseUrl || !principalBinding)
            return undefined;
        const locator = this.sessions.ensure(intervention.id, intervention.epoch, principalBinding);
        return new URL(`/takeover/${encodeURIComponent(locator.id)}`, this.config.publicBaseUrl).toString();
    }
    revokeForIntervention(interventionId) {
        this.sessions.revokeForIntervention(interventionId);
        this.abortStreamsForIntervention(interventionId);
    }
    async handle(request, boundPrincipal) {
        if (!this.config.enabled || !boundPrincipal)
            return json(404, { error: "not_found" });
        const url = new URL(request.url);
        if (url.pathname === "/takeover/client.js") {
            if (request.method !== "GET" && request.method !== "HEAD")
                return json(405, { error: "method_not_allowed" });
            return new Response(request.method === "HEAD" ? null : clientScript(), {
                status: 200,
                headers: privateHeaders("text/javascript; charset=utf-8")
            });
        }
        const pageMatch = /^\/takeover\/([A-Za-z0-9-]{8,100})$/.exec(url.pathname);
        if (pageMatch) {
            if (request.method !== "GET" && request.method !== "HEAD")
                return json(405, { error: "method_not_allowed" });
            try {
                this.sessions.validateLocator(pageMatch[1], boundPrincipal);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
            const nonce = randomBytes(18).toString("base64url");
            const headers = new Headers(privateHeaders("text/html; charset=utf-8"));
            headers.set("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
            return new Response(request.method === "HEAD" ? null : pageHtml(nonce), { status: 200, headers });
        }
        const apiMatch = /^\/takeover\/api\/(bootstrap|claim|reconnect|stream|frame|input|done)\/([A-Za-z0-9-]{8,100})$/.exec(url.pathname);
        if (!apiMatch)
            return json(404, { error: "not_found" });
        const operation = apiMatch[1];
        const id = apiMatch[2];
        const clientBinding = this.readClientBinding(request.headers.get("x-takeover-client"));
        if (!clientBinding)
            return json(404, { error: "takeover_unavailable" });
        if (operation === "bootstrap") {
            if (request.method !== "GET")
                return json(405, { error: "method_not_allowed" });
            if (request.headers.get("sec-fetch-site") !== "same-origin") {
                return json(403, { error: "bootstrap_not_same_origin" });
            }
            try {
                const grant = this.sessions.claimClient(id, boundPrincipal, clientBinding);
                return json(200, {
                    capability: grant.capability,
                    reconnectHandle: grant.reconnectHandle,
                    expiresAt: grant.expiresAt,
                    clientGeneration: grant.clientGeneration
                });
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
        }
        if (operation === "claim") {
            if (request.method !== "POST")
                return json(405, { error: "method_not_allowed" });
            if (!this.nativeMutationAllowed(request))
                return json(403, { error: "native_client_required" });
            try {
                const grant = this.sessions.claimClient(id, boundPrincipal, clientBinding);
                return json(200, {
                    capability: grant.capability,
                    reconnectHandle: grant.reconnectHandle,
                    expiresAt: grant.expiresAt,
                    clientGeneration: grant.clientGeneration
                });
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
        }
        if (operation === "reconnect") {
            if (request.method !== "POST")
                return json(405, { error: "method_not_allowed" });
            if (!this.nativeMutationAllowed(request))
                return json(403, { error: "native_client_required" });
            const reconnectHandle = this.readReconnectHandle(request.headers.get("x-mcp-takeover-reconnect"));
            if (!reconnectHandle)
                return json(404, { error: "takeover_unavailable" });
            try {
                const grant = this.sessions.reconnectClient(id, boundPrincipal, reconnectHandle, clientBinding);
                return json(200, {
                    capability: grant.capability,
                    reconnectHandle: grant.reconnectHandle,
                    expiresAt: grant.expiresAt,
                    clientGeneration: grant.clientGeneration
                });
            }
            catch (error) {
                if (error instanceof TakeoverSessionError) {
                    if (error.code === "TAKEOVER_CLIENT_ACTIVE")
                        return json(409, { error: "takeover_client_active" });
                    return json(404, { error: "takeover_unavailable" });
                }
                throw error;
            }
        }
        const capability = this.readCapability(request.headers.get("x-mcp-takeover-capability"), request.headers.get("authorization"));
        if (!capability)
            return json(404, { error: "takeover_unavailable" });
        if (operation === "stream") {
            if (request.method !== "GET")
                return json(405, { error: "method_not_allowed" });
            let grant;
            try {
                grant = this.sessions.beginUse(id, capability, boundPrincipal, clientBinding);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
            const controller = new AbortController();
            this.registerStream(grant.interventionId, controller);
            const abort = () => controller.abort();
            request.signal.addEventListener("abort", abort, { once: true });
            const ttlMs = Math.max(1, grant.expiresAt - Date.now());
            const expiry = setTimeout(abort, ttlMs);
            const frames = this.browser.streamHumanTakeoverFrames?.(grant.interventionId, grant.epoch, controller.signal);
            if (!frames) {
                clearTimeout(expiry);
                request.signal.removeEventListener("abort", abort);
                this.sessions.endUse(id, boundPrincipal, clientBinding, grant.clientGeneration);
                return json(404, { error: "frame_stream_unavailable" });
            }
            let finalized = false;
            const finalize = () => {
                if (finalized)
                    return;
                finalized = true;
                clearTimeout(expiry);
                request.signal.removeEventListener("abort", abort);
                this.unregisterStream(grant.interventionId, controller);
                this.sessions.endUse(id, boundPrincipal, clientBinding, grant.clientGeneration);
            };
            const stream = new ReadableStream({
                async start(streamController) {
                    try {
                        for await (const frame of frames) {
                            if (controller.signal.aborted)
                                break;
                            const bytes = Buffer.from(frame.data, "base64");
                            if (bytes.byteLength < 1 || bytes.byteLength > 2_000_000)
                                continue;
                            const metadata = Buffer.from(JSON.stringify({
                                width: frame.width,
                                height: frame.height,
                                hostname: frame.hostname.slice(0, 120),
                                mimeType: frame.mimeType ?? "image/jpeg"
                            }), "utf8");
                            if (metadata.byteLength > 2_048)
                                continue;
                            const prefix = Buffer.allocUnsafe(8);
                            prefix.writeUInt32BE(metadata.byteLength, 0);
                            prefix.writeUInt32BE(bytes.byteLength, 4);
                            streamController.enqueue(prefix);
                            streamController.enqueue(metadata);
                            streamController.enqueue(bytes);
                        }
                        streamController.close();
                    }
                    catch {
                        if (!controller.signal.aborted)
                            streamController.error(new Error("takeover frame stream stopped"));
                        else
                            streamController.close();
                    }
                    finally {
                        finalize();
                    }
                },
                cancel() {
                    abort();
                    finalize();
                }
            });
            const headers = new Headers(privateHeaders("application/octet-stream"));
            headers.set("x-takeover-stream", "1");
            return new Response(stream, { status: 200, headers });
        }
        if (operation === "frame") {
            if (request.method !== "GET")
                return json(405, { error: "method_not_allowed" });
            let grant;
            try {
                grant = this.sessions.beginUse(id, capability, boundPrincipal, clientBinding);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
            try {
                const frame = await this.browser.captureHumanTakeoverFrame(grant.interventionId, grant.epoch);
                const bytes = Buffer.from(frame.data, "base64");
                if (bytes.byteLength > 2_000_000)
                    return json(503, { error: "frame_too_large" });
                const mimeType = frame.mimeType ?? "image/jpeg";
                const headers = new Headers(privateHeaders(mimeType));
                headers.set("x-takeover-width", String(frame.width));
                headers.set("x-takeover-height", String(frame.height));
                headers.set("x-takeover-host", frame.hostname.slice(0, 120));
                return new Response(bytes, { status: 200, headers });
            }
            catch {
                return json(409, { error: "takeover_state_changed" });
            }
            finally {
                this.sessions.endUse(id, boundPrincipal, clientBinding, grant.clientGeneration);
            }
        }
        if (request.method !== "POST")
            return json(405, { error: "method_not_allowed" });
        if (!this.sameOriginMutation(request))
            return json(403, { error: "origin_not_allowed" });
        if (operation === "done") {
            let verified;
            try {
                verified = this.sessions.verify(id, capability, boundPrincipal, clientBinding);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
            this.sessions.revoke(id);
            this.abortStreamsForIntervention(verified.interventionId);
            return json(200, { done: true });
        }
        const length = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(length) && length > 8_192)
            return json(413, { error: "request_body_too_large" });
        let body;
        try {
            const text = await request.text();
            if (Buffer.byteLength(text, "utf8") > 8_192)
                return json(413, { error: "request_body_too_large" });
            body = JSON.parse(text);
        }
        catch {
            return json(400, { error: "invalid_json" });
        }
        let grant;
        try {
            grant = this.sessions.beginUse(id, capability, boundPrincipal, clientBinding);
        }
        catch (error) {
            if (error instanceof TakeoverSessionError)
                return json(404, { error: "takeover_unavailable" });
            throw error;
        }
        try {
            await this.dispatchInput(grant.interventionId, grant.epoch, body);
            return json(200, { ok: true });
        }
        catch {
            return json(409, { error: "takeover_input_rejected" });
        }
        finally {
            this.sessions.endUse(id, boundPrincipal, clientBinding, grant.clientGeneration);
        }
    }
    registerStream(interventionId, controller) {
        const existing = this.activeStreams.get(interventionId);
        if (existing) {
            existing.add(controller);
            return;
        }
        this.activeStreams.set(interventionId, new Set([controller]));
    }
    unregisterStream(interventionId, controller) {
        const existing = this.activeStreams.get(interventionId);
        if (!existing)
            return;
        existing.delete(controller);
        if (existing.size === 0)
            this.activeStreams.delete(interventionId);
    }
    abortStreamsForIntervention(interventionId) {
        const existing = this.activeStreams.get(interventionId);
        if (!existing)
            return;
        this.activeStreams.delete(interventionId);
        for (const controller of existing)
            controller.abort();
    }
    readCapability(dedicatedValue, legacyAuthorization) {
        const dedicated = /^([A-Za-z0-9_-]{32,128})$/.exec(dedicatedValue ?? "")?.[1];
        if (dedicated)
            return dedicated;
        const legacy = /^Takeover ([A-Za-z0-9_-]{32,128})$/.exec(legacyAuthorization ?? "")?.[1];
        return legacy;
    }
    readClientBinding(value) {
        const match = /^([A-Za-z0-9_-]{24,128})$/.exec(value ?? "");
        return match?.[1];
    }
    readReconnectHandle(value) {
        const match = /^([A-Za-z0-9_-]{32,128})$/.exec(value ?? "");
        return match?.[1];
    }
    nativeMutationAllowed(request) {
        if (request.headers.get("x-takeover-native-client") !== "1")
            return false;
        const origin = request.headers.get("origin");
        return origin === null || origin === this.publicOrigin;
    }
    sameOriginMutation(request) {
        if (!this.publicOrigin)
            return false;
        return request.headers.get("origin") === this.publicOrigin;
    }
    async dispatchInput(interventionId, epoch, body) {
        if (!body || typeof body !== "object" || Array.isArray(body))
            throw new Error("invalid_input");
        const input = body;
        if (input.kind === "tap") {
            const x = Number(input.x);
            const y = Number(input.y);
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20_000 || y > 20_000)
                throw new Error("invalid_tap");
            await this.browser.tapHumanTakeover(interventionId, epoch, x, y);
            return;
        }
        if (input.kind === "scroll") {
            const deltaY = Number(input.deltaY);
            if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 2_000)
                throw new Error("invalid_scroll");
            await this.browser.scrollHumanTakeover(interventionId, epoch, deltaY);
            return;
        }
        if (input.kind === "text") {
            if (typeof input.text !== "string" || input.text.length === 0 || input.text.length > 2_048)
                throw new Error("invalid_text");
            await this.browser.insertHumanTakeoverText(interventionId, epoch, input.text);
            return;
        }
        if (input.kind === "key") {
            if (typeof input.key !== "string")
                throw new Error("invalid_key");
            await this.browser.pressHumanTakeoverKey(interventionId, epoch, input.key);
            return;
        }
        throw new Error("unsupported_input");
    }
}
//# sourceMappingURL=broker.js.map