import test from 'node:test';
import assert from 'node:assert/strict';
import {saveProgress} from '../src/services/portal/save-progress.mjs';

function fixture() {
  const entries=new Map(),updates=new Map(),files=new Map(),calls=[];
  const state={balance:0,failUpdate:false,failFile:false};
  const api=async(path,method,body)=>{
    calls.push({path,method,body});
    if(path.endsWith('/work-entries')) {
      if(!entries.has(body.id)){entries.set(body.id,body);state.balance-=body.credits;}
      else assert.deepEqual(body,entries.get(body.id));
    } else if(method==='PATCH') {
      if(state.failUpdate)throw Error('Update unavailable');
      updates.set(body.id,body);
    } else if(path.includes('/attachments/')) {
      if(state.failFile)throw Error('Upload unavailable');
      files.set(path,body);
    }
    return {balance:state.balance};
  };
  const args={api,clientId:'client',taskId:'project',id:'stable-id',status:'completed',note:'Client summary',hours:1.5,occurredAt:'2026-09-30T12:00:00Z',files:[{id:'file',file:'bytes'}]};
  return {state,args,calls,entries,updates,files};
}
test('progress hours are logged before status, with the selected date and credit conversion',async()=>{
  const f=fixture();const result=await saveProgress(f.args);
  assert.equal(result.balance,-6);assert.equal(f.entries.size,1);assert.equal(f.updates.size,1);assert.equal(f.files.size,1);
  assert.equal(f.calls[0].path.endsWith('/work-entries'),true);
  assert.equal(f.entries.get('stable-id').occurredAt,f.args.occurredAt);
  assert.equal(f.updates.get('stable-id').occurredAt,f.args.occurredAt);
});
test('retries after progress or attachment failure retain IDs and deduct credits once',async()=>{
  for(const phase of ['failUpdate','failFile']) {
    const f=fixture();f.state[phase]=true;
    await assert.rejects(saveProgress(f.args),/Retry with the same details/);
    assert.equal(f.state.balance,-6);
    f.state[phase]=false;await saveProgress(f.args);
    assert.equal(f.state.balance,-6);assert.equal(f.entries.size,1);assert.equal(f.updates.size,1);assert.equal(f.files.size,1);
  }
});
test('blank hours save only progress; invalid quantities and hours with cancellation cause no writes',async()=>{
  const f=fixture();await saveProgress({...f.args,hours:0,files:[]});
  assert.equal(f.state.balance,0);assert.equal(f.entries.size,0);assert.equal(f.updates.size,1);
  for(const invalid of [{hours:-1},{hours:0.1},{hours:2501},{status:'cancelled'}]) {
    const f=fixture();await assert.rejects(saveProgress({...f.args,...invalid}));assert.equal(f.calls.length,0);
  }
});
