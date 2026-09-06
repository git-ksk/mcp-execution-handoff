import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  browserOperatorStatusClientSource,
  browserOperatorStatusCss,
  browserOperatorStatusMarkup
} from "../src/browser-takeover/operator-status-surface.js";

function harness() {
  const state = { hidden: false };
  const title = { textContent: "" };
  const detail = { textContent: "", style: { display: "" } };
  const document = {
    querySelector(selector: string) {
      if (selector === "#operator-state") return state;
      if (selector === "#operator-state-title") return title;
      if (selector === "#operator-state-detail") return detail;
      return null;
    }
  };
  const context = vm.createContext({ document });
  new vm.Script(browserOperatorStatusClientSource()).runInContext(context);
  return {
    state,
    title,
    detail,
    run(source: string) { return new vm.Script(source).runInContext(context); }
  };
}

test("Browser takeover operator status starts prominent and content-free before the first frame", () => {
  assert.match(browserOperatorStatusMarkup(), /id="operator-state"/);
  assert.match(browserOperatorStatusMarkup(), /aria-live="polite"/);
  assert.match(browserOperatorStatusCss(), /position:absolute/);
  const ui = harness();
  assert.equal(ui.state.hidden, false);
  assert.equal(ui.title.textContent, "Connecting…");
  assert.match(ui.detail.textContent, /Keep this page open/);
});

test("Browser takeover operator status hides for a live frame and returns during reconnect", () => {
  const ui = harness();
  ui.run("setBrowserOperatorStatus('Human authority active');setBrowserOperatorFrameVisible(true)");
  assert.equal(ui.state.hidden, true);
  ui.run("setBrowserOperatorFrameVisible(false);setBrowserOperatorStatus('Reconnecting…')");
  assert.equal(ui.state.hidden, false);
  assert.equal(ui.title.textContent, "Reconnecting…");
  assert.match(ui.detail.textContent, /reconnects/);
});

test("Browser takeover terminal status stays visible and tells the Human what to do next", () => {
  const ui = harness();
  ui.run("setBrowserOperatorFrameVisible(true);setBrowserOperatorStatus('Session unavailable')");
  assert.equal(ui.state.hidden, false);
  assert.equal(ui.title.textContent, "Session unavailable");
  assert.match(ui.detail.textContent, /Return to the requesting workflow/);
  assert.match(ui.detail.textContent, /fresh Human takeover/);
});

test("Browser takeover finishing and verification status stays visible after remote input is fenced", () => {
  const ui = harness();
  ui.run("setBrowserOperatorFrameVisible(true);setBrowserOperatorStatus('Verifying… Remote input is disabled.')");
  assert.equal(ui.state.hidden, false);
  assert.match(ui.detail.textContent, /Remote input is disabled/);
});
