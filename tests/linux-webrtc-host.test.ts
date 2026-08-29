import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  AnnexBAccessUnitParser,
  JpegFrameParser,
  avccFromNalUnits,
  frameRecord,
  jpegFrameRecord,
  isLinuxWebRtcHostCliEntryPoint,
  parseLinuxAtSpiSnapshotLine,
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

test("Linux AT-SPI snapshot parser accepts only bounded geometry and focus booleans", () => {
  assert.equal(parseLinuxAtSpiSnapshotLine("NO"), undefined);
  assert.deepEqual(parseLinuxAtSpiSnapshotLine("OK focus=1 regions=100,200,300,400;9000,9000,1000,1000"), {
    focusEditable: true,
    regions: [[100, 200, 300, 400], [9000, 9000, 1000, 1000]]
  });
  assert.deepEqual(parseLinuxAtSpiSnapshotLine("OK focus=0 regions="), { focusEditable: false, regions: [] });
  assert.throws(() => parseLinuxAtSpiSnapshotLine("OK focus=2 regions="), /response is invalid/);
  assert.throws(() => parseLinuxAtSpiSnapshotLine("OK focus=1 regions=9999,9999,2,2"), /out of bounds/);
  assert.throws(() => parseLinuxAtSpiSnapshotLine(`OK focus=0 regions=${Array.from({ length: 33 }, () => "0,0,1,1").join(";")}`), /too many regions/);
  assert.throws(() => parseLinuxAtSpiSnapshotLine("OK focus=1 regions=0,0,1,1 name=secret"), /region is invalid/);
});

test("Linux AT-SPI helper is metadata-only and never reads browser text or identity labels", () => {
  const helper = readFileSync("native/linux-atspi-editable-helper.c", "utf8");
  assert.match(helper, /atspi_accessible_get_process_id/);
  assert.match(helper, /\/proc\/%u\/stat/);
  assert.match(helper, /process_is_target_or_descendant/);
  assert.match(helper, /WINDOW_EDGE_TOLERANCE 8/);
  assert.doesNotMatch(helper, /cmdline|comm\b|exe\b/);
  assert.match(helper, /atspi_accessible_get_role/);
  assert.match(helper, /atspi_accessible_get_state_set/);
  assert.match(helper, /atspi_component_get_extents/);
  assert.match(helper, /ATSPI_STATE_EDITABLE/);
  assert.match(helper, /ATSPI_STATE_FOCUSED/);
  assert.match(helper, /ATSPI_ROLE_DOCUMENT_WEB/);
  assert.match(helper, /MAX_NODES 2048/);
  assert.match(helper, /MAX_REGIONS 32/);
  assert.match(helper, /find_exact_top_level/);
  assert.match(helper, /close_to_target/);
  assert.doesNotMatch(helper, /atspi_accessible_get_(?:name|description|attributes)/);
  assert.doesNotMatch(helper, /atspi_accessible_get_text|atspi_text_|atspi_value_|get_value/);
  assert.doesNotMatch(helper, /document title|url|credential|password|cookie/i);
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

test("Linux host JPEG parser emits bounded WSS-ready image records without changing H264 framing", () => {
  const jpegA = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const jpegB = Buffer.from([0xff, 0xd8, 0x03, 0x04, 0x05, 0xff, 0xd9]);
  const frames: Buffer[] = [];
  const parser = new JpegFrameParser((jpeg) => frames.push(jpeg));
  const stream = Buffer.concat([Buffer.from([0x00, 0x01]), jpegA, jpegB]);
  parser.push(stream.subarray(0, 7));
  parser.push(stream.subarray(7, 11));
  parser.push(stream.subarray(11));
  parser.end();
  assert.deepEqual(frames, [jpegA, jpegB]);

  const record = jpegFrameRecord(jpegB, 900, 700);
  assert.equal(record[0], 2);
  assert.equal(record.readUInt32BE(1), record.length - 5);
  assert.equal(record.readUInt16BE(5), 900);
  assert.equal(record.readUInt16BE(7), 700);
  assert.deepEqual(record.subarray(9), jpegB);
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
  assert.match(host, /windowfocus/);
  assert.match(host, /const continuingPrimaryRelease = input\.kind === "pointer_button" && input\.state === "up" && this\.primaryPressed/);
  assert.match(host, /if \(!continuingPrimaryRelease\) \{[\s\S]*windowactivate[\s\S]*windowfocus/);
  assert.match(host, /verify active\/focus below without issuing another focus mutation/);
  assert.match(host, /if \(input\.kind === "scroll"\)[\s\S]*windowfocus/);
  assert.match(host, /const alreadyAuthorized = pointerLifecycle[\s\S]*activeTargetOnce\(\)[\s\S]*inputFocusOwnedByTargetOnce\(\)/);
  assert.match(host, /if \(!alreadyAuthorized\) \{[\s\S]*windowactivate/);
  assert.doesNotMatch(host, /input\.kind === "tap" \|\| input\.kind === "pointer_button" \|\| input\.kind === "scroll"/);
  assert.match(host, /spawn\(this\.xdotool, \["type", "--clearmodifiers", "--delay", "5", "--file", "-"\]/);
  assert.match(host, /child\.stdin\.end\(Buffer\.from\(text, "utf8"\)\)/);
  assert.doesNotMatch(host, /xclip|TAKEOVER_LINUX_XCLIP/);
  assert.match(host, /Math\.round\(point\.x\)/);
  assert.match(host, /Math\.round\(point\.y\)/);
  assert.match(host, /packagedLinuxXTestHelper\(import\.meta\.url\)/);
  assert.match(host, /packagedLinuxAtSpiEditableHelper\(import\.meta\.url\)/);
  assert.match(host, /MCP_HANDOFF_CONTROL editable_regions=/);
  assert.match(host, /editableHelper \? "editable_helper_ready" : "editable_helper_unavailable"/);
  assert.match(host, /linux_stage=editable_helper_unavailable/);
  const atspiClass = host.split("class LinuxAtSpiEditableHelper", 2)[1] ?? "";
  assert.match(atspiClass, /private readonly readyPromise: Promise<boolean>/);
  assert.match(atspiClass, /this\.readyResolve\(false\)/);
  assert.match(atspiClass, /Promise<LinuxAtSpiEditableHelper \| undefined>/);
  assert.doesNotMatch(atspiClass.split("function packagedLinuxAtSpiEditableHelper", 1)[0] ?? "", /readyReject/);
  assert.match(host, /setInterval\(\(\) => \{/);
  assert.match(host, /}, 250\)/);
  assert.match(host, /private latestFrame: Buffer \| undefined/);
  assert.match(host, /private latestControl: Buffer \| undefined/);
  assert.match(host, /new URL\("\.\.\/native\/mcp-handoff-linux-xtest-helper", moduleUrl\)/);
  assert.doesNotMatch(host, /TAKEOVER_LINUX_XTEST_HELPER/);
  assert.match(host, /await this\.pointer\.move\(x, y\)/);
  assert.match(host, /currentGeometry = await this\.currentOwnedGeometry\(\)/);
  assert.match(host, /target geometry changed during primary press admission/);
  assert.match(host, /await this\.confirmActiveTarget\(\)[\s\S]*await this\.confirmInputFocusOwnedByTarget\(\)[\s\S]*await this\.pointer\.down/);
  assert.match(host, /kind: "tap" \| "pointer_button"/);
  assert.match(host, /record\.kind === "pointer_button"/);
  assert.match(host, /record\.button === "primary"/);
  assert.match(host, /record\.state === "down" \|\| record\.state === "up"/);
  assert.doesNotMatch(host, /POINTER_INPUT_SETTLE_MS/);
  assert.match(host, /linux_stage=input_pointer_helper_ready/);
  assert.match(host, /linux_stage=input_pointer_helper_failure/);
  assert.match(host, /linux_stage=input_pointer_move_ready/);
  assert.match(host, /linux_stage=input_pointer_authority_ready/);
  assert.match(host, /linux_stage=input_pointer_down_sent/);
  assert.match(host, /linux_stage=input_pointer_post_authority_ready/);
  assert.match(host, /input_pointer_authority_ready[\s\S]*await this\.pointer\.down/);
  assert.match(host, /await this\.confirmPostDownAuthority\(geometryBeforeMove\)/);
  assert.match(host, /target geometry changed after primary press/);
  assert.match(host, /lost active authority after primary press/);
  assert.match(host, /lost input focus after primary press/);
  assert.doesNotMatch(host, /LinuxXRecordDeliveryHelper|LinuxXRecordDeliveryWaitError/);
  assert.doesNotMatch(host, /packagedLinuxXRecordDeliveryHelper/);
  assert.doesNotMatch(host, /delivery\.arm|waitPrimaryPress|deliveryHelper\(\)/);
  assert.match(host, /await this\.pointer\.cancel\(\)\.catch/);
  assert.doesNotMatch(host, /runCommand\(this\.xdotool, \["mousedown", "1"\]/);
  assert.doesNotMatch(host, /\["windowactivate", "--sync"/);
  assert.match(host, /HELPER_COMMAND_TIMEOUT_MS = 2_000/);
  assert.doesNotMatch(host, /runCommand\(this\.xdotool, \["mouseup", "1"\]/);
  assert.match(host, /await this\.pointer\.up\(\)/);
  assert.match(host, /Math\.abs\(pressed\.x - x\) > 1 \|\| Math\.abs\(pressed\.y - y\) > 1/);
  assert.match(host, /await this\.pointer\.cancel\(\)\.catch/);
  assert.match(host, /Never fall back to xdotool/);
  assert.match(host, /private primaryPressed = false/);
  assert.match(host, /private pressedKey: "Backspace" \| "Enter" \| undefined/);
  assert.match(host, /await this\.pointer\.keyDown\(key\)/);
  assert.match(host, /await this\.pointer\.keyUp\(key\)/);
  assert.match(host, /await this\.pointer\.cancelKey\(\)\.catch/);
  assert.match(host, /target geometry changed during special key press/);
  assert.match(host, /linux_stage=input_key_down_sent/);
  assert.match(host, /linux_stage=input_key_authority_ready/);
  assert.match(host, /linux_stage=input_key_up_sent/);
  assert.match(host, /async releaseAll\(\): Promise<void>/);
  assert.match(host, /inputChain = inputChain[\s\S]*input\.shutdown\(\)[\s\S]*stopPromise = inputChain\.then\(async \(\) =>/);
  assert.doesNotMatch(host, /runCommand\(this\.xdotool, \["click", "1"\]/);
  assert.match(host, /getwindowfocus/);
  assert.match(host, /Linux WebRTC input focus is not owned by the target process/);
  assert.match(host, /focusedWindowId === this\.geometry\.windowId/);
  assert.match(host, /Number\(focusedPid\.trim\(\)\) === this\.targetPid/);
  assert.match(host, /linux_stage=input_focus_ready/);
  assert.match(host, /linux_stage=input_tap_sent/);
  assert.match(host, /linux_stage=input_failure/);
  assert.match(host, /target window ownership changed/);
  assert.match(host, /linux_stage=host_stop_\$\{reason\}/);
  assert.match(host, /stopHost\("capture_failure"\)/);
  assert.match(host, /stopHost\("input_failure"\)/);
  assert.match(host, /stopHost\("stdin_end"\)/);
  assert.doesNotMatch(host, /\["key", "--clearmodifiers", key\]/);
  assert.doesNotMatch(host, /\["key", "--window"/);
  assert.match(host, /if \(this\.child === current\) this\.child = undefined;[\s\S]*current\.kill\("SIGTERM"\)/);
  assert.match(host, /if \(!this\.stopping && this\.child === child && code !== 0\)/);
  assert.doesNotMatch(host, /\["type"[^\]]*text/);
  assert.doesNotMatch(host, /shell:\s*true/);
  assert.doesNotMatch(host, /console\.(?:log|error)[^\n]*text/);
});

test("Linux native XTEST helper keeps pointer and special-key mechanisms narrow and stateful", () => {
  const helper = readFileSync("native/linux-xtest-helper.c", "utf8");
  assert.match(helper, /PROTOCOL_VERSION 2/);
  assert.match(helper, /XOpenDisplay\(NULL\)/);
  assert.match(helper, /XTestQueryExtension/);
  assert.match(helper, /XGetPointerMapping/);
  assert.match(helper, /XTestFakeMotionEvent/);
  assert.match(helper, /XTestFakeButtonEvent/);
  assert.match(helper, /XTestFakeKeyEvent/);
  assert.match(helper, /XKeysymToKeycode\(state\.display, XK_Return\)/);
  assert.match(helper, /XKeysymToKeycode\(state\.display, XK_BackSpace\)/);
  assert.match(helper, /XQueryKeymap/);
  assert.match(helper, /key_state\(state, keycode, false\)/);
  assert.match(helper, /state->held_key = key/);
  assert.match(helper, /cleanup_pressed_key/);
  assert.match(helper, /XSync\(state->display, False\)/);
  assert.match(helper, /XQueryPointer/);
  assert.match(helper, /Button1Mask/);
  assert.match(helper, /pointer_at\(state, x, y\)/);
  assert.match(helper, /primary_button_state\(state, true\)/);
  assert.match(helper, /pointer_position_known/);
  assert.match(helper, /pointer_at\(state, state->pointer_x, state->pointer_y\)/);
  assert.match(helper, /primary_button_state\(state, false\)/);
  assert.match(helper, /READY.*2/);
  assert.match(helper, /strcmp\(tokens\[0\], "MOVE"\)/);
  assert.match(helper, /strcmp\(tokens\[0\], "DOWN"\)/);
  assert.match(helper, /strcmp\(tokens\[0\], "UP"\)/);
  assert.match(helper, /strcmp\(tokens\[0\], "CANCEL"\)/);
  assert.match(helper, /strcmp\(tokens\[0\], "KEYDOWN"\)/);
  assert.match(helper, /strcmp\(tokens\[0\], "KEYUP"\)/);
  assert.match(helper, /strcmp\(tokens\[0\], "CANCELKEY"\)/);
  assert.match(helper, /strcmp\(name, "RETURN"\)/);
  assert.match(helper, /strcmp\(name, "BACKSPACE"\)/);
  assert.doesNotMatch(helper, /XStringToKeysym/);
  assert.doesNotMatch(helper, /XK_(?:Shift|Control|Alt|Super)/);
  assert.match(helper, /cleanup_pressed_button/);
  assert.match(helper, /cleanup_all/);
  assert.doesNotMatch(helper, /XSendEvent/);
  assert.doesNotMatch(helper, /XTestGrabControl/);
  assert.doesNotMatch(helper, /_NET_WM_PID|window title|targetPid|windowId/);
});

test("Linux XRecord diagnostic helper remains strict and non-injecting", () => {
  const helper = readFileSync("native/linux-xrecord-delivery-helper.c", "utf8");
  assert.match(helper, /PROTOCOL_VERSION 3/);
  assert.match(helper, /reply\("READY", "3"\)/);
  assert.match(helper, /XRecordQueryVersion/);
  assert.match(helper, /!XResQueryVersion\(display, &major, &minor\)/);
  assert.match(helper, /XResQueryClientIds\(display, 1, &spec, &id_count, &ids\) != Success/);
  assert.match(helper, /XResGetClientPid/);
  assert.match(helper, /XRES_CLIENT_ID_PID_MASK/);
  assert.match(helper, /XQueryExtension\(state.control, "XInputExtension"/);
  assert.match(helper, /delivered_events\.first = ButtonPress/);
  assert.match(helper, /delivered_events\.first = GenericEvent/);
  assert.match(helper, /XI_ButtonPress/);
  assert.match(helper, /XRecordCreateContext\(state->control, 0, clients, client_count, ranges, 2\)/);
  assert.match(helper, /XRecordEnableContextAsync/);
  assert.match(helper, /XRecordProcessReplies/);
  assert.match(helper, /XSync\(state->control, False\)/);
  assert.match(helper, /window_descends_from\(state->control, state->expected_window, event_window\)/);
  assert.match(helper, /root_x == state->expected_x && root_y == state->expected_y/);
  assert.match(helper, /WIRE_XI2_EVENT_WINDOW_OFFSET/);
  assert.match(helper, /DELIVERY_WAIT_TIMEOUT_MS 1000/);
  assert.match(helper, /WAIT_NO_FROM_SERVER_CREATOR_MATCH/);
  assert.match(helper, /WAIT_NO_FROM_SERVER_CREATOR_MISMATCH/);
  assert.match(helper, /WAIT_NO_FROM_SERVER_CREATOR_UNKNOWN/);
  assert.match(helper, /resolve_window_creator_pid_relation/);
  assert.match(helper, /WAIT_SWAPPED/);
  assert.match(helper, /WAIT_SHORT_DATA/);
  assert.match(helper, /WAIT_NO_EVENT/);
  assert.match(helper, /WAIT_EVENT_MISMATCH/);
  assert.match(helper, /WAIT_XI2_MISMATCH/);
  assert.match(helper, /WAIT_WINDOW_MISMATCH/);
  assert.match(helper, /WAIT_COORD_MISMATCH/);
  assert.match(helper, /WAIT_IO/);
  assert.doesNotMatch(helper, /XRecordAllClients|XRecordCurrentClients|XRecordFutureClients/);
  assert.doesNotMatch(helper, /XSelectInput|XGrabPointer|XGrabButton|XAllowEvents|XSendEvent|XTestFake|XWarpPointer|usleep|nanosleep/);
});

test("Linux XRecord self-test target stays a minimal real X11 recipient", () => {
  const target = readFileSync("native/linux-xrecord-selftest-target.c", "utf8");
  assert.match(target, /XSelectInput\(display, window, ButtonPressMask \| ButtonReleaseMask/);
  assert.match(target, /XNextEvent/);
  assert.doesNotMatch(target, /XSendEvent|XTestFake|XWarpPointer|usleep|nanosleep/);
});

test("Linux X11 pointer query probe remains query-only and non-invasive", () => {
  const probe = readFileSync("experiments/linux-webrtc-host/native/x11-pointer-query.c", "utf8");
  assert.match(probe, /XOpenDisplay\(NULL\)/);
  assert.match(probe, /RootWindow/);
  assert.match(probe, /XQueryPointer/);
  assert.match(probe, /MAX_POINTER_DEPTH 16/);
  assert.match(probe, /CHAIN=%lu/);
  assert.doesNotMatch(probe, /XSelectInput|XGrabPointer|XGrabButton|XAllowEvents|XSendEvent|XTestFake|XWarpPointer/);
});

test("Linux exact-window authority helper is persistent query-only and cannot inject or read content", () => {
  const helper = readFileSync("native/linux-window-authority-helper.c", "utf8");
  assert.match(helper, /XGetWindowAttributes/);
  assert.match(helper, /XGetWindowProperty/);
  assert.match(helper, /_NET_WM_PID/);
  assert.match(helper, /XTranslateCoordinates/);
  assert.match(helper, /IsViewable/);
  assert.match(helper, /QUERY/);
  assert.doesNotMatch(helper, /XSelectInput|XGrabPointer|XGrabButton|XAllowEvents|XSendEvent|XTestFake|XWarpPointer/);
  assert.doesNotMatch(helper, /XGetImage|XFetchName|XGetWMName|clipboard|selection|credential|password|cookie/i);
});

test("Node WebRTC runtime passes an explicit Linux display without widening the child environment", () => {
  const runtime = readFileSync("src/browser-takeover/webrtc-runtime.ts", "utf8");
  assert.match(runtime, /displayName\?: string/);
  assert.match(runtime, /env\.TAKEOVER_WEBRTC_DISPLAY_NAME = this\.config\.displayName/);
  assert.doesNotMatch(runtime, /const env: NodeJS\.ProcessEnv = \{\s*\.\.\.process\.env/);
});

test("Linux editable-region acceptance enables only the native accessibility boundary", () => {
  const acceptance = readFileSync("experiments/linux-webrtc-host/scripts/acceptance.mts", "utf8");
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(acceptance, /ACCESSIBILITY_ENABLED:\s*"1"/);
  assert.match(acceptance, /--force-renderer-accessibility=form-controls/);
  assert.doesNotMatch(acceptance, /--no-sandbox/);
  assert.match(acceptance, /assert\.equal\(chromeArgs\.some\(\(arg\) => \/remote-debugging\|enable-automation\|headless\/i\.test\(arg\)\), false\)/);
  assert.match(ci, /libatspi2\.0-dev/);
  assert.match(ci, /at-spi2-core/);
  assert.match(ci, /dbus-x11/);
  assert.match(ci, /npm run build:linux-atspi-helper/);
  assert.match(ci, /dbus-run-session -- npm run accept:webrtc:linux/);
});
