// Provision the user-requested $600 pack, without charging or emailing anyone.
import {readFileSync,writeFileSync} from 'node:fs';
import {readLocalEnv} from './local-env.mjs';
import {stripeClient} from './stripe.mjs';
import {stripeAccountId,stripeCreditPacks} from '../src/services/stripe-catalog.mjs';
for(const mode of ['test','live']) {
  const env={...readLocalEnv(new URL(mode==='live'?'./.dev.vars.production':'./.dev.vars',import.meta.url)),STRIPE_MODE:mode};
  const stripe=stripeClient(env);
  if((await stripe.accounts.retrieve()).id!==stripeAccountId)throw new Error('Wrong Stripe account.');
  const links=await stripe.paymentLinks.list({limit:100});
  const template=links.data.find(link=>mode==='live' ? link.url===stripeCreditPacks[16].paymentLink : link.metadata?.credits==='16') || links.data.find(link=>link.active);
  if(!template)throw new Error('An existing payment link is required to copy checkout settings.');
  const templateItems=await stripe.paymentLinks.listLineItems(template.id);
  const templateProduct=await stripe.products.retrieve(templateItems.data[0].price.product);
  const taxCode=typeof templateProduct.tax_code==='string' ? templateProduct.tax_code : templateProduct.tax_code?.id;
  const lookup='windward_credits_8';
  let price=(await stripe.prices.list({lookup_keys:[lookup],limit:10})).data[0];
  if(!price) {
    const product=await stripe.products.create({name:'Windward Labs — 8 credits',description:'For a quick review, design update, or small fix.',...(taxCode ? {tax_code:taxCode} : {}),metadata:{credits:'8'}},{idempotencyKey:'windward-eight-credit-product-v1'});
    price=await stripe.prices.create({product:product.id,currency:'usd',unit_amount:60000,tax_behavior:'exclusive',lookup_key:lookup,metadata:{credits:'8'}},{idempotencyKey:'windward-eight-credit-price-v1'});
  }
  if(price.unit_amount!==60000 || price.currency!=='usd' || price.recurring)throw new Error('8-credit price has unexpected terms.');
  let link=links.data.find(link=>link.metadata?.windward_pack==='8');
  if(!link)link=await stripe.paymentLinks.create({line_items:[{price:price.id,quantity:1}],allow_promotion_codes:false,automatic_tax:{enabled:template.automatic_tax.enabled},billing_address_collection:template.billing_address_collection,customer_creation:template.customer_creation,tax_id_collection:{enabled:template.tax_id_collection?.enabled || false},metadata:{windward_pack:'8',credits:'8'},after_completion:{type:'redirect',redirect:{url:`${mode==='live'?'https://windwardlabs.xyz':'http://localhost:4321'}/service/?payment=returned&session_id={CHECKOUT_SESSION_ID}`}}},{idempotencyKey:'windward-eight-credit-payment-link-v1'});
  const items=await stripe.paymentLinks.listLineItems(link.id);
  if(!link.active || link.livemode!==(mode==='live') || items.has_more || items.data.length!==1 || items.data[0].price.id!==price.id || items.data[0].quantity!==1)throw new Error('Unexpected 8-credit payment link configuration.');
  if(mode==='live') {
    const path=new URL('../src/services/stripe-catalog.mjs',import.meta.url);
    let source=readFileSync(path,'utf8');
    if(!/^  8:/m.test(source))source=source.replace('export const stripeCreditPacks = {',`export const stripeCreditPacks = {\n  8: { productId: '${price.product}', priceId: '${price.id}', paymentLink: '${link.url}' },`);
    writeFileSync(path,source);
  } else {
    const path=new URL('./stripe.mjs',import.meta.url);
    let source=readFileSync(path,'utf8');
    if(!/^  8:/m.test(source))source=source.replace('const testPrices = {',`const testPrices = {\n  8:'${price.id}',`);
    writeFileSync(path,source);
    const localPath=new URL('../.env.local',import.meta.url);
    const local=readFileSync(localPath,'utf8').replace(/^PUBLIC_STRIPE_TEST_LINK_8=.*\n?/gm,'');
    writeFileSync(localPath,local.trimEnd()+`\nPUBLIC_STRIPE_TEST_LINK_8=${link.url}\n`);
  }
  console.log(`${mode}: 8-credit pack verified at $600. ${link.url}`);
}
