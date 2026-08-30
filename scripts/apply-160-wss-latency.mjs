import { readFileSync, writeFileSync } from "node:fs";

function edit(path, before, after) {
  const current = readFileSync(path, "utf8");
  if (!current.includes(before)) throw new Error(`marker missing in ${path}: ${before.slice(0, 80)}`);
  writeFileSync(path, current.replace(before, after));
}

function appendOnce(path, marker, addition) {
  const current = readFileSync(path, "utf8");
  if (current.includes(addition.trim())) return;
  if (!current.includes(marker)) throw new Error(`append marker missing in ${path}`);
  writeFileSync(path, current.replace(marker, `${marker}${addition}`));
}

// Channel-level, same-clock measurements. Client metrics are bounded/validated diagnostics only.
edit(
  "src/browser-takeover/websocket-takeover.ts",
  'export type WebSocketTakeoverState = "open" | "closing" | "closed" | "revoked" | "failed";\n',
  'import {\n  WebSocketLatencyTracker,\n  isWebSocketClientLatencyMetric,\n  validWebSocketLatency\n} from "./websocket-latency.js";\n\nexport type WebSocketTakeoverState = "open" | "closing" | "closed" | "revoked" | "failed";\n'
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '  onClientDiagnostic?(kind: WebSocketTakeoverClientDiagnosticKind): void;\n  maxInboundBytes?: number;',
  '  onClientDiagnostic?(kind: WebSocketTakeoverClientDiagnosticKind): void;\n  /** Shared content-free latency tracker for managed WSS acceptance. */\n  latencyTracker?: WebSocketLatencyTracker;\n  maxInboundBytes?: number;'
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '  | { kind: "diagnostic"; event: WebSocketTakeoverClientDiagnosticKind }\n  | { kind: "done" }',
  '  | { kind: "diagnostic"; event: WebSocketTakeoverClientDiagnosticKind }\n  | { kind: "latency"; metric: "client_frame_decode" | "client_frame_cadence"; valueMs: number }\n  | { kind: "done" }'
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '    case "done":\n      if (!hasOnlyKeys(record, ["kind"])) {',
  '    case "latency":\n      if (!hasOnlyKeys(record, ["kind", "metric", "valueMs"])\n        || !isWebSocketClientLatencyMetric(record.metric)\n        || !validWebSocketLatency(record.valueMs)) {\n        throw new WebSocketTakeoverError("invalid_message", "Latency diagnostic is invalid");\n      }\n      return { kind: "latency", metric: record.metric, valueMs: record.valueMs };\n    case "done":\n      if (!hasOnlyKeys(record, ["kind"])) {'
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '  private readonly onClientDiagnostic: ExperimentalWebSocketTakeoverOptions["onClientDiagnostic"];\n  private readonly maxInboundBytes: number;',
  '  private readonly onClientDiagnostic: ExperimentalWebSocketTakeoverOptions["onClientDiagnostic"];\n  private readonly latencyTracker: WebSocketLatencyTracker;\n  private readonly maxInboundBytes: number;'
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '  private lastInputStageValue: WebSocketTakeoverInputStage = "none";\n',
  '  private lastInputStageValue: WebSocketTakeoverInputStage = "none";\n  private lastFrameSentAt: number | undefined;\n'
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '    this.onClientDiagnostic = options.onClientDiagnostic;\n    this.maxInboundBytes = boundedLimit(',
  '    this.onClientDiagnostic = options.onClientDiagnostic;\n    this.latencyTracker = options.latencyTracker ?? new WebSocketLatencyTracker();\n    this.maxInboundBytes = boundedLimit('
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '      if (message.kind === "ping") {',
  '      if (message.kind === "latency") {\n        this.latencyTracker.record(message.metric, message.valueMs);\n        return;\n      }\n      if (message.kind === "ping") {'
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '      this.lastInputStageValue = "received";\n      await this.runBoundUse(',
  '      const inputStartedAt = performance.now();\n      this.lastInputStageValue = "received";\n      await this.runBoundUse('
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '      this.lastInputStageValue = "applied";\n    });',
  '      this.lastInputStageValue = "applied";\n      this.latencyTracker.record("input_apply", performance.now() - inputStartedAt);\n    });'
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '        await this.runBoundUse(async () => {\n          await this.peer.sendFrame(current!);\n        });\n        this.sentFramesValue += 1;',
  '        await this.runBoundUse(async () => {\n          const sendStartedAt = performance.now();\n          await this.peer.sendFrame(current!);\n          this.latencyTracker.record("frame_send", performance.now() - sendStartedAt);\n        });\n        const sentAt = performance.now();\n        if (this.lastFrameSentAt !== undefined) {\n          this.latencyTracker.record("frame_cadence", sentAt - this.lastFrameSentAt);\n        }\n        this.lastFrameSentAt = sentAt;\n        this.sentFramesValue += 1;'
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '    try {\n      await this.lease.complete(this.binding);\n      this.released = true;',
  '    try {\n      const completionStartedAt = performance.now();\n      await this.lease.complete(this.binding);\n      this.latencyTracker.record("completion_fence", performance.now() - completionStartedAt);\n      this.released = true;'
);
edit(
  "src/browser-takeover/websocket-takeover.ts",
  '      this.stateValue = "revoked";\n      this.clearDrainTimer();\n      this.pendingFrame = undefined;\n      try {\n        await this.releaseOnce();',
  '      this.stateValue = "revoked";\n      this.clearDrainTimer();\n      this.pendingFrame = undefined;\n      try {\n        const revokeStartedAt = performance.now();\n        await this.releaseOnce();\n        this.latencyTracker.record("revoke_fence", performance.now() - revokeStartedAt);'
);

// Pass one tracker through reconnect generations.
edit(
  "src/browser-takeover/websocket-ingress.ts",
  'import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";\n',
  'import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";\nimport type { WebSocketLatencyTracker } from "./websocket-latency.js";\n'
);
edit(
  "src/browser-takeover/websocket-ingress.ts",
  '  /** Content-free bounded event hook for first-class managed operator diagnostics. */\n  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n}',
  '  /** Content-free bounded event hook for first-class managed operator diagnostics. */\n  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n  latencyTracker?: WebSocketLatencyTracker;\n}'
);
edit(
  "src/browser-takeover/websocket-ingress.ts",
  '            onClientDiagnostic: (kind) => this.options.onDiagnosticEvent?.(kind),\n            maxInboundBytes: this.#maxInboundBytes',
  '            onClientDiagnostic: (kind) => this.options.onDiagnosticEvent?.(kind),\n            ...(this.options.latencyTracker ? { latencyTracker: this.options.latencyTracker } : {}),\n            maxInboundBytes: this.#maxInboundBytes'
);

edit(
  "src/browser-takeover/websocket-broker-binding.ts",
  'import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";\n',
  'import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";\nimport type { WebSocketLatencyTracker } from "./websocket-latency.js";\n'
);
edit(
  "src/browser-takeover/websocket-broker-binding.ts",
  '  maxInboundBytes?: number;\n  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n}',
  '  maxInboundBytes?: number;\n  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;\n  latencyTracker?: WebSocketLatencyTracker;\n}'
);
edit(
  "src/browser-takeover/websocket-broker-binding.ts",
  '      ...(options.onDiagnosticEvent ? { onDiagnosticEvent: options.onDiagnosticEvent } : {})\n    });',
  '      ...(options.onDiagnosticEvent ? { onDiagnosticEvent: options.onDiagnosticEvent } : {}),\n      ...(options.latencyTracker ? { latencyTracker: options.latencyTracker } : {})\n    });'
);

// Window composition owns capture timing and the shared tracker.
edit(
  "src/browser-takeover/websocket-window-handoff.ts",
  'import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";\n',
  'import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";\nimport { WebSocketLatencyTracker, type WebSocketLatencySnapshot } from "./websocket-latency.js";\n'
);
edit(
  "src/browser-takeover/websocket-window-handoff.ts",
  '  readonly #onAuthorityReleased: ((event: TakeoverAuthorityReleaseEvent) => void | Promise<void>) | undefined;\n',
  '  readonly #onAuthorityReleased: ((event: TakeoverAuthorityReleaseEvent) => void | Promise<void>) | undefined;\n  readonly #latencyTracker = new WebSocketLatencyTracker();\n'
);
edit(
  "src/browser-takeover/websocket-window-handoff.ts",
  '      ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {})\n    });',
  '      ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {}),\n      latencyTracker: this.#latencyTracker\n    });'
);
edit(
  "src/browser-takeover/websocket-window-handoff.ts",
  '  diagnosticsSnapshot(): ReturnType<ExperimentalWebSocketBrokerBinding["diagnosticsSnapshot"]> {\n    return this.#binding.diagnosticsSnapshot();\n  }\n',
  '  diagnosticsSnapshot(): ReturnType<ExperimentalWebSocketBrokerBinding["diagnosticsSnapshot"]> {\n    return this.#binding.diagnosticsSnapshot();\n  }\n\n  /** @internal Bounded same-clock WSS latency evidence for #160 acceptance. */\n  latencySnapshot(): WebSocketLatencySnapshot {\n    return this.#latencyTracker.snapshot();\n  }\n'
);
edit(
  "src/browser-takeover/websocket-window-handoff.ts",
  '    let frame: WebSocketTakeoverFrame;\n    try {\n      frame = await this.#surface.captureExactWindow(state.target);',
  '    let frame: WebSocketTakeoverFrame;\n    try {\n      const captureStartedAt = performance.now();\n      frame = await this.#surface.captureExactWindow(state.target);\n      this.#latencyTracker.record("capture", performance.now() - captureStartedAt);'
);

// Browser facade exposes the tracker and reports receive->image-load cadence without raw clocks.
edit(
  "src/browser-takeover/websocket-browser-handoff.ts",
  'import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";\n',
  'import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";\nimport type { WebSocketLatencySnapshot } from "./websocket-latency.js";\n'
);
edit(
  "src/browser-takeover/websocket-browser-handoff.ts",
  '  diagnosticsSnapshot(): ReturnType<ExperimentalWebSocketWindowHandoff["diagnosticsSnapshot"]> {\n    return this.#window.diagnosticsSnapshot();\n  }\n',
  '  diagnosticsSnapshot(): ReturnType<ExperimentalWebSocketWindowHandoff["diagnosticsSnapshot"]> {\n    return this.#window.diagnosticsSnapshot();\n  }\n\n  /** @internal Content-free WSS latency summary for managed acceptance. */\n  latencySnapshot(): WebSocketLatencySnapshot {\n    return this.#window.latencySnapshot();\n  }\n'
);
edit(
  "src/browser-takeover/websocket-browser-handoff.ts",
  "let editableRegions=[];let editableRegionsAt=0;let editableDiagnosticState='unknown';function setStatus(value){status.textContent=value}function controls()",
  "let editableRegions=[];let editableRegionsAt=0;let editableDiagnosticState='unknown';let lastFrameLoadedAt=0;function setStatus(value){status.textContent=value}function controls()"
);
edit(
  "src/browser-takeover/websocket-browser-handoff.ts",
  "function diagnostic(event){send({kind:'diagnostic',event})}function boundedPoint(event)",
  "function diagnostic(event){send({kind:'diagnostic',event})}function latency(metric,valueMs){if(Number.isFinite(valueMs)&&valueMs>=0&&valueMs<=120000)send({kind:'latency',metric,valueMs:Math.round(valueMs*10)/10})}function boundedPoint(event)"
);
edit(
  "src/browser-takeover/websocket-browser-handoff.ts",
  "const blob=new Blob([buffer.slice(16)],{type:mime});const next=URL.createObjectURL(blob);frame.onload=()=>{if(currentUrl)URL.revokeObjectURL(currentUrl);currentUrl=next};frame.src=next}",
  "const receivedAt=performance.now();const blob=new Blob([buffer.slice(16)],{type:mime});const next=URL.createObjectURL(blob);frame.onload=()=>{const loadedAt=performance.now();latency('client_frame_decode',loadedAt-receivedAt);if(lastFrameLoadedAt>0)latency('client_frame_cadence',loadedAt-lastFrameLoadedAt);lastFrameLoadedAt=loadedAt;if(currentUrl)URL.revokeObjectURL(currentUrl);currentUrl=next};frame.src=next}"
);

// Managed runtime/adapter expose a separate WSS snapshot; do not overload WebRTC latency semantics.
edit(
  "src/browser-takeover/managed-handoff-runtime.ts",
  'import { WebRtcLatencyTracker, type WebRtcLatencyComparison } from "./webrtc-latency.js";\n',
  'import { WebRtcLatencyTracker, type WebRtcLatencyComparison } from "./webrtc-latency.js";\nimport { emptyWebSocketLatencySnapshot, type WebSocketLatencySnapshot } from "./websocket-latency.js";\n'
);
edit(
  "src/browser-takeover/managed-handoff-runtime.ts",
  '  async revoke(interventionId: string): Promise<void> {',
  '  /** @internal Content-free managed WSS latency evidence for #160. */\n  managedWebSocketLatencySnapshot(): WebSocketLatencySnapshot {\n    return this.#lastSession?.webSocketHandoff?.latencySnapshot() ?? emptyWebSocketLatencySnapshot();\n  }\n\n  async revoke(interventionId: string): Promise<void> {'
);
edit(
  "src/browser-takeover/browser-handoff-adapter.ts",
  'import type { WebRtcLatencyComparison } from "./webrtc-latency.js";\n',
  'import type { WebRtcLatencyComparison } from "./webrtc-latency.js";\nimport { emptyWebSocketLatencySnapshot, type WebSocketLatencySnapshot } from "./websocket-latency.js";\n'
);
edit(
  "src/browser-takeover/browser-handoff-adapter.ts",
  '  latencySnapshot(): WebRtcLatencyComparison { return this.#core.latencySnapshot(); }\n',
  '  /** @internal Separate WSS performance evidence; never interpreted as WebRTC latency. */\n  managedWebSocketLatencySnapshot(): WebSocketLatencySnapshot {\n    return this.#core instanceof ManagedWindowHandoffRuntime\n      ? this.#core.managedWebSocketLatencySnapshot()\n      : emptyWebSocketLatencySnapshot();\n  }\n  latencySnapshot(): WebRtcLatencyComparison { return this.#core.latencySnapshot(); }\n'
);

// Make production-shaped container acceptance surface the bounded baseline on success and failure.
edit(
  "src/browser-takeover/managed-cloud-run-acceptance-server.ts",
  '    turnConfigured: false,\n',
  '    wssLatency: handoff?.managedWebSocketLatencySnapshot() ?? null,\n    turnConfigured: false,\n'
);
edit(
  "experiments/websocket-cloud-run/container-acceptance.mjs",
  '  ws.close();\n  process.stdout.write("WSS_CONTAINER_ACCEPTANCE_OK\\n");',
  '  const baseline = await readAcceptanceStatus(cookie);\n  process.stdout.write(`WSS_CONTAINER_LATENCY_BASELINE:${JSON.stringify(baseline.wssLatency ?? null)}\\n`);\n  ws.close();\n  process.stdout.write("WSS_CONTAINER_ACCEPTANCE_OK\\n");'
);
edit(
  "experiments/websocket-cloud-run/container-acceptance.mjs",
  '        wssFailureInputStage: status.wssFailureInputStage ?? "none"\n      };',
  '        wssFailureInputStage: status.wssFailureInputStage ?? "none",\n        wssLatency: status.wssLatency ?? null\n      };'
);

writeFileSync("tests/websocket-latency.test.ts", `import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketLatencyTracker } from "../src/browser-takeover/websocket-latency.js";
import {
  ExperimentalWebSocketTakeoverChannel,
  type WebSocketTakeoverBinding,
  type WebSocketTakeoverLease,
  type WebSocketTakeoverPeer
} from "../src/browser-takeover/websocket-takeover.js";

const binding: WebSocketTakeoverBinding = {
  interventionId: "latency-fixture",
  epoch: 1,
  principalBinding: "principal",
  clientBinding: "abcdefghijklmnopqrstuvwx",
  clientGeneration: 1
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

function lease(overrides: Partial<WebSocketTakeoverLease> = {}): WebSocketTakeoverLease {
  return {
    beginUse: async () => undefined,
    endUse: async () => undefined,
    complete: async () => undefined,
    release: async () => undefined,
    ...overrides
  };
}

function peer(): WebSocketTakeoverPeer {
  return {
    sendControl: async () => undefined,
    sendFrame: async () => { await tick(); },
    bufferedAmount: () => 0,
    close: async () => undefined
  };
}

test("WSS latency tracker is bounded, rounded and contains distributions only", () => {
  const tracker = new WebSocketLatencyTracker();
  for (let index = 0; index < 160; index += 1) tracker.record("capture", index + 0.04);
  tracker.record("frame_send", Number.NaN);
  tracker.record("input_apply", 120_001);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.capture.count, 128);
  assert.equal(snapshot.frameSend.count, 0);
  assert.equal(snapshot.inputApply.count, 0);
  assert.equal(snapshot.samples, 128);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "capture", "clientFrameCadence", "clientFrameDecode", "completionFence", "frameCadence",
    "frameSend", "inputApply", "revokeFence", "samples"
  ].sort());
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    "sessionId", "interventionId", "principal", "capability", "token", "cookie", "credential",
    "framebuffer", "humanInput", "url", "address", "timestamp"
  ]) assert.equal(serialized.includes(forbidden), false);
});

test("WSS channel records server stages plus validated browser frame diagnostics", async () => {
  const tracker = new WebSocketLatencyTracker();
  const channel = new ExperimentalWebSocketTakeoverChannel({
    binding,
    inputPolicy: { tap: true, scroll: true, text: true, key: true },
    peer: peer(),
    lease: lease({ complete: async () => { await tick(); } }),
    latencyTracker: tracker,
    onInput: async () => { await tick(); }
  });
  await channel.start();
  await channel.pushFrame({ data: new Uint8Array([1]), width: 1, height: 1, mimeType: "image/jpeg" });
  await channel.pushFrame({ data: new Uint8Array([2]), width: 1, height: 1, mimeType: "image/jpeg" });
  await channel.receiveText(JSON.stringify({ kind: "latency", metric: "client_frame_decode", valueMs: 3.26 }));
  await channel.receiveText(JSON.stringify({ kind: "latency", metric: "client_frame_cadence", valueMs: 76.14 }));
  await channel.receiveText(JSON.stringify({ kind: "tap", x: 0.5, y: 0.5 }));
  await channel.receiveText(JSON.stringify({ kind: "done" }));
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.frameSend.count, 2);
  assert.equal(snapshot.frameCadence.count, 1);
  assert.equal(snapshot.clientFrameDecode.count, 1);
  assert.equal(snapshot.clientFrameCadence.count, 1);
  assert.equal(snapshot.inputApply.count, 1);
  assert.equal(snapshot.completionFence.count, 1);
  assert.equal(snapshot.clientFrameDecode.p50Ms, 3.3);
  assert.equal(snapshot.clientFrameCadence.p50Ms, 76.1);
});

test("WSS revoke fence timing is separate from Human completion timing", async () => {
  const tracker = new WebSocketLatencyTracker();
  const channel = new ExperimentalWebSocketTakeoverChannel({
    binding,
    inputPolicy: { tap: true, scroll: true, text: true, key: true },
    peer: peer(),
    lease: lease({ release: async () => { await tick(); } }),
    latencyTracker: tracker,
    onInput: async () => undefined
  });
  await channel.revoke();
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.revokeFence.count, 1);
  assert.equal(snapshot.completionFence.count, 0);
});

test("invalid client latency diagnostics fail closed instead of entering measurements", async () => {
  const tracker = new WebSocketLatencyTracker();
  const channel = new ExperimentalWebSocketTakeoverChannel({
    binding,
    inputPolicy: { tap: true, scroll: true, text: true, key: true },
    peer: peer(),
    lease: lease(),
    latencyTracker: tracker,
    onInput: async () => undefined
  });
  await assert.rejects(
    channel.receiveText(JSON.stringify({ kind: "latency", metric: "client_frame_decode", valueMs: 120_001 })),
    /Latency diagnostic is invalid/
  );
  assert.equal(channel.state, "failed");
  assert.equal(tracker.snapshot().samples, 0);
});
`, "utf8");

console.log("#160 WSS latency instrumentation applied");
