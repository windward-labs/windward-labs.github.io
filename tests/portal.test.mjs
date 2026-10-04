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
import { paymentDocument } from '../backend/payment-documents.mjs';
import { PDFDocument } from 'pdf-lib';
import { maxAttachmentBytes } from '../backend/attachments.mjs';
import { billingPreview, issueInvoice, refreshInvoice, voidInvoice, fulfillInvoiceEvent } from '../backend/billing.mjs';

const staff = {id:'did:privy:staff',email:'phil@windwardlabs.xyz',staff:true};
const contact = {id:'did:privy:client',email:'alex@example.com',staff:false};
const outsider = {id:'did:privy:other',email:'other@example.com',staff:false};
function fixture(extraEnv = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../backend/migrations/0001_portal.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../backend/migrations/0002_attachments.sql',import.meta.url),'utf8'));
  sqlite.exec('BEGIN');
  sqlite.exec(readFileSync(new URL('../backend/migrations/0003_overage_billing.sql',import.meta.url),'utf8'));
  sqlite.exec('COMMIT');
  sqlite.exec(readFileSync(new URL('../backend/migrations/0004_progress_attachments.sql',import.meta.url),'utf8'));
  let clock=new Date().toISOString();
  sqlite.function('strftime',{varargs:true},()=>clock);
  const wrap = (sql,values=[]) => ({
    bind(...args) { return wrap(sql,args); },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return {results:sqlite.prepare(sql).all(...values)}; },
    async run() { return {meta:sqlite.prepare(sql).run(...values)}; },
  });
  let batchTail=Promise.resolve();
  const DB = {prepare:wrap,batch(statements) {
    const result=batchTail.then(async()=>{
      sqlite.exec('BEGIN');
      try { const results=[]; for (const statement of statements) results.push(await statement.all()); sqlite.exec('COMMIT'); return results; }
      catch(error) { sqlite.exec('ROLLBACK'); throw error; }
    });
    batchTail=result.catch(()=>{});
    return result;
  }};
  async function call(actor,path,method='GET',body) {
    const response = await handleApi(new Request(`https://api.example.com/v1${path}`,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}),{DB,...testStripeEnv,...extraEnv},async()=>{ if (!actor) throw new PortalError(401,'Sign in.'); return actor; });
    return {status:response.status,data:await response.json()};
  }
  async function client() {
    const id=crypto.randomUUID();
    assert.equal((await call(staff,'/clients','POST',{id,name:'Example Studio',email:contact.email})).status,201);
    return id;
  }
  async function fund(id,reference='pi_payment1',credits=16) { return call(staff,`/clients/${id}/purchases`,'POST',{credits,reference,note:'Confirmed successful payment in Stripe'}); }
  function work(credits=4) { return {id:crypto.randomUUID(),title:'Review onboarding',description:'Review the flow requested by email.',requestedBy:contact.email,source:'email',credits,status:'in_progress'}; }
  async function file(actor,clientId,taskId,attachmentId,method='POST',bytes='file contents',headers={},updateId='') {
    return handleApi(new Request(`https://api.example.com/v1/clients/${clientId}/tasks/${taskId}/attachments/${attachmentId}${updateId ? `?update=${encodeURIComponent(updateId)}` : ''}`,{method,...(method==='POST'?{body:bytes,headers:{'X-File-Name':encodeURIComponent('design résumé.png'),'Content-Type':'image/png',...headers}}:{})}),{DB,...extraEnv},async()=>{ if (!actor) throw new PortalError(401,'Sign in.'); return actor; });
  }
  return {sqlite,DB,call,client,fund,work,file,at(value){clock=value;}};
}

function attachmentStorage() {
  const objects = new Map();
  return {objects,async put(key,bytes) { objects.set(key,bytes.slice()); },async get(key) { const bytes=objects.get(key); return bytes ? {body:bytes} : null; }};
}

test('attachments require staff uploads and current client membership for private downloads',async()=>{
  const bucket=attachmentStorage(), f=fixture({ATTACHMENTS:bucket}), clientId=await f.client(), otherId=await f.client(), task=f.work(), attachmentId=crypto.randomUUID();
  await f.fund(clientId); await f.call(staff,`/clients/${clientId}/tasks`,'POST',task);
  assert.equal((await f.file(null,clientId,task.id,attachmentId)).status,401);
  assert.equal((await f.file(contact,clientId,task.id,attachmentId)).status,403);
  assert.equal((await f.file(outsider,clientId,task.id,attachmentId)).status,404);
  assert.equal((await f.file(staff,otherId,task.id,attachmentId)).status,404);
  assert.equal(bucket.objects.size,0);
  assert.equal((await f.file(staff,clientId,task.id,attachmentId)).status,200);
  const detail=(await f.call(contact,`/clients/${clientId}`)).data;
  assert.equal(detail.balance,12); assert.equal(detail.attachments.length,1);
  assert.equal(detail.attachments[0].name,'design résumé.png');
  const downloaded=await f.file(contact,clientId,task.id,attachmentId,'GET');
  assert.equal(downloaded.status,200); assert.equal(await downloaded.text(),'file contents');
  assert.equal(downloaded.headers.get('Cache-Control'),'no-store');
  assert.equal(downloaded.headers.get('Content-Type'),'application/octet-stream');
  assert.equal(downloaded.headers.get('X-Content-Type-Options'),'nosniff');
  assert.match(downloaded.headers.get('Content-Disposition'),/^attachment;.*r%C3%A9sum%C3%A9/);
  assert.equal((await f.file(outsider,clientId,task.id,attachmentId,'GET')).status,404);
  assert.equal((await f.file(staff,otherId,task.id,attachmentId,'GET')).status,404);
  await f.call(staff,`/clients/${clientId}/members`,'DELETE',{email:contact.email});
  assert.equal((await f.file(contact,clientId,task.id,attachmentId,'GET')).status,404);
  f.sqlite.close();
});

test('attachment retries resume storage failures without duplicate files or charges and reject changed bytes',async()=>{
  const bucket=attachmentStorage(), put=bucket.put;
  bucket.put=async()=>{throw new Error('Storage temporarily unavailable');};
  const f=fixture({ATTACHMENTS:bucket}), clientId=await f.client(), task=f.work(), attachmentId=crypto.randomUUID();
  await f.fund(clientId); await f.call(staff,`/clients/${clientId}/tasks`,'POST',task);
  assert.equal((await f.file(staff,clientId,task.id,attachmentId)).status,500);
  assert.equal((await f.call(contact,`/clients/${clientId}`)).data.attachments.length,0);
  assert.equal((await f.file(contact,clientId,task.id,attachmentId,'GET')).status,404);
  bucket.put=put;
  await f.call(staff,`/clients/${clientId}/tasks`,'POST',task);
  assert.equal((await f.file(staff,clientId,task.id,attachmentId)).status,200);
  assert.equal((await f.file(staff,clientId,task.id,attachmentId)).status,200);
  assert.equal((await f.file(staff,clientId,task.id,attachmentId,'POST','different file')).status,409);
  const detail=(await f.call(contact,`/clients/${clientId}`)).data;
  assert.equal(detail.balance,12); assert.equal(detail.attachments.length,1); assert.equal(bucket.objects.size,1);
  f.sqlite.close();
});

test('attachment limits reject empty and oversized streams and cap concurrent uploads at five',async()=>{
  const bucket=attachmentStorage(), f=fixture({ATTACHMENTS:bucket}), clientId=await f.client(), task=f.work();
  await f.fund(clientId); await f.call(staff,`/clients/${clientId}/tasks`,'POST',task);
  assert.equal((await f.file(staff,clientId,task.id,crypto.randomUUID(),'POST','')).status,400);
  assert.equal((await f.file(staff,clientId,task.id,crypto.randomUUID(),'POST',new Uint8Array(maxAttachmentBytes+1))).status,413);
  assert.equal((await f.file(staff,clientId,task.id,crypto.randomUUID(),'POST','small',{'Content-Length':String(maxAttachmentBytes+1)})).status,413);
  assert.equal((await f.file(staff,clientId,task.id,crypto.randomUUID(),'POST','small',{'X-File-Name':'bad%0Aname'})).status,400);
  assert.equal(bucket.objects.size,0);
  const responses=await Promise.all(Array.from({length:6},()=>f.file(staff,clientId,task.id,crypto.randomUUID())));
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,200,200,200,200,409]);
  assert.equal((await f.call(contact,`/clients/${clientId}`)).data.attachments.length,5);
  assert.equal(bucket.objects.size,5);
  f.sqlite.close();
});

test('progress attachments belong to the saved update and enforce per-update limits and account access',async()=>{
  const bucket=attachmentStorage(), f=fixture({ATTACHMENTS:bucket}), clientId=await f.client(), otherId=await f.client(), task=f.work(), otherTask=f.work();
  await f.call(staff,`/clients/${clientId}/tasks`,'POST',task); await f.call(staff,`/clients/${otherId}/tasks`,'POST',otherTask);
  const update={id:crypto.randomUUID(),status:'in_progress',note:'Design exploration.'}, otherUpdate={...update,id:crypto.randomUUID()};
  await f.call(staff,`/clients/${clientId}/tasks/${task.id}`,'PATCH',update);
  await f.call(staff,`/clients/${otherId}/tasks/${otherTask.id}`,'PATCH',otherUpdate);
  const upload=(actor,attachmentId,updateId=update.id)=>f.file(actor,clientId,task.id,attachmentId,'POST','progress file',{},updateId);
  assert.equal((await upload(contact,crypto.randomUUID())).status,403);
  assert.equal((await upload(outsider,crypto.randomUUID())).status,404);
  assert.equal((await upload(staff,crypto.randomUUID(),otherUpdate.id)).status,404);
  assert.equal((await upload(staff,crypto.randomUUID(),crypto.randomUUID())).status,404);
  assert.equal((await upload(staff,crypto.randomUUID(),'invalid')).status,400);
  const rootId=crypto.randomUUID();assert.equal((await f.file(staff,clientId,task.id,rootId)).status,200);
  assert.equal((await upload(staff,rootId)).status,409);
  const ids=Array.from({length:6},()=>crypto.randomUUID());
  const responses=await Promise.all(ids.map(attachmentId=>upload(staff,attachmentId)));
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,200,200,200,200,409]);
  const savedId=ids[responses.findIndex(response=>response.status===200)];
  assert.equal((await upload(staff,savedId)).status,200);
  const detail=(await f.call(contact,`/clients/${clientId}`)).data;
  assert.equal(detail.attachments.filter(file=>file.update_id===update.id).length,5);
  assert.equal(detail.attachments.filter(file=>!file.update_id).length,1);
  assert.equal(detail.balance,-4);
  assert.equal((await f.file(contact,clientId,task.id,savedId,'GET')).status,200);
  f.sqlite.close();
});

test('a cancelled progress update can resume failed attachments without duplicating the update or refund',async()=>{
  const bucket=attachmentStorage(), put=bucket.put, f=fixture({ATTACHMENTS:bucket}), clientId=await f.client(), task=f.work();
  await f.call(staff,`/clients/${clientId}/tasks`,'POST',task);
  const update={id:crypto.randomUUID(),status:'cancelled',note:'Cancelled with supporting document.'}, attachmentId=crypto.randomUUID();
  await f.call(staff,`/clients/${clientId}/tasks/${task.id}`,'PATCH',update);
  bucket.put=async()=>{throw new Error('Temporary storage failure');};
  assert.equal((await f.file(staff,clientId,task.id,attachmentId,'POST','file contents',{},update.id)).status,500);
  bucket.put=put;
  await f.call(staff,`/clients/${clientId}/tasks/${task.id}`,'PATCH',update);
  assert.equal((await f.file(staff,clientId,task.id,attachmentId,'POST','file contents',{},update.id)).status,200);
  const detail=(await f.call(contact,`/clients/${clientId}`)).data;
  assert.equal(detail.balance,0);assert.equal(detail.updates.length,1);assert.equal(detail.ledger.filter(row=>row.kind==='refund').length,1);
  assert.equal(detail.attachments[0].update_id,update.id);
  f.sqlite.close();
});

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

test('work beyond prepaid credits is recorded atomically, including competing charges and safe retries',async()=>{
  const f=fixture(), id=await f.client(); await f.fund(id);
  const task=f.work(17);
  assert.equal((await f.call(staff,`/clients/${id}/tasks`,'POST',task)).status,200);
  assert.equal((await f.call(staff,`/clients/${id}/tasks`,'POST',task)).data.balance,-1);
  let detail=(await f.call(contact,`/clients/${id}`)).data;
  assert.equal(detail.balance,-1); assert.equal(detail.tasks.length,1); assert.equal(detail.ledger.length,2);
  const results=await Promise.all([f.call(staff,`/clients/${id}/tasks`,'POST',f.work(12)),f.call(staff,`/clients/${id}/tasks`,'POST',f.work(12))]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,200]);
  detail=(await f.call(contact,`/clients/${id}`)).data;
  assert.equal(detail.balance,-25); assert.equal(detail.tasks.length,3); assert.equal(detail.ledger.length,4);
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

function invoiceStripe() {
  const records=new Map(), keys=new Map(), calls=[];
  const once=(key,make)=>{if(!keys.has(key))keys.set(key,make());return structuredClone(keys.get(key));};
  const stripe={records,calls,failFinalize:false,
    customers:{async create(params,options){calls.push(['customer',params]);return once(options.idempotencyKey,()=>({id:`cus_${keys.size}`}));}},
    invoices:{
      async list({customer}){return {data:[...records.values()].filter(invoice=>invoice.customer===customer).map(invoice=>structuredClone(invoice))};},
      async create(params,options){calls.push(['invoice',params]);return once(options.idempotencyKey,()=>{
        const invoice={...params,id:`in_${records.size}`,livemode:false,status:'draft',subtotal:0,total:0,amount_paid:0,amount_remaining:0,lines:{has_more:false,data:[]}};
        records.set(invoice.id,invoice);return invoice;
      });},
      async retrieve(id){return structuredClone(records.get(id));},
      async finalizeInvoice(id,params){calls.push(['finalize',params]);if(stripe.failFinalize)throw new Error('Stripe temporarily unavailable');const invoice=records.get(id);invoice.status='open';invoice.number='TEST-0001';invoice.hosted_invoice_url='https://invoice.stripe.com/i/test';return structuredClone(invoice);},
      async voidInvoice(id){const invoice=records.get(id);invoice.status='void';return structuredClone(invoice);},
    },
    invoiceItems:{async create(params,options){return once(options.idempotencyKey,()=>{const invoice=records.get(params.invoice);invoice.lines.data.push({amount:params.amount});invoice.subtotal+=params.amount;invoice.total+=params.amount;invoice.amount_remaining=invoice.total;return {id:'ii_test'};});}},
  };
  return stripe;
}
async function overdueFixture() {
  const f=fixture(), clientId=await f.client();
  f.at('2025-01-15T12:00:00.000Z'); await f.fund(clientId);
  const task=f.work(24); await f.call(staff,`/clients/${clientId}/tasks`,'POST',task);
  f.at('2025-02-05T12:00:00.000Z');
  const draft={id:crypto.randomUUID(),period:'2025-01',email:contact.email,credits:8};
  return {...f,clientId,task,draft};
}

test('month-end drafts use server-calculated closed-period debt, reject duplicates and enforce staff access',async()=>{
  const f=await overdueFixture(), {clientId,draft}=f;
  const path=`/clients/${clientId}/invoices`;
  assert.deepEqual(await billingPreview(f.DB,clientId,draft.period),{period:'2025-01',cutoff:'2025-02-01T00:00:00.000Z',credits:8,amountCents:60000});
  assert.equal((await f.call(contact,path,'POST',draft)).status,403);
  assert.equal((await f.call(outsider,path,'POST',draft)).status,404);
  assert.equal((await f.call(contact,`/clients/${clientId}/billing?period=2025-01`)).status,403);
  assert.equal((await f.call(staff,path,'POST',{...draft,credits:9})).status,409);
  assert.equal((await f.call(staff,path,'POST',{...draft,period:new Date().toISOString().slice(0,7)})).status,400);
  assert.equal((await f.call(staff,path,'POST',draft)).status,200);
  assert.equal((await f.call(staff,path,'POST',draft)).data.invoices.length,1);
  assert.equal((await f.call(staff,path,'POST',{...draft,id:crypto.randomUUID()})).status,409);
  assert.equal((await f.call(contact,`/clients/${clientId}`)).data.invoices.length,0);
  assert.equal((await f.call(staff,`/clients/${clientId}`)).data.balance,-8);
  assert.equal((await f.call(contact,`${path}/${draft.id}/issue`,'POST')).status,403);
  assert.equal((await f.call(outsider,`${path}/${draft.id}/refresh`,'POST')).status,404);
  f.sqlite.close();
});

test('issuing transfers debt exactly once; invoice payment clears that debt without awarding credits twice',async()=>{
  const f=await overdueFixture(), {clientId,draft}=f, stripe=invoiceStripe();
  await f.call(staff,`/clients/${clientId}/invoices`,'POST',draft);
  await Promise.all([issueInvoice(testStripeEnv,f.DB,clientId,draft.id,stripe),issueInvoice(testStripeEnv,f.DB,clientId,draft.id,stripe)]);
  let detail=(await f.call(contact,`/clients/${clientId}`)).data;
  assert.equal(detail.balance,0); assert.equal(detail.invoiced_credits,8); assert.equal(detail.invoices[0].status,'open');
  assert.equal(detail.ledger.filter(entry=>entry.kind==='billing').length,1);
  assert.equal(stripe.records.size,1); assert.equal([...stripe.records.values()][0].lines.data.length,1);
  assert.equal((await billingPreview(f.DB,clientId,'2025-01')).credits,0);
  assert.equal(stripe.calls.find(([kind])=>kind==='invoice')[1].collection_method,'send_invoice');
  assert.equal(stripe.calls.find(([kind])=>kind==='invoice')[1].auto_advance,false);
  await f.call(staff,`/clients/${clientId}/tasks`,'POST',f.work(4));
  const invoice=[...stripe.records.values()][0]; invoice.status='paid';invoice.amount_paid=60000;invoice.amount_remaining=0;
  await Promise.all([refreshInvoice(testStripeEnv,f.DB,clientId,draft.id,stripe),fulfillInvoiceEvent(testStripeEnv,f.DB,invoice.id,stripe)]);
  await refreshInvoice(testStripeEnv,f.DB,clientId,draft.id,stripe);
  detail=(await f.call(contact,`/clients/${clientId}`)).data;
  assert.equal(detail.balance,-4); assert.equal(detail.invoiced_credits,0); assert.equal(detail.invoices[0].status,'paid');
  assert.equal(detail.ledger.filter(entry=>entry.kind==='billing').length,1);
  assert.equal((await billingPreview(f.DB,clientId,'2025-02')).credits,4);
  assert.equal((await billingPreview(f.DB,clientId,'2025-01')).credits,0);
  f.sqlite.close();
});

test('top-ups cover old overages; later work and cancellations cannot revive already covered month-end debt',async()=>{
  const f=await overdueFixture(), {clientId,draft}=f;
  await f.call(staff,`/clients/${clientId}/invoices`,'POST',draft);
  const newer=f.work(4);await f.call(staff,`/clients/${clientId}/tasks`,'POST',newer);
  await f.call(staff,`/clients/${clientId}/tasks/${newer.id}`,'PATCH',{id:crypto.randomUUID(),status:'cancelled',note:'Cancelled newer work.'});
  assert.equal((await billingPreview(f.DB,clientId,'2025-01')).credits,8);
  assert.equal((await f.fund(clientId,'pi_laterTopup',16)).status,200);
  await f.call(staff,`/clients/${clientId}/tasks`,'POST',f.work(20));
  assert.equal((await f.call(contact,`/clients/${clientId}`)).data.balance,-12);
  assert.equal((await billingPreview(f.DB,clientId,'2025-01')).credits,0);
  assert.equal((await billingPreview(f.DB,clientId,'2025-02')).credits,12);
  const stripe=invoiceStripe();
  await assert.rejects(issueInvoice(testStripeEnv,f.DB,clientId,draft.id,stripe),/outstanding credits changed/);
  assert.equal(stripe.records.size,0);
  f.sqlite.close();
});

test('Stripe failures resume a reserved invoice without re-transferring credits; invalid settlements fail closed',async()=>{
  const f=await overdueFixture(), {clientId,draft}=f, stripe=invoiceStripe();
  await f.call(staff,`/clients/${clientId}/invoices`,'POST',draft);
  stripe.failFinalize=true;
  await assert.rejects(issueInvoice(testStripeEnv,f.DB,clientId,draft.id,stripe),/temporarily unavailable/);
  assert.equal((await f.call(staff,`/clients/${clientId}`)).data.invoices[0].status,'issuing');
  stripe.failFinalize=false;
  await issueInvoice(testStripeEnv,f.DB,clientId,draft.id,stripe);
  assert.equal(stripe.records.size,1);
  const invoice=[...stripe.records.values()][0];
  for (const override of [{livemode:true},{total:1},{metadata:{}},{status:'paid',amount_paid:1}]) {
    const original=structuredClone(invoice);Object.assign(invoice,override);
    await assert.rejects(refreshInvoice(testStripeEnv,f.DB,clientId,draft.id,stripe));
    for(const name of Object.keys(invoice))delete invoice[name];Object.assign(invoice,original);
  }
  assert.equal((await f.call(contact,`/clients/${clientId}`)).data.invoiced_credits,8);
  f.sqlite.close();
});

test('voiding an unpaid bill restores unbilled debt once; cancelling billed work and its invoice leaves no debt',async()=>{
  const f=await overdueFixture(), {clientId,draft,task}=f, stripe=invoiceStripe();
  await f.call(staff,`/clients/${clientId}/invoices`,'POST',draft);
  await issueInvoice(testStripeEnv,f.DB,clientId,draft.id,stripe);
  await voidInvoice(testStripeEnv,f.DB,clientId,draft.id,stripe);
  await voidInvoice(testStripeEnv,f.DB,clientId,draft.id,stripe);
  let detail=(await f.call(contact,`/clients/${clientId}`)).data;
  assert.equal(detail.balance,-8);assert.equal(detail.invoiced_credits,0);
  assert.equal((await billingPreview(f.DB,clientId,'2025-01')).credits,8);
  const next={...draft,id:crypto.randomUUID()};
  await f.call(staff,`/clients/${clientId}/invoices`,'POST',next);
  await issueInvoice(testStripeEnv,f.DB,clientId,next.id,stripe);
  await f.call(staff,`/clients/${clientId}/tasks/${task.id}`,'PATCH',{id:crypto.randomUUID(),status:'cancelled',note:'Cancelled agreed work.'});
  await voidInvoice(testStripeEnv,f.DB,clientId,next.id,stripe);
  detail=(await f.call(contact,`/clients/${clientId}`)).data;
  assert.equal(detail.balance,16);assert.equal(detail.invoiced_credits,0);
  assert.equal((await billingPreview(f.DB,clientId,'2025-01')).credits,0);
  f.sqlite.close();
});

test('overage migration preserves existing client IDs, credits, work, members, attachments, and immutable ledger rows',async()=>{
  const db=new DatabaseSync(':memory:');
  for(const name of ['0001_portal.sql','0002_attachments.sql'])db.exec(readFileSync(new URL(`../backend/migrations/${name}`,import.meta.url),'utf8'));
  db.exec("INSERT INTO clients(id,name) VALUES('client','Existing'); INSERT INTO client_members VALUES('client','a@example.com'); INSERT INTO ledger(id,client_id,kind,credits,note,created_by,actor_email) VALUES('fund','client','purchase',16,'Paid','staff','a@example.com'); INSERT INTO tasks(id,client_id,title,description,requested_by,source,credits,status,created_by,actor_email) VALUES('work','client','Existing task','Work','A','email',4,'completed','staff','a@example.com'); INSERT INTO attachments(id,task_id,name,content_type,size,sha256,created_by,actor_email) VALUES('file','work','test.txt','text/plain',1,'hash','staff','a@example.com');");
  const before=db.prepare('SELECT * FROM ledger ORDER BY rowid').all();
  db.exec('BEGIN');db.exec(readFileSync(new URL('../backend/migrations/0003_overage_billing.sql',import.meta.url),'utf8'));db.exec('COMMIT');
  assert.equal(db.prepare('SELECT balance FROM clients').get().balance,12);
  assert.deepEqual(db.prepare('SELECT * FROM ledger ORDER BY rowid').all(),before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM client_members').get().n,1);
  assert.equal(db.prepare('SELECT task_id FROM attachments').get().task_id,'work');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.throws(()=>db.prepare('UPDATE ledger SET credits=50').run(),/immutable/);
  db.close();
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


test('payment documents enforce current account access and use verified Stripe data',async()=>{
  const f=fixture(), clientId=await f.client(), otherId=await f.client();
  await f.fund(clientId);
  const entry=(await f.call(contact,`/clients/${clientId}`)).data.ledger[0];
  const path=`/clients/${clientId}/activity/${encodeURIComponent(entry.id)}/document`;
  assert.equal((await f.call(null,path)).status,401);
  assert.equal((await f.call(outsider,path)).status,404);
  const session={client_reference_id:clientId,livemode:false,payment_status:'paid',amount_subtotal:120000,invoice:null};
  const stripe={checkout:{sessions:{list:async({payment_intent})=>{assert.equal(payment_intent,entry.reference);return {data:[session],has_more:false};}}},paymentIntents:{retrieve:async(reference)=>({id:reference,livemode:false,status:'succeeded',currency:'usd',amount_received:120000,created:1750000000})}};
  const response=await paymentDocument(testStripeEnv,f.DB,clientId,entry.id,stripe);
  assert.equal(response.headers.get('Content-Type'),'application/pdf');
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  const pdf=await PDFDocument.load(await response.arrayBuffer());
  assert.equal(pdf.getTitle(),'Windward Labs payment receipt'); assert.equal(pdf.getPageCount(),1);
  await assert.rejects(paymentDocument(testStripeEnv,f.DB,otherId,entry.id,stripe),/Payment not found/);
  session.client_reference_id=otherId;
  await assert.rejects(paymentDocument(testStripeEnv,f.DB,clientId,entry.id,stripe),/Payment not found/);
  session.client_reference_id=clientId;session.livemode=true;
  await assert.rejects(paymentDocument(testStripeEnv,f.DB,clientId,entry.id,stripe),/Payment not found/);
  await f.call(staff,`/clients/${clientId}/members`,'DELETE',{email:contact.email});
  assert.equal((await f.call(contact,path)).status,404);
});

test('existing purchase invoice PDFs are downloaded without creating another invoice',async()=>{
  const f=fixture(), clientId=await f.client(); await f.fund(clientId);
  const entry=(await f.call(contact,`/clients/${clientId}`)).data.ledger[0];
  const invoice={id:'in_existing',livemode:false,invoice_pdf:'https://pay.stripe.com/invoice/example/pdf'};
  const stripe={checkout:{sessions:{list:async()=>({data:[{client_reference_id:clientId,livemode:false,payment_status:'paid',amount_subtotal:120000,invoice:invoice.id}],has_more:false})}},invoices:{retrieve:async()=>invoice}};
  const response=await paymentDocument(testStripeEnv,f.DB,clientId,entry.id,stripe,async(url)=>{assert.equal(url,invoice.invoice_pdf);return new Response('%PDF-existing',{headers:{'Content-Type':'application/pdf'}});});
  assert.equal(await response.text(),'%PDF-existing');
  let fetches=0;
  const redirected=await paymentDocument(testStripeEnv,f.DB,clientId,entry.id,stripe,async()=>++fetches===1 ? new Response(null,{status:302,headers:{Location:'https://stripe-upload-api.s3.us-west-1.amazonaws.com/example'}}) : new Response('%PDF-redirected',{headers:{'Content-Type':'application/octet-stream'}}));
  assert.equal(await redirected.text(),'%PDF-redirected');assert.equal(fetches,2);
  await assert.rejects(paymentDocument(testStripeEnv,f.DB,clientId,entry.id,stripe,async()=>new Response(null,{status:302,headers:{Location:'https://attacker.example/pdf'}})),/Invalid invoice download URL/);
  invoice.invoice_pdf='https://stripe.com.attacker.example/pdf';
  await assert.rejects(paymentDocument(testStripeEnv,f.DB,clientId,entry.id,stripe),/Invalid invoice download URL/);
});
