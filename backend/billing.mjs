import { PortalError, id, normalizeEmail } from './domain.mjs';
import { stripeClient } from './stripe.mjs';
import { creditPriceCents } from '../src/services/pricing.mjs';

const query=(db,sql,...values)=>db.prepare(sql).bind(...values);
export const invoicedCreditsSql=`COALESCE((SELECT SUM(i.credits) FROM invoices i WHERE i.client_id=c.id AND i.status IN ('issuing','open')),0)`;
// Purchased credits and invoice transfers cover the oldest active work first.
// Cancellations remove their own charge; they must not pay unrelated old debt.
// Work dates, rather than ingestion order, determine month attribution.
export const ledgerEventDate=`CASE WHEN l.kind='work' THEN COALESCE((SELECT c.occurred_at FROM project_charges c WHERE 'project-charge:'||c.id=l.id),(SELECT e.occurred_at FROM work_entries e WHERE 'work-entry:'||e.id=l.id),(SELECT t.occurred_at FROM tasks t WHERE t.id=l.task_id),l.created_at) ELSE l.created_at END`;
const cumulative=date=>`MAX(0,MIN(-c.balance,
  COALESCE((SELECT SUM(w.credits) FROM billable_work w WHERE w.client_id=c.id AND w.occurred_at<${date}),0)
  -COALESCE((SELECT SUM(l.credits) FROM ledger l WHERE l.client_id=c.id AND l.kind='purchase'),0)
  -COALESCE((SELECT SUM(i.credits) FROM invoices i WHERE i.client_id=c.id AND i.status IN ('issuing','open','paid') AND (i.attribution_mode='legacy' OR i.cutoff<=${date})),0)))`;
// Difference of cumulative uncovered credits makes each review month-specific.
// Purchases still cover the oldest work first; issued bills are not billed again.
const dueSql=`MAX(0,${cumulative('review.cutoff')}-${cumulative('review.start')})`;
const reviewBounds=period=>[billingPeriod(period),`${period}-01T00:00:00.000Z`];
export function billingPeriod(period,now=new Date()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '') || period<'2020-01' || period>=now.toISOString().slice(0,7)) throw new PortalError(400,'Choose a completed billing month.');
  const [year,month]=period.split('-').map(Number);
  return new Date(Date.UTC(year,month,1)).toISOString();
}
export async function billingPreview(db,clientId,period) {
  const [cutoff,start]=reviewBounds(period);
  const row=await query(db,`SELECT ${dueSql} AS credits FROM clients c CROSS JOIN (SELECT ? AS cutoff,? AS start) review WHERE c.id=?`,cutoff,start,clientId).first();
  if(!row)throw new PortalError(404,'Client not found.');
  return {period,cutoff,credits:row.credits,amountCents:row.credits*creditPriceCents};
}
export async function createInvoiceDraft(env,db,actor,clientId,body) {
  stripeClient(env); // Fail before reserving a draft if payments aren't configured.
  const invoiceId=id(body.id), email=normalizeEmail(body.email), [cutoff,start]=reviewBounds(body.period);
  if (!Number.isSafeInteger(body.credits) || body.credits<=0) throw new PortalError(400,'There are no outstanding credits to invoice.');
  const existing=await query(db,'SELECT * FROM invoices WHERE id=?',invoiceId).first();
  if (existing) {
    if (existing.client_id!==clientId || existing.period!==body.period || existing.credits!==body.credits || existing.email!==email) throw new PortalError(409,'Invoice ID already used.');
    return;
  }
  // The expected amount protects a staff review from concurrent top-ups/refunds.
  await query(db,`INSERT INTO invoices (id,client_id,period,cutoff,email,credits,amount_cents,stripe_mode,created_by,actor_email,attribution_mode)
    SELECT ?,c.id,?,?,?,?,?,?,?,?,'monthly' FROM clients c CROSS JOIN (SELECT ? AS cutoff,? AS start) review WHERE c.id=? AND ${dueSql}=?`,
    invoiceId,body.period,cutoff,email,body.credits,body.credits*creditPriceCents,env.STRIPE_MODE,actor.id,actor.email,cutoff,start,clientId,body.credits).run();
  if (!await query(db,'SELECT id FROM invoices WHERE id=?',invoiceId).first()) throw new PortalError(409,'The balance changed. Refresh the billing review before creating a draft.');
}
async function invoiceRecord(db,clientId,invoiceId) {
  const invoice=await query(db,'SELECT * FROM invoices WHERE id=? AND client_id=?',id(invoiceId),clientId).first();
  if (!invoice) throw new PortalError(404,'Invoice not found.');
  return invoice;
}
function verifyInvoice(env,record,invoice) {
  if (record.stripe_mode!==env.STRIPE_MODE || invoice.livemode!==(env.STRIPE_MODE==='live')
    || invoice.id!==record.stripe_invoice_id || invoice.metadata?.windward_invoice_id!==record.id
    || invoice.metadata?.client_id!==record.client_id || invoice.metadata?.credits!==String(record.credits)
    || invoice.currency!=='usd' || invoice.subtotal!==record.amount_cents || invoice.total!==record.amount_cents
    || invoice.lines?.has_more || invoice.lines?.data?.length!==1 || invoice.lines.data[0].amount!==record.amount_cents) throw new PortalError(409,'The Stripe invoice does not match the reviewed bill.');
}
async function applyInvoiceState(env,db,record,invoice) {
  verifyInvoice(env,record,invoice);
  const status=invoice.status==='paid' ? 'paid' : invoice.status==='void' ? 'void' : invoice.status==='open' || invoice.status==='uncollectible' ? 'open' : 'issuing';
  if (status==='paid' && (invoice.amount_paid<record.amount_cents || invoice.amount_remaining!==0)) throw new PortalError(409,'The invoice is not fully paid.');
  const url=invoice.hosted_invoice_url;
  if (url && !url.startsWith('https://invoice.stripe.com/')) throw new PortalError(409,'Invalid Stripe invoice link.');
  // No credit award on payment: the debit was already transferred to this bill.
  await query(db,`UPDATE invoices SET status=?,hosted_invoice_url=?,number=? WHERE id=? AND status IN ('issuing','open')`,status,url || null,invoice.number || null,record.id).run();
}
export async function issueInvoice(env,db,clientId,invoiceId,stripe=stripeClient(env)) {
  let record=await invoiceRecord(db,clientId,invoiceId);
  if (record.stripe_mode!==env.STRIPE_MODE) throw new PortalError(409,'Invoice payment environment does not match.');
  if (record.status==='paid' || record.status==='void' || record.status==='open') return;
  if (record.status==='draft') {
    await query(db,`UPDATE invoices SET status='issuing' WHERE id=? AND status='draft' AND credits=
      (SELECT ${record.attribution_mode==='legacy' ? cumulative('review.cutoff') : dueSql} FROM clients c CROSS JOIN (SELECT ? AS cutoff,? AS start) review WHERE c.id=invoices.client_id)`,record.id,record.cutoff,`${record.period}-01T00:00:00.000Z`).run();
    record=await invoiceRecord(db,clientId,invoiceId);
    if (record.status==='draft') throw new PortalError(409,'The outstanding credits changed. Cancel this draft and review the updated balance.');
  }
  const account=await query(db,'SELECT name FROM clients WHERE id=?',clientId).first();
  if (!record.stripe_customer_id) {
    const customer=await stripe.customers.create({name:account.name,email:record.email,metadata:{windward_invoice_id:record.id}},{idempotencyKey:`windward-invoice-customer:${record.id}`});
    await query(db,'UPDATE invoices SET stripe_customer_id=? WHERE id=? AND stripe_customer_id IS NULL',customer.id,record.id).run();
    record=await invoiceRecord(db,clientId,invoiceId);
  }
  if (!record.stripe_invoice_id) {
    // Also recover an ambiguous request after Stripe's idempotency window ends.
    const previous=await stripe.invoices.list({customer:record.stripe_customer_id,limit:100});
    let invoice=previous.data.find(invoice=>invoice.metadata?.windward_invoice_id===record.id);
    if (!invoice) invoice=await stripe.invoices.create({customer:record.stripe_customer_id,currency:'usd',collection_method:'send_invoice',days_until_due:30,auto_advance:false,pending_invoice_items_behavior:'exclude',discounts:'',
      description:`Windward outstanding credits for ${record.period}`,
      metadata:{windward_invoice_id:record.id,client_id:clientId,credits:String(record.credits),period:record.period}},
      {idempotencyKey:`windward-invoice:${record.id}`});
    await query(db,'UPDATE invoices SET stripe_invoice_id=? WHERE id=? AND stripe_invoice_id IS NULL',invoice.id,record.id).run();
    record=await invoiceRecord(db,clientId,invoiceId);
  }
  let invoice=await stripe.invoices.retrieve(record.stripe_invoice_id);
  if (invoice.status==='draft') {
    if (invoice.lines.data.length===0) {
      await stripe.invoiceItems.create({customer:record.stripe_customer_id,invoice:record.stripe_invoice_id,currency:'usd',amount:record.amount_cents,description:`${record.credits} outstanding credits × $75 · ${record.period}`},{idempotencyKey:`windward-invoice-item:${record.id}`});
      invoice=await stripe.invoices.retrieve(record.stripe_invoice_id);
    }
    verifyInvoice(env,record,invoice);
    invoice=await stripe.invoices.finalizeInvoice(record.stripe_invoice_id,{auto_advance:false},{idempotencyKey:`windward-invoice-finalize:${record.id}`});
  }
  await applyInvoiceState(env,db,record,invoice);
}
export async function refreshInvoice(env,db,clientId,invoiceId,stripe=stripeClient(env)) {
  const record=await invoiceRecord(db,clientId,invoiceId);
  if (!record.stripe_invoice_id || ['draft','paid','void'].includes(record.status)) return;
  await applyInvoiceState(env,db,record,await stripe.invoices.retrieve(record.stripe_invoice_id));
}
export async function voidInvoice(env,db,clientId,invoiceId,stripe=stripeClient(env)) {
  const record=await invoiceRecord(db,clientId,invoiceId);
  if (record.status==='void') return;
  if (record.status==='draft') { await query(db,"UPDATE invoices SET status='void' WHERE id=? AND status='draft'",record.id).run(); return; }
  if (record.status!=='open') throw new PortalError(409,'Only drafts and unpaid issued invoices can be voided.');
  const invoice=await stripe.invoices.retrieve(record.stripe_invoice_id);
  verifyInvoice(env,record,invoice);
  if (invoice.status==='paid') { await applyInvoiceState(env,db,record,invoice); throw new PortalError(409,'This invoice has already been paid.'); }
  const voided=invoice.status==='void' ? invoice : await stripe.invoices.voidInvoice(record.stripe_invoice_id,{}, {idempotencyKey:`windward-invoice-void:${record.id}`});
  await applyInvoiceState(env,db,record,voided);
}
export async function fulfillInvoiceEvent(env,db,stripeInvoiceId,stripe) {
  const record=await query(db,'SELECT * FROM invoices WHERE stripe_invoice_id=?',stripeInvoiceId).first();
  if (!record) return;
  await refreshInvoice(env,db,record.client_id,record.id,stripe);
}
