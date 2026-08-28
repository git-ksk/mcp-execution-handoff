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
  assert.match(surface, /search", "--onlyvisible", "--pid"/);
  assert.match(surface, /getwindowpid/);
  assert.match(surface, /parseWindowGeometry/);
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


test("Linux WSS capture restarts one failed helper for the same exact PID/window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-wss-recovery-"));
  const countFile = join(dir, "count");
  const hostScript = join(dir, "host.mjs");
  const xdotool = join(dir, "xdotool");
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
  chmodSync(xdotool, 0o755);

  const surface = new ExperimentalLinuxWebSocketWindowSurface({
    hostScript,
    displayName: ":99",
    xdotoolExecutable: xdotool,
    helperTtlMs: 30_000
  });
  try {
    const frame = await surface.captureExactWindow({ processId: targetPid, windowId: targetWindowId });
    assert.equal(frame.width, 640);
    assert.equal(frame.height, 480);
    assert.equal(Number(readFileSync(countFile, "utf8")), 2, "failed helper must be replaced exactly once");
  } finally {
    await surface.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Linux WSS capture does not retry an exact-window ownership failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-wss-boundary-"));
  const countFile = join(dir, "count");
  const hostScript = join(dir, "host.mjs");
  const xdotool = join(dir, "xdotool");
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
  chmodSync(xdotool, 0o755);

  const surface = new ExperimentalLinuxWebSocketWindowSurface({
    hostScript,
    displayName: ":99",
    xdotoolExecutable: xdotool,
    helperTtlMs: 30_000
  });
  try {
    await assert.rejects(
      surface.captureExactWindow({ processId: targetPid, windowId: targetWindowId }),
      /ownership changed/
    );
    assert.equal(Number(readFileSync(countFile, "utf8")), 0, "authority failure must fail before helper start");
  } finally {
    await surface.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
