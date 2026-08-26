import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  AnnexBAccessUnitParser,
  avccFromNalUnits,
  frameRecord,
  isLinuxWebRtcHostCliEntryPoint,
  parseOptionalTargetWindowId,
  parseWindowGeometry,
  parseWindowIds,
  scaledVideoSize
} from "../src/browser-takeover/linux-webrtc-host-cli.js";

function annexB(...units: Buffer[]): Buffer {
  return Buffer.concat(units.map((unit) => Buffer.concat([Buffer.from([0, 0, 0, 1]), unit])));
}

test("Linux host resolves only bounded exact-window geometry", () => {
  assert.deepEqual(parseWindowIds("12\n13\nnope\n-4\n"), [12, 13]);
  assert.deepEqual(parseWindowGeometry("WINDOW=12\nX=10\nY=20\nWIDTH=900\nHEIGHT=700\nSCREEN=0\n", 12), {
    windowId: 12, x: 10, y: 20, width: 900, height: 700
  });
  assert.equal(parseWindowGeometry("WINDOW=12\nX=0\nY=0\nWIDTH=100\nHEIGHT=80\n", 12), undefined);
  assert.equal(parseWindowGeometry("WINDOW=13\nX=0\nY=0\nWIDTH=900\nHEIGHT=700\n", 12), undefined);
});

test("Linux host accepts only a positive explicit target window id", () => {
  assert.equal(parseOptionalTargetWindowId(undefined), undefined);
  assert.equal(parseOptionalTargetWindowId("7331"), 7331);
  assert.throws(() => parseOptionalTargetWindowId("0"), /TARGET_WINDOW_ID/);
  assert.throws(() => parseOptionalTargetWindowId("-1"), /TARGET_WINDOW_ID/);
  assert.throws(() => parseOptionalTargetWindowId("not-a-window"), /TARGET_WINDOW_ID/);
});

test("Linux host H264 parser keeps access units bounded and converts Annex-B to AVCC", () => {
  const aud = Buffer.from([0x09, 0xf0]);
  const sps = Buffer.from([0x67, 0x42, 0x00, 0x1f]);
  const pps = Buffer.from([0x68, 0xce, 0x06, 0xe2]);
  const idr = Buffer.from([0x65, 0x88, 0x84]);
  const p = Buffer.from([0x41, 0x9a]);
  const stream = annexB(aud, sps, pps, idr, aud, p, aud);
  const frames: Array<{ units: Buffer[]; keyframe: boolean }> = [];
  const parser = new AnnexBAccessUnitParser((units, keyframe) => frames.push({ units, keyframe }));
  parser.push(stream.subarray(0, 11));
  parser.push(stream.subarray(11, 29));
  parser.push(stream.subarray(29));
  parser.end();
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.keyframe, true);
  assert.equal(frames[1]!.keyframe, false);
  assert.deepEqual(frames[0]!.units, [sps, pps, idr]);
  const avcc = avccFromNalUnits(frames[0]!.units);
  assert.equal(avcc.readUInt32BE(0), sps.length);
  assert.deepEqual(avcc.subarray(4, 4 + sps.length), sps);
});

test("Linux host emits the existing WebRTC host frame wire and caps video geometry", () => {
  assert.deepEqual(scaledVideoSize(1920, 1080), { width: 1280, height: 720 });
  assert.deepEqual(scaledVideoSize(901, 701), { width: 900, height: 700 });
  const nal = Buffer.from([0x65, 0x01]);
  const record = frameRecord(avccFromNalUnits([nal]), 9_000, true, 900, 700);
  assert.equal(record[0], 1);
  const length = record.readUInt32BE(1);
  assert.equal(length, record.length - 5);
  assert.equal(record.readUInt32BE(5), 9_000);
  assert.equal(record[9], 1);
  assert.equal(record.readUInt16BE(10), 900);
  assert.equal(record.readUInt16BE(12), 700);
});

test("Linux host CLI recognizes an npm-style symlink entrypoint without widening execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "handoff-cli-entry-"));
  try {
    const target = path.join(root, "linux-webrtc-host-cli.js");
    const bin = path.join(root, "handoff-linux-webrtc-host");
    await writeFile(target, "#!/usr/bin/env node\n", { mode: 0o755 });
    await symlink(target, bin);
    assert.equal(isLinuxWebRtcHostCliEntryPoint(pathToFileURL(target).href, bin), true);
    assert.equal(isLinuxWebRtcHostCliEntryPoint(pathToFileURL(target).href, path.join(root, "missing")), false);
    assert.equal(isLinuxWebRtcHostCliEntryPoint(pathToFileURL(target).href, undefined), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux host keeps Human text off argv and binds capture/input to one target window", () => {
  const host = readFileSync("src/browser-takeover/linux-webrtc-host-cli.ts", "utf8");
  assert.match(host, /TAKEOVER_WEBRTC_TARGET_PID/);
  assert.match(host, /TAKEOVER_WEBRTC_TARGET_WINDOW_ID/);
  assert.match(host, /requested window is not owned by the target browser PID/);
  assert.match(host, /search", "--onlyvisible", "--pid"/);
  assert.match(host, /candidates\.length === 1/);
  assert.match(host, /selectExactBoundedWindow/);
  assert.match(host, /normalizedPointInWindow/);
  assert.match(host, /scaledEvenWindowSize/);
  assert.match(host, /if \(candidates\.length > 1\) observedMultiple = true/);
  assert.doesNotMatch(host, /if \(candidates\.length > 1\) throw/);
  assert.match(host, /did not converge to exactly one eligible window/);
  assert.match(host, /-window_id/);
  assert.match(host, /windowactivate/);
  assert.match(host, /input\.kind === "tap" \|\| input\.kind === "pointer_button" \|\| input\.kind === "scroll"/);
  assert.match(host, /windowfocus/);
  assert.match(host, /const continuingPrimaryRelease = input\.kind === "pointer_button" && input\.state === "up" && this\.primaryPressed/);
  assert.match(host, /if \(!continuingPrimaryRelease\) \{[\s\S]*windowactivate[\s\S]*windowfocus/);
  assert.match(host, /verify active\/focus below without issuing another focus mutation/);
  assert.match(host, /spawn\(this\.xdotool, \["type", "--clearmodifiers", "--delay", "5", "--file", "-"\]/);
  assert.match(host, /child\.stdin\.end\(Buffer\.from\(text, "utf8"\)\)/);
  assert.doesNotMatch(host, /xclip|TAKEOVER_LINUX_XCLIP/);
  assert.match(host, /Math\.round\(point\.x\)/);
  assert.match(host, /Math\.round\(point\.y\)/);
  assert.match(host, /"mousemove", "--window", String\(this\.geometry\.windowId\)[\s\S]*"getmouselocation"/);
  assert.doesNotMatch(host, /"mousemove", "--sync", "--window", String\(this\.geometry\.windowId\)/);
  assert.match(host, /const relativeX = x - this\.geometry\.x/);
  assert.match(host, /const relativeY = y - this\.geometry\.y/);
  assert.doesNotMatch(host, /parseMouseLocation/);
  assert.match(host, /await this\.confirmActiveTarget\(\)[\s\S]*await this\.confirmInputFocusOwnedByTarget\(\)[\s\S]*\["mousedown", "1"\]/);
  assert.match(host, /kind: "tap" \| "pointer_button"/);
  assert.match(host, /record\.kind === "pointer_button"/);
  assert.match(host, /record\.button === "primary"/);
  assert.match(host, /record\.state === "down" \|\| record\.state === "up"/);
  assert.match(host, /runCommand\(this\.xdotool, \["mousedown", "1"\]/);
  assert.match(host, /Math\.abs\(pressed\.x - x\) > 1 \|\| Math\.abs\(pressed\.y - y\) > 1/);
  assert.match(host, /"mousemove", String\(releasePoint\.x\), String\(releasePoint\.y\),[\s\S]*"mouseup", "1"/);
  assert.doesNotMatch(host, /"mousemove", "--sync", String\(releasePoint\.x\)/);
  assert.match(host, /private primaryPressed = false/);
  assert.match(host, /async releaseAll\(\): Promise<void>/);
  assert.match(host, /inputChain = inputChain[\s\S]*input\.releaseAll\(\)[\s\S]*stopPromise = inputChain\.then\(\(\) => capture\.stop\(\)\)/);
  assert.doesNotMatch(host, /runCommand\(this\.xdotool, \["click", "1"\]/);
  assert.match(host, /getwindowfocus/);
  assert.match(host, /Linux WebRTC input focus is not owned by the target process/);
  assert.match(host, /focusedWindowId === this\.geometry\.windowId/);
  assert.match(host, /Number\(focusedPid\.trim\(\)\) === this\.targetPid/);
  assert.match(host, /linux_stage=input_focus_ready/);
  assert.match(host, /linux_stage=input_tap_sent/);
  assert.match(host, /linux_stage=input_failure/);
  assert.match(host, /target window ownership changed/);
  assert.match(host, /void stopHost\(\)/);
  assert.match(host, /\["key", "--clearmodifiers", key\]/);
  assert.doesNotMatch(host, /\["key", "--window"/);
  assert.match(host, /if \(this\.child === current\) this\.child = undefined;[\s\S]*current\.kill\("SIGTERM"\)/);
  assert.match(host, /if \(!this\.stopping && this\.child === child && code !== 0\)/);
  assert.doesNotMatch(host, /\["type"[^\]]*text/);
  assert.doesNotMatch(host, /shell:\s*true/);
  assert.doesNotMatch(host, /console\.(?:log|error)[^\n]*text/);
});

test("Node WebRTC runtime passes an explicit Linux display without widening the child environment", () => {
  const runtime = readFileSync("src/browser-takeover/webrtc-runtime.ts", "utf8");
  assert.match(runtime, /displayName\?: string/);
  assert.match(runtime, /env\.TAKEOVER_WEBRTC_DISPLAY_NAME = this\.config\.displayName/);
  assert.doesNotMatch(runtime, /const env: NodeJS\.ProcessEnv = \{\s*\.\.\.process\.env/);
});
