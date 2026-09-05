import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MacOSWebSocketWindowSurface } from "../src/browser-takeover/macos-websocket-window-surface.js";
import { WindowWebSocketHandoffAdapter } from "../src/window-takeover/window-websocket-handoff-adapter.js";
import { WebSocketLatencyTracker } from "../src/browser-takeover/websocket-latency.js";

const macOSExecutionTest = process.platform === "darwin" ? test : test.skip;

function fakeHost(authorityLoss = false, helperExit = false) {
  const dir = mkdtempSync(join(tmpdir(), "handoff-macos-wss-"));
  const executable = join(dir, "fake-host");
  const stateFile = join(dir, "state.json");
  const inputsFile = join(dir, "inputs.json");
  const startsFile = join(dir, "starts.txt");
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require("node:fs");\nconst stateFile=${JSON.stringify(stateFile)};\nconst inputsFile=${JSON.stringify(inputsFile)};\nconst startsFile=${JSON.stringify(startsFile)};\nconst starts=fs.existsSync(startsFile)?Number(fs.readFileSync(startsFile,"utf8")):0;fs.writeFileSync(startsFile,String(starts+1));\nfs.writeFileSync(stateFile,JSON.stringify({env:process.env}));\nfs.writeFileSync(inputsFile,"[]");\nconst jpeg=Buffer.from([0xff,0xd8,1,2,0xff,0xd9]);\nconst payload=Buffer.allocUnsafe(4+jpeg.length);payload.writeUInt16BE(640,0);payload.writeUInt16BE(480,2);jpeg.copy(payload,4);\nconst record=Buffer.allocUnsafe(5+payload.length);record[0]=2;record.writeUInt32BE(payload.length,1);payload.copy(record,5);\nprocess.stdout.write(record);const timer=setInterval(()=>process.stdout.write(record),25);\nprocess.stderr.write("MCP_HANDOFF_CONTROL editable_regions=1000,2000,3000,1000\\n");\n${authorityLoss ? 'setTimeout(()=>{process.stderr.write("MCP_HANDOFF_DIAGNOSTIC capture_stage=authority_lost\\n");clearInterval(timer);process.exit(2)},90);' : ''}\n${helperExit ? 'setTimeout(()=>{clearInterval(timer);process.exit(2)},90);' : ''}\nlet pending="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{pending+=chunk;for(;;){const at=pending.indexOf("\\n");if(at<0)break;const line=pending.slice(0,at);pending=pending.slice(at+1);let command;try{command=JSON.parse(line)}catch{continue}if(command.kind==="stop"){clearInterval(timer);process.exit(0)}const kinds=JSON.parse(fs.readFileSync(inputsFile,"utf8"));kinds.push(command.kind);fs.writeFileSync(inputsFile,JSON.stringify(kinds));process.stderr.write("MCP_HANDOFF_DIAGNOSTIC input_stage=applied\\n")}});\n`);
  chmodSync(executable, 0o755);
  return {
    dir, executable, stateFile, inputsFile, startsFile,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

macOSExecutionTest("macOS WSS exact-window surface is JPEG-only without ICE STUN or TURN", async () => {
  const host = fakeHost();
  const latencyTracker = new WebSocketLatencyTracker();
  const surface = new MacOSWebSocketWindowSurface({
    hostExecutable: host.executable,
    helperTtlMs: 30_000,
    latencyTracker
  });
  try {
    const target = { processId: process.pid, windowId: 7331 };
    const frame = await surface.captureExactWindow(target);
    assert.equal(frame.mimeType, "image/jpeg");
    const startupLatency = latencyTracker.snapshot();
    assert.equal(startupLatency.capturePrepare.count, 1);
    assert.equal(startupLatency.captureFrameWait.count, 1);
    assert.equal(startupLatency.captureFrameWait.p50Ms, 0, "first valid helper JPEG must be reused instead of waiting for a second frame");
    assert.equal(frame.width, 640);
    assert.equal(frame.height, 480);
    await surface.tapExactWindow(target, 0.25, 0.75);
    await surface.insertExactWindowText(target, "fixture-text");
    await surface.pressExactWindowKey(target, "Backspace");
    await surface.pressExactWindowKey(target, "Enter");
    await surface.scrollExactWindow(target, 120);
    const state = JSON.parse(readFileSync(host.stateFile, "utf8")) as { env: Record<string, string> };
    assert.equal(state.env.TAKEOVER_WEBRTC_FRAME_FORMAT, "jpeg");
    assert.equal(state.env.TAKEOVER_WEBRTC_TARGET_PID, String(process.pid));
    assert.equal(state.env.TAKEOVER_WEBRTC_TARGET_WINDOW_ID, "7331");
    assert.equal(Object.keys(state.env).some((key) => /ICE|STUN|TURN|CLOUDFLARE/i.test(key)), false);
    assert.deepEqual(JSON.parse(readFileSync(host.inputsFile, "utf8")), ["tap", "text", "key", "key", "scroll"]);
    assert.deepEqual(surface.editableRegionsSnapshot(), [[1000, 2000, 3000, 1000]]);
    assert.equal(JSON.stringify(surface.diagnosticsSnapshot()).includes("fixture-text"), false);
  } finally {
    await surface.close();
    host.cleanup();
  }
});

macOSExecutionTest("macOS LocalAuthentication WSS is PID-only and rejects scroll or Enter locally", async () => {
  const host = fakeHost();
  const surface = new MacOSWebSocketWindowSurface({
    hostExecutable: host.executable,
    helperTtlMs: 30_000,
    initialSecureWindowPolicy: { mode: "macos_local_authentication" }
  });
  try {
    const target = { processId: process.pid };
    await surface.captureExactWindow(target);
    await surface.tapExactWindow(target, 0.5, 0.5);
    await surface.insertExactWindowText(target, "1234");
    await surface.pressExactWindowKey(target, "Backspace");
    await assert.rejects(surface.scrollExactWindow(target, 100), /does not permit scroll/);
    await assert.rejects(surface.pressExactWindowKey(target, "Enter"), /unsupported/);
    const state = JSON.parse(readFileSync(host.stateFile, "utf8")) as { env: Record<string, string> };
    assert.equal(state.env.TAKEOVER_WEBRTC_INITIAL_SECURE_WINDOW, "macos_local_authentication");
    assert.equal(state.env.TAKEOVER_WEBRTC_TARGET_WINDOW_ID, undefined);
    assert.deepEqual(JSON.parse(readFileSync(host.inputsFile, "utf8")), ["tap", "text", "key"]);
  } finally {
    await surface.close();
    host.cleanup();
  }
});

macOSExecutionTest("macOS WSS classifies exact-window disappearance as authority loss", async () => {
  const host = fakeHost(true);
  const surface = new MacOSWebSocketWindowSurface({ hostExecutable: host.executable, helperTtlMs: 30_000 });
  try {
    const target = { processId: process.pid, windowId: 7331 };
    await surface.captureExactWindow(target);
    await new Promise((resolve) => setTimeout(resolve, 130));
    await assert.rejects(surface.captureExactWindow(target));
    assert.equal(surface.diagnosticsSnapshot().authorityBoundary, "lost");
    assert.equal(surface.captureFailureDisposition(new Error("stopped")), "authority_lost");
  } finally {
    await surface.close();
    host.cleanup();
  }
});


macOSExecutionTest("macOS WSS successor lineage reuses one helper and passes only the reviewed lineage env", async () => {
  const host = fakeHost();
  const surface = new MacOSWebSocketWindowSurface({
    hostExecutable: host.executable,
    helperTtlMs: 30_000,
    successorWindowPolicy: { mode: "same_process", transitionWindowMs: 650 }
  });
  try {
    const target = { processId: process.pid, windowId: 7331 };
    await surface.captureExactWindow(target);
    await surface.captureExactWindow(target);
    const state = JSON.parse(readFileSync(host.stateFile, "utf8")) as { env: Record<string, string> };
    assert.equal(state.env.TAKEOVER_WEBRTC_WINDOW_LINEAGE, "same_process_successor");
    assert.equal(state.env.TAKEOVER_WEBRTC_WINDOW_LINEAGE_TRANSITION_MS, "650");
    assert.equal(readFileSync(host.startsFile, "utf8"), "1");
  } finally {
    await surface.close();
    host.cleanup();
  }
});

macOSExecutionTest("macOS WSS lineage helper lifecycle loss is terminal and never restarts the initial target", async () => {
  const host = fakeHost(false, true);
  const surface = new MacOSWebSocketWindowSurface({
    hostExecutable: host.executable,
    helperTtlMs: 30_000,
    successorWindowPolicy: { mode: "same_process" }
  });
  try {
    const target = { processId: process.pid, windowId: 7331 };
    await surface.captureExactWindow(target);
    await new Promise((resolve) => setTimeout(resolve, 130));
    await assert.rejects(surface.captureExactWindow(target), /authority was lost/);
    assert.equal(surface.diagnosticsSnapshot().authorityBoundary, "lost");
    assert.equal(readFileSync(host.startsFile, "utf8"), "1");
  } finally {
    await surface.close();
    host.cleanup();
  }
});

macOSExecutionTest("macOS WSS lineage explicit close is teardown, not synthetic authority loss", async () => {
  const host = fakeHost();
  const surface = new MacOSWebSocketWindowSurface({
    hostExecutable: host.executable,
    helperTtlMs: 30_000,
    successorWindowPolicy: { mode: "same_process" }
  });
  try {
    await surface.captureExactWindow({ processId: process.pid, windowId: 7331 });
    await surface.close();
    assert.equal(surface.diagnosticsSnapshot().authorityBoundary, "valid");
  } finally {
    await surface.close();
    host.cleanup();
  }
});

test("macOS WSS successor lineage cannot combine with LocalAuthentication authority", () => {
  const host = fakeHost();
  try {
    assert.throws(() => new MacOSWebSocketWindowSurface({
      hostExecutable: host.executable,
      initialSecureWindowPolicy: { mode: "macos_local_authentication" },
      successorWindowPolicy: { mode: "same_process" }
    }), /cannot combine with successor lineage/);
  } finally {
    host.cleanup();
  }
});

test("Window WSS-only adapter rejects missing exact ordinary Window scope before transport", async () => {
  const host = fakeHost();
  const adapter = new WindowWebSocketHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: "https://takeover.example", ttlMs: 60_000, reconnectIdleMs: 250 },
    allowedOrigins: ["https://takeover.example"],
    host: { platform: "macos", hostExecutable: host.executable, helperTtlMs: 30_000 }
  });
  try {
    assert.throws(() => adapter.start({
      intervention: { id: "missing-exact-window", epoch: 1 },
      principalBinding: "principal",
      target: { processId: process.pid },
      inputPolicy: { tap: true, scroll: true, text: true, key: true }
    }), /one exact positive Window id/);
  } finally {
    await adapter.close();
    host.cleanup();
  }
});
