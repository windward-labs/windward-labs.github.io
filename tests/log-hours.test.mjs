import test from 'node:test';
import assert from 'node:assert/strict';
import {canLogHours,logHours,staffProjects} from '../src/services/portal/log-hours.mjs';

const task={id:'project',title:'Design system',status:'in_progress',billing_mode:'entries',pricing_model:'hourly'};
const args={clientId:'client',task,id:'stable-id',hours:0.5,occurredAt:'2026-09-30T12:00:00Z',note:''};
test('quick logging creates only a dated work entry, without changing project status',async()=>{
  const calls=[];
  const api=async(...call)=>{calls.push(call);return {balance:-2};};
  assert.deepEqual(await logHours({...args,api}),{balance:-2});
  assert.deepEqual(calls,[['/clients/client/tasks/project/work-entries','POST',{id:'stable-id',hours:0.5,occurredAt:args.occurredAt,note:'Work on Design system',credits:2}]]);
});
test('fixed-price hours use private time entries, with no charge',async()=>{
  const calls=[];
  await logHours({...args,task:{...task,pricing_model:'fixed'},note:'  Research  ',api:async(...call)=>calls.push(call)});
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'/clients/client/tasks/project/time-entries');
  assert.equal(calls[0][2].credits,undefined);
  assert.equal(calls[0][2].note,'Research');
});
test('invalid hours, future dates, cancelled and legacy hourly projects cause no writes',async()=>{
  let calls=0;
  for(const change of [{hours:0},{hours:-1},{hours:0.1},{hours:NaN},{hours:2500.25},{occurredAt:'invalid'},{occurredAt:'2999-01-01T00:00:00Z'},{task:{...task,status:'cancelled'}},{task:{...task,billing_mode:'legacy'}}]) {
    await assert.rejects(logHours({...args,...change,api:async()=>calls++}));
  }
  assert.equal(calls,0);
  assert.equal(canLogHours({...task,status:'completed'}),true);
});
test('same entry payload and ID can be retried after a lost response without a second charge',async()=>{
  const saved=new Map();let balance=0,fail=true;
  const api=async(path,method,body)=>{
    if(!saved.has(body.id)){saved.set(body.id,body);balance-=body.credits;}
    else assert.deepEqual(body,saved.get(body.id));
    if(fail){fail=false;throw Error('Response lost');}
    return {balance};
  };
  await assert.rejects(logHours({...args,api}));
  assert.deepEqual(await logHours({...args,api}),{balance:-2});
  assert.equal(saved.size,1);
});
test('recent projects and usual increments use only the signed-in staff member’s entries',()=>{
  const client={id:'client',name:'Acme',tasks:[task,{...task,id:'fixed',title:'Website',pricing_model:'fixed'},{...task,id:'unused',title:'App'}],workEntries:[
    {task_id:'project',actor_email:'me@example.com',hours:0.5,created_at:'2026-09-29T12:00:00Z'},
    {task_id:'project',actor_email:'me@example.com',hours:0.5,created_at:'2026-09-30T12:00:00Z'},
    {task_id:'unused',actor_email:'colleague@example.com',hours:8,created_at:'2026-10-07T12:00:00Z'},
  ],timeEntries:[{task_id:'fixed',actor_email:'me@example.com',hours:4,created_at:'2026-10-01T12:00:00Z',occurred_at:'2026-09-28T12:00:00Z'}]};
  const projects=staffProjects([client],'me@example.com');
  assert.deepEqual(projects.map(item=>item.task.id),['fixed','project','unused']);
  assert.equal(projects[0].frequent,4);
  assert.equal(projects[1].frequent,0.5);
  assert.equal(projects[2].recent,0);
  assert.equal(projects[2].frequent,undefined);
});

test('single work form saves the summary and attachments without changing project status',async()=>{
  const {saveWorkLog}=await import('../src/services/portal/log-hours.mjs');
  const calls=[];
  const api=async(path,method,body)=>{calls.push({path,method,body});return {id:'client',balance:-2};};
  const result=await saveWorkLog({...args,api,note:'Updated the component library',files:[{id:'file-id',file:'file-bytes'}]});
  assert.equal(result.balance,-2);
  assert.equal(calls[0].path,'/clients/client/tasks/project/work-entries');
  assert.equal(calls[1].method,'PATCH');
  assert.equal(calls[1].body.status,undefined);
  assert.equal(calls[1].body.note,'Updated the component library');
  assert.equal(calls[2].path,'/clients/client/tasks/project/attachments/file-id?update=stable-id');
  assert.equal(calls[3].method,undefined);
});
test('single work form validates summary before recording hours',async()=>{
  const {saveWorkLog}=await import('../src/services/portal/log-hours.mjs');
  let calls=0;
  for(const note of ['', '   ', 'a'.repeat(2001)])await assert.rejects(saveWorkLog({...args,api:async()=>calls++,note,files:[]}));
  assert.equal(calls,0);
});
test('retrying a partially saved work form preserves entry, summary, and attachment IDs',async()=>{
  const {saveWorkLog}=await import('../src/services/portal/log-hours.mjs');
  for(const phase of ['summary','attachment','refresh']) {
    const entries=new Map(),updates=new Map(),files=new Map();let fail=true,balance=0;
    const api=async(path,method,body)=>{
      if(path.endsWith('/work-entries')) {
        if(!entries.has(body.id)){entries.set(body.id,body);balance-=body.credits;}
        else assert.deepEqual(body,entries.get(body.id));
      } else if(method==='PATCH') {
        if(fail && phase==='summary')throw Error('Summary unavailable');
        updates.set(body.id,body);
      } else if(path.includes('/attachments/')) {
        if(fail && phase==='attachment')throw Error('Upload unavailable');
        files.set(path,body);
      } else if(fail && phase==='refresh')throw Error('Refresh unavailable');
      return {balance};
    };
    const input={...args,api,note:'Component library',files:[{id:'file-id',file:'bytes'}]};
    await assert.rejects(saveWorkLog(input));fail=false;
    await saveWorkLog(input);
    assert.equal(balance,-2);assert.equal(entries.size,1);assert.equal(updates.size,1);assert.equal(files.size,1);
  }
});
