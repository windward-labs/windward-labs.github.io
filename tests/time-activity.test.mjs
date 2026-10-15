import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarMonth,shiftMonth,timeActivity,workDay} from '../src/services/portal/time-activity.mjs';

const email='me@windwardlabs.xyz';
const entry=(id,extra={})=>({id,task_id:'task',actor_email:email,occurred_at:'2026-10-12T12:00:00Z',hours:1,note:'Design',...extra});
test('activity includes hourly, allocated, fixed-price and completed project time across clients without counting progress or charges',()=>{
  const clients=[{id:'a',name:'Acme',tasks:[{id:'task',title:'Website',status:'completed'}],
    workEntries:[entry('hourly'),entry('allocated',{kind:'allocation',hours:2}),entry('colleague',{actor_email:'other@example.com'}),entry('unknown',{actor_email:undefined}),entry('invalid',{occurred_at:'bad'}),entry('zero',{hours:0})],
    updates:[entry('summary')],projectCharges:[entry('charge')],
    timeEntries:[entry('private',{hours:3})]},
    {id:'b',name:'Studio',tasks:[],timeEntries:[entry('older',{occurred_at:'2026-09-01T12:00:00Z'})]}];
  const activity=timeActivity(clients,email);
  assert.equal(activity.length,4);
  assert.equal(activity.filter(item=>item.clientId==='a').reduce((sum,item)=>sum+item.hours,0),6);
  assert.equal(activity[0].taskTitle,'Website');
  assert.equal(activity.at(-1).clientName,'Studio');
  assert.equal(activity.at(-1).taskTitle,'Project');
  assert.deepEqual(timeActivity([],email),[]);
});
test('work dates follow the local logging date around midnight and daylight saving changes',()=>{
  const previous=process.env.TZ;
  try {
    process.env.TZ='America/Los_Angeles';
    assert.equal(workDay('2026-10-14T06:59:00Z'),'2026-10-13');
    assert.equal(workDay('2026-10-14T07:00:00Z'),'2026-10-14');
    assert.equal(workDay('2026-11-01T07:00:00Z'),'2026-11-01');
    assert.equal(workDay('2026-11-02T08:00:00Z'),'2026-11-02');
    assert.equal(workDay('bad'),'');
  } finally { if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous; }
});
test('calendar aligns weekdays, handles leap years and navigates across years',()=>{
  const october=calendarMonth('2026-10');
  assert.deepEqual(october.slice(0,5),[null,null,null,null,'2026-10-01']);
  assert.equal(october.at(-1),'2026-10-31');
  assert.equal(calendarMonth('2024-02').filter(Boolean).length,29);
  assert.equal(calendarMonth('2026-02').filter(Boolean).length,28);
  assert.equal(shiftMonth('2026-01',-1),'2025-12');
  assert.equal(shiftMonth('2026-12',1),'2027-01');
});
