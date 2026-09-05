import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import type { ExperimentalWebSocketWindowSurface } from "../src/experimental/websocket-window-handoff.js";
import { ExperimentalWebSocketBrowserHandoff } from "../src/experimental/websocket-browser-handoff.js";

const ORIGIN = "https://takeover.example";
const PRINCIPAL = "browser-principal-binding";
const TARGET = Object.freeze({ processId: 2468, windowId: 1357 });
const POLICY = Object.freeze({ tap: true, scroll: true, text: true, key: true });

function fixture() {
  const surface: ExperimentalWebSocketWindowSurface = {
    async captureExactWindow() {
      return { data: Buffer.from("frame"), width: 640, height: 480, mimeType: "image/jpeg" };
    },
    async tapExactWindow() {},
    async scrollExactWindow() {},
    async insertExactWindowText() {},
    async pressExactWindowKey() {}
  };
  return new ExperimentalWebSocketBrowserHandoff({
    takeover: {
      enabled: true,
      publicBaseUrl: ORIGIN,
      ttlMs: 60_000,
      reconnectIdleMs: 250
    },
    allowedOrigins: [ORIGIN],
    surface,
    frameIntervalMs: 50
  });
}

function start(handoff: ExperimentalWebSocketBrowserHandoff): string {
  return handoff.start({
    intervention: { id: "generic-browser-wss", epoch: 4 },
    principalBinding: PRINCIPAL,
    target: TARGET,
    inputPolicy: POLICY
  });
}

test("Generic Browser WSS serves a principal-bound Handoff-owned browser page without target identity", async () => {
  const handoff = fixture();
  const locator = start(handoff);
  const path = new URL(locator).pathname;

  const page = await handoff.handle(new Request(`${ORIGIN}${path}`), PRINCIPAL);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(
    page.headers.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  );
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src blob:/);
  assert.match(csp, /connect-src 'self' wss:\/\/takeover\.example/);
  assert.match(csp, /frame-ancestors 'none'/);

  const html = await page.text();
  assert.match(html, /new WebSocket\(target,body\.protocols\)/);
  assert.match(html, /browserWssCloseIsReconnectable\(event\.code\)/);
  assert.match(html, /function onWebSocketDisconnected\(ws,event\)/);
  assert.match(html, /function onInitialWebSocketConnectFailure\(\)/);
  assert.match(html, /browserWssReconnectMaxAttempts/);
  assert.match(html, /setStatus\('Reconnecting…'\)/);
  assert.match(html, /socket!==ws/);
  assert.match(html, /void connect\(\)\.catch\(\(\)=>onInitialWebSocketConnectFailure\(\)\)/);
  assert.match(html, /data-tap="1" data-scroll="1" data-text="1" data-key="1"/);
  assert.match(html, /app\.dataset\.tap==='1'/);
  assert.doesNotMatch(html, /const policy=\{\"/);
  assert.match(html, /body\.protocols\.length!==2/);
  assert.match(html, /0x484f4631/);
  assert.match(html, /image\/jpeg/);
  assert.match(html, /image\/png/);
  assert.match(html, /kind:'tap'/);
  assert.match(html, /aria-label="Aim precise remote tap"/);
  assert.match(html, /id="aim-crosshair"/);
  assert.match(html, /function setAimMode\(enabled\)/);
  assert.match(html, /if\(aimMode&&viewScale<MAX_VIEW_SCALE\)applyViewTransform\(MAX_VIEW_SCALE/);
  assert.match(html, /function tapAimTarget\(\)/);
  assert.match(html, /if\(aimMode\)\{event\.preventDefault\(\);return\}/);
  assert.match(html, /localPan:aimMode\|\|viewScale>1/);
  assert.match(html, /active\.localPan&&moved>8/);
  assert.match(html, /window\.addEventListener\('orientationchange',scheduleOrientationReset\)/);
  assert.match(html, /kind:'scroll'/);
  assert.match(html, /const browserScrollDeltaY=/);
  assert.match(html, /browserPhysicalSwipeScrollDelta\(dy\)/);
  assert.doesNotMatch(html, /Math\.round\(dy\*3\)/);
  assert.match(html, /kind:'text'/);
  assert.match(html, /kind:'key'/);
  assert.match(html, /maxlength="512"/);
  assert.match(html, /let keyboardMirror=''/);
  assert.match(html, /function resetKeyboardSession\(\)/);
  assert.match(html, /function sendKeyboardDelta\(current,inputType\)/);
  assert.match(html, /browserTextReplacementDelta\(keyboardMirror,current\)/);
  assert.match(html, /keyboardMirror=current/);
  assert.match(html, /pendingKeyTimer=setTimeout\(\(\)=>\{pendingKeyTimer=0;if\(compositionPhase==='idle'\)send\(\{kind:'key',key\}\)\},250\)/);
  assert.match(html, /keyboard\.addEventListener\('input',[\s\S]*clearPendingKeyboardKey\(\)/);
  assert.match(html, /compositionPhase='idle'/);
  assert.match(html, /browserImeKeyboardEventIsCompositionControlled\(compositionPhase,event\.isComposing,Number\(event\.keyCode\)\|\|0\)/);
  assert.match(html, /keyboard\.addEventListener\('input'/);
  assert.match(html, /inputType==='insertCompositionText'\|\|inputType==='deleteCompositionText'/);
  assert.match(html, /inputType==='insertFromComposition'/);
  assert.match(html, /sendKeyboardDelta\(keyboard\.value,inputType\)/);
  assert.doesNotMatch(html, /suppressKeyboardInput|suppressTrailingKeyboardInput|settleKeyboardComposition/);
  assert.doesNotMatch(html, /keyboard\.addEventListener\('beforeinput'/);
  assert.match(html, /kind==='editableRegions'/);
  assert.match(html, /applyEditableRegions/);
  assert.match(html, /pointIsEditable/);
  assert.match(html, /if\(keyboardMode\)\{focusRequested=true;focusKeyboard\(\);focusActive=document\.activeElement===keyboard\}/);
  assert.doesNotMatch(html, /if\(active\.editable\).*focusKeyboard/);
  assert.match(html, /client_tap_editable_predicted/);
  assert.match(html, /client_tap_editable_not_predicted/);
  assert.match(html, /client_keyboard_focus_requested/);
  assert.match(html, /client_keyboard_focus_active/);
  assert.match(html, /client_keyboard_focus_inactive/);
  assert.match(html, /client_editable_regions_available/);
  assert.match(html, /client_first_frame/);
  assert.match(html, /document\.activeElement===keyboard/);
  assert.doesNotMatch(html, /diagnostic\([^)]*(?:text|value|processId|windowId)/);
  assert.match(html, /setKeyboardMode\(!keyboardMode\)/);
  assert.match(html, /send\(\{kind:'done'\}\)/);
  assert.match(html, /Done\. Return for verification\./);
  assert.doesNotMatch(html, /RTCPeerConnection|ICE|TURN|STUN|DataChannel/);
  assert.doesNotMatch(html, /targetProcessId|targetWindowId|processId|windowId/);
  assert.doesNotMatch(html, new RegExp(String(TARGET.processId)));
  assert.doesNotMatch(html, new RegExp(String(TARGET.windowId)));
  assert.doesNotMatch(html, new RegExp(PRINCIPAL));

  const missingPrincipal = await handoff.handle(new Request(`${ORIGIN}${path}`), undefined);
  assert.equal(missingPrincipal.status, 404);
  const wrongPrincipal = await handoff.handle(new Request(`${ORIGIN}${path}`), "wrong-principal");
  assert.equal(wrongPrincipal.status, 404);
  handoff.revoke("generic-browser-wss");
});

test("Generic Browser WSS emits syntactically valid client JavaScript", async () => {
  const handoff = fixture();
  const locator = start(handoff);
  const html = await (await handoff.handle(new Request(locator), PRINCIPAL)).text();
  const match = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/);
  assert.ok(match?.[1]);
  assert.doesNotThrow(() => new vm.Script(match[1]));
  handoff.revoke("generic-browser-wss");
});

test("Generic Browser WSS Aim keeps pan local and emits only one explicit mapped tap", async () => {
  const handoff = fixture();
  const locator = start(handoff);
  const html = await (await handoff.handle(new Request(locator), PRINCIPAL)).text();
  const match = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/);
  assert.ok(match?.[1]);

  const listeners = new Map<string, (event: any) => void>();
  const app = { dataset: { tap: "1", scroll: "1", text: "1", key: "1" } };
  const screen = {
    addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, listener); },
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 240 }; }
  };
  const frame = {
    naturalWidth: 640,
    naturalHeight: 480,
    onload: null as (() => void) | null,
    src: "",
    style: {} as Record<string, string>
  };
  const status = { textContent: "" };
  const button = () => ({
    style: {} as Record<string, string>,
    disabled: false,
    textContent: "",
    onclick: null as (() => void) | null,
    setAttribute() {}
  });
  const zoom = button();
  const aim = button();
  const aimTap = button();
  const aimCrosshair = { style: {} as Record<string, string> };
  const keyboardOpen = button();
  const backspace = button();
  const done = button();
  const documentState: { activeElement: unknown } = { activeElement: null };
  const keyboard = {
    value: "",
    addEventListener() {},
    focus() { documentState.activeElement = keyboard; },
    blur() { documentState.activeElement = null; },
    setAttribute() {}
  };
  const document = {
    get activeElement() { return documentState.activeElement; },
    querySelector(selector: string) {
      return ({
        "#app": app,
        "#screen": screen,
        "#frame": frame,
        "#status": status,
        "#done": done,
        "#zoom": zoom,
        "#aim": aim,
        "#aim-tap": aimTap,
        "#aim-crosshair": aimCrosshair,
        "#keyboard-open": keyboardOpen,
        "#backspace": backspace,
        "#keyboard-input": keyboard
      } as Record<string, unknown>)[selector] ?? null;
    }
  };
  const sent: string[] = [];
  let socket: FakeWebSocket | undefined;
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    binaryType = "";
    onmessage?: (event: { data: unknown }) => void;
    onclose?: (event: { code: number }) => void;
    onerror?: () => void;
    constructor(_url: URL, _protocols: string[]) { socket = this; }
    send(value: string): void { sent.push(value); }
    close(): void { this.readyState = 3; }
  }
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const context = vm.createContext({
    document,
    location: { pathname: new URL(locator).pathname, href: locator, protocol: "https:" },
    fetch: async () => ({
      ok: true,
      async json() { return { protocols: ["mcp-handoff.websocket.v1", `mcp-handoff-auth.${"x".repeat(32)}`] }; }
    }),
    WebSocket: FakeWebSocket,
    URL,
    Blob,
    TextEncoder,
    performance: { now: () => 1 },
    queueMicrotask,
    setTimeout(callback: () => void, delay: number) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
    window: { addEventListener() {} }
  });
  new vm.Script(match[1]).runInContext(context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket?.onmessage?.({ data: JSON.stringify({ kind: "ready" }) });

  assert.equal(aim.style.display, "block");
  aim.onclick?.();
  assert.match(frame.style.transform ?? "", /^matrix\(4,0,0,4,/);
  assert.equal(aimCrosshair.style.display, "block");
  assert.equal(aimTap.style.display, "block");

  const preventDefault = () => {};
  listeners.get("pointerdown")?.({ pointerId: 1, clientX: 160, clientY: 120, preventDefault });
  listeners.get("pointermove")?.({ pointerId: 1, clientX: -1_000, clientY: 120, preventDefault });
  listeners.get("pointerup")?.({ pointerId: 1, clientX: -1_000, clientY: 120, preventDefault });
  assert.deepEqual(sent, [], "Aim pan must remain client-local");

  aimTap.onclick?.();
  assert.equal(sent.length, 1);
  const tapped = JSON.parse(sent[0]!) as { kind?: string; x?: number; y?: number };
  assert.equal(tapped.kind, "tap");
  assert.equal(tapped.x, 1, "Aim pan must let the fitted remote right edge reach the crosshair");
  assert.equal(tapped.y, 0.5);

  socket?.onclose?.({ code: 1006 });
  assert.equal(frame.style.transform, "none", "reconnect must reset local zoom/pan");
  assert.equal(aimCrosshair.style.display, "none", "reconnect must exit Aim");
  handoff.revoke("generic-browser-wss");
});

test("Generic Browser WSS page is not a target selector or generic remote desktop", async () => {
  const handoff = fixture();
  const locator = start(handoff);
  const html = await (await handoff.handle(new Request(locator), PRINCIPAL)).text();
  assert.doesNotMatch(html, /select target|choose window|desktop|display capture|screen share/i);
  assert.doesNotMatch(html, /document\.querySelector.*\.click\(|\.click\(\)/);
  // CSP nonces are random capability-neutral bytes; exclude them from semantic capability scans.
  const semanticHtml = html.replace(/nonce="[^"]+"/g, 'nonce=""');
  assert.doesNotMatch(semanticHtml, /chrome\.debugger|devtools|cdp/i);
  handoff.revoke("generic-browser-wss");
});

test("Generic Browser WSS keeps bootstrap authentication and target binding server-side", async () => {
  const handoff = fixture();
  const locator = start(handoff);
  const sessionId = new URL(locator).pathname.split("/").at(-1)!;

  const bootstrap = await handoff.handle(new Request(
    `${ORIGIN}/takeover/api/websocket-bootstrap/${sessionId}`,
    { method: "POST", headers: { origin: ORIGIN } }
  ), PRINCIPAL);
  assert.equal(bootstrap.status, 200);
  const body = await bootstrap.json() as { protocols?: string[] };
  assert.deepEqual(body.protocols?.slice(0, 1), ["mcp-handoff.websocket.v1"]);
  assert.match(body.protocols?.[1] ?? "", /^mcp-handoff-auth\.[A-Za-z0-9_-]{32,128}$/);
  assert.equal(JSON.stringify(body).includes(PRINCIPAL), false);
  assert.equal(JSON.stringify(body).includes(String(TARGET.processId)), false);
  assert.equal(JSON.stringify(body).includes(String(TARGET.windowId)), false);

  const wrongOrigin = await handoff.handle(new Request(
    `${ORIGIN}/takeover/api/websocket-bootstrap/${sessionId}`,
    { method: "POST", headers: { origin: "https://evil.example" } }
  ), PRINCIPAL);
  assert.equal(wrongOrigin.status, 403);
  handoff.revoke("generic-browser-wss");
});

test("Generic Browser WSS HEAD is content-free and POST cannot mutate the client page route", async () => {
  const handoff = fixture();
  const locator = start(handoff);
  const head = await handoff.handle(new Request(locator, { method: "HEAD" }), PRINCIPAL);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const post = await handoff.handle(new Request(locator, { method: "POST" }), PRINCIPAL);
  assert.equal(post.status, 405);
  handoff.revoke("generic-browser-wss");
});

test("Generic Browser WSS retries an abnormal close with a fresh bootstrap but never revives a policy close", async () => {
  const handoff = fixture();
  const locator = start(handoff);
  const html = await (await handoff.handle(new Request(locator), PRINCIPAL)).text();
  const match = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/);
  assert.ok(match?.[1]);

  const app = { dataset: { tap: "1", scroll: "1", text: "1", key: "1" } };
  const screen = {
    addEventListener() {},
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 240 }; }
  };
  const frame = { naturalWidth: 0, naturalHeight: 0, onload: null as (() => void) | null, src: "", style: {} as Record<string, string> };
  const status = { textContent: "" };
  const button = () => ({ style: {} as Record<string, string>, disabled: false, textContent: "", onclick: null as (() => void) | null, setAttribute() {} });
  const zoom = button();
  const aim = button();
  const aimTap = button();
  const aimCrosshair = { style: {} as Record<string, string> };
  const keyboardOpen = button();
  const backspace = button();
  const done = button();
  const keyboard = {
    value: "",
    addEventListener() {},
    focus() { documentState.activeElement = keyboard; },
    blur() { documentState.activeElement = null; }
  };
  const documentState: { activeElement: unknown } = { activeElement: null };
  const document = {
    get activeElement() { return documentState.activeElement; },
    querySelector(selector: string) {
      return ({
        "#app": app,
        "#screen": screen,
        "#frame": frame,
        "#status": status,
        "#done": done,
        "#zoom": zoom,
        "#aim": aim,
        "#aim-tap": aimTap,
        "#aim-crosshair": aimCrosshair,
        "#keyboard-open": keyboardOpen,
        "#backspace": backspace,
        "#keyboard-input": keyboard
      } as Record<string, unknown>)[selector] ?? null;
    }
  };
  const sockets: Array<{
    readyState: number;
    binaryType: string;
    onmessage?: (event: { data: unknown }) => void;
    onclose?: (event: { code: number }) => void;
    onerror?: () => void;
    send(value: string): void;
    close(): void;
  }> = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    binaryType = "";
    onmessage?: (event: { data: unknown }) => void;
    onclose?: (event: { code: number }) => void;
    onerror?: () => void;
    constructor(_url: URL, _protocols: string[]) { sockets.push(this); }
    send(_value: string): void {}
    close(): void { this.readyState = 3; }
  }
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let bootstrapCalls = 0;
  const context = vm.createContext({
    document,
    location: { pathname: new URL(locator).pathname, href: locator, protocol: "https:" },
    fetch: async () => {
      bootstrapCalls += 1;
      return {
        ok: true,
        async json() { return { protocols: ["mcp-handoff.websocket.v1", `mcp-handoff-auth.${"x".repeat(32)}`] }; }
      };
    },
    WebSocket: FakeWebSocket,
    URL,
    Blob,
    TextEncoder,
    performance: { now: () => 1 },
    queueMicrotask,
    setTimeout(callback: () => void, delay: number) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
    window: { addEventListener() {} }
  });
  new vm.Script(match[1]).runInContext(context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(bootstrapCalls, 1);
  assert.equal(sockets.length, 1);

  sockets[0]!.onmessage?.({ data: JSON.stringify({ kind: "ready" }) });
  assert.equal(status.textContent, "Human authority active");
  frame.src = "blob:stale-generation-1";
  frame.style.opacity = "1";
  sockets[0]!.onclose?.({ code: 1006 });
  assert.equal(status.textContent, "Reconnecting…");
  assert.equal(frame.style.opacity, "0", "disconnect must hide a stale decoded frame before reconnect");
  assert.equal(frame.src, "", "disconnect must detach the stale frame source");
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delay, 250);

  timers.shift()!.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(bootstrapCalls, 2);
  assert.equal(sockets.length, 2);
  sockets[1]!.onmessage?.({ data: JSON.stringify({ kind: "ready" }) });
  assert.equal(status.textContent, "Human authority active");
  frame.src = "blob:stale-generation-2";
  frame.style.opacity = "1";

  sockets[1]!.onclose?.({ code: 1008 });
  assert.equal(status.textContent, "Connection closed");
  assert.equal(frame.style.opacity, "0", "terminal close must not leave the last remote frame visible");
  assert.equal(frame.src, "", "terminal close must detach the stale frame source");
  assert.equal(timers.length, 0, "policy close must not schedule a new generation");
  handoff.revoke("generic-browser-wss");
});
