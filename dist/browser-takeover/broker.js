import { randomBytes } from "node:crypto";
import { TakeoverSessionError, TakeoverSessionManager } from "./session.js";
import { NativeTakeoverRuntimeError, nativeBindingFromGrant, parseNativeTakeoverClientEndpoint } from "./native-runtime.js";
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
let cap='';let viewport={width:1,height:1};let stopped=false;let objectUrl='';
function status(text){statusEl.textContent=text}
function randomClientBinding(){const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);let binary='';for(let i=0;i<bytes.length;i+=1)binary+=String.fromCharCode(bytes[i]);return btoa(binary).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
const clientBinding=randomClientBinding();
async function bootstrap(){const response=await fetch('/takeover/api/bootstrap/'+encodeURIComponent(sessionId),{cache:'no-store',headers:{'x-takeover-client':clientBinding}});if(!response.ok)throw new Error('bootstrap unavailable');const data=await response.json();if(!data.capability)throw new Error('missing capability');cap=data.capability}
async function api(path,options){const opts=options||{};const headers=Object.assign({},opts.headers||{}, {'x-mcp-takeover-capability':cap,'x-takeover-client':clientBinding});const response=await fetch('/takeover/api/'+path+'/'+encodeURIComponent(sessionId),Object.assign({},opts,{headers:headers,cache:'no-store'}));if(!response.ok)throw new Error('takeover unavailable');return response}
async function refresh(){if(stopped)return;try{const r=await api('frame');viewport={width:Number(r.headers.get('x-takeover-width'))||1,height:Number(r.headers.get('x-takeover-height'))||1};const host=r.headers.get('x-takeover-host')||'Browser';const blob=await r.blob();const next=URL.createObjectURL(blob);frame.onload=function(){if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=next};frame.src=next;status(host+' · live')}catch(e){status('Session unavailable, expired, or already active elsewhere');stopped=true;return}setTimeout(refresh,700)}
async function input(body){try{await api('input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});setTimeout(refresh,100)}catch(e){status('Input rejected or session active elsewhere');stopped=true}}
screen.addEventListener('click',function(event){const r=frame.getBoundingClientRect();if(!r.width||!r.height)return;const x=Math.max(0,Math.min(viewport.width,(event.clientX-r.left)*viewport.width/r.width));const y=Math.max(0,Math.min(viewport.height,(event.clientY-r.top)*viewport.height/r.height));void input({kind:'tap',x:x,y:y})});
document.querySelectorAll('[data-scroll]').forEach(function(el){el.addEventListener('click',function(){void input({kind:'scroll',deltaY:Number(el.dataset.scroll)})})});
document.querySelectorAll('[data-key]').forEach(function(el){el.addEventListener('click',function(){void input({kind:'key',key:el.dataset.key})})});
document.querySelector('#send').addEventListener('click',function(){const field=document.querySelector('#text');const text=field.value;if(text){field.value='';void input({kind:'text',text:text})}});
document.querySelector('#done').addEventListener('click',async function(){try{await api('done',{method:'POST'});status('Remote control closed. Return to the requesting workflow.');stopped=true}catch(e){status('Session already closed')}});
void bootstrap().then(refresh).catch(function(){status('Session unavailable, expired, or already active elsewhere');stopped=true});
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
:root{font-family:system-ui,-apple-system,sans-serif;color-scheme:light dark}body{margin:0;background:Canvas;color:CanvasText}main{max-width:760px;margin:auto;padding:12px}.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.status{font-size:13px;opacity:.8;flex:1}.screen{margin:10px 0;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:12px;overflow:hidden;background:#111;touch-action:manipulation}.screen img{display:block;width:100%;height:auto;min-height:180px;object-fit:contain}.controls{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}button,input{font:inherit;min-height:44px;border-radius:10px;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);padding:8px}input{grid-column:1/4;min-width:0}button{cursor:pointer}.wide{grid-column:1/-1}small{display:block;line-height:1.4;opacity:.75;margin-top:10px}
</style>
</head>
<body><main>
<div class="bar"><strong>Human takeover</strong><span id="status" class="status">Connecting…</span></div>
<div id="screen" class="screen"><img id="frame" alt="Live browser view"></div>
<div class="controls">
<button data-scroll="-620">↑ Scroll</button><button data-key="Tab">Tab</button><button data-key="Enter">Enter</button><button data-key="Escape">Esc</button>
<button data-scroll="620">↓ Scroll</button><button data-key="Backspace">⌫</button><button data-key="ArrowUp">↑ key</button><button data-key="ArrowDown">↓ key</button>
<input id="text" autocomplete="off" autocapitalize="none" placeholder="Type into focused browser field"><button id="send">Send</button>
<button id="done" class="wide">Done — return to the requesting workflow</button>
</div>
<small>This page controls only the current dedicated browser surface. One remote page owns the takeover lease at a time. Reloading or opening the same URL elsewhere cannot reclaim an active lease; return to the requesting workflow for a fresh Human round instead. It does not expose a native automation protocol, an address bar, cookies, DOM, or network data. Passwords, 2FA codes and CAPTCHA responses stay in the browser interaction and are not sent to the requesting agent or workflow.</small>
</main>
<script nonce="${nonce}" src="/takeover/client.js" defer></script>
</body></html>`;
}
export class TakeoverBroker {
    browser;
    config;
    nativeRuntime;
    sessions;
    publicOrigin;
    constructor(browser, config, nativeRuntime) {
        this.browser = browser;
        this.config = config;
        this.nativeRuntime = nativeRuntime;
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
        if (this.nativeRuntime)
            void this.nativeRuntime.revokeForIntervention(interventionId).catch(() => undefined);
    }
    async revokeNativeForIntervention(interventionId) {
        this.sessions.revokeForIntervention(interventionId);
        await this.nativeRuntime?.revokeForIntervention(interventionId);
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
        const apiMatch = /^\/takeover\/api\/(bootstrap|claim|reconnect|frame|input|done|cancel)\/([A-Za-z0-9-]{8,100})$/.exec(url.pathname);
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
                return json(200, this.publicGrant(grant));
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
        }
        if (operation === "claim" || operation === "reconnect") {
            if (request.method !== "POST")
                return json(405, { error: "method_not_allowed" });
            if (!this.nativeMutationAllowed(request))
                return json(403, { error: "native_client_required" });
            const reconnectHandle = operation === "reconnect"
                ? this.readReconnectHandle(request.headers.get("x-mcp-takeover-reconnect"))
                : undefined;
            if (operation === "reconnect" && !reconnectHandle)
                return json(404, { error: "takeover_unavailable" });
            let endpoint;
            if (this.nativeRuntime) {
                try {
                    endpoint = parseNativeTakeoverClientEndpoint(await this.readBoundedJson(request, 1_024));
                }
                catch (error) {
                    if (error instanceof NativeTakeoverRuntimeError)
                        return json(400, { error: "native_endpoint_invalid" });
                    return json(400, { error: "invalid_json" });
                }
            }
            let grant;
            try {
                grant = operation === "claim"
                    ? this.sessions.claimClient(id, boundPrincipal, clientBinding)
                    : this.sessions.reconnectClient(id, boundPrincipal, reconnectHandle, clientBinding);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError) {
                    if (error.code === "TAKEOVER_CLIENT_ACTIVE")
                        return json(409, { error: "takeover_client_active" });
                    return json(404, { error: "takeover_unavailable" });
                }
                throw error;
            }
            try {
                const native = this.nativeRuntime && endpoint
                    ? await this.nativeRuntime.begin(nativeBindingFromGrant(grant), endpoint)
                    : undefined;
                return json(200, this.publicGrant(grant, native));
            }
            catch (error) {
                if (error instanceof NativeTakeoverRuntimeError && error.code === "NATIVE_BOOTSTRAP_ALREADY_ISSUED") {
                    return json(409, { error: "native_bootstrap_already_issued" });
                }
                this.sessions.revoke(id);
                await this.nativeRuntime?.revoke(id).catch(() => undefined);
                return json(503, { error: "native_runtime_unavailable" });
            }
        }
        const capability = this.readCapability(request.headers.get("x-mcp-takeover-capability"), request.headers.get("authorization"));
        if (!capability)
            return json(404, { error: "takeover_unavailable" });
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
        const mutationAllowed = this.sameOriginMutation(request) || this.nativeMutationAllowed(request);
        if (!mutationAllowed)
            return json(403, { error: "origin_not_allowed" });
        if (operation === "done" || operation === "cancel") {
            try {
                this.sessions.verify(id, capability, boundPrincipal, clientBinding);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
            // Revoke the broker generation first. Even if process teardown encounters an OS failure,
            // the stale capability/reconnect handle can no longer be used through this control plane.
            this.sessions.revoke(id);
            try {
                await this.nativeRuntime?.revoke(id);
            }
            catch {
                return json(503, { error: "native_runtime_revoke_failed", revoked: true });
            }
            return operation === "done"
                ? json(200, { done: true })
                : json(200, { cancelled: true });
        }
        const length = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(length) && length > 8_192)
            return json(413, { error: "request_body_too_large" });
        let body;
        try {
            body = await this.readBoundedJson(request, 8_192);
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
    publicGrant(grant, native) {
        return {
            capability: grant.capability,
            reconnectHandle: grant.reconnectHandle,
            expiresAt: grant.expiresAt,
            clientGeneration: grant.clientGeneration,
            ...(native ? { native } : {})
        };
    }
    async readBoundedJson(request, maxBytes) {
        const length = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(length) && length > maxBytes)
            throw new Error("body_too_large");
        const text = await request.text();
        if (Buffer.byteLength(text, "utf8") > maxBytes)
            throw new Error("body_too_large");
        if (!text)
            return {};
        return JSON.parse(text);
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