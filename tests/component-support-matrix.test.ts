import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface TestRef {
  file: string;
  name: string;
}

type SupportState =
  | "supported"
  | "supported_if_configured"
  | "deterministic_physical_pending"
  | "planned"
  | "unsupported";

interface TransportEntry {
  state: SupportState;
  deterministicTests?: TestRef[];
  physicalCommand?: string;
  issue?: number;
  reason?: string;
}

interface MatrixRow {
  id: string;
  surface: string;
  host: string;
  transports: Record<string, TransportEntry>;
}

type AcceptanceStatus = "passed" | "pending" | "documented";

interface AcceptanceEvidence {
  rowId: string;
  transport: string;
  status: AcceptanceStatus;
  command?: string;
  issue?: number;
  evidence: string;
}

interface MatrixDocument {
  schemaVersion: number;
  states: SupportState[];
  rows: MatrixRow[];
  highRiskFailureGates: Array<{ category: string; test: TestRef }>;
  authUxGates: Array<{ category: string; test: TestRef }>;
  authUxPolicy: {
    secureFormCredentialBroker: "out_of_scope";
    modeSwitch: "unsupported";
    sessionPersistenceOwner: "consumer_provider";
    semanticVerificationOwner: "consumer";
  };
  acceptanceEvidence: AcceptanceEvidence[];
}

const matrix = JSON.parse(
  await readFile("docs/component-support-matrix.json", "utf8")
) as MatrixDocument;
const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};
const testSource = new Map<string, string>();

async function assertTrackedTest(ref: TestRef): Promise<void> {
  let source = testSource.get(ref.file);
  if (source === undefined) {
    source = await readFile(ref.file, "utf8");
    testSource.set(ref.file, source);
  }
  assert.ok(source.includes(ref.name), `${ref.file} no longer contains tracked test: ${ref.name}`);
}

function assertAcceptanceCommand(command: string): void {
  const prefix = "npm run ";
  const scriptName = command.startsWith(prefix) ? command.slice(prefix.length) : command;
  assert.ok(packageJson.scripts?.[scriptName], `missing physical acceptance script: ${scriptName}`);
}

test("component support matrix is closed-world and every claimed row has executable coverage", async () => {
  assert.equal(matrix.schemaVersion, 2);
  assert.deepEqual(new Set(matrix.states), new Set<SupportState>([
    "supported",
    "supported_if_configured",
    "deterministic_physical_pending",
    "planned",
    "unsupported"
  ]));
  assert.ok(matrix.rows.length >= 9);

  const rowIds = new Set<string>();
  for (const row of matrix.rows) {
    assert.ok(row.id && row.surface && row.host);
    assert.equal(rowIds.has(row.id), false, `duplicate matrix row: ${row.id}`);
    rowIds.add(row.id);
    assert.deepEqual(
      new Set(Object.keys(row.transports)),
      new Set(["webrtc_direct", "webrtc_relay", "websocket_wss"]),
      `transport set drifted for ${row.id}`
    );

    for (const [transport, entry] of Object.entries(row.transports)) {
      assert.ok(matrix.states.includes(entry.state), `unknown state for ${row.id}/${transport}`);
      if (entry.state === "supported" || entry.state === "supported_if_configured"
        || entry.state === "deterministic_physical_pending") {
        assert.ok(entry.deterministicTests?.length, `claimed support lacks tests: ${row.id}/${transport}`);
        for (const ref of entry.deterministicTests ?? []) await assertTrackedTest(ref);
      }
      if (entry.state === "deterministic_physical_pending") {
        assert.ok(Number.isSafeInteger(entry.issue) && entry.issue! > 0, `physical-pending row lacks issue: ${row.id}/${transport}`);
        assert.ok(entry.physicalCommand, `physical-pending row lacks acceptance command: ${row.id}/${transport}`);
      }
      if (entry.state === "planned") {
        assert.ok(Number.isSafeInteger(entry.issue) && entry.issue! > 0, `planned row lacks issue: ${row.id}/${transport}`);
        assert.ok(entry.reason, `planned row lacks bounded reason: ${row.id}/${transport}`);
      }
      if (entry.state === "unsupported") {
        assert.ok(entry.reason, `unsupported row lacks bounded reason: ${row.id}/${transport}`);
        assert.equal(entry.deterministicTests, undefined, `unsupported row must not imply positive coverage: ${row.id}/${transport}`);
      }
      if (entry.physicalCommand) assertAcceptanceCommand(entry.physicalCommand);
    }
  }
});

test("component support matrix tracks every P0 high-risk failure-injection category", async () => {
  const required = new Set([
    "capture_transient_failure",
    "input_transient_failure",
    "exact_target_authority_loss",
    "reconnect_and_stale_generation",
    "consumer_restart",
    "completion_observer_failure",
    "diagnostic_observer_failure",
    "runtime_revoke_failure_retry"
  ]);
  const actual = new Set(matrix.highRiskFailureGates.map((gate) => gate.category));
  assert.deepEqual(actual, required);
  for (const gate of matrix.highRiskFailureGates) await assertTrackedTest(gate.test);
});


test("component support matrix indexes canonical acceptance evidence independently of consumers", () => {
  const rows = new Map(matrix.rows.map((row) => [row.id, row]));
  const seen = new Set<string>();
  for (const evidence of matrix.acceptanceEvidence) {
    const row = rows.get(evidence.rowId);
    assert.ok(row, `acceptance evidence references unknown row: ${evidence.rowId}`);
    const entry = row!.transports[evidence.transport];
    assert.ok(entry, `acceptance evidence references unknown transport: ${evidence.rowId}/${evidence.transport}`);
    const key = `${evidence.rowId}/${evidence.transport}`;
    assert.equal(seen.has(key), false, `duplicate acceptance evidence: ${key}`);
    seen.add(key);
    assert.ok(evidence.evidence.length >= 12, `acceptance evidence is too vague: ${key}`);
    if (evidence.command) {
      assert.equal(entry.physicalCommand, evidence.command, `acceptance command drifted: ${key}`);
      assertAcceptanceCommand(evidence.command);
    }
    if (entry.state === "deterministic_physical_pending") {
      assert.equal(evidence.status, "pending", `physical-pending row must remain pending: ${key}`);
      assert.equal(evidence.issue, entry.issue, `physical-pending issue drifted: ${key}`);
    }
    if ((entry.state === "supported" || entry.state === "supported_if_configured") && entry.physicalCommand) {
      assert.equal(evidence.status, "passed", `claimed physical command lacks passed evidence: ${key}`);
    }
  }

  for (const row of matrix.rows) {
    for (const [transport, entry] of Object.entries(row.transports)) {
      if (entry.physicalCommand) {
        assert.ok(seen.has(`${row.id}/${transport}`), `physical command lacks indexed evidence: ${row.id}/${transport}`);
      }
    }
  }

  for (const required of [
    "browser-macos-bounded/webrtc_direct",
    "browser-macos-bounded/webrtc_relay",
    "browser-linux-exact-window/webrtc_direct",
    "browser-linux-exact-window/websocket_wss",
    "window-macos-ordinary/webrtc_direct",
    "window-macos-ordinary/websocket_wss",
    "window-macos-local-authentication/webrtc_direct",
    "window-macos-local-authentication/websocket_wss",
    "window-macos-successor-lineage/webrtc_direct",
    "window-macos-successor-lineage/websocket_wss",
    "window-linux-exact-x11/webrtc_direct",
    "window-linux-exact-x11/websocket_wss",
    "terminal-consumer-pty/webrtc_direct"
  ]) {
    assert.ok(seen.has(required), `minimum physical/real acceptance evidence missing: ${required}`);
  }
});

test("component support matrix closes auth UX scope with synthetic no-secret gates", async () => {
  assert.deepEqual(matrix.authUxPolicy, {
    secureFormCredentialBroker: "out_of_scope",
    modeSwitch: "unsupported",
    sessionPersistenceOwner: "consumer_provider",
    semanticVerificationOwner: "consumer"
  });
  const required = new Set([
    "manual_completion_and_verification_outcomes",
    "cancellation",
    "expiry",
    "transport_loss",
    "stale_generation",
    "observation_isolation_and_mode_switch"
  ]);
  const actual = new Set(matrix.authUxGates.map((gate) => gate.category));
  assert.deepEqual(actual, required);
  for (const gate of matrix.authUxGates) await assertTrackedTest(gate.test);
});
