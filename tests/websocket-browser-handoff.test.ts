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
  assert.match(html, /data-tap="1" data-scroll="1" data-text="1" data-key="1"/);
  assert.match(html, /app\.dataset\.tap==='1'/);
  assert.doesNotMatch(html, /const policy=\{\"/);
  assert.match(html, /body\.protocols\.length!==2/);
  assert.match(html, /0x484f4631/);
  assert.match(html, /image\/jpeg/);
  assert.match(html, /image\/png/);
  assert.match(html, /kind:'tap'/);
  assert.match(html, /kind:'scroll'/);
  assert.match(html, /const browserScrollDeltaY=/);
  assert.match(html, /browserScrollDeltaY\(dy\)/);
  assert.doesNotMatch(html, /Math\.round\(dy\*3\)/);
  assert.match(html, /kind:'text'/);
  assert.match(html, /kind:'key'/);
  assert.match(html, /maxlength="512"/);
  assert.match(html, /let keyboardMirror=''/);
  assert.match(html, /function syncKeyboardValue\(\)/);
  assert.match(html, /function focusKeyboard\(\)\{if\(document\.activeElement===keyboard\)return/);
  assert.match(html, /const remove=mirrored\.length-prefix,insert=current\.slice\(prefix\)\.join\(''\)/);
  assert.match(html, /for\(let i=0;i<remove;i\+=1\).*Backspace/);
  assert.match(html, /compositionend.*queueMicrotask/);
  assert.match(html, /keyboard\.addEventListener\('input'/);
  assert.doesNotMatch(html, /compositionend',event=>.*event\.data.*kind:'text'/);
  assert.doesNotMatch(html, /insertReplacementText'.*kind:'text'/);
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

test("Generic Browser WSS page is not a target selector or generic remote desktop", async () => {
  const handoff = fixture();
  const locator = start(handoff);
  const html = await (await handoff.handle(new Request(locator), PRINCIPAL)).text();
  assert.doesNotMatch(html, /select target|choose window|desktop|display capture|screen share/i);
  assert.doesNotMatch(html, /document\.querySelector.*\.click\(|\.click\(\)/);
  assert.doesNotMatch(html, /chrome\.debugger|devtools|cdp/i);
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
