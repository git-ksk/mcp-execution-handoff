import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defineExecutionAdapter, ExecutionHandoffRuntime, HandoffCheckpointError, SignedFileHandoffCheckpointStore, type CheckpointableIntervention, type ExecutionHandoffAdapter, type ResumePolicy } from "../src/core/index.js";
type I=CheckpointableIntervention; type D={epoch:number;resumePolicy:ResumePolicy};
class Adapter implements ExecutionHandoffAdapter<I,D>{ active:I|undefined={id:"i1",status:"human_active",epoch:4,resumePolicy:"replay_safe",updatedAt:12000}; getResourceEpoch(){return this.active?.epoch??5;} getActiveIntervention(){return this.active?{...this.active}:undefined;} claimHumanControl(){return {...this.active!};} markHumanControlComplete(){return {...this.active!};} async verifyHumanIntervention(){return {...this.active!};} resumeAfterHumanIntervention(){return {epoch:this.getResourceEpoch(),resumePolicy:"revalidate" as const};} cancelHumanIntervention(){this.active=undefined;} }
function temp(now=13000){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"handoff-"));const file=path.join(dir,"checkpoint.json");return{dir,file,store:new SignedFileHandoffCheckpointStore(file,Buffer.alloc(32,8),()=>now)}}
test("durable recovery is principal-bound and never restores stale authority or raw args",()=>{const {dir,file,store}=temp();try{const runtime=new ExecutionHandoffRuntime(defineExecutionAdapter("browser.test",new Adapter()),{checkpointStore:store,checkpointTtlMs:60000,now:()=>13000});runtime.checkpoint("principal-binding-a-1234567890","digest-value-123456");const r=runtime.recover("principal-binding-a-1234567890");assert.equal(r?.recovery,"reissue_and_revalidate");assert.equal(runtime.recover("principal-binding-b-1234567890"),undefined);const raw=fs.readFileSync(file,"utf8");assert.doesNotMatch(raw,/Tokyo|password|captcha|cookie|card/i);assert.equal("action" in (r??{}),false);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test("tampered and expired checkpoints fail closed",()=>{const {dir,file,store}=temp();try{const cp={version:1 as const,adapterKind:"browser.test",interventionId:"i1",status:"human_active" as const,epoch:4,resumePolicy:"replay_safe" as const,principalBinding:"principal-binding-a-1234567890",actionDigest:"digest-value-123456",updatedAt:12000,expiresAt:20000};store.write(cp);const env=JSON.parse(fs.readFileSync(file,"utf8"));env.checkpoint.epoch=999;fs.writeFileSync(file,JSON.stringify(env));assert.throws(()=>store.recover(),(e:unknown)=>e instanceof HandoffCheckpointError&&e.code==="CHECKPOINT_INVALID");fs.rmSync(file,{force:true});const expired=new SignedFileHandoffCheckpointStore(file,Buffer.alloc(32,8),()=>30000);expired.write(cp);assert.throws(()=>expired.recover(),(e:unknown)=>e instanceof HandoffCheckpointError&&e.code==="CHECKPOINT_EXPIRED");}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test("checkpoint persistence failure releases Human authority",()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),"handoff-fail-"));const blocker=path.join(dir,"file");fs.writeFileSync(blocker,"x");try{const adapter=new Adapter();const runtime=new ExecutionHandoffRuntime(defineExecutionAdapter("browser.test",adapter),{checkpointStore:new SignedFileHandoffCheckpointStore(path.join(blocker,"checkpoint.json"),Buffer.alloc(32,8)),checkpointTtlMs:60000});assert.throws(()=>runtime.checkpoint("principal-binding-a-1234567890","digest-value-123456"));assert.equal(adapter.getActiveIntervention(),undefined);}finally{fs.rmSync(dir,{recursive:true,force:true});}});


test("expired checkpoint is readable only for explicit operator revalidation after MAC verification",()=>{
  const {dir,file,store}=temp(30000);
  try {
    const cp={version:1 as const,adapterKind:"browser.test",interventionId:"i-expired",status:"human_active" as const,epoch:7,resumePolicy:"never_replay" as const,principalBinding:"principal-binding-expired-1234",actionDigest:"digest-expired-1234567890",updatedAt:12000,expiresAt:20000};
    store.write(cp);
    assert.throws(()=>store.recover(),(e:unknown)=>e instanceof HandoffCheckpointError&&e.code==="CHECKPOINT_EXPIRED");
    const recovered=store.recoverForOperatorRevalidation();
    assert.equal(recovered?.interventionId,"i-expired");
    assert.equal(recovered?.status,"human_active");
    assert.equal(recovered?.recovery,"reissue_and_revalidate");
    const envelope=JSON.parse(fs.readFileSync(file,"utf8"));
    envelope.checkpoint.epoch=8;
    fs.writeFileSync(file,JSON.stringify(envelope));
    assert.throws(()=>store.recoverForOperatorRevalidation(),(e:unknown)=>e instanceof HandoffCheckpointError&&e.code==="CHECKPOINT_INVALID");
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

class MemoryCheckpointStore {
  value: unknown;
  writes = 0;
  clears = 0;
  write(checkpoint: Readonly<import("../src/core/index.js").HandoffCheckpoint>): void {
    this.writes += 1;
    this.value = { ...checkpoint };
  }
  read(): unknown { return this.value; }
  clear(): void { this.clears += 1; this.value = undefined; }
}

test("provider-neutral in-memory store preserves reissue-and-revalidate recovery semantics", () => {
  const store = new MemoryCheckpointStore();
  const adapter = new Adapter();
  const runtime = new ExecutionHandoffRuntime(defineExecutionAdapter("browser.test", adapter), {
    checkpointStore: store,
    checkpointTtlMs: 60_000,
    now: () => 13_000
  });
  runtime.checkpoint("principal-binding-memory-123456", "digest-memory-1234567890");
  assert.equal(store.writes, 1);

  // Simulate process loss: the new runtime has no restored active intervention authority.
  const restartedAdapter = new Adapter();
  restartedAdapter.active = undefined;
  const restarted = new ExecutionHandoffRuntime(defineExecutionAdapter("browser.test", restartedAdapter), {
    checkpointStore: store,
    checkpointTtlMs: 60_000,
    now: () => 13_001
  });
  const recovered = restarted.recover("principal-binding-memory-123456");
  assert.equal(recovered?.recovery, "reissue_and_revalidate");
  assert.equal(recovered?.status, "human_active");
  assert.equal(restartedAdapter.getActiveIntervention(), undefined);
  assert.equal("requestState" in (recovered ?? {}), false);
  assert.equal("capability" in (recovered ?? {}), false);
});

test("runtime owns checkpoint schema and expiry validation for provider-neutral stores", () => {
  const principal = "principal-binding-store-validation";
  const base = {
    version: 1,
    adapterKind: "browser.test",
    interventionId: "i-store",
    status: "human_active",
    epoch: 4,
    resumePolicy: "revalidate",
    principalBinding: principal,
    updatedAt: 12_000,
    expiresAt: 20_000
  };
  const store = new MemoryCheckpointStore();
  const runtime = new ExecutionHandoffRuntime(defineExecutionAdapter("browser.test", new Adapter()), {
    checkpointStore: store,
    now: () => 13_000
  });

  store.value = { ...base, rawArgs: { password: "not-allowed" } };
  assert.throws(() => runtime.recover(principal), (error: unknown) =>
    error instanceof HandoffCheckpointError && error.code === "CHECKPOINT_INVALID");

  store.value = { ...base, expiresAt: 13_000 };
  assert.throws(() => runtime.recover(principal), (error: unknown) =>
    error instanceof HandoffCheckpointError && error.code === "CHECKPOINT_EXPIRED");

  store.value = { ...base, adapterKind: "terminal.test" };
  assert.equal(runtime.recover(principal), undefined);
  store.value = { ...base, principalBinding: "principal-binding-other-12345" };
  assert.equal(runtime.recover(principal), undefined);
});

test("generic checkpoint parser rejects execution, content, transport, and approval fields", async () => {
  const { parseHandoffCheckpoint } = await import("../src/core/index.js");
  const base = {
    version: 1 as const,
    adapterKind: "browser.test",
    interventionId: "i-shape",
    status: "human_active" as const,
    epoch: 4,
    resumePolicy: "never_replay" as const,
    principalBinding: "principal-binding-shape-12345",
    updatedAt: 12_000,
    expiresAt: 20_000
  };
  for (const forbidden of [
    "args", "rawArgs", "humanInput", "terminalContent", "browserContent", "framebuffer",
    "credential", "cookie", "token", "otp", "payment", "approvalReceipt", "capability",
    "requestState", "clientGeneration", "reconnectHandle", "sdp"
  ]) {
    assert.throws(() => parseHandoffCheckpoint({ ...base, [forbidden]: "secret" }),
      (error: unknown) => error instanceof HandoffCheckpointError && error.code === "CHECKPOINT_INVALID");
  }
});

test("provider-neutral store write failure still fences active Human authority synchronously", () => {
  class FailingStore extends MemoryCheckpointStore {
    override write(): void { throw new Error("store unavailable"); }
  }
  const adapter = new Adapter();
  const runtime = new ExecutionHandoffRuntime(defineExecutionAdapter("browser.test", adapter), {
    checkpointStore: new FailingStore(), checkpointTtlMs: 60_000, now: () => 13_000
  });
  assert.throws(() => runtime.checkpoint("principal-binding-write-fail-1234"), /store unavailable/);
  assert.equal(adapter.getActiveIntervention(), undefined);
});

test("provider-neutral store read and clear failures propagate instead of restoring or hiding authority state", () => {
  class ReadFailStore extends MemoryCheckpointStore {
    override read(): unknown { throw new Error("read unavailable"); }
  }
  const recoveringAdapter = new Adapter();
  recoveringAdapter.active = undefined;
  const recovering = new ExecutionHandoffRuntime(defineExecutionAdapter("browser.test", recoveringAdapter), {
    checkpointStore: new ReadFailStore(), now: () => 13_000
  });
  assert.throws(() => recovering.recover("principal-binding-read-fail-12345"), /read unavailable/);
  assert.equal(recoveringAdapter.getActiveIntervention(), undefined);

  class ClearFailStore extends MemoryCheckpointStore {
    override clear(): void { throw new Error("clear unavailable"); }
  }
  const activeAdapter = new Adapter();
  const clearing = new ExecutionHandoffRuntime(defineExecutionAdapter("browser.test", activeAdapter), {
    checkpointStore: new ClearFailStore(), now: () => 13_000
  });
  assert.throws(() => clearing.clearCheckpoint("principal-binding-clear-fail-1234"), /clear unavailable/);
  // Explicit clear is not an authority transition; failure is surfaced and the existing adapter
  // state is left unchanged rather than silently pretending durable state was removed.
  assert.equal(activeAdapter.getActiveIntervention()?.status, "human_active");
});
