import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { creditPacks, creditPriceCents, formatPrice, normalCreditsPerHour } from '../pricing.mjs';
import { checkoutLink, isLocalApi } from '../stripe-checkout.mjs';
import type { Actor, ClientSummary, ClientDetail, Task, WorkStatus, Attachment } from './types';

const statusNames: Record<WorkStatus, string> = { queued: 'Queued', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const date = (value: string) => new Intl.DateTimeFormat('en-US', { month:'short', day:'numeric', year:'numeric' }).format(new Date(value));
const clientUrl = (id: string) => `/service/client/?id=${encodeURIComponent(id)}`;
const creditsOwed = (client:ClientSummary) => Math.max(0,-client.balance)+(client.invoiced_credits || 0);
const previousMonth = () => { const now=new Date(); return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)).toISOString().slice(0,7); };
type Api = <T>(path: string, method?: string, body?: unknown, responseType?: 'json' | 'blob') => Promise<T>;
type PendingFile = {id:string;file:File};

export default function Portal() {
  const appId = import.meta.env.PUBLIC_PRIVY_APP_ID;
  if (!appId) return <section className="section stack"><h1>Client portal</h1><p>Portal setup is in progress. Contact Windward for access to your account.</p></section>;
  return <PrivyProvider appId={appId} clientId={import.meta.env.PUBLIC_PRIVY_CLIENT_ID || undefined} config={{ loginMethods:['email'], appearance:{ theme:'light', accentColor:'#171717', showWalletLoginFirst:false } }}><AuthenticatedPortal /></PrivyProvider>;
}

function AuthenticatedPortal() {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const [actor,setActor] = useState<Actor | null>(null);
  const [clients,setClients] = useState<ClientSummary[]>([]);
  const [client,setClient] = useState<ClientDetail | null>(null);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [revision,setRevision] = useState(0);
  const [showNewClient,setShowNewClient] = useState(false);
  const apiUrl = import.meta.env.PUBLIC_SERVICE_API_URL?.replace(/\/$/,'');
  const params = new URLSearchParams(window.location.search);
  const paymentReturn = params.get('payment') === 'returned';
  const selectedId = params.get('id') || params.get('client') || (paymentReturn ? params.get('utm_content') : null);
  const checkoutOnly = window.location.pathname.replace(/\/$/,'') === '/service/checkout';
  const api: Api = useCallback(async (path, method = 'GET', body, responseType = 'json') => {
    if (!apiUrl) throw new Error('The portal is being set up. Please contact Windward for account access.');
    if (import.meta.env.DEV && !isLocalApi(apiUrl)) throw new Error('Local testing requires a local service API. Set PUBLIC_SERVICE_API_URL=http://localhost:8787.');
    const token = await getAccessToken();
    if (!token) throw new Error('Your session expired. Please sign in again.');
    const file = body instanceof File ? body : null;
    const response = await fetch(`${apiUrl}/v1${path}`, { method, headers:{ Authorization:`Bearer ${token}`, ...(file ? {'Content-Type':file.type || 'application/octet-stream','X-File-Name':encodeURIComponent(file.name)} : body ? {'Content-Type':'application/json'} : {}) }, ...(body ? {body:file || JSON.stringify(body)} : {}) });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Unable to load your account. Please try again.');
    }
    return responseType === 'blob' ? response.blob() : response.json();
  },[apiUrl,getAccessToken]);
  useEffect(() => {
    let active = true;
    setActor(null); setClients([]); setClient(null); setError(''); setLoading(true);
    if (!ready || !authenticated) return () => { active=false; };
    async function load() {
      try {
        const identity = await api<Actor>('/me');
        const result = await api<{clients:ClientSummary[]}>('/clients');
        const id = selectedId || (!identity.staff && result.clients.length === 1 ? result.clients[0].id : null);
        const detail = id ? await api<ClientDetail>(`/clients/${encodeURIComponent(id)}`) : null;
        if (active) { setActor(identity); setClients(result.clients); setClient(detail); }
      } catch (error) { if (active) setError(error instanceof Error ? error.message : 'Unable to load your account.'); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active=false; };
  },[ready,authenticated,user?.id,api,selectedId,revision]);
  if (!ready) return <p className="portal-loading" role="status">Loading sign-in…</p>;
  if (!authenticated) return <section className="section stack"><h1>Client portal</h1><p>Sign in with your email to follow your work with Windward.</p><div><button className="action" onClick={() => login({loginMethods:['email']})}>Sign in with email</button></div><p className="caption muted">Use the email address Windward approved for your client account.</p></section>;
  const sessionTarget = document.getElementById('service-session');
  return <>
    {sessionTarget && createPortal(<AccountMenu email={actor?.email || user?.email?.address || 'Account'} onSignOut={() => { setActor(null); setClients([]); setClient(null); void logout(); }}/>,sessionTarget)}
    {loading ? <p role="status" className="portal-loading">Loading your account…</p> : error ? <section className="section stack"><h1>Account unavailable</h1><p role="alert">{error}</p><div><button className="plain-button" onClick={() => setRevision(value=>value+1)}>Try again</button></div></section> : actor && <>
      {client ? <ClientView key={client.id} actor={actor} client={client} api={api} setClient={setClient} checkoutOnly={checkoutOnly} paymentReturn={paymentReturn} /> : <>
        <section className="section stack">
          <div className="row">
            <h1>{actor.staff ? 'Clients' : 'Your accounts'}</h1>
            {actor.staff && <button type="button" className="plain-button" aria-expanded={showNewClient} aria-controls="new-client-section" onClick={()=>setShowNewClient(value=>!value)}>Add new client</button>}
          </div>
          <p className="muted">{actor.staff ? 'Manage prepaid balances and track work across channels.' : clients.length ? 'Choose your client account.' : 'Your email is not assigned to a client account yet. Contact Windward to arrange access.'}</p>
          {clients.length > 0 && <div className="table-scroll"><table aria-label="Client accounts"><thead><tr><th>Client</th><th>Credits available</th><th>Credits owed</th><th>Active tasks</th></tr></thead><tbody>{clients.map(item=><tr key={item.id}><td><a href={clientUrl(item.id)}>{item.name}</a></td><td>{Math.max(0,item.balance)}</td><td>{creditsOwed(item)}</td><td>{item.active_tasks}</td></tr>)}</tbody></table></div>}
        </section>
        {actor.staff && <section id="new-client-section" className="section" hidden={!showNewClient}><h2 className="portal-heading">Add client</h2><MutationForm label="Create client" submit={async (form,id)=>{ const created = await api<ClientDetail>('/clients','POST',{id,name:form.get('name'),email:form.get('email')}); window.location.assign(clientUrl(created.id)); }}>
          <div className="fields"><Field label="Client name" name="name" maxLength={160}/><Field label="Client contact email" name="email" type="email" maxLength={254}/></div><p className="caption muted">The contact can sign in and view this account. Share their portal link after creating it.</p>
        </MutationForm></section>}
      </>}
    </>}
  </>;
}

function AccountMenu({email,onSignOut}:{email:string;onSignOut:()=>void}) {
  const [open,setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const signOut = useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if (!open) return;
    signOut.current?.focus();
    const dismiss = (event:PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false); };
    const escape = (event:KeyboardEvent) => { if (event.key==='Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown',dismiss);
    document.addEventListener('keydown',escape);
    return ()=>{ document.removeEventListener('pointerdown',dismiss); document.removeEventListener('keydown',escape); };
  },[open]);
  return <div ref={container} className="portal-session" onBlur={event=>{ if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="plain-button portal-account-trigger" aria-expanded={open} aria-controls="portal-account-popover" onClick={()=>setOpen(value=>!value)}>
      <span>{email}</span>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open && <div id="portal-account-popover" className="portal-account-popover"><button ref={signOut} type="button" className="portal-sign-out" onClick={()=>{ setOpen(false); onSignOut(); }}>Sign out</button></div>}
  </div>;
}

function ClientView({actor,client,api,setClient,checkoutOnly,paymentReturn}:{actor:Actor; client:ClientDetail; api:Api; setClient:(client:ClientDetail)=>void; checkoutOnly:boolean; paymentReturn:boolean}) {
  const [checkout,setCheckout] = useState(checkoutOnly);
  const [copyStatus,setCopyStatus] = useState('');
  const [showWorkForm,setShowWorkForm] = useState(false);
  const [workHours,setWorkHours] = useState('');
  const [workFiles,setWorkFiles] = useState<PendingFile[]>([]);
  const [fileError,setFileError] = useState('');
  const workCredits = Number(workHours) * normalCreditsPerHour;
  const validWorkHours = Number.isSafeInteger(workCredits) && workCredits > 0 && workCredits <= 10000;
  const mutate = async (resource:string,method:string,body:unknown) => setClient(await api<ClientDetail>(`/clients/${client.id}/${resource}`,method,body));
  const portalLink = `${window.location.origin}/service/?client=${encodeURIComponent(client.id)}`;
  return <>
    {actor.staff && <div className="portal-back"><a href="/service/">&lt; All clients</a></div>}
    <section className="section stack">
      <div className="row portal-client-header">
        <div>
          <div className="portal-client-heading">
            <h1>{client.name}</h1>
            {actor.staff && <button type="button" className="portal-copy-button" aria-label="Copy client link" title="Copy client link" onClick={async()=>{ try { await navigator.clipboard.writeText(portalLink); setCopyStatus('Client link copied.'); } catch { setCopyStatus(`Client link: ${portalLink}`); } }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/></svg>
            </button>}
          </div>
        </div>
        <div className="portal-balance">
          {(client.balance>0 || !creditsOwed(client)) && <div><strong>{Math.max(0,client.balance)}</strong><span> credits available</span></div>}
          {creditsOwed(client)>0 && <><div><strong>{creditsOwed(client)}</strong><span> credits owed</span></div><p className="caption muted">{formatPrice(creditsOwed(client)*creditPriceCents)} outstanding · $75 per credit</p><p className="caption muted">{Math.max(0,-client.balance)} unbilled · {client.invoiced_credits || 0} on unpaid invoices</p></>}
          {!checkoutOnly && <button type="button" className="plain-button" onClick={()=>setCheckout(value=>!value)} aria-expanded={checkout} aria-controls="portal-credit-checkout">Add credits</button>}
        </div>
      </div>
      {checkoutOnly && <div className="portal-actions"><a href={clientUrl(client.id)}>Back to account</a></div>}
      {copyStatus && <p className="caption" role="status">{copyStatus}</p>}
    </section>
    {paymentReturn && <PaymentReturn client={client} api={api} setClient={setClient} />}
    {checkout && <Checkout client={client} email={actor.email} automaticPayments={!!actor.automaticPayments} />}
    {!checkoutOnly && <>
      <section className="section"><div className="row section-title"><h2>Work & progress</h2><div className="portal-actions"><span className="caption muted">{client.tasks.filter(task=>task.status==='queued'||task.status==='in_progress').length} active</span>{actor.staff && <button type="button" className="plain-button" aria-expanded={showWorkForm} aria-controls="record-work-form" onClick={()=>setShowWorkForm(value=>!value)}>Record work</button>}</div></div>
      {actor.staff && <div id="record-work-form" className="portal-work-form" hidden={!showWorkForm}><MutationForm label="Submit" submit={async(form,id)=>{
        if (fileError) throw new Error(fileError);
        const credits = Number(form.get('hours')) * normalCreditsPerHour;
        if (!Number.isSafeInteger(credits) || credits < 1 || credits > 10000) throw new Error('Enter hours in 0.25-hour increments, from 0.25 to 2,500.');
        await mutate('tasks','POST',{id,title:form.get('title'),description:form.get('description'),requestedBy:form.get('requestedBy'),source:form.get('source'),credits,status:form.get('status')});
        try {
          for (const {id:attachmentId,file} of workFiles) await api(`/clients/${client.id}/tasks/${id}/attachments/${attachmentId}`,'POST',file);
        } catch (error) {
          setClient(await api<ClientDetail>(`/clients/${client.id}`));
          throw new Error(`Work was saved. ${error instanceof Error ? error.message : 'An attachment could not be uploaded.'} Submit again to retry the attachments; credits will not be deducted again.`);
        }
        if (workFiles.length) setClient(await api<ClientDetail>(`/clients/${client.id}`));
        setWorkFiles([]);
        setWorkHours('');
      }}>
        <Field label="Title" name="title" maxLength={160}/><label>Work description<textarea name="description" required maxLength={2000} rows={4} placeholder="Describe the agreed work. This is visible to the client."/></label>
        <AttachmentPicker helpId="work-attachments-help" filesChanged={setWorkFiles} errorChanged={setFileError}/>
        {fileError && <p role="alert">{fileError}</p>}
        <div className="fields"><Field label="Requested by" name="requestedBy" maxLength={254}/><label>Source channel<select name="source"><option value="email">Email</option><option value="text">Text</option><option value="call">Call</option><option value="meeting">Meeting</option><option value="other">Other</option></select></label></div>
        <div className="fields"><div><span className="portal-field-label"><label htmlFor="work-hours">Hours of work</label><span className="portal-info"><button type="button" className="portal-info-button" aria-label="Hours to credits conversion" aria-describedby="work-hours-rate">ⓘ</button><span id="work-hours-rate" role="tooltip">1 hour = {normalCreditsPerHour} credits. Log time in 15-minute increments (0.25 hours).</span></span></span><input id="work-hours" name="hours" type="number" required min={1 / normalCreditsPerHour} max={10000 / normalCreditsPerHour} step={1 / normalCreditsPerHour} value={workHours} onChange={event=>setWorkHours(event.target.value)}/></div><label>Status<select name="status" defaultValue="in_progress"><option value="queued">Queued</option><option value="in_progress">In progress</option><option value="completed">Completed</option></select></label></div>
        {validWorkHours && workCredits>Math.max(0,client.balance) && <p className="portal-overage-note" role="status">{workCredits-Math.max(0,client.balance)} credits will be owed and billed after month-end.</p>}
        <p className="caption muted">Credits are deducted on submit and returned if cancelled.</p>
      </MutationForm></div>}
        {!client.tasks.length ? <p className="muted">No work recorded yet. Requests made through email, text, or other channels will appear here once the team records them.</p> : <div className="portal-tasks">{client.tasks.map(task=><TaskView key={task.id} task={task} client={client} staff={actor.staff} mutate={mutate} api={api} setClient={setClient}/>)}</div>}
      </section>
      <Billing actor={actor} client={client} api={api} setClient={setClient}/>
      <section className="section"><h2 className="portal-heading">Credit activity</h2>{client.ledger.length ? <div className="table-scroll"><table aria-label="Credit purchases, work charges, refunds, and invoice transfers"><thead><tr><th>Date</th><th>Activity</th><th>Credits</th></tr></thead><tbody>{client.ledger.map(entry=><tr key={entry.id}><td>{date(entry.created_at)}</td><td className="wrap">{entry.note}<div className="caption muted">{entry.kind === 'purchase' ? 'Purchase confirmed' : entry.kind === 'refund' ? 'Credits returned' : entry.kind==='billing' ? entry.credits>0 ? 'Moved to invoice · Payment still due' : 'Invoice voided' : 'Work recorded'}{actor.staff && entry.reference ? ` · ${entry.reference}` : ''}</div></td><td>{entry.credits > 0 ? '+' : ''}{entry.credits}</td></tr>)}</tbody></table></div> : <p className="muted">No credit activity yet. Successful purchases appear here automatically.</p>}</section>
      {actor.staff && <>
        {!actor.automaticPayments && <section className="section"><h2 className="portal-heading">Confirm credit purchase</h2><MutationForm label="Add confirmed credits" submit={async(form)=>mutate('purchases','POST',{credits:Number(form.get('credits')),reference:form.get('reference'),note:form.get('note')})}>
          <label>Credit pack<select name="credits">{creditPacks.map(pack=><option key={pack.credits} value={pack.credits}>{pack.credits} credits · {formatPrice(pack.amountCents)}</option>)}</select></label><Field label="Stripe PaymentIntent ID" name="reference" maxLength={200} placeholder="pi_…"/><Field label="Verification note" name="note" maxLength={2000} placeholder="Payment confirmed in Stripe"/>
          <p className="caption muted">Check the successful payment and pack in Stripe first. Use its PaymentIntent ID; each payment can only be credited once.</p>
        </MutationForm></section>}
        <section className="section"><h2 className="portal-heading">Client access</h2><ul className="portal-members">{client.members.map(email=><li key={email}><span>{email}</span><MutationForm label="Remove access" reset={false} submit={async()=>mutate('members','DELETE',{email})}/></li>)}</ul><MutationForm label="Allow email" submit={async(form)=>mutate('members','POST',{email:form.get('email')})}><Field label="Client email" name="email" type="email" maxLength={254}/><p className="caption muted">Share the client link yourself. No invitation email is sent.</p></MutationForm></section>
      </>}
    </>}
  </>;
}

function Billing({actor,client,api,setClient}:{actor:Actor;client:ClientDetail;api:Api;setClient:(client:ClientDetail)=>void}) {
  const [period,setPeriod]=useState(previousMonth);
  const [preview,setPreview]=useState<{period:string;credits:number;amountCents:number}|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState('');
  const invoices=client.invoices || [];
  const invoiceRevision=invoices.map(invoice=>`${invoice.id}:${invoice.status}`).join(',');
  useEffect(()=>{
    if (!actor.staff) return;
    let active=true; setPreview(null); setError('');
    void api<{period:string;credits:number;amountCents:number}>(`/clients/${client.id}/billing?period=${encodeURIComponent(period)}`).then(result=>{if(active)setPreview(result);}).catch(error=>{if(active)setError(error instanceof Error ? error.message : 'Unable to review billing.');});
    return ()=>{active=false;};
  },[actor.staff,client.id,client.balance,invoiceRevision,api,period]);
  async function action(invoiceId:string,operation:'issue'|'refresh'|'void') {
    setBusy(invoiceId); setError('');
    try {setClient(await api<ClientDetail>(`/clients/${client.id}/invoices/${invoiceId}/${operation}`,'POST'));}
    catch(error){setError(error instanceof Error ? error.message : 'Unable to update invoice.');
      try {setClient(await api<ClientDetail>(`/clients/${client.id}`));} catch { /* Keep the original error. */ }
    }
    finally {setBusy('');}
  }
  useEffect(()=>{
    const focus=()=>{for(const invoice of invoices.filter(invoice=>invoice.status==='open')) void action(invoice.id,'refresh');};
    window.addEventListener('focus',focus);
    return ()=>window.removeEventListener('focus',focus);
  },[invoiceRevision,client.id,api]);
  if (!actor.staff && !invoices.length) return null;
  return <section className="section stack"><h2>{actor.staff ? 'Month-end billing' : 'Invoices'}</h2>
    {actor.staff && <>
      <p className="caption muted">Review outstanding credits after each month closes (UTC). Drafts don’t charge the client. Issued bills are due in 30 days; copy the payment link to share it.</p>
      <label>Billing month<input type="month" value={period} max={previousMonth()} min="2020-01" onChange={event=>setPeriod(event.target.value)}/></label>
      {!preview && !error && <p role="status">Loading billing review…</p>}
      {preview && <p role="status">{preview.credits ? `${preview.credits} unbilled credits through ${preview.period} · ${formatPrice(preview.amountCents)}` : `No unbilled credits remain through ${preview.period}.`}</p>}
      {preview && preview.credits>0 && !invoices.some(invoice=>invoice.period===period && invoice.status!=='void') && <MutationForm key={period} label="Create draft" submit={async(form,id)=>{setClient(await api<ClientDetail>(`/clients/${client.id}/invoices`,'POST',{id,period,email:form.get('email'),credits:preview.credits}));}}>
        <label>Billing email<input name="email" type="email" required maxLength={254} defaultValue={client.members[0] || ''}/></label>
      </MutationForm>}
    </>}
    {invoices.map(invoice=><div key={invoice.id} className="portal-invoice stack">
      <div className="row"><h3>{invoice.number || invoice.period}</h3><span className="caption muted">{{draft:'Draft · Staff review',issuing:'Preparing invoice',open:'Payment due',paid:'Paid',void:'Voided'}[invoice.status]}</span></div>
      <p>{invoice.credits} credits · {formatPrice(invoice.amount_cents)} · through {invoice.period}</p>
      {actor.staff && <p className="caption muted">Billing email: {invoice.email}</p>}
      <div className="portal-actions">
        {actor.staff && (invoice.status==='draft' || invoice.status==='issuing') && <button className="plain-button" disabled={!!busy} onClick={()=>void action(invoice.id,'issue')}>{busy===invoice.id ? 'Preparing…' : invoice.status==='draft' ? 'Approve & issue invoice' : 'Retry issuing invoice'}</button>}
        {invoice.status==='open' && invoice.hosted_invoice_url && <><a href={invoice.hosted_invoice_url} target="_blank" rel="noopener noreferrer">{actor.staff ? 'Open payment link' : 'Pay invoice'}</a>{actor.staff && <button className="plain-button" onClick={async()=>{try {await navigator.clipboard.writeText(invoice.hosted_invoice_url!);} catch {setError('Unable to copy. Open the payment link to share it.');}}}>Copy payment link</button>}</>}
        {invoice.status==='open' && <button className="plain-button" disabled={!!busy} onClick={()=>void action(invoice.id,'refresh')}>{busy===invoice.id ? 'Checking…' : 'Refresh payment status'}</button>}
        {actor.staff && (invoice.status==='draft' || invoice.status==='open') && <details><summary>{invoice.status==='draft' ? 'Cancel draft' : 'Void invoice'}</summary><div className="stack details-body"><p className="caption muted">{invoice.status==='draft' ? 'Cancel this draft so you can review an updated bill.' : 'This cancels the bill and returns its credits to the unbilled balance. It does not refund payments.'}</p><div><button className="plain-button" disabled={!!busy} onClick={()=>void action(invoice.id,'void')}>{busy===invoice.id ? 'Saving…' : 'Confirm cancellation'}</button></div></div></details>}
      </div>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function PaymentReturn({client,api,setClient}:{client:ClientDetail;api:Api;setClient:(client:ClientDetail)=>void}) {
  const sessionId = new URLSearchParams(window.location.search).get('session_id');
  const [paymentStatus,setPaymentStatus] = useState<'pending' | 'credited' | 'failed'>('pending');
  const [purchasedCredits,setPurchasedCredits] = useState(0);
  const updated = paymentStatus === 'credited';
  const [refreshing,setRefreshing] = useState(false);
  const [error,setError] = useState('');
  const busy = useRef(false);
  const refresh = useCallback(async()=>{
    if (busy.current) return;
    busy.current=true; setRefreshing(true);
    try {
      if (!sessionId) throw new Error('The checkout session is missing. Contact Windward if you completed a payment.');
      const result = await api<{status:'pending'|'credited'|'failed';credits?:number;client:ClientDetail}>(`/clients/${client.id}/checkout`,'POST',{sessionId});
      setClient(result.client); setPaymentStatus(result.status); setPurchasedCredits(result.credits || 0); setError('');
    }
    catch(error) { setError(error instanceof Error ? error.message : 'Unable to refresh your account.'); }
    finally { busy.current=false; setRefreshing(false); }
  },[api,client.id,setClient,sessionId]);
  useEffect(()=>{
    if (updated || paymentStatus==='failed' || !sessionId) return;
    // Verify immediately on return; retry briefly for delayed payment methods.
    void refresh();
    const interval = window.setInterval(()=>{ if (!document.hidden) void refresh(); },5000);
    const timeout = window.setTimeout(()=>window.clearInterval(interval),120000);
    const focus = ()=>void refresh();
    window.addEventListener('focus',focus);
    return ()=>{ window.clearInterval(interval); window.clearTimeout(timeout); window.removeEventListener('focus',focus); };
  },[refresh,updated,paymentStatus,sessionId]);
  return <section className="section stack" aria-labelledby="payment-return-heading">
    <h2 id="payment-return-heading">{updated ? 'Payment successful' : paymentStatus==='failed' ? 'Checkout expired' : 'Confirming payment'}</h2>
    <p role="status">{updated ? `${purchasedCredits} credits have been added to your account. Your latest balance and credit activity are shown below.` : paymentStatus==='failed' ? 'This checkout expired without a confirmed payment. No credits were added.' : 'We’re checking your payment with Stripe. Your credits will be added automatically once payment is confirmed.'}</p>
    {!updated && <><p className="caption muted">We check automatically for two minutes, and whenever you return to this tab. If payment is still processing, you can check again later.</p>
    <div><button type="button" className="plain-button" disabled={refreshing} onClick={()=>void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh balance'}</button></div></>}
    <div><a href={clientUrl(client.id)}>Back to account</a></div>
    {error && <p role="alert">{error}</p>}
  </section>;
}

function AttachmentPicker({helpId,filesChanged,errorChanged}:{helpId:string;filesChanged:(files:PendingFile[])=>void;errorChanged:(error:string)=>void}) {
  return <><label>Attachments<input name="attachments" type="file" multiple aria-describedby={helpId} onChange={event=>{
    const files=Array.from(event.target.files || []);
    const error=files.length>5 ? 'Choose up to 5 attachments.' : files.some(file=>file.size>10*1024*1024 || file.size===0) ? 'Each attachment must be nonempty and 10 MB or smaller.' : files.some(file=>file.name.length>255) ? 'File names must be 255 characters or shorter.' : '';
    errorChanged(error); filesChanged(error ? [] : files.map(file=>({id:crypto.randomUUID(),file})));
  }}/></label><p id={helpId} className="caption muted">Up to 5 files, 10 MB each. Visible to this client’s approved emails and Windward staff.</p></>;
}

function TaskView({task,client,staff,mutate,api,setClient}:{task:Task; client:ClientDetail; staff:boolean; mutate:(resource:string,method:string,body:unknown)=>Promise<void>;api:Api;setClient:(client:ClientDetail)=>void}) {
  const updates = client.updates.filter(update=>update.task_id===task.id);
  const attachments = (client.attachments || []).filter(attachment=>attachment.task_id===task.id);
  const [files,setFiles]=useState<PendingFile[]>([]);
  const [fileError,setFileError]=useState('');
  const [pendingUpdate,setPendingUpdate]=useState('');
  return <details className={`portal-task ${task.status==='completed'?'portal-task-completed':''}`}><summary><span>{task.title}</span><span className="caption muted">{statusNames[task.status]} · {task.credits} credits{task.status==='cancelled' ? ' returned' : ''}</span></summary><div className="stack details-body"><p className="portal-description">{task.description}</p><p className="caption muted">Requested by {task.requested_by} · {task.source} · {date(task.created_at)}</p>
    <AttachmentList attachments={attachments.filter(file=>!file.update_id)} clientId={client.id} taskId={task.id} api={api}/>
    {updates.length>0 && <ol className="portal-updates">{updates.map(update=><li key={update.id} className="stack"><p>{update.note}</p><p className="caption muted">{statusNames[update.status]} · {date(update.created_at)}</p><AttachmentList attachments={attachments.filter(file=>file.update_id===update.id)} clientId={client.id} taskId={task.id} api={api}/></li>)}</ol>}
    {staff && (task.status!=='cancelled' || pendingUpdate) && <MutationForm label="Save progress" submit={async(form,id)=>{
      if (fileError) throw new Error(fileError);
      // Keep the cancellation form mounted until all its attachments are saved.
      setPendingUpdate(id);
      await mutate(`tasks/${task.id}`,'PATCH',{id,status:form.get('status'),note:form.get('note')});
      try {
        for (const {id:attachmentId,file} of files) await api(`/clients/${client.id}/tasks/${task.id}/attachments/${attachmentId}?update=${encodeURIComponent(id)}`,'POST',file);
      } catch(error) {
        setClient(await api<ClientDetail>(`/clients/${client.id}`));
        throw new Error(`Progress was saved. ${error instanceof Error ? error.message : 'An attachment could not be uploaded.'} Save progress again to retry; the update and any refund will not be duplicated.`);
      }
      if (files.length) setClient(await api<ClientDetail>(`/clients/${client.id}`));
      setFiles([]); setPendingUpdate('');
    }}><label>Status<select name="status" defaultValue={task.status}>{Object.entries(statusNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Progress note<textarea name="note" rows={3} required maxLength={2000} placeholder="Visible to the client"/></label>
      <AttachmentPicker helpId={`progress-attachments-${task.id}`} filesChanged={setFiles} errorChanged={setFileError}/>
      {fileError && <p role="alert">{fileError}</p>}
      <p className="caption muted">Cancelling returns {task.credits} credits and closes this work record.</p>
    </MutationForm>}
  </div></details>;
}

function AttachmentList({attachments,clientId,taskId,api}:{attachments:Attachment[];clientId:string;taskId:string;api:Api}) {
  const [downloading,setDownloading] = useState('');
  const [downloadError,setDownloadError] = useState('');
  if (!attachments.length) return null;
  return <div className="stack"><h3>Attachments</h3><ul className="portal-attachments">{attachments.map(attachment=><li key={attachment.id}><button type="button" className="plain-button" disabled={!!downloading} onClick={async()=>{
      setDownloading(attachment.id); setDownloadError('');
      try {
        const blob = await api<Blob>(`/clients/${clientId}/tasks/${taskId}/attachments/${attachment.id}`,'GET',undefined,'blob');
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href=url; link.download=attachment.name; document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(()=>URL.revokeObjectURL(url),60000);
      } catch(error) { setDownloadError(error instanceof Error ? error.message : 'Unable to download this attachment.'); }
      finally { setDownloading(''); }
    }}>{downloading === attachment.id ? 'Downloading…' : attachment.name}</button><span className="caption muted">{attachment.size < 1024 * 1024 ? `${Math.max(1,Math.ceil(attachment.size / 1024))} KB` : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`}</span></li>)}</ul>{downloadError && <p role="alert">{downloadError}</p>}</div>;
}

function Checkout({client,email,automaticPayments}:{client:ClientDetail;email:string;automaticPayments:boolean}) {
  const clientId = client.id;
  const [credits,setCredits] = useState<16 | 32 | 64>(32);
  const pack = creditPacks.find(pack=>pack.credits===credits)!;
  const testMode = import.meta.env.DEV;
  const link = checkoutLink(credits,testMode,{
    16:import.meta.env.PUBLIC_STRIPE_TEST_LINK_16,
    32:import.meta.env.PUBLIC_STRIPE_TEST_LINK_32,
    64:import.meta.env.PUBLIC_STRIPE_TEST_LINK_64,
  });
  const url = link ? new URL(link) : null;
  // A reconciliation hint, never an authorization check or proof of payment.
  url?.searchParams.set('client_reference_id',clientId);
  // Stripe copies UTM parameters into the configured completion redirect.
  // This selects an account only; the API still enforces access for every read.
  url?.searchParams.set('utm_content',clientId);
  url?.searchParams.set('prefilled_email',email);
  return <section id="portal-credit-checkout" className="section stack portal-checkout">
    <h2>Add credits</h2>
    {testMode && <p role="status">Stripe test mode · No real money is charged. Credits are recorded in the local database.</p>}
    <label>Credit pack<select value={credits} aria-describedby="credit-pack-description" onChange={event=>setCredits(Number(event.target.value) as 16 | 32 | 64)}>{creditPacks.map(pack=><option key={pack.credits} value={pack.credits}>{pack.name} · {pack.credits} credits · {formatPrice(pack.amountCents)}</option>)}</select></label>
    <div id="credit-pack-description" aria-live="polite">
      <p>{pack.description}</p>
      <p className="caption muted">{pack.hours} hours of work at normal delivery. Fast delivery uses more credits.</p>
    </div>
    <div className="row"><span>Subtotal · USD</span><output aria-live="polite">{formatPrice(pack.amountCents)}</output></div>
    <p className="caption muted">$75 per credit · One-time purchase. Applicable tax is shown at checkout.</p>
    {client.balance<0 && <p className="caption muted">Purchased credits first cover your {Math.max(0,-client.balance)} unbilled credits owed.</p>}
    {!!client.invoiced_credits && <p className="caption muted">Issued invoices are paid separately using their payment links. Buying credits does not pay an issued invoice.</p>}
    <div>{url ? <a className="action" href={url.href}>Continue to Stripe{testMode ? ' test checkout' : ''}</a> : <p role="alert">The test payment link for this pack has not been configured.</p>}</div>
    <p className="caption muted">{automaticPayments ? 'Credits are added automatically after Stripe confirms payment.' : 'Windward adds credits after confirming payment.'}</p>
  </section>;
}

function Field({label,...props}:{label:string;name:string;type?:string;maxLength?:number;placeholder?:string;min?:number;max?:number;step?:number}) { return <label>{label}<input {...props} required /></label>; }
function MutationForm({children,submit,label,reset=true}:{children?:ReactNode; submit:(form:FormData,id:string)=>Promise<void>;label:string;reset?:boolean}) {
  const [busy,setBusy] = useState(false), [message,setMessage] = useState(''), [failed,setFailed] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  async function onSubmit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget, data = new FormData(form);
    setBusy(true); setMessage(''); setFailed(false);
    try { await submit(data,requestId.current); if (reset) form.reset(); requestId.current=crypto.randomUUID(); setMessage('Saved.'); }
    catch(error) { setFailed(true); setMessage(error instanceof Error ? error.message : 'Unable to save. Please try again.'); }
    finally { setBusy(false); }
  }
  return <form className="stack portal-form" onSubmit={onSubmit}><fieldset disabled={busy} className="portal-fieldset stack">{children}<div><button type="submit" className="action">{busy?'Saving…':label}</button></div></fieldset>{message && <p className="caption" role={failed?'alert':'status'}>{message}</p>}</form>;
}
