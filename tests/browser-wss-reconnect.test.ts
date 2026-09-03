import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  BROWSER_WSS_RECONNECT_MAX_ATTEMPTS,
  browserWssCloseIsReconnectable,
  browserWssReconnectClientSource,
  browserWssReconnectDelayMs
} from "../src/browser-takeover/browser-wss-reconnect.js";

test("Browser WSS reconnect policy is bounded to transport/lifecycle closes", () => {
  assert.equal(BROWSER_WSS_RECONNECT_MAX_ATTEMPTS, 5);
  assert.equal(browserWssCloseIsReconnectable(1001), true);
  assert.equal(browserWssCloseIsReconnectable(1006), true);
  for (const code of [1000, 1008, 1011, 1012, 1013, 3999]) {
    assert.equal(browserWssCloseIsReconnectable(code), false, `close ${code} must stay terminal`);
  }
  assert.deepEqual([0, 1, 2, 3, 4].map(browserWssReconnectDelayMs), [250, 500, 1000, 2000, 2000]);
  assert.equal(browserWssReconnectDelayMs(-1), 2000);
});

test("Browser WSS reconnect helpers emitted to the client preserve the reviewed policy", () => {
  const context = vm.createContext({ result: undefined });
  const source = `${browserWssReconnectClientSource()}result={max:browserWssReconnectMaxAttempts,codes:[browserWssCloseIsReconnectable(1000),browserWssCloseIsReconnectable(1001),browserWssCloseIsReconnectable(1006),browserWssCloseIsReconnectable(1008)],delays:[0,1,2,3,4].map(browserWssReconnectDelayMs)};`;
  new vm.Script(source).runInContext(context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), {
    max: 5,
    codes: [false, true, true, false],
    delays: [250, 500, 1000, 2000, 2000]
  });
});
