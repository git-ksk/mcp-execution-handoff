import { randomBytes } from "node:crypto";
import { TakeoverSessionError, TakeoverSessionManager } from "./session.js";
import { NativeTakeoverRuntimeError, nativeBindingFromGrant, parseNativeTakeoverClientEndpoint } from "./native-runtime.js";
import { WebRtcTakeoverRuntimeError, parseWebRtcOffer, webRtcBindingFromGrant } from "./webrtc-runtime.js";
import { parseWebRtcLatencySample } from "./webrtc-latency.js";
import { parseBrowserWebRtcDiagnosticEvent } from "./webrtc-diagnostics.js";
import { MAX_BROWSER_HANDOFF_VIEW_SCALE } from "./mobile-view-transform.js";
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
keyboardOpen.addEventListener('click',function(){if(stopped)return;try{keyboard.focus({preventScroll:true});resetKeyboard()}catch{}});
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
function webRtcClientScript() {
    return `(() => {
const parts=location.pathname.split('/').filter(Boolean);const sessionId=parts.length?parts[parts.length-1]:'';
const statusEl=document.querySelector('#status');const video=document.querySelector('#video');const screen=document.querySelector('.screen');const zoomButton=document.querySelector('#zoom');const aimButton=document.querySelector('#aim');const aimTapButton=document.querySelector('#aim-tap');const aimCrosshair=document.querySelector('#aim-crosshair');const keyboard=document.querySelector('#keyboard');const keyboardOpen=document.querySelector('#keyboard-open');const keyboardBackspace=document.querySelector('#keyboard-backspace');const doneButton=document.querySelector('#done');let completionCapability=doneButton&&doneButton.dataset?doneButton.dataset.completion||'':'';
let clientBinding=randomClientBinding();let cap='';let reconnectHandle='';let clientGeneration=0;let inputPolicy={tap:true,scroll:true,text:true,key:true};let pc=null;let critical=null;let realtime=null;let primaryButtonDown=false;let primaryButtonPoint=null;let primaryReleaseTimer=0;let stopped=false;let suspended=false;let suspendPromise=Promise.resolve();let gesture=null;let pinch=null;let viewScale=1;let viewPanX=0;let viewPanY=0;let aimMode=false;let orientationResetTimer=0;let composing=false;let keyboardMode=false;let failureInProgress=false;let initialReconnectUsed=false;let connectionStartedAt=0;let firstFrameMs=null;let metricsSamplesSent=0;let inputMetricsSamplesSent=0;let metricsTimer=0;let latestFrameMetrics={};let lastTapSentAt=0;let relayState='disabled';let relayTimer=0;let editableRegions=[];let editableRegionsAt=0;let keyboardFallbackTimer=0;let iceCandidateCounts={host:0,srflx:0,prflx:0,relay:0};let iceGatherStartedAt=0;
const MARK='_';
const touchEventsAvailable=('ontouchstart' in window)||(Number(navigator.maxTouchPoints)||0)>0;
const MAX_VIEW_SCALE=${MAX_BROWSER_HANDOFF_VIEW_SCALE};
function status(text){statusEl.textContent=text}
function clamp(value,min,max){const result=Math.max(min,Math.min(max,value));return Object.is(result,-0)?0:result}
function viewBounds(scale){const r=screen.getBoundingClientRect();return{x:Math.max(0,(scale-1)*r.width/2),y:Math.max(0,(scale-1)*r.height/2)}}
function applyViewTransform(scale,panX,panY){const nextScale=clamp(Number(scale)||1,1,MAX_VIEW_SCALE);const bounds=viewBounds(nextScale);viewScale=nextScale;viewPanX=clamp(Number(panX)||0,-bounds.x,bounds.x);viewPanY=clamp(Number(panY)||0,-bounds.y,bounds.y);video.style.transform=viewScale===1?'none':'matrix('+viewScale+',0,0,'+viewScale+','+viewPanX+','+viewPanY+')';zoomButton.textContent=(Math.round(viewScale*10)/10)+'×';zoomButton.setAttribute('aria-pressed',viewScale>1?'true':'false')}
function setAimMode(enabled){aimMode=Boolean(enabled)&&inputPolicy.tap&&!stopped;aimButton.setAttribute('aria-pressed',aimMode?'true':'false');aimButton.textContent=aimMode?'Aim ✓':'Aim';aimCrosshair.style.display=aimMode?'block':'none';aimTapButton.style.display=aimMode?'block':'none';if(aimMode&&viewScale<MAX_VIEW_SCALE)applyViewTransform(MAX_VIEW_SCALE,viewPanX,viewPanY)}
function resetViewTransform(){pinch=null;gesture=null;setAimMode(false);applyViewTransform(1,0,0)}
function cycleViewScale(){const next=viewScale<1.5?2:viewScale<2.5?3:viewScale<3.5?4:1;applyViewTransform(next,0,0)}
function touchDistance(a,b){return Math.max(1,Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY))}
function touchMidpoint(a,b){return{x:(a.clientX+b.clientX)/2,y:(a.clientY+b.clientY)/2}}
function beginPinch(list){if(!list||list.length!==2)return false;const a=list[0],b=list[1],mid=touchMidpoint(a,b),r=screen.getBoundingClientRect();gesture=null;pinch={startDistance:touchDistance(a,b),startScale:viewScale,startPanX:viewPanX,startPanY:viewPanY,startMidX:mid.x,startMidY:mid.y,centerX:r.left+r.width/2,centerY:r.top+r.height/2};return true}
function updatePinch(list){if(!pinch||!list||list.length<2)return;const a=list[0],b=list[1],mid=touchMidpoint(a,b),ratio=clamp(touchDistance(a,b)/pinch.startDistance,0.25,4),nextScale=clamp(pinch.startScale*ratio,1,MAX_VIEW_SCALE),scaleRatio=nextScale/pinch.startScale;const panX=mid.x-pinch.centerX-scaleRatio*(pinch.startMidX-pinch.centerX-pinch.startPanX);const panY=mid.y-pinch.centerY-scaleRatio*(pinch.startMidY-pinch.centerY-pinch.startPanY);applyViewTransform(nextScale,panX,panY)}
function scheduleOrientationReset(){if(orientationResetTimer)clearTimeout(orientationResetTimer);orientationResetTimer=setTimeout(function(){orientationResetTimer=0;resetViewTransform()},180)}
function randomClientBinding(){const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);let binary='';for(let i=0;i<bytes.length;i+=1)binary+=String.fromCharCode(bytes[i]);return btoa(binary).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function wait(ms){return new Promise(r=>setTimeout(r,ms))}
function waitIce(peer,relayAvailable){if(peer.iceGatheringState==='complete')return Promise.resolve();return new Promise((resolve)=>{let settled=false;let timer=0;function finish(){if(settled)return;settled=true;if(timer)clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',stateChanged);peer.removeEventListener('icecandidate',candidateReady);resolve()}function stateChanged(){if(peer.iceGatheringState==='complete')finish()}function candidateReady(event){if(!event.candidate){finish();return}if(relayAvailable&&event.candidate.type==='relay')finish()}timer=setTimeout(finish,10000);peer.addEventListener('icegatheringstatechange',stateChanged);peer.addEventListener('icecandidate',candidateReady)})}
function resetKeyboard(){keyboard.value=MARK;try{keyboard.setSelectionRange(MARK.length,MARK.length)}catch{}}
function focusKeyboard(){try{keyboard.focus({preventScroll:true})}catch{try{keyboard.focus()}catch{}}resetKeyboard()}function setKeyboardMode(enabled){keyboardMode=enabled;keyboardOpen.setAttribute('aria-pressed',enabled?'true':'false');if(enabled)focusKeyboard();else keyboard.blur()}
function setKeyboardControlsVisible(visible){const keyboardAllowed=inputPolicy.text||inputPolicy.key;const display=visible&&keyboardAllowed?'block':'none';keyboardOpen.style.display=display;keyboardBackspace.style.display=display}function setAimControlsVisible(){aimButton.style.display=inputPolicy.tap?'block':'none';if(!inputPolicy.tap)setAimMode(false)}function armKeyboardFallback(){if(keyboardFallbackTimer)clearTimeout(keyboardFallbackTimer);keyboardFallbackTimer=0;if(touchEventsAvailable){if(!stopped)setKeyboardControlsVisible(true);return}keyboardFallbackTimer=setTimeout(function(){if(!editableRegionsAt&&!stopped)setKeyboardControlsVisible(true)},1200)}
function clearRelayTimer(){if(relayTimer){clearTimeout(relayTimer);relayTimer=0}}
function clearMetricsTimer(){if(metricsTimer){clearInterval(metricsTimer);metricsTimer=0}}
function closePeer(){releasePrimaryButton();clearRelayTimer();clearMetricsTimer();lastTapSentAt=0;editableRegions=[];editableRegionsAt=0;keyboardMode=false;keyboardOpen.setAttribute('aria-pressed','false');keyboard.blur();setKeyboardControlsVisible(false);armKeyboardFallback();resetViewTransform();video.style.opacity='0';if(pc){try{pc.ontrack=null;pc.onconnectionstatechange=null;pc.close()}catch{}pc=null}critical=null;realtime=null}
function mapPoint(event){const r=video.getBoundingClientRect();const vw=video.videoWidth||1;const vh=video.videoHeight||1;if(!r.width||!r.height)return null;const scale=Math.min(r.width/vw,r.height/vh);const w=vw*scale,h=vh*scale;const left=r.left+(r.width-w)/2,top=r.top+(r.height-h)/2;if(event.clientX<left||event.clientX>left+w||event.clientY<top||event.clientY>top+h)return null;return{x:(event.clientX-left)/w,y:(event.clientY-top)/h}}
function applyEditableRegions(value){if(!Array.isArray(value)||value.length>32)return;const next=[];for(const item of value){if(!Array.isArray(item)||item.length!==4||!item.every(Number.isSafeInteger))return;const x=item[0],y=item[1],w=item[2],h=item[3];if(x<0||y<0||w<1||h<1||x+w>10000||y+h>10000)return;next.push([x,y,w,h])}editableRegions=next;editableRegionsAt=performance.now();setKeyboardControlsVisible(touchEventsAvailable);if(keyboardFallbackTimer){clearTimeout(keyboardFallbackTimer);keyboardFallbackTimer=0}}
function pointIsEditable(point){if(!editableRegionsAt||performance.now()-editableRegionsAt>1000)return false;const x=point.x*10000,y=point.y*10000;return editableRegions.some(function(region){return x>=region[0]&&x<=region[0]+region[2]&&y>=region[1]&&y<=region[1]+region[3]})}
function inputAllowed(kind){return kind==='tap'||kind==='pointer_button'?inputPolicy.tap:kind==='scroll'?inputPolicy.scroll:kind==='text'?inputPolicy.text:kind==='key'?inputPolicy.key:false}function send(channel,body,maxBuffered){if(stopped||!inputAllowed(body&&body.kind)||!channel||channel.readyState!=='open'||channel.bufferedAmount>maxBuffered)return false;const text=JSON.stringify(body);if(new TextEncoder().encode(text).byteLength>4096)return false;channel.send(text);return true}
function sendCritical(body){return send(critical,body,32768)}function sendRealtime(body){return send(realtime,body,4096)}
function releasePrimaryButton(){if(primaryReleaseTimer){clearTimeout(primaryReleaseTimer);primaryReleaseTimer=0}if(!primaryButtonDown||!primaryButtonPoint)return;const p=primaryButtonPoint;sendCritical({kind:'pointer_button',button:'primary',state:'up',x:p.x,y:p.y});primaryButtonDown=false;primaryButtonPoint=null}
function sendPrimaryTap(point){if(primaryButtonDown||!point)return false;if(!sendCritical({kind:'pointer_button',button:'primary',state:'down',x:point.x,y:point.y}))return false;primaryButtonDown=true;primaryButtonPoint={x:point.x,y:point.y};primaryReleaseTimer=setTimeout(function(){primaryReleaseTimer=0;releasePrimaryButton()},20);return true}
async function prepare(mode){const headers={'x-takeover-client':clientBinding};if(mode==='reconnect')headers['x-mcp-takeover-reconnect']=reconnectHandle;const response=await fetch('/takeover/api/webrtc-prepare-'+mode+'/'+encodeURIComponent(sessionId),{method:'POST',cache:'no-store',headers});if(!response.ok){const e=new Error('prepare unavailable');e.status=response.status;throw e}const data=await response.json();if(!data.capability||!data.reconnectHandle||!Number.isFinite(data.clientGeneration)||!data.webrtcIce||!Array.isArray(data.webrtcIce.iceServers))throw new Error('invalid prepare response');if(!['disabled','available','unavailable'].includes(data.webrtcIce.relay))throw new Error('invalid relay state');const p=data.inputPolicy;if(!p||typeof p!=='object'||['tap','scroll','text','key'].some(function(k){return typeof p[k]!=='boolean'}))throw new Error('invalid input policy');inputPolicy={tap:p.tap,scroll:p.scroll,text:p.text,key:p.key};setKeyboardControlsVisible(false);setAimControlsVisible();cap=data.capability;reconnectHandle=data.reconnectHandle;clientGeneration=data.clientGeneration;relayState=data.webrtcIce.relay;return data.webrtcIce}
function boundedMs(value){const number=Number(value);return Number.isFinite(number)&&number>=0?Math.min(120000,number):undefined}
function frameDelta(later,earlier){const a=Number(later),b=Number(earlier);return Number.isFinite(a)&&Number.isFinite(b)&&a>=b?boundedMs(a-b):undefined}
function armMetrics(peer){clearMetricsTimer();metricsTimer=setInterval(function(){if(peer!==pc||stopped||metricsSamplesSent>=12){clearMetricsTimer();return}void reportMetrics(peer,false)},2000)}
function armFirstFrame(next){firstFrameMs=null;metricsSamplesSent=0;latestFrameMetrics={};let fired=false;const mark=function(now,metadata){if(next!==pc)return;const frame={};const senderToDisplay=frameDelta(metadata.expectedDisplayTime,metadata.captureTime);if(senderToDisplay!==undefined)frame.senderTimelineToDisplayMs=senderToDisplay;const senderToReceive=frameDelta(metadata.receiveTime,metadata.captureTime);if(senderToReceive!==undefined)frame.senderTimelineToReceiveMs=senderToReceive;const receiveToDisplay=frameDelta(metadata.expectedDisplayTime,metadata.receiveTime);if(receiveToDisplay!==undefined)frame.receiveToDisplayMs=receiveToDisplay;const decode=boundedMs(Number(metadata.processingDuration)*1000);if(decode!==undefined)frame.frameDecodeMs=decode;const compositor=frameDelta(metadata.expectedDisplayTime,metadata.presentationTime);if(compositor!==undefined)frame.compositorMs=compositor;latestFrameMetrics=frame;if(!fired){fired=true;video.style.opacity='1';firstFrameMs=Math.max(0,performance.now()-connectionStartedAt);void reportMetrics(next,true);armMetrics(next)}if(next===pc&&typeof video.requestVideoFrameCallback==='function')video.requestVideoFrameCallback(mark)};if(typeof video.requestVideoFrameCallback==='function'){video.requestVideoFrameCallback(mark)}else{video.addEventListener('playing',function(){if(fired||next!==pc)return;fired=true;video.style.opacity='1';firstFrameMs=Math.max(0,performance.now()-connectionStartedAt);void reportMetrics(next,true);armMetrics(next)},{once:true})}}
async function selectedPath(peer){for(let attempt=0;attempt<4;attempt+=1){try{const stats=await peer.getStats();let pair=null;stats.forEach(function(report){if(!pair&&report.type==='transport'&&report.selectedCandidatePairId)pair=stats.get(report.selectedCandidatePairId)});if(!pair)stats.forEach(function(report){if(!pair&&report.type==='candidate-pair'&&report.state==='succeeded'&&report.nominated)pair=report});if(pair){const local=stats.get(pair.localCandidateId);const remote=stats.get(pair.remoteCandidateId);const path=(local&&local.candidateType==='relay')||(remote&&remote.candidateType==='relay')?'relay':'direct';const rtt=Number(pair.currentRoundTripTime);return{path:path,rttMs:Number.isFinite(rtt)&&rtt>=0?Math.min(120000,rtt*1000):undefined}}}catch{}await wait(100)}return null}
async function receiverMetrics(peer){try{const stats=await peer.getStats();const result={};stats.forEach(function(report){if(report.type!=='inbound-rtp'||!((report.kind==='video')||(report.mediaType==='video')))return;const emitted=Number(report.jitterBufferEmittedCount);const frames=Number(report.framesDecoded);const jitter=boundedMs(Number(report.jitter)*1000);if(jitter!==undefined)result.jitterMs=jitter;const jitterDelay=Number(report.jitterBufferDelay);if(Number.isFinite(jitterDelay)&&jitterDelay>=0&&Number.isFinite(emitted)&&emitted>0)result.jitterBufferMs=boundedMs((jitterDelay/emitted)*1000);const target=Number(report.jitterBufferTargetDelay);if(Number.isFinite(target)&&target>=0&&Number.isFinite(emitted)&&emitted>0)result.jitterBufferTargetMs=boundedMs((target/emitted)*1000);const minimum=Number(report.jitterBufferMinimumDelay);if(Number.isFinite(minimum)&&minimum>=0&&Number.isFinite(emitted)&&emitted>0)result.jitterBufferMinimumMs=boundedMs((minimum/emitted)*1000);const decode=Number(report.totalDecodeTime);if(Number.isFinite(decode)&&decode>=0&&Number.isFinite(frames)&&frames>0)result.avgDecodeMs=boundedMs((decode/frames)*1000);const processing=Number(report.totalProcessingDelay);if(Number.isFinite(processing)&&processing>=0&&Number.isFinite(frames)&&frames>0)result.avgProcessingMs=boundedMs((processing/frames)*1000)});return result}catch{return {}}}
async function postMetrics(body){if(!cap)return;try{await fetch('/takeover/api/webrtc-metrics/'+encodeURIComponent(sessionId),{method:'POST',cache:'no-store',headers:{'content-type':'application/json','x-mcp-takeover-capability':cap,'x-takeover-client':clientBinding},body:JSON.stringify(body)})}catch{}}
async function postDiagnostic(body){if(!cap)return;try{await fetch('/takeover/api/webrtc-diagnostics/'+encodeURIComponent(sessionId),{method:'POST',cache:'no-store',headers:{'content-type':'application/json','x-mcp-takeover-capability':cap,'x-takeover-client':clientBinding},body:JSON.stringify(body)})}catch{}}
async function reportMetrics(peer,includeFirstFrame){if(peer!==pc||!cap||metricsSamplesSent>=12)return;const selected=await selectedPath(peer);if(!selected||peer!==pc)return;const body={path:selected.path,...latestFrameMetrics};if(includeFirstFrame&&firstFrameMs!==null)body.firstFrameMs=firstFrameMs;if(selected.rttMs!==undefined)body.rttMs=selected.rttMs;Object.assign(body,await receiverMetrics(peer));if(peer!==pc||!cap)return;metricsSamplesSent+=1;if(metricsSamplesSent>=12)clearMetricsTimer();status('Live · '+selected.path);await postMetrics(body)}
async function reportInputAck(peer,inputAckMs){if(peer!==pc||!cap||inputMetricsSamplesSent>=6)return;const selected=await selectedPath(peer);if(!selected||peer!==pc)return;inputMetricsSamplesSent+=1;await postMetrics({path:selected.path,inputAckMs:inputAckMs})}
async function connected(next){clearRelayTimer();failureInProgress=false;initialReconnectUsed=false;const selected=await selectedPath(next);if(next!==pc)return;if(selected){status('Live · '+selected.path)}else{status('Live')}}
async function releaseGeneration(label){if(stopped||!cap)return;suspended=true;const oldPc=pc;closePeer();status(label||'Suspended · stale session closed');try{await fetch('/takeover/api/webrtc-suspend/'+encodeURIComponent(sessionId),{method:'POST',cache:'no-store',keepalive:true,headers:{'x-mcp-takeover-capability':cap,'x-takeover-client':clientBinding}})}catch{}finally{if(oldPc){try{oldPc.close()}catch{}}}}
async function connectionFailed(next){if(next!==pc||stopped||failureInProgress)return;failureInProgress=true;const finalStatus=relayState==='unavailable'?'Secure relay unavailable':relayState==='disabled'?'Direct connection unavailable':'Connection unavailable';await releaseGeneration(finalStatus);if(document.visibilityState==='visible'&&!stopped&&!initialReconnectUsed&&reconnectHandle){initialReconnectUsed=true;await wait(250);try{await reconnect();return}catch{}}status(finalStatus);failureInProgress=false}
async function makeOffer(ice){closePeer();connectionStartedAt=performance.now();firstFrameMs=null;metricsSamplesSent=0;inputMetricsSamplesSent=0;latestFrameMetrics={};const next=new RTCPeerConnection({iceServers:ice.iceServers,iceTransportPolicy:'all'});pc=next;iceCandidateCounts={host:0,srflx:0,prflx:0,relay:0};iceGatherStartedAt=performance.now();next.addEventListener('icecandidate',function(event){const type=event.candidate&&event.candidate.type;if(type&&Object.prototype.hasOwnProperty.call(iceCandidateCounts,type)&&iceCandidateCounts[type]<64)iceCandidateCounts[type]+=1});next.addTransceiver('video',{direction:'recvonly'});critical=next.createDataChannel('human-critical',{ordered:true});realtime=next.createDataChannel('human-realtime',{ordered:false,maxRetransmits:0});critical.onmessage=function(event){try{const m=JSON.parse(String(event.data));if(m.kind==='editableRegions'){applyEditableRegions(m.regions);return}if(m.kind==='focus'){if(lastTapSentAt>0){const ack=boundedMs(performance.now()-lastTapSentAt);lastTapSentAt=0;if(ack!==undefined)void reportInputAck(next,ack)}if(m.editable){if(document.activeElement===keyboard)resetKeyboard()}else if(!keyboardMode){keyboard.blur()}}}catch{}};next.ontrack=function(event){if(event.streams&&event.streams[0])video.srcObject=event.streams[0];else video.srcObject=new MediaStream([event.track]);armFirstFrame(next);void video.play().catch(()=>{})};next.onconnectionstatechange=function(){if(next!==pc)return;const state=next.connectionState;if(['new','connecting','connected','disconnected','failed','closed'].includes(state))void postDiagnostic({stage:'browser.peer.state',state:state});if(state==='connected')void connected(next);if(state==='failed'||state==='disconnected')void connectionFailed(next)};if(ice.relay==='available'){relayTimer=setTimeout(function(){if(next===pc&&next.connectionState!=='connected')status('Trying secure relay…')},1800)}else if(ice.relay==='unavailable'){relayTimer=setTimeout(function(){if(next===pc&&next.connectionState!=='connected')status('Connecting directly… · secure relay unavailable')},1800)}const offer=await next.createOffer();const iceReady=waitIce(next,ice.relay==='available');await next.setLocalDescription(offer);await iceReady;void postDiagnostic({stage:'browser.gather.complete',candidateCounts:iceCandidateCounts,durationMs:Math.max(0,Math.min(120000,performance.now()-iceGatherStartedAt))});if(!next.localDescription)throw new Error('missing offer');return{type:'offer',sdp:next.localDescription.sdp}}
async function signal(offer){const response=await fetch('/takeover/api/webrtc-connect/'+encodeURIComponent(sessionId),{method:'POST',cache:'no-store',headers:{'content-type':'application/json','x-mcp-takeover-capability':cap,'x-takeover-client':clientBinding},body:JSON.stringify(offer)});if(!response.ok){const e=new Error('signal unavailable');e.status=response.status;throw e}const data=await response.json();if(!data.webrtc||data.webrtc.type!=='answer')throw new Error('invalid signal response');if(!pc)throw new Error('peer closed');await pc.setRemoteDescription(data.webrtc);suspended=false}
async function connect(mode){status(mode==='claim'?'Connecting directly…':'Reconnecting with fresh generation…');const ice=await prepare(mode);if(mode==='reconnect')status('Connecting directly…');const offer=await makeOffer(ice);try{await signal(offer)}catch(error){await releaseGeneration(ice.relay==='unavailable'?'Secure relay unavailable':'Connection unavailable');throw error}}
async function suspend(){if(stopped||suspended||!cap)return;suspendPromise=releaseGeneration('Suspended · stale session closed');await suspendPromise}
async function reconnect(){if(stopped||!suspended||!reconnectHandle)return;clientBinding=randomClientBinding();for(let attempt=0;attempt<4;attempt+=1){try{await connect('reconnect');failureInProgress=false;return}catch(e){closePeer();if(e&&e.status===409){await wait(350);continue}throw e}}throw new Error('reconnect unavailable')}
function sendGestureScroll(g,x,y){const dx=x-g.lastX,dy=y-g.lastY;g.lastX=x;g.lastY=y;if(Math.hypot(x-g.startX,y-g.startY)>18)g.moved=true;if(g.moved&&(dx||dy))sendRealtime({kind:'scroll',deltaX:Math.max(-2000,Math.min(2000,dx*2)),deltaY:Math.max(-2000,Math.min(2000,dy*2))})}
function finishGesture(g,x,y){if(!g.moved&&Math.hypot(x-g.startX,y-g.startY)>18)g.moved=true;if(g.moved){if(g.localPan)return;sendGestureScroll(g,x,y);return}if(aimMode)return;if(g.editable||keyboardMode){focusKeyboard()}else{keyboard.blur()}const sentAt=performance.now();if(sendPrimaryTap(g.point))lastTapSentAt=sentAt}
function tapAimTarget(){if(!aimMode||stopped||!inputPolicy.tap)return;const r=screen.getBoundingClientRect();const p=mapPoint({clientX:r.left+r.width/2,clientY:r.top+r.height/2});if(!p){status('Aim target outside remote view');return}keyboard.blur();const sentAt=performance.now();if(sendPrimaryTap(p))lastTapSentAt=sentAt}
function touchWithId(list,id){for(let i=0;i<list.length;i+=1)if(list[i].identifier===id)return list[i];return null}
video.addEventListener('touchstart',function(event){if(!touchEventsAvailable||stopped||!critical||critical.readyState!=='open')return;if(event.touches.length===2){beginPinch(event.touches);event.preventDefault();return}if(event.touches.length!==1||pinch)return;const touch=event.touches[0];const p=mapPoint(touch);if(!p)return;gesture={id:touch.identifier,pointerType:'touch',startX:touch.clientX,startY:touch.clientY,lastX:touch.clientX,lastY:touch.clientY,point:p,moved:false,editable:pointIsEditable(p),localPan:aimMode||viewScale>1,viewStartPanX:viewPanX,viewStartPanY:viewPanY};event.preventDefault()},{passive:false});
video.addEventListener('touchmove',function(event){if(!touchEventsAvailable)return;if(pinch){updatePinch(event.touches);event.preventDefault();return}if(!gesture||gesture.pointerType!=='touch')return;const touch=touchWithId(event.touches,gesture.id);if(!touch)return;if(gesture.localPan){if(Math.hypot(touch.clientX-gesture.startX,touch.clientY-gesture.startY)>8)gesture.moved=true;if(gesture.moved)applyViewTransform(viewScale,gesture.viewStartPanX+touch.clientX-gesture.startX,gesture.viewStartPanY+touch.clientY-gesture.startY)}else{sendGestureScroll(gesture,touch.clientX,touch.clientY)}event.preventDefault()},{passive:false});
video.addEventListener('touchend',function(event){if(!touchEventsAvailable)return;if(pinch){if(event.touches.length<2)pinch=null;gesture=null;event.preventDefault();return}if(!gesture||gesture.pointerType!=='touch')return;const touch=touchWithId(event.changedTouches,gesture.id);if(!touch){gesture=null;return}const g=gesture;gesture=null;finishGesture(g,touch.clientX,touch.clientY);event.preventDefault()},{passive:false});
video.addEventListener('touchcancel',function(){pinch=null;if(gesture&&gesture.pointerType==='touch')gesture=null},{passive:false});
video.addEventListener('pointerdown',function(event){if(touchEventsAvailable&&event.pointerType==='touch')return;if(stopped||!critical||critical.readyState!=='open')return;const p=mapPoint(event);if(!p)return;video.setPointerCapture?.(event.pointerId);gesture={id:event.pointerId,pointerType:event.pointerType,startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,point:p,moved:false,editable:pointIsEditable(p),localPan:aimMode||viewScale>1,viewStartPanX:viewPanX,viewStartPanY:viewPanY};event.preventDefault()});
video.addEventListener('pointermove',function(event){if(!gesture||gesture.pointerType==='touch'||gesture.id!==event.pointerId)return;const dx=event.clientX-gesture.lastX,dy=event.clientY-gesture.lastY;gesture.lastX=event.clientX;gesture.lastY=event.clientY;if(Math.hypot(event.clientX-gesture.startX,event.clientY-gesture.startY)>8)gesture.moved=true;if(gesture.moved){if(gesture.localPan)applyViewTransform(viewScale,gesture.viewStartPanX+event.clientX-gesture.startX,gesture.viewStartPanY+event.clientY-gesture.startY);else sendRealtime({kind:'scroll',deltaX:Math.max(-2000,Math.min(2000,dx*2)),deltaY:Math.max(-2000,Math.min(2000,dy*2))})}event.preventDefault()});
video.addEventListener('pointerup',function(event){if(!gesture||gesture.pointerType==='touch'||gesture.id!==event.pointerId)return;const g=gesture;gesture=null;if(!g.moved&&Math.hypot(event.clientX-g.startX,event.clientY-g.startY)>8)g.moved=true;if(g.moved){if(!g.localPan){const finalDx=event.clientX-g.lastX,finalDy=event.clientY-g.lastY;if(finalDx||finalDy)sendRealtime({kind:'scroll',deltaX:Math.max(-2000,Math.min(2000,finalDx*2)),deltaY:Math.max(-2000,Math.min(2000,finalDy*2))})}}else{if(aimMode){event.preventDefault();return}if(g.editable||keyboardMode){focusKeyboard()}else{keyboard.blur()}const sentAt=performance.now();if(sendPrimaryTap(g.point))lastTapSentAt=sentAt}event.preventDefault()});
video.addEventListener('pointercancel',function(){if(gesture&&gesture.pointerType!=='touch')gesture=null});
keyboard.addEventListener('compositionstart',function(){composing=true});keyboard.addEventListener('compositionend',function(event){composing=false;if(event.data)sendCritical({kind:'text',text:event.data});resetKeyboard()});keyboard.addEventListener('keydown',function(event){if(composing||event.isComposing)return;if(event.key==='Backspace'){if(sendCritical({kind:'key',key:'Backspace'})){event.preventDefault();resetKeyboard()}return}if(event.key==='Enter'){if(sendCritical({kind:'key',key:'Enter'})){event.preventDefault();resetKeyboard()}}});keyboard.addEventListener('beforeinput',function(event){if(composing||event.isComposing)return;if(event.inputType==='deleteContentBackward'){if(sendCritical({kind:'key',key:'Backspace'})){event.preventDefault();resetKeyboard()}return}if(event.inputType==='insertLineBreak'||event.inputType==='insertParagraph'){if(sendCritical({kind:'key',key:'Enter'})){event.preventDefault();resetKeyboard()}return}if((event.inputType==='insertText'||event.inputType==='insertReplacementText'||event.inputType==='insertFromPaste')&&typeof event.data==='string'&&event.data){if(sendCritical({kind:'text',text:event.data})){event.preventDefault();resetKeyboard()}}});keyboard.addEventListener('input',function(){if(composing)return;const value=keyboard.value;if(value===''){sendCritical({kind:'key',key:'Backspace'})}else{let text=value.startsWith(MARK)?value.slice(MARK.length):value;if(text.endsWith('\\n')){text=text.slice(0,-1);if(text)sendCritical({kind:'text',text});sendCritical({kind:'key',key:'Enter'})}else if(text){sendCritical({kind:'text',text})}}resetKeyboard()});
zoomButton.addEventListener('click',function(event){event.preventDefault();if(stopped)return;cycleViewScale()});aimButton.addEventListener('click',function(event){event.preventDefault();if(stopped||!inputPolicy.tap)return;setAimMode(!aimMode)});aimTapButton.addEventListener('click',function(event){event.preventDefault();tapAimTarget()});
keyboardOpen.addEventListener('click',function(event){event.preventDefault();if(stopped)return;setKeyboardMode(!keyboardMode)});keyboardBackspace.addEventListener('click',function(event){event.preventDefault();if(stopped)return;if(sendCritical({kind:'key',key:'Backspace'}))setKeyboardMode(true)});
async function completeHuman(){if(!completionCapability)return;keyboard.blur();const completion=completionCapability;completionCapability='';try{const response=await fetch('/takeover/api/complete/'+encodeURIComponent(sessionId),{method:'POST',cache:'no-store',keepalive:true,headers:{'x-mcp-takeover-completion':completion}});if(!response.ok)throw new Error('completion unavailable');status('Remote control closed. Return to the requesting workflow.')}catch{status('Session closed or completion unavailable')}finally{stopped=true;closePeer();cap='';reconnectHandle='';clientGeneration=0}}
function consumeDoneGesture(event){event.preventDefault();event.stopPropagation();void completeHuman()}
doneButton.addEventListener('touchstart',function(event){event.stopPropagation()},{passive:true});
doneButton.addEventListener('touchend',consumeDoneGesture,{passive:false});
doneButton.addEventListener('click',consumeDoneGesture);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden'){void suspend()}else if(document.visibilityState==='visible'&&suspended&&!stopped){void suspendPromise.finally(()=>reconnect().catch(()=>status('Connection unavailable')))}});window.addEventListener('pagehide',function(){void suspend()});window.addEventListener('pageshow',function(event){if(event.persisted&&suspended&&!stopped)void suspendPromise.finally(()=>reconnect().catch(()=>status('Connection unavailable')))});window.addEventListener('orientationchange',scheduleOrientationReset);
resetKeyboard();resetViewTransform();armKeyboardFallback();void connect('claim').catch(function(){closePeer();if(relayState==='unavailable')status('Secure relay unavailable');else status('Session unavailable or connection failed');stopped=true});
})();`;
}
function webRtcPageHtml(nonce, completionCapability) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Human takeover</title>
<style nonce="${nonce}">
:root{font-family:system-ui,-apple-system,sans-serif;color-scheme:dark}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}main{position:fixed;inset:0;background:#000}.screen{position:absolute;z-index:0;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none}.screen video{position:relative;z-index:0;width:100%;height:100%;display:block;object-fit:contain;touch-action:none;background:#000;opacity:0;transform-origin:50% 50%;will-change:transform}.top{position:absolute;z-index:2147483647;transform:translateZ(0);left:max(10px,env(safe-area-inset-left));right:max(10px,env(safe-area-inset-right));top:max(10px,env(safe-area-inset-top));display:flex;gap:8px;align-items:center;pointer-events:none}.status{font-size:12px;padding:6px 9px;border-radius:999px;background:rgba(0,0,0,.62);color:#fff;backdrop-filter:blur(8px);max-width:58vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.zoom,.aim,.keyboard-open,.keyboard-backspace{pointer-events:auto;min-height:40px;padding:7px 11px;border:0;border-radius:999px;background:rgba(0,0,0,.62);color:#fff;font:600 14px system-ui,-apple-system,sans-serif;backdrop-filter:blur(8px)}.zoom{margin-left:auto;min-width:48px}.aim{display:none}.keyboard-open,.keyboard-backspace{display:none}.done{pointer-events:auto;touch-action:manipulation;min-height:40px;padding:7px 14px;border:0;border-radius:999px;background:rgba(255,255,255,.92);color:#111;font:600 14px system-ui,-apple-system,sans-serif}.aim-crosshair{display:none;position:absolute;z-index:2147483646;left:50%;top:50%;width:32px;height:32px;transform:translate(-50%,-50%);pointer-events:none}.aim-crosshair:before,.aim-crosshair:after{content:'';position:absolute;background:rgba(255,255,255,.95);box-shadow:0 0 2px #000}.aim-crosshair:before{left:15px;top:0;width:2px;height:32px}.aim-crosshair:after{left:0;top:15px;width:32px;height:2px}.aim-tap{display:none;position:absolute;z-index:2147483647;left:50%;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%);pointer-events:auto;min-height:48px;min-width:120px;border:0;border-radius:999px;background:rgba(255,255,255,.94);color:#111;font:700 15px system-ui,-apple-system,sans-serif}.keyboard{position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:.001;border:0;padding:0;font-size:16px;pointer-events:none}
</style>
</head>
<body><main>
<div class="screen"><video id="video" autoplay playsinline webkit-playsinline muted></video></div>
<div id="aim-crosshair" class="aim-crosshair" aria-hidden="true"></div><button id="aim-tap" class="aim-tap" type="button" aria-label="Tap aimed remote point">Tap</button>
<div class="top"><span id="status" class="status">Connecting…</span><button id="zoom" class="zoom" type="button" aria-label="Zoom remote view" aria-pressed="false">1×</button><button id="aim" class="aim" type="button" aria-label="Aim precise remote tap" aria-pressed="false">Aim</button><button id="keyboard-open" class="keyboard-open" type="button" aria-label="Open keyboard" aria-pressed="false">⌨︎</button><button id="keyboard-backspace" class="keyboard-backspace" type="button" aria-label="Backspace">⌫</button><button id="done" class="done" data-completion="${completionCapability}">Done</button></div>
<textarea id="keyboard" class="keyboard" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Remote keyboard"></textarea>
</main>
<script nonce="${nonce}" src="/takeover/webrtc-client.js" defer></script>
</body></html>`;
}
const ALLOW_ALL_WEBRTC_INPUT = Object.freeze({
    tap: true,
    scroll: true,
    text: true,
    key: true
});
export class TakeoverBroker {
    browser;
    config;
    nativeRuntime;
    webRtcRuntime;
    hooks;
    sessions;
    publicOrigin;
    nativeOnlySessions = new Map();
    webRtcOnlySessions = new Map();
    nativeTargetProcessIds = new Map();
    nativeTargetWindowIds = new Map();
    webRtcTargetProcessIds = new Map();
    webRtcTargetWindowIds = new Map();
    webRtcInputPolicies = new Map();
    completionDelivered = new Set();
    completionGraceMs;
    // A Safari page lifecycle suspend must never revoke the peer while its answer is still being built.
    webRtcConnectInFlight = new Map();
    constructor(browser, config, nativeRuntime, webRtcRuntime, hooks = {}) {
        this.browser = browser;
        this.config = config;
        this.nativeRuntime = nativeRuntime;
        this.webRtcRuntime = webRtcRuntime;
        this.hooks = hooks;
        this.completionGraceMs = config.completionGraceMs ?? config.ttlMs;
        this.sessions = new TakeoverSessionManager(config.ttlMs, undefined, undefined, undefined, config.reconnectIdleMs ?? 5_000, this.completionGraceMs);
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
    createNativeLink(intervention, principalBinding, target) {
        if (!this.nativeRuntime || !this.config.enabled || !this.config.publicBaseUrl || !principalBinding)
            return undefined;
        if (target && (!Number.isSafeInteger(target.processId) || target.processId < 1
            || (target.windowId !== undefined && (!Number.isSafeInteger(target.windowId) || target.windowId < 1))))
            return undefined;
        const locator = this.sessions.ensure(intervention.id, intervention.epoch, principalBinding);
        if (this.webRtcOnlySessions.has(locator.id))
            return undefined;
        for (const [sessionId, currentIntervention] of this.nativeOnlySessions) {
            if (currentIntervention === intervention.id && sessionId !== locator.id) {
                this.nativeOnlySessions.delete(sessionId);
                this.nativeTargetProcessIds.delete(sessionId);
                this.nativeTargetWindowIds.delete(sessionId);
            }
        }
        this.nativeOnlySessions.set(locator.id, intervention.id);
        if (target) {
            this.nativeTargetProcessIds.set(locator.id, target.processId);
            if (target.windowId !== undefined)
                this.nativeTargetWindowIds.set(locator.id, target.windowId);
        }
        const expiryCleanup = setTimeout(() => {
            this.nativeOnlySessions.delete(locator.id);
            this.nativeTargetProcessIds.delete(locator.id);
            this.nativeTargetWindowIds.delete(locator.id);
        }, this.config.ttlMs + 1_000);
        expiryCleanup.unref();
        return new URL(`/takeover/${encodeURIComponent(locator.id)}`, this.config.publicBaseUrl).toString();
    }
    createWebRtcLink(intervention, principalBinding, target, inputPolicy) {
        if (!this.webRtcRuntime || !this.config.enabled || !this.config.publicBaseUrl || !principalBinding)
            return undefined;
        if (target && (!Number.isSafeInteger(target.processId) || target.processId < 1
            || (target.windowId !== undefined && (!Number.isSafeInteger(target.windowId) || target.windowId < 1))))
            return undefined;
        const normalizedInputPolicy = normalizeWebRtcInputPolicy(inputPolicy ?? ALLOW_ALL_WEBRTC_INPUT);
        if (!normalizedInputPolicy)
            return undefined;
        const locator = this.sessions.ensure(intervention.id, intervention.epoch, principalBinding);
        if (this.nativeOnlySessions.has(locator.id))
            return undefined;
        for (const [sessionId, currentIntervention] of this.webRtcOnlySessions) {
            if (currentIntervention === intervention.id && sessionId !== locator.id) {
                // A prior session can exist here only after its mutable media/input lease expired or was
                // revoked by a newer epoch. Keep the route marker until its bounded completion grace ends,
                // but drop all target/input metadata immediately so it cannot regain Human input authority.
                this.webRtcTargetProcessIds.delete(sessionId);
                this.webRtcTargetWindowIds.delete(sessionId);
                this.webRtcInputPolicies.delete(sessionId);
            }
        }
        const existingPolicy = this.webRtcInputPolicies.get(locator.id);
        if (existingPolicy && !sameWebRtcInputPolicy(existingPolicy, normalizedInputPolicy))
            return undefined;
        this.webRtcOnlySessions.set(locator.id, intervention.id);
        this.webRtcInputPolicies.set(locator.id, normalizedInputPolicy);
        if (target) {
            this.webRtcTargetProcessIds.set(locator.id, target.processId);
            if (target.windowId !== undefined)
                this.webRtcTargetWindowIds.set(locator.id, target.windowId);
        }
        const mediaExpiryCleanup = setTimeout(() => {
            // Media/input authority ends at ttlMs. Keep only the route marker needed to deliver a
            // completion-only capability during the bounded grace window. Session-manager checks keep
            // prepare/connect/input/reconnect fail-closed after the media lease expires.
            this.webRtcTargetProcessIds.delete(locator.id);
            this.webRtcTargetWindowIds.delete(locator.id);
            this.webRtcInputPolicies.delete(locator.id);
        }, this.config.ttlMs + 1_000);
        mediaExpiryCleanup.unref();
        const completionExpiryCleanup = setTimeout(() => {
            this.webRtcOnlySessions.delete(locator.id);
            this.webRtcTargetProcessIds.delete(locator.id);
            this.webRtcTargetWindowIds.delete(locator.id);
            this.webRtcInputPolicies.delete(locator.id);
            this.completionDelivered.delete(locator.id);
        }, this.config.ttlMs + this.completionGraceMs + 1_000);
        completionExpiryCleanup.unref();
        return new URL(`/takeover/${encodeURIComponent(locator.id)}`, this.config.publicBaseUrl).toString();
    }
    revokeForIntervention(interventionId) {
        this.sessions.revokeForIntervention(interventionId);
        this.forgetNativeOnlyIntervention(interventionId);
        this.forgetWebRtcOnlyIntervention(interventionId);
        if (this.nativeRuntime)
            void this.nativeRuntime.revokeForIntervention(interventionId).catch(() => undefined);
        if (this.webRtcRuntime)
            void this.webRtcRuntime.revokeForIntervention(interventionId).catch(() => undefined);
    }
    async revokeNativeForIntervention(interventionId) {
        this.sessions.revokeForIntervention(interventionId);
        this.forgetNativeOnlyIntervention(interventionId);
        await this.nativeRuntime?.revokeForIntervention(interventionId);
    }
    async revokeWebRtcForIntervention(interventionId) {
        this.sessions.revokeForIntervention(interventionId);
        this.forgetWebRtcOnlyIntervention(interventionId);
        await this.webRtcRuntime?.revokeForIntervention(interventionId);
    }
    async handle(request, boundPrincipal) {
        if (!this.config.enabled || !boundPrincipal)
            return json(404, { error: "not_found" });
        const url = new URL(request.url);
        if (url.pathname === "/takeover/webrtc-client.js") {
            if (request.method !== "GET" && request.method !== "HEAD")
                return json(405, { error: "method_not_allowed" });
            return new Response(request.method === "HEAD" ? null : webRtcClientScript(), {
                status: 200,
                headers: privateHeaders("text/javascript; charset=utf-8")
            });
        }
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
            let completionCapability;
            try {
                if (this.webRtcOnlySessions.has(pageMatch[1])) {
                    completionCapability = this.sessions.issueCompletionCapability(pageMatch[1], boundPrincipal);
                }
                else {
                    this.sessions.validateLocator(pageMatch[1], boundPrincipal);
                }
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
            const nonce = randomBytes(18).toString("base64url");
            const headers = new Headers(privateHeaders("text/html; charset=utf-8"));
            headers.set("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
            const html = completionCapability ? webRtcPageHtml(nonce, completionCapability) : pageHtml(nonce);
            return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
        }
        const apiMatch = /^\/takeover\/api\/(bootstrap|claim|reconnect|webrtc-prepare-claim|webrtc-prepare-reconnect|webrtc-connect|webrtc-diagnostics|webrtc-metrics|webrtc-suspend|frame|input|done|cancel|complete)\/([A-Za-z0-9-]{8,100})$/.exec(url.pathname);
        if (!apiMatch)
            return json(404, { error: "not_found" });
        const operation = apiMatch[1];
        const id = apiMatch[2];
        if (operation === "complete") {
            if (request.method !== "POST")
                return json(405, { error: "method_not_allowed" });
            if (!this.sameOriginMutation(request))
                return json(403, { error: "origin_not_allowed" });
            const completionCapability = this.readCompletionCapability(request.headers.get("x-mcp-takeover-completion"));
            if (!completionCapability)
                return json(404, { error: "takeover_unavailable" });
            const wasNative = this.nativeOnlySessions.has(id);
            const wasWebRtc = this.webRtcOnlySessions.has(id);
            let completion;
            try {
                completion = this.sessions.complete(id, completionCapability, boundPrincipal);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
            this.nativeOnlySessions.delete(id);
            this.webRtcOnlySessions.delete(id);
            this.nativeTargetProcessIds.delete(id);
            this.nativeTargetWindowIds.delete(id);
            this.webRtcTargetProcessIds.delete(id);
            this.webRtcTargetWindowIds.delete(id);
            this.webRtcInputPolicies.delete(id);
            try {
                if (wasNative)
                    await this.nativeRuntime?.revoke(id);
                if (wasWebRtc)
                    await this.webRtcRuntime?.revoke(id);
            }
            catch {
                return json(503, { error: "takeover_runtime_revoke_failed", revoked: true });
            }
            if (!this.completionDelivered.has(id)) {
                try {
                    await this.hooks.completed?.({
                        interventionId: completion.interventionId,
                        epoch: completion.epoch
                    });
                    this.completionDelivered.add(id);
                }
                catch {
                    return json(503, { error: "takeover_completion_handler_failed", revoked: true });
                }
            }
            return json(200, { done: true, alreadyDone: completion.alreadyCompleted });
        }
        const clientBinding = this.readClientBinding(request.headers.get("x-takeover-client"));
        if (!clientBinding)
            return json(404, { error: "takeover_unavailable" });
        if (operation === "webrtc-prepare-claim" || operation === "webrtc-prepare-reconnect") {
            if (!this.webRtcRuntime || !this.webRtcOnlySessions.has(id))
                return json(404, { error: "takeover_unavailable" });
            if (request.method !== "POST")
                return json(405, { error: "method_not_allowed" });
            if (!this.sameOriginMutation(request))
                return json(403, { error: "origin_not_allowed" });
            const reconnectHandle = operation === "webrtc-prepare-reconnect"
                ? this.readReconnectHandle(request.headers.get("x-mcp-takeover-reconnect"))
                : undefined;
            if (operation === "webrtc-prepare-reconnect" && !reconnectHandle)
                return json(404, { error: "takeover_unavailable" });
            const prepareStartedAt = Date.now();
            this.webRtcRuntime.recordDiagnostic({ stage: "broker.prepare.request" });
            let grant;
            try {
                grant = operation === "webrtc-prepare-claim"
                    ? this.sessions.claimClient(id, boundPrincipal, clientBinding)
                    : this.sessions.reconnectClient(id, boundPrincipal, reconnectHandle, clientBinding);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError) {
                    this.webRtcRuntime.recordDiagnostic({ stage: "broker.prepare.failure", durationMs: Date.now() - prepareStartedAt });
                    if (error.code === "TAKEOVER_CLIENT_ACTIVE")
                        return json(409, { error: "takeover_client_active" });
                    return json(404, { error: "takeover_unavailable" });
                }
                throw error;
            }
            const binding = webRtcBindingFromGrant(grant, this.webRtcTargetProcessIds.get(id), this.webRtcTargetWindowIds.get(id));
            try {
                const webrtcIce = await this.webRtcRuntime.prepare(binding);
                this.webRtcRuntime.recordDiagnostic({ stage: "broker.prepare.success", durationMs: Date.now() - prepareStartedAt });
                return json(200, {
                    ...this.publicGrant(grant),
                    webrtcIce,
                    inputPolicy: this.webRtcInputPolicy(id)
                });
            }
            catch (error) {
                this.webRtcRuntime.recordDiagnostic({ stage: "broker.prepare.failure", durationMs: Date.now() - prepareStartedAt });
                try {
                    this.sessions.releaseClientGeneration(id, boundPrincipal, clientBinding, binding.clientGeneration);
                }
                catch { }
                await this.webRtcRuntime.revoke(id).catch(() => undefined);
                if (error instanceof WebRtcTakeoverRuntimeError && error.code === "WEBRTC_RUNTIME_ALREADY_ACTIVE") {
                    return json(409, { error: "webrtc_runtime_already_active" });
                }
                return json(503, { error: "webrtc_ice_unavailable" });
            }
        }
        if (operation === "webrtc-connect") {
            if (!this.webRtcRuntime || !this.webRtcOnlySessions.has(id))
                return json(404, { error: "takeover_unavailable" });
            if (request.method !== "POST")
                return json(405, { error: "method_not_allowed" });
            if (!this.sameOriginMutation(request))
                return json(403, { error: "origin_not_allowed" });
            const connectStartedAt = Date.now();
            this.webRtcRuntime.recordDiagnostic({ stage: "broker.connect.request" });
            const capability = this.readCapability(request.headers.get("x-mcp-takeover-capability"), request.headers.get("authorization"));
            if (!capability)
                return json(404, { error: "takeover_unavailable" });
            let offer;
            try {
                offer = parseWebRtcOffer(await this.readBoundedJson(request, 128 * 1024));
            }
            catch {
                return json(400, { error: "webrtc_offer_invalid" });
            }
            let verified;
            try {
                verified = this.sessions.verify(id, capability, boundPrincipal, clientBinding);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
            const binding = {
                takeoverSessionId: verified.id,
                interventionId: verified.interventionId,
                epoch: verified.epoch,
                principalBinding: verified.principalBinding,
                clientBinding: verified.clientBinding,
                clientGeneration: verified.clientGeneration,
                expiresAt: verified.expiresAt,
                ...(this.webRtcTargetProcessIds.has(id) ? { targetProcessId: this.webRtcTargetProcessIds.get(id) } : {}),
                ...(this.webRtcTargetWindowIds.has(id) ? { targetWindowId: this.webRtcTargetWindowIds.get(id) } : {})
            };
            let settleConnect;
            const connectInFlight = new Promise((resolve) => { settleConnect = resolve; });
            this.webRtcConnectInFlight.set(id, connectInFlight);
            try {
                const answer = await this.webRtcRuntime.start(binding, offer, this.webRtcHooks(binding));
                this.webRtcRuntime.recordDiagnostic({ stage: "broker.connect.success", durationMs: Date.now() - connectStartedAt });
                return json(200, { webrtc: answer });
            }
            catch (error) {
                this.webRtcRuntime.recordDiagnostic({ stage: "broker.connect.failure", durationMs: Date.now() - connectStartedAt });
                const runtimeCode = error instanceof WebRtcTakeoverRuntimeError ? error.code : "WEBRTC_RUNTIME_UNEXPECTED";
                const startStage = error instanceof WebRtcTakeoverRuntimeError ? error.startStage : undefined;
                const startReason = error instanceof WebRtcTakeoverRuntimeError ? error.startReason : undefined;
                const startSignalingState = error instanceof WebRtcTakeoverRuntimeError ? error.startSignalingState : undefined;
                const startEndCause = error instanceof WebRtcTakeoverRuntimeError ? error.startEndCause : undefined;
                const diagnosticStages = this.webRtcRuntime.diagnosticsSnapshot().events
                    .slice(-16)
                    .map((event) => event.stage)
                    .join(",");
                console.error(`[mcp-execution-handoff] WebRTC connect failed code=${runtimeCode}${startStage ? ` stage=${startStage}` : ""}${startReason ? ` reason=${startReason}` : ""}${startSignalingState ? ` signaling_state=${startSignalingState}` : ""}${startEndCause ? ` end_cause=${startEndCause}` : ""} diagnostics=${diagnosticStages || "none"}`);
                try {
                    this.sessions.releaseClientGeneration(id, boundPrincipal, clientBinding, binding.clientGeneration);
                }
                catch { }
                await this.webRtcRuntime.revoke(id).catch(() => undefined);
                return json(503, { error: "webrtc_runtime_unavailable", reconnectRequired: true });
            }
            finally {
                settleConnect();
                if (this.webRtcConnectInFlight.get(id) === connectInFlight)
                    this.webRtcConnectInFlight.delete(id);
            }
        }
        if (operation === "webrtc-diagnostics") {
            if (!this.webRtcRuntime || !this.webRtcOnlySessions.has(id))
                return json(404, { error: "takeover_unavailable" });
            if (request.method !== "POST")
                return json(405, { error: "method_not_allowed" });
            if (!this.sameOriginMutation(request))
                return json(403, { error: "origin_not_allowed" });
            const capability = this.readCapability(request.headers.get("x-mcp-takeover-capability"), request.headers.get("authorization"));
            if (!capability)
                return json(404, { error: "takeover_unavailable" });
            try {
                this.sessions.verify(id, capability, boundPrincipal, clientBinding);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
            let event;
            try {
                event = parseBrowserWebRtcDiagnosticEvent(await this.readBoundedJson(request, 512));
            }
            catch {
                return json(400, { error: "webrtc_diagnostics_invalid" });
            }
            if (!event)
                return json(400, { error: "webrtc_diagnostics_invalid" });
            this.webRtcRuntime.recordDiagnostic(event);
            return json(200, { accepted: true });
        }
        if (operation === "webrtc-metrics") {
            if (!this.webRtcRuntime || !this.webRtcOnlySessions.has(id))
                return json(404, { error: "takeover_unavailable" });
            if (request.method !== "POST")
                return json(405, { error: "method_not_allowed" });
            if (!this.sameOriginMutation(request))
                return json(403, { error: "origin_not_allowed" });
            const capability = this.readCapability(request.headers.get("x-mcp-takeover-capability"), request.headers.get("authorization"));
            if (!capability)
                return json(404, { error: "takeover_unavailable" });
            try {
                this.sessions.verify(id, capability, boundPrincipal, clientBinding);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
            let sample;
            try {
                sample = parseWebRtcLatencySample(await this.readBoundedJson(request, 1_024));
            }
            catch {
                return json(400, { error: "webrtc_metrics_invalid" });
            }
            if (!sample)
                return json(400, { error: "webrtc_metrics_invalid" });
            this.webRtcRuntime.recordLatency(id, sample);
            return json(200, { accepted: true });
        }
        if (operation === "webrtc-suspend") {
            if (!this.webRtcRuntime || !this.webRtcOnlySessions.has(id))
                return json(404, { error: "takeover_unavailable" });
            if (request.method !== "POST")
                return json(405, { error: "method_not_allowed" });
            if (!this.sameOriginMutation(request))
                return json(403, { error: "origin_not_allowed" });
            const capability = this.readCapability(request.headers.get("x-mcp-takeover-capability"), request.headers.get("authorization"));
            if (!capability)
                return json(404, { error: "takeover_unavailable" });
            const connectInFlight = this.webRtcConnectInFlight.get(id);
            // pagehide/visibilitychange may race the initial connect on iOS Safari. Drain answer creation first.
            if (connectInFlight)
                await connectInFlight;
            let grant;
            try {
                grant = this.sessions.verify(id, capability, boundPrincipal, clientBinding);
                this.sessions.releaseClientGeneration(id, boundPrincipal, clientBinding, grant.clientGeneration);
            }
            catch (error) {
                if (error instanceof TakeoverSessionError)
                    return json(404, { error: "takeover_unavailable" });
                throw error;
            }
            try {
                await this.webRtcRuntime.revoke(id);
            }
            catch {
                return json(503, { error: "webrtc_runtime_revoke_failed", suspended: true });
            }
            return json(200, { suspended: true, reconnectRequired: true });
        }
        if (operation === "bootstrap") {
            if (this.nativeOnlySessions.has(id) || this.webRtcOnlySessions.has(id))
                return json(404, { error: "takeover_unavailable" });
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
            if (this.webRtcOnlySessions.has(id))
                return json(404, { error: "takeover_unavailable" });
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
                    ? await this.nativeRuntime.begin(nativeBindingFromGrant(grant, this.nativeTargetProcessIds.get(id), this.nativeTargetWindowIds.get(id)), endpoint)
                    : undefined;
                return json(200, this.publicGrant(grant, native));
            }
            catch (error) {
                if (error instanceof NativeTakeoverRuntimeError && error.code === "NATIVE_BOOTSTRAP_ALREADY_ISSUED") {
                    return json(409, { error: "native_bootstrap_already_issued" });
                }
                this.sessions.revoke(id);
                this.nativeOnlySessions.delete(id);
                this.nativeTargetProcessIds.delete(id);
                this.nativeTargetWindowIds.delete(id);
                await this.nativeRuntime?.revoke(id).catch(() => undefined);
                return json(503, { error: "native_runtime_unavailable" });
            }
        }
        const capability = this.readCapability(request.headers.get("x-mcp-takeover-capability"), request.headers.get("authorization"));
        if (!capability)
            return json(404, { error: "takeover_unavailable" });
        if ((this.nativeOnlySessions.has(id) || this.webRtcOnlySessions.has(id)) && (operation === "frame" || operation === "input")) {
            return json(404, { error: "takeover_unavailable" });
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
            this.nativeOnlySessions.delete(id);
            this.webRtcOnlySessions.delete(id);
            this.nativeTargetProcessIds.delete(id);
            this.nativeTargetWindowIds.delete(id);
            this.webRtcTargetProcessIds.delete(id);
            this.webRtcTargetWindowIds.delete(id);
            this.webRtcInputPolicies.delete(id);
            try {
                await this.nativeRuntime?.revoke(id);
            }
            catch {
                return json(503, { error: "native_runtime_revoke_failed", revoked: true });
            }
            try {
                await this.webRtcRuntime?.revoke(id);
            }
            catch {
                return json(503, { error: "webrtc_runtime_revoke_failed", revoked: true });
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
    webRtcHooks(binding) {
        return {
            beginInput: (input) => {
                const inputPolicy = this.webRtcInputPolicy(binding.takeoverSessionId);
                if (!inputAllowed(inputPolicy, input.kind)) {
                    throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Human input is not allowed for this takeover");
                }
                const use = this.sessions.beginBoundUse(binding.takeoverSessionId, binding.principalBinding, binding.clientBinding, binding.clientGeneration);
                return () => this.sessions.endUse(binding.takeoverSessionId, binding.principalBinding, binding.clientBinding, use.clientGeneration);
            },
            disconnected: () => {
                try {
                    this.sessions.releaseClientGeneration(binding.takeoverSessionId, binding.principalBinding, binding.clientBinding, binding.clientGeneration);
                }
                catch {
                    // A newer/revoked generation already fences this transport.
                }
            }
        };
    }
    forgetNativeOnlyIntervention(interventionId) {
        for (const [sessionId, currentIntervention] of this.nativeOnlySessions) {
            if (currentIntervention === interventionId) {
                this.nativeOnlySessions.delete(sessionId);
                this.nativeTargetProcessIds.delete(sessionId);
                this.nativeTargetWindowIds.delete(sessionId);
            }
        }
    }
    forgetWebRtcOnlyIntervention(interventionId) {
        for (const [sessionId, currentIntervention] of this.webRtcOnlySessions) {
            if (currentIntervention === interventionId) {
                this.webRtcOnlySessions.delete(sessionId);
                this.webRtcTargetProcessIds.delete(sessionId);
                this.webRtcTargetWindowIds.delete(sessionId);
                this.webRtcInputPolicies.delete(sessionId);
                this.completionDelivered.delete(sessionId);
            }
        }
    }
    webRtcInputPolicy(sessionId) {
        const policy = this.webRtcInputPolicies.get(sessionId) ?? ALLOW_ALL_WEBRTC_INPUT;
        return { ...policy };
    }
    publicGrant(grant, native, webrtc) {
        return {
            capability: grant.capability,
            reconnectHandle: grant.reconnectHandle,
            expiresAt: grant.expiresAt,
            clientGeneration: grant.clientGeneration,
            ...(native ? { native } : {}),
            ...(webrtc ? { webrtc } : {})
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
    readCompletionCapability(value) {
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
function normalizeWebRtcInputPolicy(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    const keys = ["tap", "scroll", "text", "key"];
    if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) {
        return undefined;
    }
    for (const key of keys)
        if (typeof record[key] !== "boolean")
            return undefined;
    return { tap: value.tap, scroll: value.scroll, text: value.text, key: value.key };
}
function sameWebRtcInputPolicy(left, right) {
    return left.tap === right.tap && left.scroll === right.scroll && left.text === right.text && left.key === right.key;
}
function inputAllowed(policy, kind) {
    if (kind === "pointer_button")
        return policy.tap;
    return policy[kind];
}
//# sourceMappingURL=broker.js.map