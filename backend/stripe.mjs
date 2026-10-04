import Stripe from 'stripe';
import { PortalError, id } from './domain.mjs';
import { stripeCreditPacks } from '../src/services/stripe-catalog.mjs';

const testPrices = {
  8:'price_1UMwWLLFTZ7EIElECMrKEp3m',
  16:'price_1UMiLILFTZ7EIElEShnvpadu',
  32:'price_1UMiMjLFTZ7EIElE1yX0D8qR',
  64:'price_1UMiOLLFTZ7EIElE4bh23C35',
};
export function stripeClient(env) {
  const live = env.STRIPE_MODE === 'live';
  if (!['test','live'].includes(env.STRIPE_MODE) || !env.STRIPE_SECRET_KEY?.startsWith(live ? 'sk_live_' : 'sk_test_')) {
    throw new PortalError(503,'Automatic payment confirmation is not configured yet.');
  }
  return new Stripe(env.STRIPE_SECRET_KEY,{httpClient:Stripe.createFetchHttpClient(),maxNetworkRetries:2,timeout:10000});
}

// Both webhook delivery and the authenticated return page use this operation.
// Values come from Stripe, never the posted credit quantity or redirect query.
export async function fulfillCheckout(env,db,sessionId,expectedClientId,client = stripeClient(env)) {
  if (!/^cs_(test_|live_)[A-Za-z0-9]+$/.test(sessionId || '')) throw new PortalError(400,'Invalid checkout session.');
  const session = await client.checkout.sessions.retrieve(sessionId,{expand:['line_items']});
  if (session.livemode !== (env.STRIPE_MODE === 'live')) throw new PortalError(400,'Payment environment does not match.');
  if (expectedClientId && session.client_reference_id !== expectedClientId) throw new PortalError(404,'Payment not found for this account.');
  const prices = env.STRIPE_MODE === 'live' ? Object.fromEntries(Object.entries(stripeCreditPacks).map(([credits,pack])=>[credits,pack.priceId])) : testPrices;
  const items = session.line_items;
  const line = items?.data?.[0];
  const credits = Number(Object.keys(prices).find(credits=>prices[credits]===line?.price?.id));
  if (!credits || session.mode !== 'payment' || !session.payment_link) return {status:'ignored'};
  const clientId = id(session.client_reference_id);
  if (!await db.prepare('SELECT id FROM clients WHERE id=?').bind(clientId).first()) throw new PortalError(404,'Client not found.');
  if (items.has_more || items.data.length !== 1 || line.quantity !== 1 || line.currency !== 'usd'
    || line.amount_subtotal !== credits*7500 || line.amount_discount !== 0
    || session.amount_subtotal !== credits*7500 || session.currency !== 'usd' || session.total_details?.amount_discount !== 0) {
    throw new PortalError(400,'Payment does not match a fixed credit pack.');
  }
  if (session.payment_status !== 'paid' || session.status !== 'complete') return {status:session.status==='expired' ? 'failed' : 'pending'};
  const reference = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (!/^pi_[A-Za-z0-9]+$/.test(reference || '')) throw new PortalError(400,'Payment reference is missing.');
  // Unique reference + ledger balance trigger make concurrent retries atomic.
  await db.prepare(`INSERT INTO ledger (id,client_id,kind,credits,reference,note,created_by,actor_email)
    VALUES (?,?,'purchase',?,?,?,?,?) ON CONFLICT(reference) DO NOTHING`)
    .bind(`stripe:${reference}`,clientId,credits,reference,`${credits} credits purchased via Stripe`,'stripe','Stripe').run();
  const entry = await db.prepare('SELECT client_id,credits FROM ledger WHERE reference=?').bind(reference).first();
  if (entry.client_id !== clientId || entry.credits !== credits) throw new PortalError(409,'Payment reference already used.');
  return {status:'credited',credits};
}

export async function handleStripeWebhook(request,env) {
  const headers = {'Cache-Control':'no-store'};
  try {
    if (request.method !== 'POST') throw new PortalError(405,'Method not allowed.');
    if (!env.STRIPE_WEBHOOK_SECRET) throw new PortalError(503,'Stripe webhook is not configured.');
    const raw = await request.text();
    if (raw.length > 1000000) throw new PortalError(413,'Request too large.');
    const stripe = stripeClient(env);
    let event;
    try { event = await stripe.webhooks.constructEventAsync(raw,request.headers.get('Stripe-Signature'),env.STRIPE_WEBHOOK_SECRET,300,Stripe.createSubtleCryptoProvider()); }
    catch { throw new PortalError(400,'Invalid Stripe signature.'); }
    if (event.livemode !== (env.STRIPE_MODE==='live')) throw new PortalError(400,'Payment environment does not match.');
    if (['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
      const db = env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
      await fulfillCheckout(env,db,event.data.object.id,undefined,stripe);
    }
    if (['invoice.paid','invoice.voided'].includes(event.type)) {
      const {fulfillInvoiceEvent}=await import('./billing.mjs');
      const db=env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
      await fulfillInvoiceEvent(env,db,event.data.object.id,stripe);
    }
    return Response.json({received:true},{headers});
  } catch(error) {
    return Response.json({error:error instanceof PortalError ? error.message : 'Unable to process Stripe event.'},{status:error instanceof PortalError ? error.status : 500,headers});
  }
}
