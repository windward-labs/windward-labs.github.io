// Creates an isolated Stripe TEST invoice. No live database, email, or card charge.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readLocalEnv } from './local-env.mjs';
import { stripeClient } from './stripe.mjs';
import { billingPreview, createInvoiceDraft, issueInvoice, refreshInvoice } from './billing.mjs';

const env=readLocalEnv();
if (env.STRIPE_MODE!=='test' || !env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new Error('This verification requires a Stripe test key and STRIPE_MODE=test.');
const stripe=stripeClient(env), sqlite=new DatabaseSync(':memory:');
for (const file of ['0001_portal.sql','0002_attachments.sql','0003_overage_billing.sql','0004_progress_attachments.sql']) {
  sqlite.exec('BEGIN');sqlite.exec(readFileSync(new URL(`./migrations/${file}`,import.meta.url),'utf8'));sqlite.exec('COMMIT');
}
const wrap=(sql,values=[])=>({bind(...args){return wrap(sql,args);},async first(){return sqlite.prepare(sql).get(...values)||null;},async run(){return sqlite.prepare(sql).run(...values);}});
const db={prepare:wrap};
const now=new Date(), period=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)).toISOString().slice(0,7);
const clientId=crypto.randomUUID(), invoiceId=crypto.randomUUID();
sqlite.prepare('INSERT INTO clients(id,name) VALUES(?,?)').run(clientId,'Windward billing integration test');
sqlite.prepare("INSERT INTO ledger(id,client_id,kind,credits,note,created_by,actor_email,created_at) VALUES(?,?,'work',-8,'Test overage','test','billing-test@example.invalid',?)").run(crypto.randomUUID(),clientId,`${period}-15T00:00:00.000Z`);
const preview=await billingPreview(db,clientId,period);
assert.equal(preview.credits,8);
await createInvoiceDraft(env,db,{id:'test',email:'billing-test@example.invalid'},clientId,{id:invoiceId,period,email:'billing-test@example.invalid',credits:8});
await issueInvoice(env,db,clientId,invoiceId,stripe);
await issueInvoice(env,db,clientId,invoiceId,stripe);
const record=sqlite.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
assert.equal(record.status,'open');assert.equal(sqlite.prepare('SELECT balance FROM clients').get().balance,0);
const invoice=await stripe.invoices.retrieve(record.stripe_invoice_id);
assert.equal(invoice.livemode,false);assert.equal(invoice.total,60000);assert.equal(invoice.auto_advance,false);
assert.equal(invoice.collection_method,'send_invoice');assert.equal(invoice.lines.data.length,1);
// Simulate a full out-of-band settlement in TEST mode only, without card use.
await stripe.invoices.pay(invoice.id,{paid_out_of_band:true});
await refreshInvoice(env,db,clientId,invoiceId,stripe);
await refreshInvoice(env,db,clientId,invoiceId,stripe);
assert.equal(sqlite.prepare('SELECT status FROM invoices').get().status,'paid');
assert.equal(sqlite.prepare('SELECT balance FROM clients').get().balance,0);
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM ledger WHERE kind='billing'").get().n,1);
console.log('Stripe TEST invoice creation, safe retries, and settlement passed. No real money was charged or email sent.');
sqlite.close();
