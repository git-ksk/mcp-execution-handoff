import { randomBytes } from "node:crypto";
import { ExperimentalWebSocketWindowHandoff } from "./websocket-window-handoff.js";
import { browserHumanInputClientSource } from "./browser-human-input.js";
import { browserWssReconnectClientSource } from "./browser-wss-reconnect.js";
/**
 * Private normal-browser facade for the #40 WSS experiment.
 *
 * Browser profile/auth semantics remain consumer-owned. This class serves only Handoff's locator
 * page and WSS transport UI; it never receives account identity, cookies, credentials, or target
 * service metadata. Exact process/window enforcement stays in the shared Window composition.
 */
export class ExperimentalWebSocketBrowserHandoff {
    #window;
    #publicOrigin;
    #sessionsById = new Map();
    #sessionsByIntervention = new Map();
    constructor(config) {
        if (!config.takeover.publicBaseUrl)
            throw new Error("Browser WSS Handoff requires a public base URL");
        this.#publicOrigin = new URL(config.takeover.publicBaseUrl).origin;
        this.#window = new ExperimentalWebSocketWindowHandoff({
            takeover: config.takeover,
            allowedOrigins: config.allowedOrigins,
            surface: config.surface,
            ...(config.frameIntervalMs === undefined ? {} : { frameIntervalMs: config.frameIntervalMs }),
            ...(config.maxInboundBytes === undefined ? {} : { maxInboundBytes: config.maxInboundBytes }),
            ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {}),
            ...(config.latencyTracker ? { latencyTracker: config.latencyTracker } : {}),
            ...(config.onAuthorityReleased ? { onAuthorityReleased: config.onAuthorityReleased } : {}),
            onComplete: async (event) => {
                this.#forgetMatching(event.interventionId, event.epoch);
                await config.onComplete?.(event);
            }
        });
    }
    start(request) {
        const locator = this.#window.start(request);
        const sessionId = sessionIdFromLocator(locator);
        if (!sessionId) {
            this.#window.revoke(request.intervention.id);
            throw new Error("Browser WSS Handoff locator is invalid");
        }
        const existing = this.#sessionsByIntervention.get(request.intervention.id);
        if (existing && existing.sessionId !== sessionId)
            this.#forget(existing);
        const state = {
            interventionId: request.intervention.id,
            epoch: request.intervention.epoch,
            sessionId,
            inputPolicy: { ...request.inputPolicy }
        };
        this.#sessionsById.set(sessionId, state);
        this.#sessionsByIntervention.set(state.interventionId, state);
        return locator;
    }
    async handle(request, boundPrincipal) {
        const url = new URL(request.url);
        const page = /^\/takeover\/([A-Za-z0-9-]{8,100})$/.exec(url.pathname);
        if (page && this.#sessionsById.has(page[1])) {
            if (request.method !== "GET" && request.method !== "HEAD") {
                return browserResponse(405, "application/json; charset=utf-8", JSON.stringify({ error: "method_not_allowed" }));
            }
            const state = this.#sessionsById.get(page[1]);
            if (!this.#window.authorizeClientPage(state.sessionId, boundPrincipal)) {
                return browserResponse(404, "application/json; charset=utf-8", JSON.stringify({ error: "takeover_unavailable" }));
            }
            const nonce = randomBytes(18).toString("base64url");
            const headers = browserHeaders("text/html; charset=utf-8");
            headers.set("content-security-policy", browserContentSecurityPolicy(nonce, this.#publicOrigin));
            return new Response(request.method === "HEAD" ? null : browserPageHtml(nonce, state.inputPolicy), { status: 200, headers });
        }
        return await this.#window.handle(request, boundPrincipal);
    }
    handleUpgrade(request, socket, head) {
        return this.#window.handleUpgrade(request, socket, head);
    }
    ownsPath(pathname) {
        return this.#window.ownsPath(pathname);
    }
    /** @internal Content-free WSS ingress diagnostics for managed physical acceptance. */
    diagnosticsSnapshot() {
        return this.#window.diagnosticsSnapshot();
    }
    /** @internal Content-free WSS latency summary for managed acceptance. */
    latencySnapshot() {
        return this.#window.latencySnapshot();
    }
    revoke(interventionId) {
        const state = this.#sessionsByIntervention.get(interventionId);
        if (state)
            this.#forget(state);
        this.#window.revoke(interventionId);
    }
    async completeAfterVerification(intervention) {
        return await this.#window.completeAfterVerification(intervention);
    }
    #forgetMatching(interventionId, epoch) {
        const state = this.#sessionsByIntervention.get(interventionId);
        if (state?.epoch === epoch)
            this.#forget(state);
    }
    #forget(state) {
        if (this.#sessionsById.get(state.sessionId) === state)
            this.#sessionsById.delete(state.sessionId);
        if (this.#sessionsByIntervention.get(state.interventionId) === state) {
            this.#sessionsByIntervention.delete(state.interventionId);
        }
    }
}
function browserPageHtml(nonce, policy) {
    const tap = policy.tap ? "1" : "0";
    const scroll = policy.scroll ? "1" : "0";
    const text = policy.text ? "1" : "0";
    const key = policy.key ? "1" : "0";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><title>Human takeover</title><style nonce="${nonce}">:root{font-family:system-ui,-apple-system,sans-serif;color-scheme:dark}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}main{position:fixed;inset:0;background:#000}.screen{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none}.screen img{width:100%;height:100%;object-fit:contain;display:block;user-select:none;-webkit-user-drag:none;transform-origin:50% 50%;will-change:transform}.top{position:absolute;z-index:5;left:max(10px,env(safe-area-inset-left));right:max(10px,env(safe-area-inset-right));top:max(10px,env(safe-area-inset-top));display:flex;gap:8px;align-items:center;pointer-events:none}.status{font-size:12px;padding:6px 9px;border-radius:999px;background:rgba(0,0,0,.65);color:#fff;max-width:62vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.zoom,.aim,.keyboard,.backspace,.done{pointer-events:auto;min-height:42px;border:0;border-radius:999px;padding:8px 12px;font:600 14px system-ui,-apple-system,sans-serif}.zoom,.aim,.keyboard,.backspace{background:rgba(0,0,0,.65);color:#fff}.zoom{margin-left:auto;min-width:48px}.aim{display:none}.done{background:rgba(255,255,255,.94);color:#111}.aim-crosshair{display:none;position:absolute;z-index:4;left:50%;top:50%;width:32px;height:32px;transform:translate(-50%,-50%);pointer-events:none}.aim-crosshair:before,.aim-crosshair:after{content:'';position:absolute;background:rgba(255,255,255,.95);box-shadow:0 0 2px #000}.aim-crosshair:before{left:15px;top:0;width:2px;height:32px}.aim-crosshair:after{left:0;top:15px;width:32px;height:2px}.aim-tap{display:none;position:absolute;z-index:5;left:50%;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%);pointer-events:auto;min-height:48px;min-width:120px;border:0;border-radius:999px;background:rgba(255,255,255,.94);color:#111;font:700 15px system-ui,-apple-system,sans-serif}.keyboard-input{position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:.001;border:0;padding:0;font-size:16px;pointer-events:none}</style></head><body><main id="app" data-tap="${tap}" data-scroll="${scroll}" data-text="${text}" data-key="${key}"><div id="screen" class="screen"><img id="frame" alt="Remote bounded browser surface" draggable="false"></div><div id="aim-crosshair" class="aim-crosshair" aria-hidden="true"></div><button id="aim-tap" class="aim-tap" type="button" aria-label="Tap aimed remote point">Tap</button><div class="top"><span id="status" class="status">Connecting…</span><button id="zoom" class="zoom" type="button" aria-label="Zoom remote view" aria-pressed="false">1×</button><button id="aim" class="aim" type="button" aria-label="Aim precise remote tap" aria-pressed="false">Aim</button><button id="keyboard-open" class="keyboard" type="button" aria-label="Open keyboard" aria-pressed="false">⌨︎</button><button id="backspace" class="backspace" type="button" aria-label="Backspace">⌫</button><button id="done" class="done" type="button">Done</button></div><textarea id="keyboard-input" class="keyboard-input" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="512"></textarea></main><script nonce="${nonce}">(()=>{'use strict';${browserHumanInputClientSource()}${browserWssReconnectClientSource()}const app=document.querySelector('#app');const policy={tap:app.dataset.tap==='1',scroll:app.dataset.scroll==='1',text:app.dataset.text==='1',key:app.dataset.key==='1'};const parts=location.pathname.split('/').filter(Boolean);const id=parts[parts.length-1]||'';const screen=document.querySelector('#screen');const frame=document.querySelector('#frame');const status=document.querySelector('#status');const done=document.querySelector('#done');const zoomButton=document.querySelector('#zoom');const aimButton=document.querySelector('#aim');const aimTapButton=document.querySelector('#aim-tap');const aimCrosshair=document.querySelector('#aim-crosshair');const keyboardOpen=document.querySelector('#keyboard-open');const backspace=document.querySelector('#backspace');const keyboard=document.querySelector('#keyboard-input');let socket=null;let ready=false;let stopped=false;let terminalPending=false;let connecting=false;let reconnectTimer=null;let reconnectAttempts=0;let currentUrl='';let pointer=null;let composing=false;let keyboardMode=false;let keyboardMirror='';let editableRegions=[];let editableRegionsAt=0;let editableDiagnosticState='unknown';let lastFrameLoadedAt=0;let firstFrameStartedAt=0;let firstFrameLoadedAt=0;let firstFrameReported=false;let viewScale=1;let viewPanX=0;let viewPanY=0;let aimMode=false;let orientationResetTimer=0;const MAX_VIEW_SCALE=4;function clamp(value,min,max){const result=Math.max(min,Math.min(max,value));return Object.is(result,-0)?0:result}function viewBounds(scale){const r=screen.getBoundingClientRect();if(aimMode){const naturalWidth=Number(frame.naturalWidth)||0,naturalHeight=Number(frame.naturalHeight)||0;if(naturalWidth>0&&naturalHeight>0&&r.width>0&&r.height>0){const fit=Math.min(r.width/naturalWidth,r.height/naturalHeight),width=naturalWidth*fit,height=naturalHeight*fit;return{x:scale*width/2,y:scale*height/2}}}return{x:Math.max(0,(scale-1)*r.width/2),y:Math.max(0,(scale-1)*r.height/2)}}function applyViewTransform(scale,panX,panY){const nextScale=clamp(Number(scale)||1,1,MAX_VIEW_SCALE);const bounds=viewBounds(nextScale);viewScale=nextScale;viewPanX=clamp(Number(panX)||0,-bounds.x,bounds.x);viewPanY=clamp(Number(panY)||0,-bounds.y,bounds.y);frame.style.transform=viewScale===1?'none':'matrix('+viewScale+',0,0,'+viewScale+','+viewPanX+','+viewPanY+')';zoomButton.textContent=(Math.round(viewScale*10)/10)+'×';zoomButton.setAttribute('aria-pressed',viewScale>1?'true':'false')}function setAimMode(enabled){aimMode=Boolean(enabled)&&policy.tap&&!stopped;aimButton.setAttribute('aria-pressed',aimMode?'true':'false');aimButton.textContent=aimMode?'Aim ✓':'Aim';aimCrosshair.style.display=aimMode?'block':'none';aimTapButton.style.display=aimMode?'block':'none';if(aimMode&&viewScale<MAX_VIEW_SCALE)applyViewTransform(MAX_VIEW_SCALE,viewPanX,viewPanY)}function resetViewTransform(){pointer=null;setAimMode(false);applyViewTransform(1,0,0)}function cycleViewScale(){const next=viewScale<1.5?2:viewScale<2.5?3:viewScale<3.5?4:1;applyViewTransform(next,0,0)}function scheduleOrientationReset(){if(orientationResetTimer)clearTimeout(orientationResetTimer);orientationResetTimer=setTimeout(()=>{orientationResetTimer=0;resetViewTransform()},180)}function setStatus(value){status.textContent=value}function controls(){keyboardOpen.style.display=policy.text||policy.key?'block':'none';backspace.style.display=policy.key?'block':'none';aimButton.style.display=policy.tap?'block':'none';if(!policy.tap)setAimMode(false)}function send(message){if(stopped||!ready||!socket||socket.readyState!==WebSocket.OPEN)return false;socket.send(JSON.stringify(message));return true}function diagnostic(event){send({kind:'diagnostic',event})}function latency(metric,valueMs){return Number.isFinite(valueMs)&&valueMs>=0&&valueMs<=120000?send({kind:'latency',metric,valueMs:Math.round(valueMs*10)/10}):false}function flushFirstFrameLatency(){if(firstFrameReported||!ready||firstFrameLoadedAt<=0)return;if(latency('client_first_frame',firstFrameLoadedAt-firstFrameStartedAt))firstFrameReported=true}function boundedPoint(event){if(!frame.naturalWidth||!frame.naturalHeight)return null;const r=screen.getBoundingClientRect();if(!r.width||!r.height)return null;const centerX=r.left+r.width/2,centerY=r.top+r.height/2;const baseX=centerX+(event.clientX-centerX-viewPanX)/viewScale,baseY=centerY+(event.clientY-centerY-viewPanY)/viewScale;const scale=Math.min(r.width/frame.naturalWidth,r.height/frame.naturalHeight);const width=frame.naturalWidth*scale,height=frame.naturalHeight*scale;const left=r.left+(r.width-width)/2,top=r.top+(r.height-height)/2;if(baseX<left||baseX>left+width||baseY<top||baseY>top+height)return null;return{x:Math.max(0,Math.min(1,(baseX-left)/width)),y:Math.max(0,Math.min(1,(baseY-top)/height))}}function resetKeyboardBuffer(){keyboard.value='';keyboardMirror=''}function focusKeyboard(){if(document.activeElement===keyboard)return;try{keyboard.focus({preventScroll:true})}catch{keyboard.focus()}resetKeyboardBuffer()}function syncKeyboardValue(){if(composing)return true;const current=Array.from(keyboard.value),mirrored=Array.from(keyboardMirror);let prefix=0;while(prefix<current.length&&prefix<mirrored.length&&current[prefix]===mirrored[prefix])prefix+=1;const remove=mirrored.length-prefix,insert=current.slice(prefix).join('');if(remove>0&&!policy.key){setStatus('Keyboard replacement unavailable');return false}for(let i=0;i<remove;i+=1){if(!send({kind:'key',key:'Backspace'}))return false}if(insert&&(!policy.text||!send({kind:'text',text:insert})))return false;keyboardMirror=keyboard.value;return true}function setKeyboardMode(enabled){keyboardMode=enabled;keyboardOpen.setAttribute('aria-pressed',enabled?'true':'false');if(enabled)focusKeyboard();else keyboard.blur()}function applyEditableRegions(regions){if(!Array.isArray(regions)||regions.length>32)return;const next=[];for(const region of regions){if(!Array.isArray(region)||region.length!==4||region.some(value=>!Number.isInteger(value)))return;const [x,y,width,height]=region;if(x<0||y<0||width<1||height<1||x+width>10000||y+height>10000)return;next.push(region)}editableRegions=next;editableRegionsAt=performance.now();const state=next.length>0?'available':'empty';if(state!==editableDiagnosticState){editableDiagnosticState=state;diagnostic(state==='available'?'client_editable_regions_available':'client_editable_regions_empty')}}function pointIsEditable(point){if(!editableRegionsAt)return false;const x=point.x*10000,y=point.y*10000;return editableRegions.some(region=>x>=region[0]&&x<=region[0]+region[2]&&y>=region[1]&&y<=region[1]+region[3])}function parseFrame(buffer){if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<16)return;const view=new DataView(buffer);if(view.getUint32(0)!==0x484f4631||view.getUint8(5)!==0||view.getUint16(14)!==0)return;const mimeCode=view.getUint8(4),width=view.getUint16(6),height=view.getUint16(8),length=view.getUint32(10);if(!width||!height||length!==buffer.byteLength-16)return;const mime=mimeCode===1?'image/jpeg':mimeCode===2?'image/png':'';if(!mime)return;const receivedAt=performance.now();const blob=new Blob([buffer.slice(16)],{type:mime});const next=URL.createObjectURL(blob);frame.onload=()=>{const loadedAt=performance.now();if(firstFrameLoadedAt<=0)firstFrameLoadedAt=loadedAt;flushFirstFrameLatency();latency('client_frame_decode',loadedAt-receivedAt);if(lastFrameLoadedAt>0)latency('client_frame_cadence',loadedAt-lastFrameLoadedAt);lastFrameLoadedAt=loadedAt;if(currentUrl)URL.revokeObjectURL(currentUrl);currentUrl=next};frame.src=next}function scheduleReconnect(){if(stopped||terminalPending||reconnectTimer)return;resetViewTransform();if(reconnectAttempts>=browserWssReconnectMaxAttempts){stopped=true;setStatus('Connection closed');return}const attempt=reconnectAttempts;reconnectAttempts+=1;ready=false;setStatus('Reconnecting…');reconnectTimer=setTimeout(()=>{reconnectTimer=null;void connect().catch(()=>onInitialWebSocketConnectFailure())},browserWssReconnectDelayMs(attempt))}function onWebSocketDisconnected(ws,event){if(stopped||terminalPending)return;if(browserWssCloseIsReconnectable(event.code)){scheduleReconnect();return}stopped=true;resetViewTransform();setStatus('Connection closed')}function onInitialWebSocketConnectFailure(){scheduleReconnect()}async function connect(){if(stopped||terminalPending||connecting)return;connecting=true;try{if(firstFrameStartedAt<=0)firstFrameStartedAt=performance.now();const bootstrap=await fetch('/takeover/api/websocket-bootstrap/'+encodeURIComponent(id),{method:'POST',cache:'no-store',headers:{'content-type':'application/json'}});if(!bootstrap.ok)throw new Error('bootstrap unavailable');const body=await bootstrap.json();if(!body||!Array.isArray(body.protocols)||body.protocols.length!==2||body.protocols.some(p=>typeof p!=='string'))throw new Error('invalid bootstrap');const target=new URL('/takeover/ws/'+encodeURIComponent(id),location.href);target.protocol=location.protocol==='https:'?'wss:':'ws:';const ws=new WebSocket(target,body.protocols);socket=ws;ws.binaryType='arraybuffer';ws.onmessage=(event)=>{if(socket!==ws)return;if(typeof event.data!=='string'){parseFrame(event.data);return}let message;try{message=JSON.parse(event.data)}catch{return}if(!message||typeof message!=='object')return;if(message.kind==='ready'){ready=true;flushFirstFrameLatency();setStatus('Human authority active');return}if(message.kind==='editableRegions'){applyEditableRegions(message.regions);return}if(message.kind==='closing'){ready=false;terminalPending=true;resetViewTransform();setStatus('Finishing…');return}if(message.kind==='closed'){ready=false;terminalPending=true;stopped=true;resetViewTransform();setStatus('Done. Return for verification.');try{ws.close()}catch{}return}if(message.kind==='error'){ready=false;terminalPending=true;stopped=true;resetViewTransform();setStatus('Session unavailable')}};ws.onclose=(event)=>{if(socket!==ws)return;socket=null;ready=false;onWebSocketDisconnected(ws,event)};ws.onerror=()=>{if(socket!==ws||stopped||terminalPending)return;ready=false;setStatus('Connection unavailable')}}finally{connecting=false}}screen.addEventListener('pointerdown',event=>{if(stopped||!ready)return;const point=boundedPoint(event);if(!point)return;const editable=pointIsEditable(point);pointer={id:event.pointerId,startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,point,editable,localPan:aimMode||viewScale>1,viewStartPanX:viewPanX,viewStartPanY:viewPanY};try{screen.setPointerCapture(event.pointerId)}catch{}event.preventDefault()});screen.addEventListener('pointermove',event=>{if(!pointer||pointer.id!==event.pointerId)return;pointer.lastX=event.clientX;pointer.lastY=event.clientY;if(pointer.localPan&&Math.hypot(event.clientX-pointer.startX,event.clientY-pointer.startY)>8)applyViewTransform(viewScale,pointer.viewStartPanX+event.clientX-pointer.startX,pointer.viewStartPanY+event.clientY-pointer.startY);event.preventDefault()});screen.addEventListener('pointerup',event=>{if(!pointer||pointer.id!==event.pointerId)return;const active=pointer;pointer=null;const dx=event.clientX-active.startX,dy=event.clientY-active.startY,moved=Math.hypot(dx,dy);if(active.localPan&&moved>8){event.preventDefault();return}if(moved<=12){if(aimMode){event.preventDefault();return}let focusRequested=false,focusActive=false;if(keyboardMode){focusRequested=true;focusKeyboard();focusActive=document.activeElement===keyboard}if(policy.tap)send({kind:'tap',x:active.point.x,y:active.point.y});diagnostic(active.editable?'client_tap_editable_predicted':'client_tap_editable_not_predicted');if(focusRequested){diagnostic('client_keyboard_focus_requested');diagnostic(focusActive?'client_keyboard_focus_active':'client_keyboard_focus_inactive')}}else if(!active.localPan&&policy.scroll){const delta=browserPhysicalSwipeScrollDelta(dy);if(delta)send({kind:'scroll',deltaY:delta})}event.preventDefault()});screen.addEventListener('pointercancel',()=>{pointer=null});function tapAimTarget(){if(!aimMode||stopped||!ready||!policy.tap)return;const r=screen.getBoundingClientRect();const point=boundedPoint({clientX:r.left+r.width/2,clientY:r.top+r.height/2});if(!point){setStatus('Aim target outside remote view');return}if(keyboardMode)focusKeyboard();send({kind:'tap',x:point.x,y:point.y})}zoomButton.onclick=()=>{if(!stopped)cycleViewScale()};aimButton.onclick=()=>{if(!stopped&&policy.tap)setAimMode(!aimMode)};aimTapButton.onclick=()=>{tapAimTarget()};keyboardOpen.onclick=()=>{if(!stopped&&(policy.text||policy.key))setKeyboardMode(!keyboardMode)};backspace.onclick=()=>{if(policy.key)send({kind:'key',key:'Backspace'});setKeyboardMode(true)};keyboard.addEventListener('compositionstart',()=>{composing=true});keyboard.addEventListener('compositionend',()=>{composing=false;queueMicrotask(()=>{syncKeyboardValue()})});keyboard.addEventListener('keydown',event=>{if(composing||event.isComposing)return;if(event.key==='Backspace'&&policy.key&&keyboard.value===''){if(send({kind:'key',key:'Backspace'}))event.preventDefault();return}if(event.key==='Enter'&&policy.key){if(syncKeyboardValue()&&send({kind:'key',key:'Enter'})){event.preventDefault();resetKeyboardBuffer()}}});keyboard.addEventListener('beforeinput',event=>{if(composing||event.isComposing)return;if(event.inputType==='deleteContentBackward'&&policy.key&&keyboard.value===''){if(send({kind:'key',key:'Backspace'}))event.preventDefault();return}if((event.inputType==='insertLineBreak'||event.inputType==='insertParagraph')&&policy.key){if(syncKeyboardValue()&&send({kind:'key',key:'Enter'})){event.preventDefault();resetKeyboardBuffer()}}});keyboard.addEventListener('input',()=>{if(composing)return;const value=keyboard.value;if(policy.key&&(value.endsWith('\\n')||value.endsWith('\\r'))){keyboard.value=value.slice(0,-1);if(syncKeyboardValue()&&send({kind:'key',key:'Enter'}))resetKeyboardBuffer();return}syncKeyboardValue()});done.onclick=()=>{if(!ready||stopped)return;done.disabled=true;terminalPending=true;resetViewTransform();setStatus('Finishing…');if(send({kind:'done'})){ready=false}else{ready=false;stopped=true;setStatus('Session unavailable')}};controls();resetViewTransform();window.addEventListener('orientationchange',scheduleOrientationReset);void connect().catch(()=>onInitialWebSocketConnectFailure())})();</script></body></html>`;
}
function browserContentSecurityPolicy(nonce, publicOrigin) {
    const origin = new URL(publicOrigin);
    const websocketOrigin = `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}`;
    return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src 'self' ${websocketOrigin}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
function browserHeaders(contentType) {
    return new Headers({
        "content-type": contentType,
        "cache-control": "no-store, max-age=0",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    });
}
function browserResponse(status, contentType, body) {
    return new Response(body, { status, headers: browserHeaders(contentType) });
}
function sessionIdFromLocator(locator) {
    try {
        return /^\/takeover\/([A-Za-z0-9-]{8,100})$/.exec(new URL(locator).pathname)?.[1];
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=websocket-browser-handoff.js.map