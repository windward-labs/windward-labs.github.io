// Only run after the user supplies a live key in this ignored file.
import { readFileSync,writeFileSync,mkdtempSync,unlinkSync,rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readLocalEnv } from './local-env.mjs';
import { stripeClient } from './stripe.mjs';
import { stripeAccountId,stripeCreditPacks } from '../src/services/stripe-catalog.mjs';

const path = new URL('./.dev.vars.production',import.meta.url);
const env = {...readLocalEnv(path),STRIPE_MODE:'live'};
const stripe = stripeClient(env);
const account = await stripe.accounts.retrieve();
if (account.id!==stripeAccountId) throw new Error('The live key belongs to a different Stripe account.');

if (process.argv.includes('--redirects')) {
  // Run only after the new frontend is deployed successfully.
  const links=await stripe.paymentLinks.list({limit:100});
  for (const [credits,pack] of Object.entries(stripeCreditPacks)) {
    const link=links.data.find(link=>link.url===pack.paymentLink && link.livemode);
    if (!link) throw new Error(`Missing ${credits}-credit live link.`);
    const items=await stripe.paymentLinks.listLineItems(link.id);
    if (items.has_more || items.data.length!==1 || items.data[0].price.id!==pack.priceId || items.data[0].quantity!==1) throw new Error('Live link does not match its fixed credit pack.');
    await stripe.paymentLinks.update(link.id,{after_completion:{type:'redirect',redirect:{url:'https://windwardlabs.xyz/service/?payment=returned&session_id={CHECKOUT_SESSION_ID}'}}});
    console.log(`${credits}-credit live link returns to the client portal.`);
  }
} else {
  const url='https://windward-service-api.windwardlabs.workers.dev/v1/stripe/webhook';
  const endpoints=await stripe.webhookEndpoints.list({limit:100});
  let endpoint=endpoints.data.find(endpoint=>endpoint.url===url && endpoint.livemode);
  const required=['checkout.session.completed','checkout.session.async_payment_succeeded','invoice.paid','invoice.voided'];
  if (process.argv.includes('--events-only')) {
    if (!endpoint) throw new Error('The production webhook must be provisioned first.');
    await stripe.webhookEndpoints.update(endpoint.id,{enabled_events:endpoint.enabled_events.includes('*') ? ['*'] : [...new Set([...endpoint.enabled_events,...required])],disabled:false});
    console.log('Live webhook events updated for credit purchases and invoice settlement.');
    process.exit(0);
  }
  if (!endpoint) {
    endpoint=await stripe.webhookEndpoints.create({url,enabled_events:required,description:'Windward service credit fulfillment'});
    env.STRIPE_WEBHOOK_SECRET=endpoint.secret;
    writeFileSync(path,readFileSync(path,'utf8').replace(/^STRIPE_WEBHOOK_SECRET=.*\n?/gm,'').trimEnd()+`\nSTRIPE_WEBHOOK_SECRET=${endpoint.secret}\n`,{mode:0o600});
  } else {
    if (!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) throw new Error('Save the existing live webhook signing secret in .dev.vars.production before continuing.');
    await stripe.webhookEndpoints.update(endpoint.id,{enabled_events:endpoint.enabled_events.includes('*') ? ['*'] : [...new Set([...endpoint.enabled_events,...required])],disabled:false});
  }
  const directory=mkdtempSync(join(tmpdir(),'windward-stripe-'));
  const secrets=join(directory,'secrets.json');
  try {
    writeFileSync(secrets,JSON.stringify({STRIPE_SECRET_KEY:env.STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET:env.STRIPE_WEBHOOK_SECRET}),{mode:0o600});
    execFileSync(new URL('../node_modules/.bin/wrangler',import.meta.url).pathname,['secret','bulk',secrets,'--config','backend/wrangler.jsonc'],{stdio:'inherit'});
  } finally { unlinkSync(secrets); rmdirSync(directory); }
  console.log('Live webhook configured and Stripe secrets uploaded to Cloudflare.');
}
