import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, chmod, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { RTCPeerConnection, useH264 } from "werift";
import {
  SpawnedWebRtcRuntimeProvider,
  type WebRtcTakeoverRuntimeBinding
} from "../../../dist/browser-takeover/webrtc-runtime.js";
import { waitForLinuxWindowReadiness } from "./window-readiness.ts";

async function exists(value: string): Promise<boolean> {
  return access(value).then(() => true, () => false);
}

async function firstExecutable(values: string[]): Promise<string> {
  for (const value of values) if (await exists(value)) return value;
  throw new Error(`required executable not found: ${values.join(", ")}`);
}

async function waitFor(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Linux WebRTC acceptance timed out at ${label}`);
}

async function waitForX(displayNumber: number): Promise<void> {
  const socket = `/tmp/.X11-unix/X${displayNumber}`;
  await waitFor("xvfb-socket", () => exists(socket), 5_000);
}


async function within<T>(label: string, promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Linux WebRTC acceptance timed out at ${label}`)), timeoutMs))
  ]);
}

async function stopAndWait(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit").catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 1_000))
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      once(child, "exit").catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500))
    ]);
  }
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

function x11ParentWindow(windowId: number, env: NodeJS.ProcessEnv): number | undefined {
  if (!Number.isSafeInteger(windowId) || windowId <= 0) return undefined;
  const result = spawnSync(
    "/usr/bin/xwininfo",
    ["-id", String(windowId), "-int", "-children"],
    { env, encoding: "utf8" }
  );
  if (result.status !== 0) return undefined;
  const match = /Parent window id:\s+(\d+)/.exec(result.stdout);
  if (!match) return undefined;
  const parent = Number(match[1]);
  return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined;
}

function x11IsAncestor(ancestor: number, descendant: number, env: NodeJS.ProcessEnv): boolean {
  if (!Number.isSafeInteger(ancestor) || !Number.isSafeInteger(descendant) || ancestor <= 0 || descendant <= 0) return false;
  let current = descendant;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === ancestor) return true;
    const parent = x11ParentWindow(current, env);
    if (!parent || parent === current) return false;
    current = parent;
  }
  return false;
}

function x11DescendantWindows(windowId: number, env: NodeJS.ProcessEnv): number[] {
  if (!Number.isSafeInteger(windowId) || windowId <= 0) return [];
  const result = spawnSync(
    "/usr/bin/xwininfo",
    ["-id", String(windowId), "-int", "-tree"],
    { env, encoding: "utf8" }
  );
  if (result.status !== 0) return [];
  const ids: number[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s+(\d+)\s+/.exec(line);
    if (!match) continue;
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > 0 && id !== windowId && !ids.includes(id)) ids.push(id);
    if (ids.length >= 32) break;
  }
  return ids;
}

function x11AncestorWindows(windowId: number, env: NodeJS.ProcessEnv): number[] {
  const ids: number[] = [];
  let current = windowId;
  for (let depth = 0; depth < 6; depth += 1) {
    const parent = x11ParentWindow(current, env);
    if (!parent || parent === current) break;
    ids.push(parent);
    current = parent;
  }
  return ids;
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Linux acceptance must run on Linux");
  const chromeExecutable = await firstExecutable([
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ]);
  for (const executable of ["/usr/bin/Xvfb", "/usr/bin/xdotool", "/usr/bin/xwininfo", "/usr/bin/xev", "/usr/bin/ffmpeg"]) {
    assert.equal(await exists(executable), true, `${executable} is required`);
  }
  const openboxExecutable = await firstExecutable(["/usr/bin/openbox"]);
  const helper = path.resolve("dist/browser-takeover/linux-webrtc-host-cli.js");
  assert.equal(await exists(helper), true, "compiled Linux helper is required");
  const xtestHelper = path.resolve("dist/native/mcp-handoff-linux-xtest-helper");
  assert.equal(await exists(xtestHelper), true, "compiled Linux XTEST pointer helper is required");
  await chmod(helper, 0o755);

  const root = await mkdtemp(path.join(os.tmpdir(), "handoff-linux-webrtc-"));
  const profile = path.join(root, "profile");
  const home = path.join(root, "home");
  const runtimeDir = path.join(root, "runtime");
  const helperBin = path.join(root, "handoff-linux-webrtc-host");
  await symlink(helper, helperBin);
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(profile, { recursive: true, mode: 0o700 }),
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  ]));

  let pageInteractive = false;
  let formOpened = false;
  const pointerEvents = { pointermove: false, mousemove: false, pointerdown: false, mousedown: false, pointerup: false, mouseup: false, click: false };
  let typedLength = 0;
  let submitted: string | undefined;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/ready") {
      pageInteractive = true;
      res.end("ok");
      return;
    }
    if (url.pathname === "/pointer-event") {
      const kind = url.searchParams.get("kind");
      if (kind === "pointermove" || kind === "mousemove" || kind === "pointerdown" || kind === "mousedown" || kind === "pointerup" || kind === "mouseup" || kind === "click") {
        pointerEvents[kind] = true;
        res.end("ok");
        return;
      }
      res.statusCode = 400;
      res.end("invalid");
      return;
    }
    if (url.pathname === "/form") {
      formOpened = true;
      res.end(`<!doctype html><html><body style="margin:0;font-family:sans-serif"><form action="/submitted" method="get"><input id="field" name="value" autocomplete="off" style="position:fixed;inset:0;width:100%;height:100%;box-sizing:border-box;font-size:32px"></form><script>const f=document.getElementById('field');f.addEventListener('input',()=>fetch('/typed?length='+encodeURIComponent(String(f.value.length)),{cache:'no-store'}).catch(()=>{}));</script></body></html>`);
      return;
    }
    if (url.pathname === "/typed") {
      const length = Number(url.searchParams.get("length"));
      if (Number.isSafeInteger(length) && length >= 0 && length <= 4_096) typedLength = length;
      res.end("ok");
      return;
    }
    if (url.pathname === "/submitted") {
      submitted = url.searchParams.get("value") ?? undefined;
      res.end("<!doctype html><html><body>submitted</body></html>");
      return;
    }
    res.end(`<!doctype html><html><head><title>Handoff Linux Acceptance</title></head><body style="margin:0"><button id="open-form" onclick="location.href='/form'" style="position:fixed;inset:0;border:0;font-size:32px">Open form</button><script>const b=document.getElementById('open-form');for(const k of ['pointermove','mousemove','pointerdown','mousedown','pointerup','mouseup','click'])b.addEventListener(k,()=>fetch('/pointer-event?kind='+k,{cache:'no-store',keepalive:true}).catch(()=>{}));window.addEventListener('load',()=>fetch('/ready',{cache:'no-store'}).catch(()=>{}),{once:true});</script></body></html>`);
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
  // Exercise the same packaged shebang executable shape used by production consumers.
  // Direct `process.execPath` spawning would bypass `#!/usr/bin/env node` lookup entirely.
  const provider = new SpawnedWebRtcRuntimeProvider({
    hostExecutable: helperBin,
    displayName: display
  });
  const client = new RTCPeerConnection({ codecs: { video: [useH264()] }, iceServers: [], maxMessageSize: 4_096 });
  client.addTransceiver("video", { direction: "recvonly" });
  const critical = client.createDataChannel("human-critical", { ordered: true });
  const realtime = client.createDataChannel("human-realtime", { ordered: false, maxRetransmits: 0 });
  let rtpPackets = 0;
  let inputUses = 0;
  let endedUses = 0;
  let pointerInsideExactWindow = false;
  let pointerWindowOwnedByTarget = false;
  let pointerWindowIsExact = false;
  let pointerWindowDescendsFromExact = false;
  let pointerWindowAncestorsExact = false;
  const x11Probes: ChildProcess[] = [];
  const x11PointerEvents = {
    exact: { motion: false, buttonPress: false, buttonRelease: false },
    descendant: { motion: false, buttonPress: false, buttonRelease: false },
    ancestor: { motion: false, buttonPress: false, buttonRelease: false }
  };
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
    chrome.once("error", () => undefined);
    assert.ok(chrome.pid);

    process.stdout.write("LINUX_WEBRTC_STAGE chrome-window\n");
    const acceptedWindowId = await waitForLinuxWindowReadiness({
      expectedTitle: "Handoff Linux Acceptance",
      timeoutMs: 45_000,
      stableSamples: 2,
      observe: () => {
        const processAlive = chrome?.exitCode === null && chrome?.signalCode === null;
        if (!processAlive || !chrome?.pid) {
          return { processAlive: false, candidateIds: [], pageInteractive };
        }
        const result = spawnSync(
          "/usr/bin/xdotool",
          ["search", "--onlyvisible", "--pid", String(chrome.pid)],
          { env: xEnv, encoding: "utf8" }
        );
        const candidateIds = result.status === 0
          ? result.stdout.trim().split(/\s+/).filter(Boolean)
          : [];
        const candidateTitle = candidateIds.length === 1
          ? (() => {
              const title = spawnSync("/usr/bin/xdotool", ["getwindowname", candidateIds[0]!], { env: xEnv, encoding: "utf8" });
              return title.status === 0 ? title.stdout.slice(0, 160) : undefined;
            })()
          : undefined;
        return {
          processAlive: true,
          candidateIds,
          ...(candidateTitle === undefined ? {} : { candidateTitle }),
          pageInteractive
        };
      }
    });
    const acceptedWindowIdNumber = Number(acceptedWindowId);
    assert.equal(Number.isSafeInteger(acceptedWindowIdNumber) && acceptedWindowIdNumber > 0, true, "accepted X11 window id must be a positive integer");
    process.stdout.write("LINUX_WEBRTC_STAGE page-ready\n");
    // Diagnostic-only observer: another X11 client selects mouse events on the already-authorized
    // exact Chrome client window. It never sends input or changes Handoff authority. Keep output
    // bounded and collapse it to event-presence booleans before reporting.
    const startX11Probe = (windowId: number, category: "exact" | "descendant" | "ancestor") => {
      const probe = spawn("/usr/bin/xev", ["-id", String(windowId), "-event", "mouse"], {
        env: xEnv,
        stdio: ["ignore", "pipe", "ignore"]
      });
      x11Probes.push(probe);
      probe.once("error", () => undefined);
      let output = "";
      probe.stdout?.on("data", (chunk: Buffer) => {
        if (output.length >= 4_096) return;
        output = (output + chunk.toString("utf8")).slice(0, 4_096);
        x11PointerEvents[category].motion ||= /MotionNotify/.test(output);
        x11PointerEvents[category].buttonPress ||= /ButtonPress/.test(output);
        x11PointerEvents[category].buttonRelease ||= /ButtonRelease/.test(output);
      });
    };
    startX11Probe(acceptedWindowIdNumber, "exact");
    for (const windowId of x11DescendantWindows(acceptedWindowIdNumber, xEnv)) startX11Probe(windowId, "descendant");
    for (const windowId of x11AncestorWindows(acceptedWindowIdNumber, xEnv)) startX11Probe(windowId, "ancestor");
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
      targetProcessId: chrome.pid,
      targetWindowId: acceptedWindowIdNumber
    };
    process.stdout.write("LINUX_WEBRTC_STAGE provider-prepare\n");
    await provider.prepare(binding);
    const offer = await client.createOffer();
    await client.setLocalDescription(offer);
    assert.ok(client.localDescription?.sdp);
    process.stdout.write("LINUX_WEBRTC_STAGE provider-start\n");
    const answer = await provider.start(binding, { type: "offer", sdp: client.localDescription.sdp }, {
      beginInput() { inputUses += 1; return () => { endedUses += 1; }; },
      disconnected() { /* acceptance observes explicit teardown below */ }
    });
    process.stdout.write("LINUX_WEBRTC_STAGE client-remote-description\n");
    await client.setRemoteDescription(answer);
    await waitFor("webrtc-connected", () => client.connectionState === "connected" && critical.readyState === "open" && realtime.readyState === "open");
    process.stdout.write("LINUX_WEBRTC_STAGE rtp\n");
    try {
      await waitFor("rtp", () => rtpPackets > 0);
    } catch (error) {
      const stages = provider.diagnosticsSnapshot().events.map((event) => event.stage).join(",");
      throw new Error(`${error instanceof Error ? error.message : "RTP timeout"}; diagnostics=${stages}`);
    }

    critical.send(JSON.stringify({ kind: "pointer_button", button: "primary", state: "down", x: 0.5, y: 0.55 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    critical.send(JSON.stringify({ kind: "pointer_button", button: "primary", state: "up", x: 0.5, y: 0.55 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pointerLocation = spawnSync("/usr/bin/xdotool", ["getmouselocation", "--shell"], { env: xEnv, encoding: "utf8" });
    const pointerFields = new Map<string, number>();
    if (pointerLocation.status === 0) {
      for (const line of pointerLocation.stdout.split(/\r?\n/)) {
        const match = /^([A-Z]+)=(-?\d+)$/.exec(line.trim());
        if (match) pointerFields.set(match[1]!, Number(match[2]));
      }
    }
    const acceptedGeometry = spawnSync("/usr/bin/xdotool", ["getwindowgeometry", "--shell", acceptedWindowId], { env: xEnv, encoding: "utf8" });
    const geometryFields = new Map<string, number>();
    if (acceptedGeometry.status === 0) {
      for (const line of acceptedGeometry.stdout.split(/\r?\n/)) {
        const match = /^([A-Z]+)=(-?\d+)$/.exec(line.trim());
        if (match) geometryFields.set(match[1]!, Number(match[2]));
      }
    }
    const px = pointerFields.get("X"), py = pointerFields.get("Y");
    const gx = geometryFields.get("X"), gy = geometryFields.get("Y"), gw = geometryFields.get("WIDTH"), gh = geometryFields.get("HEIGHT");
    pointerInsideExactWindow = [px, py, gx, gy, gw, gh].every(Number.isFinite)
      && px! >= gx! && px! < gx! + gw! && py! >= gy! && py! < gy! + gh!;
    const pointerWindow = pointerFields.get("WINDOW");
    if (Number.isSafeInteger(pointerWindow) && pointerWindow! > 0) {
      const pointerPid = spawnSync("/usr/bin/xdotool", ["getwindowpid", String(pointerWindow)], { env: xEnv, encoding: "utf8" });
      pointerWindowOwnedByTarget = pointerPid.status === 0 && Number(pointerPid.stdout.trim()) === chrome.pid;
      pointerWindowIsExact = pointerWindow === acceptedWindowIdNumber;
      pointerWindowDescendsFromExact = x11IsAncestor(acceptedWindowIdNumber, pointerWindow!, xEnv);
      pointerWindowAncestorsExact = x11IsAncestor(pointerWindow!, acceptedWindowIdNumber, xEnv);
    }
    process.stdout.write("LINUX_WEBRTC_STAGE tap-form\n");
    try {
      await waitFor("tap-form", () => inputUses >= 2 && endedUses >= 2 && formOpened);
    } catch (error) {
      const stages = provider.diagnosticsSnapshot().events.map((event) => event.stage).join(",");
      throw new Error(`${error instanceof Error ? error.message : "tap timeout"}; diagnostics=${stages}; pointer_events=${JSON.stringify(pointerEvents)}; pointer_inside=${pointerInsideExactWindow}; pointer_window_owned=${pointerWindowOwnedByTarget}; pointer_is_exact=${pointerWindowIsExact}; pointer_descends_exact=${pointerWindowDescendsFromExact}; pointer_ancestors_exact=${pointerWindowAncestorsExact}; x11_events=${JSON.stringify(x11PointerEvents)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));

    critical.send(JSON.stringify({ kind: "pointer_button", button: "primary", state: "down", x: 0.5, y: 0.5 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    critical.send(JSON.stringify({ kind: "pointer_button", button: "primary", state: "up", x: 0.5, y: 0.5 }));
    process.stdout.write("LINUX_WEBRTC_STAGE tap-input\n");
    await waitFor("tap-input", () => inputUses >= 4 && endedUses >= 4);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const marker = `handoff-linux-${process.pid}-dummy`;
    critical.send(JSON.stringify({ kind: "text", text: marker }));
    process.stdout.write("LINUX_WEBRTC_STAGE text-input\n");
    await waitFor("text-input", () => inputUses >= 5 && endedUses >= 5);
    await waitFor("text-field-value", () => typedLength === marker.length);
    process.stdout.write("LINUX_WEBRTC_STAGE text-field-value\n");
    assert.equal(await markerInAnyProcess(marker), false, "Human text leaked into a process command line");
    critical.send(JSON.stringify({ kind: "key", key: "Enter" }));
    process.stdout.write("LINUX_WEBRTC_STAGE enter-submit\n");
    await waitFor("enter-submit", () => inputUses >= 6 && endedUses >= 6 && submitted === marker);

    assert.ok(rtpPackets > 0, "no H264 RTP reached the WebRTC peer");
    process.stdout.write(`LINUX_WEBRTC_X11_POINTER_PROBE ${JSON.stringify(x11PointerEvents)}\n`);
    process.stdout.write(`LINUX_WEBRTC_HOST_ACCEPTANCE_PASS rtp=${rtpPackets} inputs=${inputUses}\n`);
  } finally {
    process.stdout.write("LINUX_WEBRTC_STAGE cleanup-client\n");
    await within("cleanup-client", client.close().catch(() => undefined));
    process.stdout.write("LINUX_WEBRTC_STAGE cleanup-provider\n");
    await within("cleanup-provider", provider.revoke("linux-host-acceptance").catch(() => undefined));
    await within("cleanup-xev", Promise.all(x11Probes.map((probe) => stopAndWait(probe))).then(() => undefined));
    process.stdout.write("LINUX_WEBRTC_STAGE cleanup-chrome\n");
    await within("cleanup-chrome", stopAndWait(chrome));
    await within("cleanup-openbox", stopAndWait(openbox));
    await within("cleanup-xvfb", stopAndWait(xvfb));
    process.stdout.write("LINUX_WEBRTC_STAGE cleanup-server\n");
    server.closeAllConnections?.();
    if (server.listening) {
      await within("cleanup-server", new Promise<void>((resolve) => server.close(() => resolve())));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    process.stdout.write("LINUX_WEBRTC_STAGE cleanup-complete\n");
  }
}

main().then(() => {
  // All browser/WebRTC/helper cleanup is awaited above. Werift may keep an internal timer handle
  // alive after peer.close(); do not let that third-party timer turn a completed acceptance into
  // an indefinitely running CI job.
  process.exit(0);
}).catch((error) => {
  process.stderr.write(`LINUX_WEBRTC_HOST_ACCEPTANCE_FAIL ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exit(1);
});
