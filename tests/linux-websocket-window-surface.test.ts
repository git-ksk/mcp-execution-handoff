import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jpegFrameRecord } from "../src/browser-takeover/linux-webrtc-host-cli.js";
import {
  ExperimentalLinuxWebSocketWindowSurface,
  LinuxWebSocketHostRecordParser
} from "../src/experimental/linux-websocket-window-surface.js";

function editableFocusRecord(editable: boolean): Buffer {
  const record = Buffer.allocUnsafe(6);
  record[0] = 2;
  record.writeUInt32BE(1, 1);
  record[5] = editable ? 1 : 0;
  return record;
}

test("Linux WSS surface parser accepts bounded JPEG and editable-focus helper records", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const record = jpegFrameRecord(jpeg, 640, 480);
  const frames: Array<{ data: Buffer; width: number; height: number }> = [];
  const parser = new LinuxWebSocketHostRecordParser((frame) => frames.push(frame));
  parser.push(editableFocusRecord(true));
  parser.push(record.subarray(0, 3));
  parser.push(record.subarray(3, 11));
  parser.push(record.subarray(11));
  parser.push(editableFocusRecord(false));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.width, 640);
  assert.equal(frames[0]!.height, 480);
  assert.deepEqual(frames[0]!.data, jpeg);

  const invalid = Buffer.from(record);
  invalid[0] = 1;
  assert.throws(() => new LinuxWebSocketHostRecordParser(() => undefined).push(invalid), /invalid record/);

  const invalidFocus = editableFocusRecord(true);
  invalidFocus[5] = 2;
  assert.throws(
    () => new LinuxWebSocketHostRecordParser(() => undefined).push(invalidFocus),
    /invalid editable-focus record/
  );
});

test("Linux WSS physical surface reuses exact helper without transport or target leakage", () => {
  const surface = readFileSync("src/browser-takeover/linux-websocket-window-surface.ts", "utf8");
  assert.match(surface, /TAKEOVER_WEBRTC_FRAME_FORMAT: "jpeg"/);
  assert.match(surface, /TAKEOVER_WEBRTC_TARGET_PID: String\(target\.processId\)/);
  assert.match(surface, /TAKEOVER_WEBRTC_TARGET_WINDOW_ID: String\(target\.windowId\)/);
  assert.match(surface, /mcp-handoff-linux-window-authority-helper/);
  assert.match(surface, /authority\.query\(\)/);
  assert.match(surface, /TAKEOVER_LINUX_XDOTOOL: this\.#xdotoolExecutable/);
  assert.match(surface, /match\[1\] === "input_applied"/);
  assert.match(surface, /mimeType: "image\/jpeg"/);
  assert.match(surface, /CAPTURE_RECOVERY_ATTEMPTS = 2/);
  assert.match(surface, /failActive\(active, "Linux WSS exact-window helper capture stalled"\)/);
  assert.match(surface, /isExactWindowBoundaryError\(error\)/);
  assert.match(surface, /target window ownership changed/);
  assert.doesNotMatch(surface, /RTCPeerConnection|ICE|TURN|STUN|DataChannel/);
  assert.doesNotMatch(surface, /\.\.\.process\.env/);
  assert.doesNotMatch(surface, /console\.(?:log|error).*text/);
});


test("Linux WSS capture restarts one failed helper for the same exact PID/window", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-wss-recovery-"));
  const countFile = join(dir, "count");
  const hostScript = join(dir, "host.mjs");
  const xdotool = join(dir, "xdotool");
  const authorityHelper = join(dir, "authority-helper");
  const targetPid = process.pid;
  const targetWindowId = 7331;
  writeFileSync(countFile, "0");
  writeFileSync(hostScript, `
import { readFileSync, writeFileSync } from "node:fs";
const countFile = ${JSON.stringify(countFile)};
const next = Number(readFileSync(countFile, "utf8")) + 1;
writeFileSync(countFile, String(next));
const jpeg = Buffer.from([0xff,0xd8,0x01,0x02,0xff,0xd9]);
const payload = Buffer.allocUnsafe(4 + jpeg.length);
payload.writeUInt16BE(640, 0); payload.writeUInt16BE(480, 2); jpeg.copy(payload, 4);
const record = Buffer.allocUnsafe(5 + payload.length);
record[0] = 2; record.writeUInt32BE(payload.length, 1); payload.copy(record, 5);
process.stdout.write(record);
if (next === 1) setTimeout(() => process.exit(1), 20);
else setInterval(() => process.stdout.write(record), 25);
`);
  writeFileSync(xdotool, `#!/bin/sh
case "$1" in
  search) echo ${targetWindowId} ;;
  getwindowpid) echo ${targetPid} ;;
  getwindowgeometry) printf 'WINDOW=${targetWindowId}\\nX=0\\nY=0\\nWIDTH=640\\nHEIGHT=480\\nSCREEN=0\\n' ;;
  *) exit 1 ;;
esac
`);
  writeFileSync(authorityHelper, `#!/bin/sh
printf 'READY 1\n'
while IFS= read -r line; do
  case "$line" in
    QUERY) printf 'OK\n' ;;
    CLOSE) printf 'OK CLOSE\n'; exit 0 ;;
    *) exit 2 ;;
  esac
done
`);
  chmodSync(authorityHelper, 0o755);
  chmodSync(xdotool, 0o755);

  const diagnosticEvents: string[] = [];
  const surface = new ExperimentalLinuxWebSocketWindowSurface({
    hostScript,
    displayName: ":99",
    xdotoolExecutable: xdotool,
    authorityHelperExecutable: authorityHelper,
    helperTtlMs: 30_000,
    onDiagnosticEvent: (kind) => diagnosticEvents.push(kind)
  });
  try {
    const frame = await surface.captureExactWindow({ processId: targetPid, windowId: targetWindowId });
    assert.equal(frame.width, 640);
    assert.equal(frame.height, 480);
    assert.equal(Number(readFileSync(countFile, "utf8")), 2, "failed helper must be replaced exactly once");
    assert.ok(diagnosticEvents.includes("capture_recovery_attempt"));
    assert.ok(diagnosticEvents.includes("helper_restart"));
    assert.equal(surface.diagnosticsSnapshot().authorityBoundary, "valid");
  } finally {
    await surface.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Linux WSS capture does not retry an exact-window ownership failure", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-wss-boundary-"));
  const countFile = join(dir, "count");
  const hostScript = join(dir, "host.mjs");
  const xdotool = join(dir, "xdotool");
  const authorityHelper = join(dir, "authority-helper");
  const targetPid = process.pid;
  const targetWindowId = 7331;
  writeFileSync(countFile, "0");
  writeFileSync(hostScript, `
import { readFileSync, writeFileSync } from "node:fs";
const countFile = ${JSON.stringify(countFile)};
writeFileSync(countFile, String(Number(readFileSync(countFile, "utf8")) + 1));
setInterval(() => {}, 1000);
`);
  writeFileSync(xdotool, `#!/bin/sh
case "$1" in
  search) echo ${targetWindowId} ;;
  getwindowpid) echo $(( ${targetPid} + 1 )) ;;
  getwindowgeometry) printf 'WINDOW=${targetWindowId}\\nX=0\\nY=0\\nWIDTH=640\\nHEIGHT=480\\nSCREEN=0\\n' ;;
  *) exit 1 ;;
esac
`);
  writeFileSync(authorityHelper, `#!/bin/sh
printf 'READY 1\n'
while IFS= read -r line; do
  case "$line" in
    QUERY) printf 'ERR OWNER\n' ;;
    CLOSE) printf 'OK CLOSE\n'; exit 0 ;;
    *) exit 2 ;;
  esac
done
`);
  chmodSync(authorityHelper, 0o755);
  chmodSync(xdotool, 0o755);

  const diagnosticEvents: string[] = [];
  const surface = new ExperimentalLinuxWebSocketWindowSurface({
    hostScript,
    displayName: ":99",
    xdotoolExecutable: xdotool,
    authorityHelperExecutable: authorityHelper,
    helperTtlMs: 30_000,
    onDiagnosticEvent: (kind) => diagnosticEvents.push(kind)
  });
  try {
    await assert.rejects(
      surface.captureExactWindow({ processId: targetPid, windowId: targetWindowId }),
      /ownership changed/
    );
    assert.equal(Number(readFileSync(countFile, "utf8")), 0, "authority failure must fail before helper start");
    assert.equal(surface.diagnosticsSnapshot().authorityBoundary, "lost");
    assert.deepEqual(diagnosticEvents, ["authority_boundary_lost"]);
  } finally {
    await surface.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Linux WSS serializes frame and Human-input authority queries without weakening revalidation", async () => {
  const source = readFileSync("src/browser-takeover/linux-websocket-window-surface.ts", "utf8");
  assert.match(source, /#queryChain: Promise<void> = Promise\.resolve\(\)/);
  assert.match(source, /this\.#queryChain = this\.#queryChain/);
  assert.doesNotMatch(source, /authority helper is busy/);
});

test("Linux WSS capture failure classification fails closed only for exact authority boundaries", () => {
  const surface = new ExperimentalLinuxWebSocketWindowSurface({
    hostScript: process.execPath,
    displayName: ":99"
  });
  assert.equal(
    surface.captureFailureDisposition(new Error("Linux WSS target window ownership changed")),
    "authority_lost"
  );
  assert.equal(
    surface.captureFailureDisposition(new Error("Linux WSS exact-window helper frame timed out")),
    "recoverable"
  );
});

test("Linux WSS input failure diagnostics classify helper/ACK stage without Human payload", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-wss-input-diagnostics-"));
  const hostScript = join(dir, "host.mjs");
  const xdotool = join(dir, "xdotool");
  const authorityHelper = join(dir, "authority-helper");
  const targetPid = process.pid;
  const targetWindowId = 7331;
  writeFileSync(hostScript, `
const jpeg = Buffer.from([0xff,0xd8,0x01,0x02,0xff,0xd9]);
const payload = Buffer.allocUnsafe(4 + jpeg.length);
payload.writeUInt16BE(640, 0); payload.writeUInt16BE(480, 2); jpeg.copy(payload, 4);
const record = Buffer.allocUnsafe(5 + payload.length);
record[0] = 2; record.writeUInt32BE(payload.length, 1); payload.copy(record, 5);
process.stdout.write(record);
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_focus_ready\\n");
  process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=host_stop_input_failure\\n");
  process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_xtest_ack_timeout\\n");
  process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_failure\\n");
});
setInterval(() => {}, 1000);
`);
  writeFileSync(xdotool, `#!/bin/sh
case "$1" in
  search) echo ${targetWindowId} ;;
  getwindowpid) echo ${targetPid} ;;
  getwindowgeometry) printf 'WINDOW=${targetWindowId}\\nX=0\\nY=0\\nWIDTH=640\\nHEIGHT=480\\nSCREEN=0\\n' ;;
  *) exit 1 ;;
esac
`);
  writeFileSync(authorityHelper, `#!/bin/sh
printf 'READY 1\n'
while IFS= read -r line; do
  case "$line" in
    QUERY) printf 'OK\n' ;;
    CLOSE) printf 'OK CLOSE\n'; exit 0 ;;
    *) exit 2 ;;
  esac
done
`);
  chmodSync(authorityHelper, 0o755);
  chmodSync(xdotool, 0o755);

  const diagnosticEvents: string[] = [];
  const surface = new ExperimentalLinuxWebSocketWindowSurface({
    hostScript,
    displayName: ":99",
    xdotoolExecutable: xdotool,
    authorityHelperExecutable: authorityHelper,
    helperTtlMs: 30_000,
    onDiagnosticEvent: (kind) => diagnosticEvents.push(kind)
  });
  try {
    await assert.rejects(
      surface.insertExactWindowText(
        { processId: targetPid, windowId: targetWindowId },
        "never-log-this-human-input"
      ),
      /helper input failed|helper is unavailable/
    );
    const diagnostics = surface.diagnosticsSnapshot();
    assert.equal(diagnostics.failure, "input_failure");
    assert.equal(diagnostics.failureInputStage, "focus_ready");
    assert.equal(diagnostics.failureInputBoundaryStage, "command_sent");
    assert.equal(diagnostics.failureInputFailureDetail, "xtest_ack_timeout");
    assert.equal(diagnostics.failureHelperStopReason, "input_failure");
    assert.equal(diagnostics.authorityBoundary, "valid");
    assert.ok(diagnosticEvents.includes("input_dispatch_failure"));
    assert.doesNotMatch(JSON.stringify(diagnostics), /never-log-this-human-input/);
  } finally {
    await surface.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
