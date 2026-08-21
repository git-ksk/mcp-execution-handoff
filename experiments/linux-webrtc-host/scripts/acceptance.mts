import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { RTCPeerConnection, useH264 } from "werift";
import {
  SpawnedWebRtcRuntimeProvider,
  type WebRtcTakeoverRuntimeBinding
} from "../../../dist/browser-takeover/webrtc-runtime.js";

async function exists(value: string): Promise<boolean> {
  return access(value).then(() => true, () => false);
}

async function firstExecutable(values: string[]): Promise<string> {
  for (const value of values) if (await exists(value)) return value;
  throw new Error(`required executable not found: ${values.join(", ")}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Linux WebRTC acceptance timed out");
}

async function waitForX(displayNumber: number): Promise<void> {
  const socket = `/tmp/.X11-unix/X${displayNumber}`;
  await waitFor(() => exists(socket), 5_000);
}

function stop(child: ChildProcess | undefined): void {
  if (child && child.exitCode === null) child.kill("SIGTERM");
}

async function cmdline(pid: number): Promise<string> {
  return (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").replaceAll("\0", " ");
}

async function markerInAnyProcess(marker: string): Promise<boolean> {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const value = await readFile(`/proc/${entry}/cmdline`).catch(() => Buffer.alloc(0));
    if (value.includes(Buffer.from(marker))) return true;
  }
  return false;
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Linux acceptance must run on Linux");
  const chromeExecutable = await firstExecutable([
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ]);
  for (const executable of ["/usr/bin/Xvfb", "/usr/bin/xdotool", "/usr/bin/xclip", "/usr/bin/ffmpeg"]) {
    assert.equal(await exists(executable), true, `${executable} is required`);
  }
  const openboxExecutable = await firstExecutable(["/usr/bin/openbox"]);
  const helper = path.resolve("dist/browser-takeover/linux-webrtc-host-cli.js");
  assert.equal(await exists(helper), true, "compiled Linux helper is required");
  await chmod(helper, 0o755);

  const root = await mkdtemp(path.join(os.tmpdir(), "handoff-linux-webrtc-"));
  const profile = path.join(root, "profile");
  const home = path.join(root, "home");
  const runtimeDir = path.join(root, "runtime");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(profile, { recursive: true, mode: 0o700 }),
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  ]));

  let formOpened = false;
  let submitted: string | undefined;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/form") {
      formOpened = true;
      res.end(`<!doctype html><html><body style="margin:0;font-family:sans-serif"><form action="/submitted" method="get"><input name="value" autofocus autocomplete="off" style="position:fixed;left:15%;top:30%;width:70%;height:70px;font-size:24px"><button type="submit" style="position:fixed;left:35%;top:55%;width:30%;height:70px">Submit</button></form></body></html>`);
      return;
    }
    if (url.pathname === "/submitted") {
      submitted = url.searchParams.get("value") ?? undefined;
      res.end("<!doctype html><html><body>submitted</body></html>");
      return;
    }
    res.end(`<!doctype html><html><body style="margin:0"><button onclick="location.href='/form'" style="position:fixed;inset:0;border:0;font-size:32px">Open form</button></body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const pageUrl = `http://127.0.0.1:${address.port}/`;

  const displayNumber = 90 + (process.pid % 40);
  const display = `:${displayNumber}`;
  const xEnv = { DISPLAY: display, HOME: home, XDG_RUNTIME_DIR: runtimeDir, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
  let xvfb: ChildProcess | undefined;
  let openbox: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  const provider = new SpawnedWebRtcRuntimeProvider({
    hostExecutable: process.execPath,
    hostArgs: [helper],
    displayName: display
  });
  const client = new RTCPeerConnection({ codecs: { video: [useH264()] }, iceServers: [], maxMessageSize: 4_096 });
  client.addTransceiver("video", { direction: "recvonly" });
  const critical = client.createDataChannel("human-critical", { ordered: true });
  const realtime = client.createDataChannel("human-realtime", { ordered: false, maxRetransmits: 0 });
  let rtpPackets = 0;
  let inputUses = 0;
  let endedUses = 0;
  client.onTrack.subscribe((track) => track.onReceiveRtp.subscribe(() => { rtpPackets += 1; }));

  try {
    xvfb = spawn("/usr/bin/Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    xvfb.once("error", () => undefined);
    await waitForX(displayNumber);
    openbox = spawn(openboxExecutable, ["--sm-disable"], { env: xEnv, stdio: ["ignore", "ignore", "ignore"] });
    openbox.once("error", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const chromeArgs = [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--window-size=1000,700",
      "--new-window",
      pageUrl
    ];
    assert.equal(chromeArgs.some((arg) => /remote-debugging|enable-automation|headless/i.test(arg)), false);
    chrome = spawn(chromeExecutable, chromeArgs, { env: xEnv, stdio: ["ignore", "ignore", "pipe"] });
    let chromeError = "";
    chrome.stderr?.on("data", (chunk: Buffer) => { if (chromeError.length < 8_192) chromeError += chunk.toString("utf8"); });
    chrome.once("error", () => undefined);
    assert.ok(chrome.pid);

    await waitFor(async () => {
      if (chrome?.exitCode !== null) throw new Error(`normal Chrome exited before window readiness: ${chromeError.slice(0, 500)}`);
      const result = spawnSync("/usr/bin/xdotool", ["search", "--onlyvisible", "--pid", String(chrome!.pid)], { env: xEnv, encoding: "utf8" });
      return result.status === 0 && result.stdout.trim().split(/\s+/).filter(Boolean).length === 1;
    });
    const liveCmdline = await cmdline(chrome.pid);
    assert.doesNotMatch(liveCmdline, /--remote-debugging(?:-port|-pipe)?|--enable-automation|--headless/i);

    const binding: WebRtcTakeoverRuntimeBinding = {
      takeoverSessionId: "linux-host-acceptance",
      interventionId: "linux-normal-browser",
      epoch: 1,
      principalBinding: "acceptance-principal",
      clientBinding: "acceptance-client-binding-1234567890",
      clientGeneration: 1,
      expiresAt: Date.now() + 60_000,
      targetProcessId: chrome.pid
    };
    await provider.prepare(binding);
    const offer = await client.createOffer();
    await client.setLocalDescription(offer);
    assert.ok(client.localDescription?.sdp);
    const answer = await provider.start(binding, { type: "offer", sdp: client.localDescription.sdp }, {
      beginInput() { inputUses += 1; return () => { endedUses += 1; }; },
      disconnected() { /* acceptance observes explicit teardown below */ }
    });
    await client.setRemoteDescription(answer);
    await waitFor(() => client.connectionState === "connected" && critical.readyState === "open" && realtime.readyState === "open");
    await waitFor(() => rtpPackets > 0);

    critical.send(JSON.stringify({ kind: "tap", x: 0.5, y: 0.55 }));
    await waitFor(() => inputUses >= 1 && endedUses >= 1 && formOpened);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const marker = `handoff-linux-${process.pid}-dummy`;
    critical.send(JSON.stringify({ kind: "text", text: marker }));
    await waitFor(() => inputUses >= 2 && endedUses >= 2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await markerInAnyProcess(marker), false, "Human text leaked into a process command line");
    critical.send(JSON.stringify({ kind: "key", key: "Enter" }));
    await waitFor(() => inputUses >= 3 && endedUses >= 3 && submitted === marker);

    const clipboard = spawnSync("/usr/bin/xclip", ["-selection", "clipboard", "-o"], {
      env: xEnv,
      encoding: "utf8",
      timeout: 1_000
    });
    assert.ok(clipboard.status !== 0 || clipboard.stdout === "", "Human text remained in the X11 clipboard");
    assert.ok(rtpPackets > 0, "no H264 RTP reached the WebRTC peer");
    process.stdout.write(`LINUX_WEBRTC_HOST_ACCEPTANCE_PASS rtp=${rtpPackets} inputs=${inputUses}\n`);
  } finally {
    await client.close().catch(() => undefined);
    await provider.revoke("linux-host-acceptance").catch(() => undefined);
    stop(chrome);
    stop(openbox);
    stop(xvfb);
    await new Promise((resolve) => setTimeout(resolve, 150));
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`LINUX_WEBRTC_HOST_ACCEPTANCE_FAIL ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exit(1);
});
