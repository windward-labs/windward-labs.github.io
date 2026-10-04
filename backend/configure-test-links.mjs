// Run locally after adding the test secret key to backend/.dev.vars.
import { readLocalEnv } from './local-env.mjs';
import { stripeClient } from './stripe.mjs';

const env = readLocalEnv();
if (env.STRIPE_MODE!=='test') throw new Error('This script configures test links only.');
const stripe=stripeClient(env);
const links=await stripe.paymentLinks.list({limit:100});
const expected = {
  16:'https://buy.stripe.com/test_fZu8wQeuKdN4cic13ieME00',
  32:'https://buy.stripe.com/test_6oU8wQfyO8sK3LG8vKeME01',
  64:'https://buy.stripe.com/test_aFabJ2dqG6kC5TO7rGeME02',
};
for (const [credits,url] of Object.entries(expected)) {
  const link=links.data.find(link=>link.url===url && !link.livemode);
  if (!link) throw new Error(`Missing ${credits}-credit test link.`);
  const updated=await stripe.paymentLinks.update(link.id,{after_completion:{type:'redirect',redirect:{url:'http://localhost:4321/service/?payment=returned&session_id={CHECKOUT_SESSION_ID}'}}});
  if (updated.after_completion.type!=='redirect') throw new Error('Redirect was not saved.');
  console.log(`${credits}-credit test link now returns to the local portal.`);
}
