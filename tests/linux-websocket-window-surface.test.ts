import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { jpegFrameRecord } from "../src/browser-takeover/linux-webrtc-host-cli.js";
import { LinuxWebSocketHostRecordParser } from "../src/experimental/linux-websocket-window-surface.js";

test("Linux WSS surface parser accepts only bounded JPEG helper records", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const record = jpegFrameRecord(jpeg, 640, 480);
  const frames: Array<{ data: Buffer; width: number; height: number }> = [];
  const parser = new LinuxWebSocketHostRecordParser((frame) => frames.push(frame));
  parser.push(record.subarray(0, 3));
  parser.push(record.subarray(3, 11));
  parser.push(record.subarray(11));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.width, 640);
  assert.equal(frames[0]!.height, 480);
  assert.deepEqual(frames[0]!.data, jpeg);

  const invalid = Buffer.from(record);
  invalid[0] = 1;
  assert.throws(() => new LinuxWebSocketHostRecordParser(() => undefined).push(invalid), /invalid record/);
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
