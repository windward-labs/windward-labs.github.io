import test from 'node:test';
import assert from 'node:assert/strict';
import {creditActivity} from '../src/services/portal/credit-activity.mjs';

const row = (id,task_id,credits,kind='work') => ({id,task_id,credits,kind,note:'Original charge',created_at:'2026-10-04T12:00:00Z'});
const entry = (id,task_id,credits,month,kind='allocation') => ({id,task_id,credits,kind,note:`${month} work`,occurred_at:`2026-${month}-01T00:00:00Z`});

test('reallocated activity shows August 160 and September 67 instead of October project debits, preserving totals and source data',()=>{
  const ledger=[row('work:career','career',-87),row('work:cards','cards',-72),row('work:site','site',-48),row('work:invite','invite',-20)];
  const entries=[entry('career-aug','career',81,'08'),entry('career-sep','career',6,'09'),entry('cards-aug','cards',40,'08'),entry('cards-sep','cards',32,'09'),entry('site-aug','site',19,'08'),entry('site-sep','site',29,'09'),entry('invite-aug','invite',20,'08')];
  const before=structuredClone({ledger,entries});
  const activity=creditActivity(ledger,entries);
  assert.equal(activity.length,7);
  assert.equal(activity.filter(row=>row.occurred_at.startsWith('2026-08')).reduce((sum,row)=>sum-row.credits,0),160);
  assert.equal(activity.filter(row=>row.occurred_at.startsWith('2026-09')).reduce((sum,row)=>sum-row.credits,0),67);
  assert.equal(activity.some(row=>row.occurred_at.startsWith('2026-10')),false);
  assert.equal(activity.reduce((sum,row)=>sum+row.credits,0),-227);
  assert.deepEqual({ledger,entries},before);
  assert.ok(activity.every(row=>row.allocation && row.created_at.startsWith('2026-10')));
});
test('additional debits use corrected entry dates; purchases, refunds and invoice document IDs are retained',()=>{
  const ledger=[row('work:p','p',-8),row('work-entry:extra','p',-4),row('payment',null,16,'purchase'),row('refund:p','p',12,'refund'),row('invoice:i',null,8,'billing')];
  const entries=[entry('allocation','p',8,'08'),entry('extra','p',4,'09','debit')];
  const activity=creditActivity(ledger,entries);
  assert.equal(activity.find(row=>row.id==='work-entry:extra').occurred_at,'2026-09-01T00:00:00Z');
  for(const id of ['payment','refund:p','invoice:i'])assert.deepEqual(activity.find(row=>row.id===id),ledger.find(row=>row.id===id));
  assert.equal(activity.reduce((sum,row)=>sum+row.credits,0),ledger.reduce((sum,row)=>sum+row.credits,0));
});
test('missing or incomplete allocations retain the original debit without duplicate displayed charges',()=>{
  const ledger=[row('work:p','p',-8)];
  assert.deepEqual(creditActivity(ledger),ledger);
  assert.deepEqual(creditActivity(ledger,[entry('partial','p',4,'08')]),ledger);
  assert.deepEqual(creditActivity(ledger,[entry('wrong-project','other',8,'08')]),ledger);
});
