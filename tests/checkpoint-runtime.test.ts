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
