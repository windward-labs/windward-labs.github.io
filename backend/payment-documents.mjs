import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PortalError } from './domain.mjs';
import { stripeClient } from './stripe.mjs';

async function invoicePdf(env,invoice,fetchPdf) {
  if (invoice.livemode!==(env.STRIPE_MODE==='live') || !invoice.invoice_pdf) throw new PortalError(404,'The invoice PDF is not available yet.');
  let url=new URL(invoice.invoice_pdf), response;
  if (url.protocol!=='https:' || !url.hostname.endsWith('.stripe.com')) throw new PortalError(409,'Invalid invoice download URL.');
  for(let step=0;step<4;step++) {
    if (url.protocol!=='https:' || !(url.hostname.endsWith('.stripe.com') || url.hostname==='stripe-upload-api.s3.us-west-1.amazonaws.com')) throw new PortalError(409,'Invalid invoice download URL.');
    response=await fetchPdf(url.href,{redirect:'manual',signal:AbortSignal.timeout(15000)});
    if (response.status>=300 && response.status<400) {
      const location=response.headers.get('Location');
      if(!location) throw new PortalError(502,'Invoice download is unavailable.');
      url=new URL(location,url);continue;
    }
    break;
  }
  if (!response?.ok) throw new PortalError(502,'Unable to download the Stripe invoice. Try again shortly.');
  const bytes=await response.arrayBuffer();
  if (bytes.byteLength>10000000 || new TextDecoder().decode(new Uint8Array(bytes).slice(0,5))!=='%PDF-') throw new PortalError(502,'Invalid invoice PDF.');
  return documentResponse(bytes,'invoice.pdf');
}
function documentResponse(bytes,name) {
  return new Response(bytes,{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
export async function paymentDocument(env,db,clientId,entryId,stripe=stripeClient(env),fetchPdf=fetch) {
  const entry=await db.prepare('SELECT * FROM ledger WHERE id=? AND client_id=?').bind(entryId,clientId).first();
  if (!entry) throw new PortalError(404,'Payment not found.');
  if (entry.kind==='billing' && entry.credits>0) {
    const record=await db.prepare('SELECT * FROM invoices WHERE id=? AND client_id=?').bind(entry.id.replace(/^invoice:/,''),clientId).first();
    if (!record?.stripe_invoice_id || record.stripe_mode!==env.STRIPE_MODE) throw new PortalError(404,'Invoice not available.');
    const invoice=await stripe.invoices.retrieve(record.stripe_invoice_id);
    if (invoice.id!==record.stripe_invoice_id || invoice.metadata?.client_id!==clientId || invoice.metadata?.windward_invoice_id!==record.id) throw new PortalError(409,'Invoice does not match this account.');
    return invoicePdf(env,invoice,fetchPdf);
  }
  if (entry.kind!=='purchase' || !/^pi_[A-Za-z0-9]+$/.test(entry.reference || '')) throw new PortalError(404,'This activity has no payment document.');
  const sessions=await stripe.checkout.sessions.list({payment_intent:entry.reference,limit:2});
  if (sessions.has_more || sessions.data.length>1) throw new PortalError(409,'Unable to identify this payment.');
  const session=sessions.data[0];
  if (session && (session.client_reference_id!==clientId || session.livemode!==(env.STRIPE_MODE==='live') || session.payment_status!=='paid' || session.amount_subtotal!==entry.credits*7500)) throw new PortalError(404,'Payment not found for this account.');
  if (session?.invoice) {
    const invoiceId=typeof session.invoice==='string' ? session.invoice : session.invoice.id;
    const invoice=await stripe.invoices.retrieve(invoiceId);
    if(invoice.id!==invoiceId) throw new PortalError(409,'Invoice does not match this purchase.');
    return invoicePdf(env,invoice,fetchPdf);
  }
  // Older Payment Links may not have created an invoice. Download a receipt
  // from the actual successful Stripe payment, without creating a new bill.
  const payment=await stripe.paymentIntents.retrieve(entry.reference);
  if (payment.id!==entry.reference || payment.livemode!==(env.STRIPE_MODE==='live') || payment.status!=='succeeded' || payment.currency!=='usd' || !Number.isSafeInteger(payment.amount_received) || payment.amount_received<entry.credits*7500) throw new PortalError(409,'Payment does not match the recorded purchase.');
  const pdf=await PDFDocument.create();
  pdf.setTitle('Windward Labs payment receipt');
  const page=pdf.addPage([612,792]), font=await pdf.embedFont(StandardFonts.Helvetica), bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const draw=(text,y,size=12,strong=false)=>page.drawText(text,{x:48,y,size,font:strong?bold:font,color:rgb(.09,.09,.09)});
  draw('Windward Labs',724,20,true); draw('Payment receipt',680,16,true);
  draw(`Paid on ${new Date(payment.created*1000).toISOString().slice(0,10)}`,640);
  draw(`${entry.credits} credits`,596,14,true);
  draw(`Amount paid: USD ${(payment.amount_received/100).toFixed(2)}`,560,14,true);
  draw('Includes any applicable tax collected by Stripe.',536,10);
  draw('Payment reference',480,10); draw(payment.id,458,10);
  draw('Client account',414,10); draw(clientId,392,10);
  draw('Paid in full. This is a receipt, not a request for payment.',330,10);
  return documentResponse(await pdf.save(),'payment-receipt.pdf');
}
