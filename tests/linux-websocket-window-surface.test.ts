import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { jpegFrameRecord } from "../src/browser-takeover/linux-webrtc-host-cli.js";
import { LinuxWebSocketHostRecordParser } from "../src/experimental/linux-websocket-window-surface.js";

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
  assert.doesNotMatch(surface, /RTCPeerConnection|ICE|TURN|STUN|DataChannel/);
  assert.doesNotMatch(surface, /\.\.\.process\.env/);
  assert.doesNotMatch(surface, /console\.(?:log|error).*text/);
});
