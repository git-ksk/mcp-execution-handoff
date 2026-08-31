import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface ConsumerEvidenceRecord {
  consumerRepository: string;
  consumerRevision: string;
  handoffRevision: string;
  evidenceClass: "consumer_integration" | "physical_component" | "physical_consumer";
  result: "pass";
  validation: string[];
  summary: string;
  limitations: string;
}

interface ConsumerEvidenceDocument {
  schemaVersion: number;
  evidenceDate: string;
  records: ConsumerEvidenceRecord[];
}

const document = JSON.parse(
  await readFile("docs/consumer-compatibility-evidence.json", "utf8")
) as ConsumerEvidenceDocument;
const SHA = /^[0-9a-f]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const requiredConsumers = new Set([
  "git-ksk/maps-browser-mcp",
  "git-ksk/japan-cinema-browser-mcp",
  "git-ksk/computer-use-mcp-gateway"
]);

test("consumer compatibility ledger records exact immutable revisions for all established consumers", () => {
  assert.equal(document.schemaVersion, 1);
  assert.match(document.evidenceDate, ISO_DATE);
  const observed = new Set<string>();

  for (const record of document.records) {
    assert.ok(requiredConsumers.has(record.consumerRepository), `unknown consumer ${record.consumerRepository}`);
    assert.equal(observed.has(record.consumerRepository), false, `duplicate consumer ${record.consumerRepository}`);
    observed.add(record.consumerRepository);
    assert.match(record.consumerRevision, SHA);
    assert.match(record.handoffRevision, SHA);
    assert.equal(record.result, "pass");
    assert.ok(["consumer_integration", "physical_component", "physical_consumer"].includes(record.evidenceClass));
    assert.ok(record.validation.length > 0);
    assert.ok(record.validation.every((value) => value.length > 8 && !/\blatest\b/i.test(value)));
    assert.ok(record.summary.length > 24);
    assert.ok(record.limitations.length > 24, "each record must state what it does not prove");
  }

  assert.deepEqual(observed, requiredConsumers);
});
