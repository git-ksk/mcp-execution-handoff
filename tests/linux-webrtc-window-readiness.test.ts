import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LinuxWindowReadinessError,
  waitForLinuxWindowReadiness,
  type LinuxWindowReadinessSample
} from "../experiments/linux-webrtc-host/scripts/window-readiness.ts";

function sequence(samples: LinuxWindowReadinessSample[]) {
  let index = 0;
  let clock = 0;
  return {
    observe() {
      const sample = samples[Math.min(index, samples.length - 1)];
      index += 1;
      if (!sample) throw new Error("sample sequence is empty");
      return sample;
    },
    now: () => clock,
    sleep: async (ms: number) => { clock += Math.max(1, ms); },
    calls: () => index
  };
}

const ready = (ids: string[], title = "Handoff Linux Acceptance"): LinuxWindowReadinessSample => ({
  processAlive: true,
  candidateIds: ids,
  candidateTitle: ids.length === 1 ? title : undefined,
  pageInteractive: true
});

test("Linux acceptance readiness carries forward one stable exact window id", async () => {
  const source = sequence([ready(["101"]), ready(["101"])]);
  const id = await waitForLinuxWindowReadiness({
    ...source,
    expectedTitle: "Handoff Linux Acceptance",
    timeoutMs: 100,
    pollMs: 1,
    stableSamples: 2
  });
  assert.equal(id, "101");
  assert.equal(source.calls(), 2);
});

test("transient exact-one to zero does not become a false success and stability restarts", async () => {
  const source = sequence([
    ready(["101"]),
    ready([]),
    ready(["101"]),
    ready(["101"])
  ]);
  const id = await waitForLinuxWindowReadiness({
    ...source,
    expectedTitle: "Handoff Linux Acceptance",
    timeoutMs: 100,
    pollMs: 1,
    stableSamples: 2
  });
  assert.equal(id, "101");
  assert.equal(source.calls(), 4);
});

test("ambiguous windows are never selected and timeout reports only bounded readiness facts", async () => {
  const source = sequence([ready(["101", "202"])]);
  await assert.rejects(
    waitForLinuxWindowReadiness({
      ...source,
      expectedTitle: "Handoff Linux Acceptance",
      timeoutMs: 3,
      pollMs: 1,
      stableSamples: 2
    }),
    (error: unknown) => {
      assert.ok(error instanceof LinuxWindowReadinessError);
      assert.equal(error.code, "READINESS_TIMEOUT");
      assert.equal(error.diagnostics.candidateCount, 2);
      assert.equal(error.diagnostics.titleMatched, false);
      assert.doesNotMatch(error.message, /101|202/);
      return true;
    }
  );
});

test("process exit during readiness fails deterministically without browser stderr", async () => {
  const source = sequence([{ processAlive: false, candidateIds: [], pageInteractive: false }]);
  await assert.rejects(
    waitForLinuxWindowReadiness({
      ...source,
      expectedTitle: "Handoff Linux Acceptance",
      timeoutMs: 100,
      pollMs: 1
    }),
    (error: unknown) => {
      assert.ok(error instanceof LinuxWindowReadinessError);
      assert.equal(error.code, "PROCESS_EXITED");
      assert.match(error.message, /candidates=0/);
      assert.match(error.message, /process_alive=no/);
      return true;
    }
  );
});

test("wrong title or non-interactive page cannot satisfy exact-window readiness", async () => {
  const wrongTitle = ready(["101"], "Other Window");
  const notInteractive: LinuxWindowReadinessSample = {
    processAlive: true,
    candidateIds: ["101"],
    candidateTitle: "Handoff Linux Acceptance",
    pageInteractive: false
  };
  const source = sequence([wrongTitle, notInteractive, ready(["101"]), ready(["101"])]);
  const id = await waitForLinuxWindowReadiness({
    ...source,
    expectedTitle: "Handoff Linux Acceptance",
    timeoutMs: 100,
    pollMs: 1,
    stableSamples: 2
  });
  assert.equal(id, "101");
  assert.equal(source.calls(), 4);
});


test("Linux real-browser acceptance carries the accepted exact window into WebRTC target binding", () => {
  const source = readFileSync("experiments/linux-webrtc-host/scripts/acceptance.mts", "utf8");
  assert.match(source, /waitForLinuxWindowReadiness/);
  assert.match(source, /timeoutMs:\s*45_000/);
  assert.match(source, /stableSamples:\s*2/);
  assert.match(source, /targetWindowId:\s*acceptedWindowIdNumber/);
  assert.match(source, /waitForOpenboxReady\(openbox, xEnv\)/);
  assert.match(source, /_NET_SUPPORTING_WM_CHECK/);
  assert.match(source, /_NET_WM_NAME/);
  assert.doesNotMatch(source, /openbox\.once\("error"[\s\S]{0,160}setTimeout\(resolve, 250\)/);
  assert.match(source, /kind: "pointer_button", button: "primary", state: "down"/);
  assert.match(source, /kind: "pointer_button", button: "primary", state: "up"/);
  assert.doesNotMatch(source, /critical\.send\(JSON\.stringify\(\{ kind: "tap"/);
  const visibleSearches = source.match(/xdotool[\s\S]{0,120}search[\s\S]{0,120}--onlyvisible/g) ?? [];
  assert.equal(visibleSearches.length, 1, "window readiness must use one coherent polling observation path");
  assert.doesNotMatch(source, /assert\.equal\(windowIds\.length,\s*1\)/);
  assert.doesNotMatch(source, /chromeError/);
});
