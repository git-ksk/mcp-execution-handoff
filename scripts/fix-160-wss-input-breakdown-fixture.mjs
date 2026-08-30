import { readFileSync, writeFileSync } from "node:fs";

const path = "tests/linux-websocket-window-surface.test.ts";
const current = readFileSync(path, "utf8");
const marker = '\ntest("Linux WSS input latency breakdown shares bounded tracker without payload data"';
const index = current.indexOf(marker);
if (index < 0) throw new Error("#160 latency fixture marker missing");

const fixed = String.raw`

test("Linux WSS input latency breakdown shares bounded tracker without payload data", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-wss-input-latency-"));
  const hostScript = join(dir, "host.mjs");
  const authorityHelper = join(dir, "authority-helper");
  const targetPid = process.pid;
  const targetWindowId = 7331;
  writeFileSync(hostScript, [
    'const jpeg = Buffer.from([0xff,0xd8,0x01,0x02,0xff,0xd9]);',
    'const payload = Buffer.allocUnsafe(4 + jpeg.length);',
    'payload.writeUInt16BE(640, 0); payload.writeUInt16BE(480, 2); jpeg.copy(payload, 4);',
    'const record = Buffer.allocUnsafe(5 + payload.length);',
    'record[0] = 2; record.writeUInt32BE(payload.length, 1); payload.copy(record, 5);',
    'const timer = setInterval(() => process.stdout.write(record), 20);',
    'process.stdout.write(record);',
    'let pending = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    '  pending += chunk;',
    '  for (;;) {',
    '    const newline = pending.indexOf("\\n");',
    '    if (newline < 0) break;',
    '    const line = pending.slice(0, newline); pending = pending.slice(newline + 1);',
    '    if (line.includes("\\\"kind\\\":\\\"stop\\\"")) { clearInterval(timer); process.exit(0); }',
    '    setTimeout(() => process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_applied\\n"), 8);',
    '  }',
    '});'
  ].join("\n"));
  writeFileSync(authorityHelper, [
    "#!/bin/sh",
    "printf 'READY 1\\n'",
    "while IFS= read -r line; do",
    "  case \"$line\" in",
    "    QUERY) printf 'OK\\n' ;;",
    "    CLOSE) printf 'OK CLOSE\\n'; exit 0 ;;",
    "    *) exit 2 ;;",
    "  esac",
    "done"
  ].join("\n"));
  chmodSync(authorityHelper, 0o755);
  const latencyTracker = new WebSocketLatencyTracker();
  const surface = new ExperimentalLinuxWebSocketWindowSurface({
    hostScript,
    displayName: ":99",
    xdotoolExecutable: "/bin/true",
    authorityHelperExecutable: authorityHelper,
    helperTtlMs: 30_000,
    latencyTracker
  });
  try {
    await surface.captureExactWindow({ processId: targetPid, windowId: targetWindowId });
    await surface.insertExactWindowText(
      { processId: targetPid, windowId: targetWindowId },
      "fixture-only"
    );
    const snapshot = latencyTracker.snapshot();
    assert.equal(snapshot.inputPrepare.count, 1);
    assert.equal(snapshot.inputQueueWait.count, 1);
    assert.equal(snapshot.inputRevalidate.count, 1);
    assert.equal(snapshot.inputHostAck.count, 1);
    assert.ok((snapshot.inputHostAck.p50Ms ?? 0) >= 5);
    assert.doesNotMatch(JSON.stringify(snapshot), /fixture-only/);
  } finally {
    await surface.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
`;

writeFileSync(path, current.slice(0, index) + fixed, "utf8");
console.log("#160 WSS input latency fixture fixed");
