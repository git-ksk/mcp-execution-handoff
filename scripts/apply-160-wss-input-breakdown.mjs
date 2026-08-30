import { readFileSync, writeFileSync } from "node:fs";

function edit(path, before, after) {
  const current = readFileSync(path, "utf8");
  if (!current.includes(before)) throw new Error(`marker missing in ${path}: ${before.slice(0, 100)}`);
  writeFileSync(path, current.replace(before, after));
}

// Extend the existing bounded content-free tracker; do not add raw timestamps or payload metadata.
edit(
  "src/browser-takeover/websocket-latency.ts",
  '  | "input_apply"\n  | "completion_fence"',
  '  | "input_apply"\n  | "input_prepare"\n  | "input_queue_wait"\n  | "input_revalidate"\n  | "input_host_ack"\n  | "completion_fence"'
);
edit(
  "src/browser-takeover/websocket-latency.ts",
  '  inputApply: WebSocketLatencyDistribution;\n  completionFence: WebSocketLatencyDistribution;',
  '  inputApply: WebSocketLatencyDistribution;\n  inputPrepare: WebSocketLatencyDistribution;\n  inputQueueWait: WebSocketLatencyDistribution;\n  inputRevalidate: WebSocketLatencyDistribution;\n  inputHostAck: WebSocketLatencyDistribution;\n  completionFence: WebSocketLatencyDistribution;'
);
edit(
  "src/browser-takeover/websocket-latency.ts",
  '  "input_apply",\n  "completion_fence",',
  '  "input_apply",\n  "input_prepare",\n  "input_queue_wait",\n  "input_revalidate",\n  "input_host_ack",\n  "completion_fence",'
);
edit(
  "src/browser-takeover/websocket-latency.ts",
  '    const inputApply = distribution(this.#samples.get("input_apply")!);\n    const completionFence = distribution(this.#samples.get("completion_fence")!);',
  '    const inputApply = distribution(this.#samples.get("input_apply")!);\n    const inputPrepare = distribution(this.#samples.get("input_prepare")!);\n    const inputQueueWait = distribution(this.#samples.get("input_queue_wait")!);\n    const inputRevalidate = distribution(this.#samples.get("input_revalidate")!);\n    const inputHostAck = distribution(this.#samples.get("input_host_ack")!);\n    const completionFence = distribution(this.#samples.get("completion_fence")!);'
);
edit(
  "src/browser-takeover/websocket-latency.ts",
  '        + inputApply.count\n        + completionFence.count',
  '        + inputApply.count\n        + inputPrepare.count\n        + inputQueueWait.count\n        + inputRevalidate.count\n        + inputHostAck.count\n        + completionFence.count'
);
edit(
  "src/browser-takeover/websocket-latency.ts",
  '      inputApply,\n      completionFence,',
  '      inputApply,\n      inputPrepare,\n      inputQueueWait,\n      inputRevalidate,\n      inputHostAck,\n      completionFence,'
);

// Allow one tracker to span transport/channel and the Linux exact-window helper boundary.
edit(
  "src/browser-takeover/websocket-window-handoff.ts",
  '  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n  /** Called only after the shared Human generation has been fenced. */',
  '  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n  /** Optional shared tracker used by managed composition to include exact-surface stages. */\n  latencyTracker?: WebSocketLatencyTracker;\n  /** Called only after the shared Human generation has been fenced. */'
);
edit(
  "src/browser-takeover/websocket-window-handoff.ts",
  '  readonly #latencyTracker = new WebSocketLatencyTracker();\n\n  constructor(config: ExperimentalWebSocketWindowHandoffConfig) {\n    this.#surface = config.surface;',
  '  readonly #latencyTracker: WebSocketLatencyTracker;\n\n  constructor(config: ExperimentalWebSocketWindowHandoffConfig) {\n    this.#surface = config.surface;\n    this.#latencyTracker = config.latencyTracker ?? new WebSocketLatencyTracker();'
);

edit(
  "src/browser-takeover/websocket-browser-handoff.ts",
  'import type { WebSocketLatencySnapshot } from "./websocket-latency.js";',
  'import type { WebSocketLatencySnapshot, WebSocketLatencyTracker } from "./websocket-latency.js";'
);
edit(
  "src/browser-takeover/websocket-browser-handoff.ts",
  '  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n  onComplete?:',
  '  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n  latencyTracker?: WebSocketLatencyTracker;\n  onComplete?:'
);
edit(
  "src/browser-takeover/websocket-browser-handoff.ts",
  '      ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {}),\n      ...(config.onAuthorityReleased',
  '      ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {}),\n      ...(config.latencyTracker ? { latencyTracker: config.latencyTracker } : {}),\n      ...(config.onAuthorityReleased'
);

edit(
  "src/browser-takeover/managed-window-websocket-surface.ts",
  'import type { ManagedWindowWebSocketSurfaceDiagnostics } from "./websocket-window-surface-diagnostics.js";',
  'import type { ManagedWindowWebSocketSurfaceDiagnostics } from "./websocket-window-surface-diagnostics.js";\nimport type { WebSocketLatencyTracker } from "./websocket-latency.js";'
);
edit(
  "src/browser-takeover/managed-window-websocket-surface.ts",
  '  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n}',
  '  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n  latencyTracker?: WebSocketLatencyTracker;\n}'
);
edit(
  "src/browser-takeover/managed-window-websocket-surface.ts",
  '    ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {})\n  });',
  '    ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {}),\n    ...(config.latencyTracker ? { latencyTracker: config.latencyTracker } : {})\n  });'
);

edit(
  "src/browser-takeover/linux-websocket-window-surface.ts",
  'import type { ManagedWindowWebSocketSurfaceDiagnostics } from "./websocket-window-surface-diagnostics.js";',
  'import type { ManagedWindowWebSocketSurfaceDiagnostics } from "./websocket-window-surface-diagnostics.js";\nimport type { WebSocketLatencyTracker } from "./websocket-latency.js";'
);
edit(
  "src/browser-takeover/linux-websocket-window-surface.ts",
  '  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n}',
  '  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n  latencyTracker?: WebSocketLatencyTracker;\n}'
);
edit(
  "src/browser-takeover/linux-websocket-window-surface.ts",
  '  readonly #onDiagnosticEvent: ((kind: ManagedOperatorDiagnosticEventKind) => void) | undefined;\n\n  constructor(config: ExperimentalLinuxWebSocketWindowSurfaceConfig) {',
  '  readonly #onDiagnosticEvent: ((kind: ManagedOperatorDiagnosticEventKind) => void) | undefined;\n  readonly #latencyTracker: WebSocketLatencyTracker | undefined;\n\n  constructor(config: ExperimentalLinuxWebSocketWindowSurfaceConfig) {'
);
edit(
  "src/browser-takeover/linux-websocket-window-surface.ts",
  '    this.#helperTtlMs = helperTtlMs;\n    this.#onDiagnosticEvent = config.onDiagnosticEvent;\n  }',
  '    this.#helperTtlMs = helperTtlMs;\n    this.#onDiagnosticEvent = config.onDiagnosticEvent;\n    this.#latencyTracker = config.latencyTracker;\n  }'
);
edit(
  "src/browser-takeover/linux-websocket-window-surface.ts",
  '    this.#lastInputBoundaryStage = "requested";\n    const active = await this.#ensure(target);\n    this.#lastInputBoundaryStage = "helper_ready";\n    active.inputChain = active.inputChain.then(async () => {',
  '    this.#lastInputBoundaryStage = "requested";\n    const prepareStartedAt = performance.now();\n    const active = await this.#ensure(target);\n    this.#latencyTracker?.record("input_prepare", performance.now() - prepareStartedAt);\n    this.#lastInputBoundaryStage = "helper_ready";\n    const queuedAt = performance.now();\n    active.inputChain = active.inputChain.then(async () => {\n      this.#latencyTracker?.record("input_queue_wait", performance.now() - queuedAt);'
);
edit(
  "src/browser-takeover/linux-websocket-window-surface.ts",
  '      try {\n        await this.#revalidate(target, active);\n        this.#lastInputBoundaryStage = "revalidation_ready";',
  '      try {\n        const revalidateStartedAt = performance.now();\n        await this.#revalidate(target, active);\n        this.#latencyTracker?.record("input_revalidate", performance.now() - revalidateStartedAt);\n        this.#lastInputBoundaryStage = "revalidation_ready";'
);
edit(
  "src/browser-takeover/linux-websocket-window-surface.ts",
  '      if (active.pendingInputAck) throw new Error("Linux WSS exact-window helper input is busy");\n      await new Promise<void>((resolve, reject) => {',
  '      if (active.pendingInputAck) throw new Error("Linux WSS exact-window helper input is busy");\n      const hostAckStartedAt = performance.now();\n      await new Promise<void>((resolve, reject) => {'
);
edit(
  "src/browser-takeover/linux-websocket-window-surface.ts",
  '        this.#lastInputBoundaryStage = "command_sent";\n      });\n    });',
  '        this.#lastInputBoundaryStage = "command_sent";\n      });\n      this.#latencyTracker?.record("input_host_ack", performance.now() - hostAckStartedAt);\n    });'
);

edit(
  "src/browser-takeover/managed-handoff-runtime.ts",
  'import { emptyWebSocketLatencySnapshot, type WebSocketLatencySnapshot } from "./websocket-latency.js";',
  'import {\n  WebSocketLatencyTracker,\n  emptyWebSocketLatencySnapshot,\n  type WebSocketLatencySnapshot\n} from "./websocket-latency.js";'
);
edit(
  "src/browser-takeover/managed-handoff-runtime.ts",
  '    if (this.#transportOrder.includes("websocket_relay")) {\n      try {\n        surface = createManagedWindowWebSocketSurface({',
  '    if (this.#transportOrder.includes("websocket_relay")) {\n      const wssLatencyTracker = new WebSocketLatencyTracker();\n      try {\n        surface = createManagedWindowWebSocketSurface({'
);
edit(
  "src/browser-takeover/managed-handoff-runtime.ts",
  '          onDiagnosticEvent: noteDiagnosticEvent\n        });',
  '          onDiagnosticEvent: noteDiagnosticEvent,\n          latencyTracker: wssLatencyTracker\n        });'
);
edit(
  "src/browser-takeover/managed-handoff-runtime.ts",
  '        surface,\n        onDiagnosticEvent: noteDiagnosticEvent,',
  '        surface,\n        latencyTracker: wssLatencyTracker,\n        onDiagnosticEvent: noteDiagnosticEvent,'
);

// Update closure/privacy test expectations for the new bounded fields.
edit(
  "tests/websocket-latency.test.ts",
  '    "capture", "clientFrameCadence", "clientFrameDecode", "completionFence", "frameCadence",\n    "frameSend", "inputApply", "revokeFence", "samples"',
  '    "capture", "clientFrameCadence", "clientFrameDecode", "completionFence", "frameCadence",\n    "frameSend", "inputApply", "inputHostAck", "inputPrepare", "inputQueueWait",\n    "inputRevalidate", "revokeFence", "samples"'
);

// Add a deterministic Linux-surface fixture that proves all four sub-stages reach the shared tracker.
edit(
  "tests/linux-websocket-window-surface.test.ts",
  'import { jpegFrameRecord } from "../src/browser-takeover/linux-webrtc-host-cli.js";\n',
  'import { jpegFrameRecord } from "../src/browser-takeover/linux-webrtc-host-cli.js";\nimport { WebSocketLatencyTracker } from "../src/browser-takeover/websocket-latency.js";\n'
);
const latencyTest = String.raw`

test("Linux WSS input latency breakdown shares bounded tracker without payload data", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-wss-input-latency-"));
  const hostScript = join(dir, "host.mjs");
  const authorityHelper = join(dir, "authority-helper");
  const targetPid = process.pid;
  const targetWindowId = 7331;
  writeFileSync(hostScript, String.raw\`
const jpeg = Buffer.from([0xff,0xd8,0x01,0x02,0xff,0xd9]);
const payload = Buffer.allocUnsafe(4 + jpeg.length);
payload.writeUInt16BE(640, 0); payload.writeUInt16BE(480, 2); jpeg.copy(payload, 4);
const record = Buffer.allocUnsafe(5 + payload.length);
record[0] = 2; record.writeUInt32BE(payload.length, 1); payload.copy(record, 5);
const timer = setInterval(() => process.stdout.write(record), 20);
process.stdout.write(record);
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf("\\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
    if (line.includes('"kind":"stop"')) { clearInterval(timer); process.exit(0); }
    setTimeout(() => process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_applied\\n"), 8);
  }
});
\`);
  writeFileSync(authorityHelper, String.raw\`#!/bin/sh
printf 'READY 1\\n'
while IFS= read -r line; do
  case "$line" in
    QUERY) printf 'OK\\n' ;;
    CLOSE) printf 'OK CLOSE\\n'; exit 0 ;;
    *) exit 2 ;;
  esac
done
\`);
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
const testFile = "tests/linux-websocket-window-surface.test.ts";
writeFileSync(testFile, readFileSync(testFile, "utf8") + latencyTest, "utf8");

console.log("#160 WSS input breakdown applied");
