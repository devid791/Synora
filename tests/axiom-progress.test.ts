import test from "node:test";
import assert from "node:assert/strict";
import { AxiomProgressTracker, hasFreshAxiomProgress } from "../src/engine/axiom-progress";
const sample = () => ({state:"available",observedAt:100000,data:{schema:"axiom_runtime_status_v1",model:"qwen",loaded:true,generation_busy:true,
  active_session_id:"owned",active_request_sequence:42,active_request_progress:{scope:"current_request_observed_work_not_durable_commit",phase:"prefill",
  revision:2001,prefill_tokens_processed:2000,prefill_tokens_total:9000,generated_tokens:0,seconds_since_advance:0.1}}});
test("Only fresh measured work from the exact model/session proves activity",()=>{
 assert.equal(hasFreshAxiomProgress(sample(),"owned","qwen",101000),true);
 for(const alter of [
  (v:any)=>v.state="unavailable", (v:any)=>v.observedAt=0, (v:any)=>v.observedAt=110000,
  (v:any)=>v.data.active_session_id="other", (v:any)=>v.data.model="other", (v:any)=>v.data.generation_busy=false,
  (v:any)=>v.data.active_request_progress=null, (v:any)=>v.data.active_request_progress.phase="queue",
  (v:any)=>v.data.active_request_progress.revision=0, (v:any)=>v.data.active_request_progress.seconds_since_advance=20,
  (v:any)=>v.data.active_request_progress.prefill_tokens_processed=0, (v:any)=>v.data.active_request_progress.prefill_tokens_processed=10000,
 ]){const v=sample();alter(v);assert.equal(hasFreshAxiomProgress(v,"owned","qwen",101000),false);}
});
test("Cached, repeated and regressive runtime samples cannot renew an idle budget",()=>{
 const tracker=new AxiomProgressTracker(),v=sample();
 assert.equal(tracker.accept(v,"owned","qwen",101000),true);
 assert.equal(tracker.accept(v,"owned","qwen",101000),false);
 v.data.active_request_progress.revision++;
 assert.equal(tracker.accept(v,"owned","qwen",101000),false);
 v.data.active_request_progress.prefill_tokens_processed++;
 assert.equal(tracker.accept(v,"owned","qwen",101000),true);
 v.data.active_request_sequence--;
 assert.equal(tracker.accept(v,"owned","qwen",101000),false);
 v.data.active_request_sequence+=2;
 assert.equal(tracker.accept(v,"owned","qwen",101000),true);
});
test("Alternating parent/child probes cannot replay either session's cached progress",()=>{
 const tracker=new AxiomProgressTracker(),parent=sample(),child=sample();
 child.data.active_session_id="owned-child";
 assert.equal(tracker.accept(parent,"owned","qwen",101000),true);
 assert.equal(tracker.accept(child,"owned-child","qwen",101000),true);
 assert.equal(tracker.accept(parent,"owned","qwen",101000),false);
 assert.equal(tracker.accept(child,"owned-child","qwen",101000),false);
 child.data.active_request_progress.revision++;
 child.data.active_request_progress.prefill_tokens_processed++;
 assert.equal(tracker.accept(child,"owned-child","qwen",101000),true);
});
