import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleApi } from '../backend/api.mjs';
import { actorFromPrivyUser, authenticate } from '../backend/auth.mjs';
import { isStaffEmail, PortalError } from '../backend/domain.mjs';
import worker from '../backend/worker.mjs';
import Stripe from 'stripe';
import { fulfillCheckout, handleStripeWebhook } from '../backend/stripe.mjs';

const staff = {id:'did:privy:staff',email:'phil@windwardlabs.xyz',staff:true};
const contact = {id:'did:privy:client',email:'alex@example.com',staff:false};
const outsider = {id:'did:privy:other',email:'other@example.com',staff:false};
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../backend/migrations/0001_portal.sql',import.meta.url),'utf8'));
  const wrap = (sql,values=[]) => ({
    bind(...args) { return wrap(sql,args); },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return {results:sqlite.prepare(sql).all(...values)}; },
    async run() { return {meta:sqlite.prepare(sql).run(...values)}; },
  });
  const DB = {prepare:wrap,async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results=[]; for (const statement of statements) results.push(await statement.all()); sqlite.exec('COMMIT'); return results; }
    catch(error) { sqlite.exec('ROLLBACK'); throw error; }
  }};
  async function call(actor,path,method='GET',body) {
    const response = await handleApi(new Request(`https://api.example.com/v1${path}`,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}),{DB},async()=>{ if (!actor) throw new PortalError(401,'Sign in.'); return actor; });
    return {status:response.status,data:await response.json()};
  }
  async function client() {
    const id=crypto.randomUUID();
    assert.equal((await call(staff,'/clients','POST',{id,name:'Example Studio',email:contact.email})).status,201);
    return id;
  }
  async function fund(id,reference='pi_payment1',credits=16) { return call(staff,`/clients/${id}/purchases`,'POST',{credits,reference,note:'Confirmed successful payment in Stripe'}); }
  function work(credits=4) { return {id:crypto.randomUUID(),title:'Review onboarding',description:'Review the flow requested by email.',requestedBy:contact.email,source:'email',credits,status:'in_progress'}; }
  return {sqlite,DB,call,client,fund,work};
}

function paidSession(clientId) {
  return {id:'cs_test_purchase',livemode:false,mode:'payment',payment_link:'plink_test',client_reference_id:clientId,
    payment_status:'paid',status:'complete',payment_intent:'pi_automatic',currency:'usd',amount_subtotal:120000,
    total_details:{amount_discount:0,amount_tax:5000},
    line_items:{has_more:false,data:[{price:{id:'price_1UMiLILFTZ7EIElEShnvpadu'},quantity:1,currency:'usd',amount_subtotal:120000,amount_discount:0,amount_total:125000}]}};
}
const testStripeEnv = {STRIPE_MODE:'test',STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_WEBHOOK_SECRET:'whsec_test'};

test('portal advertises automatic purchases only with a key matching the configured environment',async()=>{
  const f=fixture();
  for (const [config,enabled] of [[{},false],[testStripeEnv,true],[{STRIPE_MODE:'live',STRIPE_SECRET_KEY:'sk_test_fake'},false]]) {
    const response=await handleApi(new Request('https://api.example.com/v1/me'),{DB:f.DB,...config},async()=>contact);
    assert.equal((await response.json()).automaticPayments,enabled);
  }
  f.sqlite.close();
});

test('Stripe fulfillment verifies paid catalog packs and credits once across concurrent callback/webhook retries',async()=>{
  const f=fixture(), clientId=await f.client(), session=paidSession(clientId);
  const stripe={checkout:{sessions:{retrieve:async()=>structuredClone(session)}}};
  await Promise.all([fulfillCheckout(testStripeEnv,f.DB,session.id,clientId,stripe),fulfillCheckout(testStripeEnv,f.DB,session.id,undefined,stripe)]);
  await fulfillCheckout(testStripeEnv,f.DB,session.id,clientId,stripe);
  const account=(await f.call(contact,`/clients/${clientId}`)).data;
  assert.equal(account.balance,16); assert.equal(account.ledger.length,1);
  assert.equal(account.ledger[0].reference,'pi_automatic');
  f.sqlite.close();
});

test('unpaid, mismatched, and unsupported Stripe sessions never award credits',async()=>{
  const f=fixture(), clientId=await f.client();
  const verify = session=>fulfillCheckout(testStripeEnv,f.DB,'cs_test_purchase',clientId,{checkout:{sessions:{retrieve:async()=>session}}});
  assert.equal((await verify({...paidSession(clientId),payment_status:'unpaid'})).status,'pending');
  assert.equal((await verify({...paidSession(clientId),payment_status:'unpaid',status:'expired'})).status,'failed');
  for (const override of [{livemode:true},{client_reference_id:crypto.randomUUID()},{amount_subtotal:1},{total_details:{amount_discount:1}}]) {
    await assert.rejects(verify({...paidSession(clientId),...override}));
  }
  for (const override of [{quantity:2},{amount_discount:100},{currency:'eur'}]) {
    const session=paidSession(clientId); Object.assign(session.line_items.data[0],override);
    await assert.rejects(verify(session));
  }
  const unsupported=paidSession(clientId); unsupported.line_items.data[0].price.id='price_unrecognized';
  assert.equal((await verify(unsupported)).status,'ignored');
  assert.equal((await f.call(contact,`/clients/${clientId}`)).data.balance,0);
  assert.equal((await f.call(outsider,`/clients/${clientId}/checkout`,'POST',{sessionId:'cs_test_purchase'})).status,404);
  f.sqlite.close();
});

test('Stripe webhook rejects tampering and stale signatures, and accepts signed unrelated events without writes',async()=>{
  const payload=JSON.stringify({id:'evt_test',type:'customer.created',livemode:false,data:{object:{id:'cus_test'}}});
  const signature=Stripe.webhooks.generateTestHeaderString({payload,secret:testStripeEnv.STRIPE_WEBHOOK_SECRET});
  const send=(body,header)=>handleStripeWebhook(new Request('https://api.example.com/v1/stripe/webhook',{method:'POST',headers:{'Stripe-Signature':header},body}),testStripeEnv);
  assert.equal((await send(payload,signature)).status,200);
  assert.equal((await send(payload+' ',signature)).status,400);
  const stale=Stripe.webhooks.generateTestHeaderString({payload,secret:testStripeEnv.STRIPE_WEBHOOK_SECRET,timestamp:Math.floor(Date.now()/1000)-600});
  assert.equal((await send(payload,stale)).status,400);
});

test('staff authority uses a verified exact Windward email domain from Privy',()=>{
  assert.equal(isStaffEmail(' Phil@WindwardLabs.xyz '),true);
  for (const email of ['phil@windwardlabs.xyz.attacker.com','phil@evilwindwardlabs.xyz','windwardlabs.xyz@example.com']) assert.equal(isStaffEmail(email),false);
  const user={id:staff.id,linked_accounts:[{type:'email',address:staff.email,latest_verified_at:123}]};
  assert.deepEqual(actorFromPrivyUser(user),staff);
  assert.throws(()=>actorFromPrivyUser({...user,linked_accounts:[{type:'email',address:staff.email,latest_verified_at:null}]}),/verified email/);
  assert.throws(()=>actorFromPrivyUser({...user,linked_accounts:[{type:'google_oauth',email:staff.email,latest_verified_at:123}]}),/verified email/);
});

test('missing access tokens fail closed before any Privy network request',async()=>{
  await assert.rejects(authenticate(new Request('https://api.example.com'),{PRIVY_APP_ID:'app',PRIVY_APP_SECRET:'secret'}),error=>error.status===401);
  await assert.rejects(authenticate(new Request('https://api.example.com'),{}),error=>error.status===503);
});

test('clients see only assigned accounts; URL IDs and posted roles cannot grant access',async()=>{
  const f=fixture(); const id=await f.client();
  assert.equal((await f.call(null,'/clients')).status,401);
  assert.equal((await f.call(contact,'/clients')).data.clients.length,1);
  assert.equal((await f.call(outsider,'/clients')).data.clients.length,0);
  assert.equal((await f.call(outsider,`/clients/${id}`)).status,404);
  assert.equal((await f.call(contact,`/clients/${id}/tasks`,'POST',{...f.work(),role:'staff',email:staff.email})).status,403);
  assert.equal((await f.call(contact,`/clients/${id}/purchases`,'POST',{credits:64,reference:'pi_spoof',note:'Paid'})).status,403);
  assert.equal((await f.call(contact,'/clients','POST',{id:crypto.randomUUID(),name:'Spoof',email:contact.email})).status,403);
  f.sqlite.close();
});

test('work deducts once, progress is free, cancellation refunds once and preserves audit attribution',async()=>{
  const f=fixture(), id=await f.client(), task=f.work();
  assert.equal((await f.fund(id)).data.balance,16);
  assert.equal((await f.call(staff,`/clients/${id}/tasks`,'POST',task)).data.balance,12);
  assert.equal((await f.call(staff,`/clients/${id}/tasks`,'POST',task)).data.balance,12);
  const progress={id:crypto.randomUUID(),status:'completed',note:'Review delivered.'};
  const completed=await f.call(staff,`/clients/${id}/tasks/${task.id}`,'PATCH',progress);
  assert.equal(completed.data.balance,12);
  assert.equal(completed.data.updates.length,1);
  assert.equal((await f.call(staff,`/clients/${id}/tasks/${task.id}`,'PATCH',progress)).data.updates.length,1);
  const secondStaff={id:'did:privy:colleague',email:'team@windwardlabs.xyz',staff:true};
  const cancel={id:crypto.randomUUID(),status:'cancelled',note:'Work cancelled by agreement.'};
  const cancelled=await f.call(secondStaff,`/clients/${id}/tasks/${task.id}`,'PATCH',cancel);
  assert.equal(cancelled.data.balance,16);
  assert.equal(cancelled.data.tasks[0].created_by,staff.id);
  assert.equal(cancelled.data.ledger.find(row=>row.kind==='refund').created_by,secondStaff.id);
  assert.equal((await f.call(secondStaff,`/clients/${id}/tasks/${task.id}`,'PATCH',cancel)).data.balance,16);
  assert.equal((await f.call(staff,`/clients/${id}/tasks/${task.id}`,'PATCH',{...cancel,id:crypto.randomUUID()})).status,409);
  assert.equal(cancelled.data.ledger.length,3);
  f.sqlite.close();
});

test('overdrafts roll back the work record, charge, and balance; competing charges cannot overspend',async()=>{
  const f=fixture(), id=await f.client(); await f.fund(id);
  assert.equal((await f.call(staff,`/clients/${id}/tasks`,'POST',f.work(17))).status,409);
  let detail=(await f.call(contact,`/clients/${id}`)).data;
  assert.equal(detail.balance,16); assert.equal(detail.tasks.length,0); assert.equal(detail.ledger.length,1);
  const results=await Promise.all([f.call(staff,`/clients/${id}/tasks`,'POST',f.work(12)),f.call(staff,`/clients/${id}/tasks`,'POST',f.work(12))]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  detail=(await f.call(contact,`/clients/${id}`)).data;
  assert.equal(detail.balance,4); assert.equal(detail.tasks.length,1); assert.equal(detail.ledger.length,2);
  f.sqlite.close();
});

test('Stripe payment references cannot be applied twice or to two clients',async()=>{
  const f=fixture(), id=await f.client(), other=await f.client();
  assert.equal((await f.fund(id)).data.balance,16);
  assert.equal((await f.fund(id)).data.balance,16);
  assert.equal((await f.fund(other)).status,409);
  assert.equal((await f.fund(id,'pi_payment1',32)).status,409);
  assert.equal((await f.fund(id,'cs_samePayment')).status,400);
  assert.equal((await f.fund(id,'pi_payment2',17)).status,400);
  f.sqlite.close();
});

test('revoking an email removes access immediately while work and credits remain',async()=>{
  const f=fixture(), id=await f.client(); await f.fund(id); await f.call(staff,`/clients/${id}/tasks`,'POST',f.work());
  assert.equal((await f.call(staff,`/clients/${id}/members`,'DELETE',{email:contact.email})).status,200);
  assert.equal((await f.call(contact,`/clients/${id}`)).status,404);
  assert.equal((await f.call(contact,'/clients')).data.clients.length,0);
  assert.equal((await f.call(staff,`/clients/${id}`)).data.balance,12);
  assert.equal((await f.call(staff,`/clients/${id}`)).data.tasks.length,1);
  assert.equal((await f.call(staff,`/clients/${id}/members`,'POST',{email:contact.email})).status,200);
  assert.equal((await f.call(contact,`/clients/${id}`)).status,200);
  f.sqlite.close();
});

test('invalid work quantities and duplicate IDs do not create charges',async()=>{
  const f=fixture(), id=await f.client(); await f.fund(id);
  for (const credits of [-1,0,1.5,10001,'4']) assert.equal((await f.call(staff,`/clients/${id}/tasks`,'POST',f.work(credits))).status,400);
  const task=f.work(); await f.call(staff,`/clients/${id}/tasks`,'POST',task);
  assert.equal((await f.call(staff,`/clients/${id}/tasks`,'POST',{...task,credits:8})).status,409);
  assert.equal((await f.call(staff,`/clients/${id}`)).data.balance,12);
  assert.throws(()=>f.sqlite.prepare('UPDATE ledger SET credits=100').run(),/immutable/);
  assert.throws(()=>f.sqlite.prepare('UPDATE tasks SET credits=8').run(),/immutable/);
  f.sqlite.close();
});

test('worker allows only configured browser origins and never caches private responses',async()=>{
  const env={DB:{},PRIVY_APP_ID:'app',PRIVY_APP_SECRET:'secret',ALLOWED_ORIGINS:'https://windwardlabs.xyz'};
  const rejected=await worker.fetch(new Request('https://api.example.com/v1/me',{headers:{Origin:'https://attacker.example'}}),env);
  assert.equal(rejected.status,403);
  const preflight=await worker.fetch(new Request('https://api.example.com/v1/me',{method:'OPTIONS',headers:{Origin:'https://windwardlabs.xyz'}}),env);
  assert.equal(preflight.status,204);
  const unauthorized=await worker.fetch(new Request('https://api.example.com/v1/me',{headers:{Origin:'https://windwardlabs.xyz'}}),env);
  assert.equal(unauthorized.status,401);
  assert.equal(unauthorized.headers.get('Access-Control-Allow-Origin'),'https://windwardlabs.xyz');
  assert.equal(unauthorized.headers.get('Cache-Control'),'no-store');
});
