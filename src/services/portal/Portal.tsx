import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { creditPacks, creditPriceCents, formatPrice, normalCreditsPerHour } from '../pricing.mjs';
import { checkoutLink, isLocalApi } from '../stripe-checkout.mjs';
import { creditActivity } from './credit-activity.mjs';
import { saveProgress } from './save-progress.mjs';
import type { Actor, ClientSummary, ClientDetail, Task, WorkStatus, Attachment, BillingInvoice, WorkEntry } from './types';

const statusNames: Record<WorkStatus, string> = { queued: 'Queued', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const date = (value: string) => new Intl.DateTimeFormat('en-US', { month:'short', day:'numeric', year:'numeric' }).format(new Date(value));
const localDateTime = (value:string) => {const time=new Date(value);return new Date(time.getTime()-time.getTimezoneOffset()*60000).toISOString().slice(0,19);};
const monthName = (value:string) => new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${value}-01T00:00:00Z`));
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
  const projectId = window.location.pathname.replace(/\/$/,'') === '/service/project' ? params.get('project') : null;
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
      {client ? projectId ? <ProjectPage actor={actor} client={client} projectId={projectId} api={api} setClient={setClient}/> : <ClientView key={client.id} actor={actor} client={client} api={api} setClient={setClient} checkoutOnly={checkoutOnly} paymentReturn={paymentReturn} /> : <>
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
    <button ref={trigger} type="button" className="plain-button portal-account-trigger" aria-label="Windward Labs account menu" aria-expanded={open} aria-controls="portal-account-popover" onClick={()=>setOpen(value=>!value)}>
      <span>Windward Labs</span>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open && <div id="portal-account-popover" className="portal-account-popover"><div className="portal-account-info"><p className="caption muted">Signed in as</p><p>{email}</p></div><button ref={signOut} type="button" className="portal-sign-out" onClick={()=>{ setOpen(false); onSignOut(); }}>Sign out</button></div>}
  </div>;
}

function ClientView({actor,client,api,setClient,checkoutOnly,paymentReturn}:{actor:Actor; client:ClientDetail; api:Api; setClient:(client:ClientDetail)=>void; checkoutOnly:boolean; paymentReturn:boolean}) {
  const checkout = checkoutOnly;
  const [copyStatus,setCopyStatus] = useState('');
  const creditActionTarget = document.getElementById('service-credit-action');
  const [showWorkForm,setShowWorkForm] = useState(false);
  const [workSaving,setWorkSaving] = useState(false);
  const [workFormRevision,setWorkFormRevision] = useState(0);
  const [workSuccess,setWorkSuccess] = useState<{id:string;credits:number;balance:number}|null>(null);
  const [workHours,setWorkHours] = useState('');
  const [pricingModel,setPricingModel]=useState<'fixed'|'hourly'>('fixed');
  const [fixedPrice,setFixedPrice]=useState('');
  const [chargeTiming,setChargeTiming]=useState('upfront');
  const [workFiles,setWorkFiles] = useState<PendingFile[]>([]);
  const [fileError,setFileError] = useState('');
  const activeProjects = client.tasks.filter(task=>task.status==='queued'||task.status==='in_progress');
  const completedProjects = client.tasks.filter(task=>task.status==='completed'||task.status==='cancelled');
  const activity=creditActivity(client.ledger,client.workEntries);
  const workCredits = pricingModel==='fixed' ? (chargeTiming==='upfront' ? Number(fixedPrice) : 0) : Number(workHours) * normalCreditsPerHour;
  const validWorkHours = Number.isSafeInteger(workCredits) && workCredits > 0 && workCredits <= 10000;
  const mutate = async (resource:string,method:string,body:unknown) => setClient(await api<ClientDetail>(`/clients/${client.id}/${resource}`,method,body));
  const portalLink = `${window.location.origin}/service/?client=${encodeURIComponent(client.id)}`;
  return <>
    {creditActionTarget && !checkoutOnly && createPortal(<a className="action" href={`/service/checkout/?client=${encodeURIComponent(client.id)}`}>Add credits</a>,creditActionTarget)}
    {actor.staff && !checkoutOnly && <div className="portal-back"><a href="/service/">&lt; All clients</a></div>}
    {checkoutOnly && <div className="portal-back"><a href={clientUrl(client.id)}>&lt; Back to account</a></div>}
    <section className="section stack" hidden={checkoutOnly}>
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
        </div>
      </div>
      {copyStatus && <p className="caption" role="status">{copyStatus}</p>}
    </section>
    {paymentReturn && <PaymentReturn client={client} api={api} setClient={setClient} />}
    {checkout && <Checkout client={client} email={actor.email} automaticPayments={!!actor.automaticPayments} />}
    {!checkoutOnly && <>
      <section id="active-projects" className="section"><div className="row section-title"><div><h2>Active Projects</h2><p className="caption muted">{activeProjects.length} active</p></div><div className="portal-actions">{actor.staff && <button type="button" className="plain-button" aria-haspopup="dialog" aria-controls="record-work-form" onClick={()=>{setWorkSuccess(null);setShowWorkForm(true);}}>New Project</button>}</div></div>
      {workSuccess && <ProjectCreatedToast success={workSuccess} onDismiss={()=>setWorkSuccess(null)}/>}
      {actor.staff && <ProjectDialog open={showWorkForm} busy={workSaving} onClose={()=>setShowWorkForm(false)}><MutationForm key={workFormRevision} onBusyChange={setWorkSaving} label="Submit" submit={async(form,id)=>{
        if (fileError) throw new Error(fileError);
        const fixed=form.get('pricingModel')==='fixed';
        const fixedCredits=fixed ? Number(form.get('fixedCredits')) : null;
        const budgetCredits=!fixed && form.get('budgetCredits') ? Number(form.get('budgetCredits')) : null;
        const credits = fixed ? (form.get('chargeTiming')==='upfront' ? fixedCredits! : 0) : Number(form.get('hours')) * normalCreditsPerHour;
        if (!Number.isSafeInteger(credits) || credits < 0 || credits > 10000) throw new Error('Enter hours in 0.25-hour increments, from 0.25 to 2,500, or leave blank.');
        if(!fixed && budgetCredits!==null && credits>budgetCredits)throw new Error('Initial hours exceed the approved budget.');
        const workDate=String(form.get('occurredAt') || '');
        let savedClient = await api<ClientDetail>(`/clients/${client.id}/tasks`,'POST',{id,title:form.get('title'),description:form.get('description'),requestedBy:form.get('requestedBy'),source:form.get('source'),credits:0,status:form.get('status'),pricingModel:fixed ? 'fixed' : 'hourly',fixedCredits,budgetCredits});
        if(credits>0) {
          const occurredAt=workDate ? new Date(workDate).toISOString() : savedClient.tasks.find(task=>task.id===id)!.created_at;
          savedClient=await api<ClientDetail>(`/clients/${client.id}/tasks/${id}/${fixed ? 'charges' : 'work-entries'}`,'POST',{id,occurredAt,...(fixed ? {} : {hours:credits/normalCreditsPerHour}),credits,note:fixed ? `Agreed price: ${String(form.get('title'))}` : form.get('description')});
        }
        setClient(savedClient);
        try {
          for (const {id:attachmentId,file} of workFiles) await api(`/clients/${client.id}/tasks/${id}/attachments/${attachmentId}`,'POST',file);
        } catch (error) {
          setClient(await api<ClientDetail>(`/clients/${client.id}`));
          throw new Error(`Work was saved. ${error instanceof Error ? error.message : 'An attachment could not be uploaded.'} Submit again to retry the attachments; credits will not be deducted again.`);
        }
        if (workFiles.length) {savedClient = await api<ClientDetail>(`/clients/${client.id}`);setClient(savedClient);}
        setWorkFiles([]);setWorkHours('');setFixedPrice('');setPricingModel('fixed');setChargeTiming('upfront');
        setWorkSuccess({id,credits,balance:savedClient.balance});
        setShowWorkForm(false);setWorkFormRevision(value=>value+1);
      }}>
        <label>Project type<select name="pricingModel" value={pricingModel} onChange={event=>setPricingModel(event.target.value as 'fixed'|'hourly')}><option value="fixed">Fixed price</option><option value="hourly">Hourly</option></select></label>
        {pricingModel==='fixed' ? <><div className="fields"><label>Agreed price (credits)<input name="fixedCredits" type="number" required min={1} max={10000} step={1} value={fixedPrice} onChange={event=>setFixedPrice(event.target.value)}/></label><label>Charge timing<select name="chargeTiming" value={chargeTiming} onChange={event=>setChargeTiming(event.target.value)}><option value="upfront">Charge upfront</option><option value="milestones">Charge by milestones</option></select></label></div><p className="caption muted">{Number(fixedPrice)>0 ? `${formatPrice(Number(fixedPrice)*creditPriceCents)} · ` : ''}A fixed price for the agreed scope. Hours are tracked privately without additional charges.</p></> : <><label>Approved budget (credits, optional)<input name="budgetCredits" type="number" min={1} max={10000} step={1}/></label><p className="caption muted">Actual time costs 4 credits per hour ($300/hour). Further work requires approval when the budget is reached.</p></>}
        <Field label="Title" name="title" maxLength={160}/><label>Work description<textarea name="description" required maxLength={2000} rows={4} placeholder="Describe the brief. This is visible to the client."/></label>
        <AttachmentPicker helpId="work-attachments-help" filesChanged={setWorkFiles} errorChanged={setFileError}/>
        {fileError && <p role="alert">{fileError}</p>}
        <div className="fields"><Field label="Requested by" name="requestedBy" maxLength={254}/><label>Source channel<select name="source"><option value="email">Email</option><option value="text">Text</option><option value="call">Call</option><option value="meeting">Meeting</option><option value="other">Other</option></select></label></div>
        <div className="fields">{pricingModel==='hourly' && <div><span className="portal-field-label"><label htmlFor="work-hours">Initial hours (optional)</label><span className="portal-info"><button type="button" className="portal-info-button" aria-label="Hours to credits conversion" aria-describedby="work-hours-rate">ⓘ</button><span id="work-hours-rate" role="tooltip">1 hour = {normalCreditsPerHour} credits. Log time in 15-minute increments (0.25 hours).</span></span></span><input id="work-hours" name="hours" type="number" min={1 / normalCreditsPerHour} max={10000 / normalCreditsPerHour} step={1 / normalCreditsPerHour} value={workHours} onChange={event=>setWorkHours(event.target.value)}/></div>}<label>Status<select name="status" defaultValue="in_progress"><option value="queued">Queued</option><option value="in_progress">In progress</option><option value="completed">Completed</option></select></label></div>
        {validWorkHours && workCredits>Math.max(0,client.balance) && <p className="portal-overage-note" role="status">{workCredits-Math.max(0,client.balance)} credits will be owed and billed after month-end.</p>}
        <label>{pricingModel==='fixed' ? 'Charge date (optional)' : 'Work date (optional)'}<input type="datetime-local" name="occurredAt" step={1} max={localDateTime(new Date().toISOString())}/></label><p className="caption muted">Leave blank to use today. Billing months use UTC.</p>
        <p className="caption muted">{pricingModel==='fixed' ? 'Upfront charges use this date. Milestone projects start without a charge.' : 'Initial hours create a dated work entry. Leave blank to start without a charge.'}</p>
      </MutationForm></ProjectDialog>}
        {!activeProjects.length ? <div className="portal-empty-state"><h3>No active projects</h3><p className="muted">{actor.staff ? 'Start a new project to record work and track its progress.' : 'The team will add your next project here. You’ll be able to follow its progress and updates.'}</p></div> : <div className="portal-tasks">{activeProjects.map(task=><ProjectLink key={task.id} task={task} clientId={client.id}/>)}</div>}
      </section>
      <section className="section"><h2 className="portal-heading">Completed Projects</h2>{completedProjects.length ? <div className="portal-tasks">{completedProjects.map(task=><ProjectLink key={task.id} task={task} clientId={client.id}/>)}</div> : <p className="muted">No completed projects yet.</p>}</section>
      <Billing actor={actor} client={client} api={api} setClient={setClient}/>
      <section className="section"><h2 className="portal-heading">Credit activity</h2>{activity.length ? <div className="table-scroll"><table className="portal-credit-table" aria-label="Credit purchases, work charges, refunds, and invoice transfers"><thead><tr><th>Date (UTC)</th><th>Activity</th><th>Credits</th><th><span className="portal-pack-legend">Invoice</span></th></tr></thead><tbody>{activity.map(entry=><tr key={entry.id}><td><time dateTime={entry.occurred_at || entry.created_at}>{new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(entry.occurred_at || entry.created_at))}</time></td><td className="wrap">{entry.note}<div className="caption muted">{entry.kind === 'purchase' ? 'Purchase confirmed' : entry.kind === 'refund' ? 'Credits returned' : entry.kind==='billing' ? entry.credits>0 ? 'Moved to invoice · Payment still due' : 'Invoice voided' : entry.allocation ? 'Work allocated' : 'Work recorded'}{actor.staff && entry.reference ? ` · ${entry.reference}` : ''}</div></td><td>{entry.credits > 0 ? '+' : ''}{entry.credits}</td><td>{(entry.kind==='purchase' || (entry.kind==='billing' && entry.credits>0)) && <PaymentDocument clientId={client.id} entryId={entry.id} purchase={entry.kind==='purchase'} api={api}/>}</td></tr>)}</tbody></table></div> : <p className="muted">No credit activity yet. Successful purchases appear here automatically.</p>}</section>
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

function ProjectDialog({open,busy,onClose,children,id='record-work-form',title='New Project'}:{open:boolean;busy:boolean;onClose:()=>void;children:ReactNode;id?:string;title?:string}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const element=dialog.current;
    if(open && element && !element.open)element.showModal();
    else if(!open && element?.open)element.close();
  },[open]);
  return <dialog ref={dialog} id={id} className="portal-project-dialog" aria-labelledby={`${id}-title`} onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onClose={onClose}><div className="row"><h2 id={`${id}-title`}>{title}</h2><button type="button" className="portal-copy-button" aria-label={`Close ${title.toLowerCase()}`} disabled={busy} onClick={onClose}>×</button></div>{children}</dialog>;
}

function Billing({actor,client,api,setClient}:{actor:Actor;client:ClientDetail;api:Api;setClient:(client:ClientDetail)=>void}) {
  const [period,setPeriod]=useState(previousMonth);
  const [preview,setPreview]=useState<{period:string;credits:number;amountCents:number}|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState('');
  const invoices=[...(client.invoices || [])].sort((a,b)=>a.period.localeCompare(b.period) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
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
      <p className="caption muted">Review a completed month and approve a bill for outstanding credits.</p>
      <label>Billing month<input type="month" value={period} max={previousMonth()} min="2020-01" onChange={event=>setPeriod(event.target.value)}/></label>
      {!preview && !error && <p role="status">Loading billing review…</p>}
      {preview && <p role="status">{preview.credits ? `${preview.credits} unbilled credits · ${formatPrice(preview.amountCents)}` : `No unbilled credits for ${monthName(preview.period)}.`}</p>}
      {preview && preview.credits>0 && !invoices.some(invoice=>invoice.period===period && invoice.status!=='void') && <MutationForm key={period} label="Create draft" submit={async(form,id)=>{setClient(await api<ClientDetail>(`/clients/${client.id}/invoices`,'POST',{id,period,email:form.get('email'),credits:preview.credits}));}}>
        <label>Billing email<input name="email" type="email" required maxLength={254} defaultValue={client.members[0] || ''}/></label>
      </MutationForm>}
    </>}
    {invoices.map(invoice=><InvoiceCard key={invoice.id} invoice={invoice} clientId={client.id} staff={actor.staff} busy={!!busy} working={busy===invoice.id} api={api} action={operation=>void action(invoice.id,operation)}/>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function InvoiceCard({invoice,clientId,staff,busy,working,api,action}:{invoice:BillingInvoice;clientId:string;staff:boolean;busy:boolean;working:boolean;api:Api;action:(operation:'issue'|'refresh'|'void')=>void}) {
  const [copied,setCopied]=useState(false), [copyError,setCopyError]=useState(''), [menuOpen,setMenuOpen]=useState(false);
  const menu=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    if(!menuOpen)return;
    const dismiss=(event:PointerEvent)=>{if(event.target instanceof Node && !menu.current?.contains(event.target) && menu.current)menu.current.open=false;};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape' && menu.current){menu.current.open=false;menu.current.querySelector('summary')?.focus();}};
    document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape);
    return ()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape);};
  },[menuOpen]);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),4000);return ()=>clearTimeout(timer);},[copied]);
  async function copyLink(){try{await navigator.clipboard.writeText(invoice.hosted_invoice_url!);setCopied(true);setCopyError('');}catch{setCopyError('Unable to copy. Open the invoice to share its link.');}}
  return <div className="portal-invoice">
    <div><div className="portal-invoice-title"><strong className="portal-invoice-amount">{formatPrice(invoice.amount_cents)}</strong><span className={`caption portal-invoice-status ${invoice.status==='paid' ? 'portal-success' : invoice.status==='open' ? 'portal-invoice-due' : ''}`}>{invoice.status==='paid' && '✓ '}{{draft:'Draft',issuing:'Preparing',open:'Payment due',paid:'Paid',void:'Voided'}[invoice.status]}</span></div><p className="caption muted">{invoice.credits} credits · {monthName(invoice.period)}</p></div>
    <div className="portal-invoice-controls">
      {staff && (invoice.status==='draft'||invoice.status==='issuing') && <button type="button" className="action" disabled={busy} onClick={()=>action('issue')}>{working ? 'Preparing…' : invoice.status==='draft' ? 'Approve & issue' : 'Retry issuing'}</button>}
      {invoice.status==='open' && invoice.hosted_invoice_url && (staff ? <button type="button" className="action" onClick={()=>void copyLink()} aria-live="polite">{copied ? 'Copied ✓' : 'Copy payment link'}</button> : <a className="action" href={invoice.hosted_invoice_url} target="_blank" rel="noopener noreferrer">Pay invoice</a>)}
      <details ref={menu} className="portal-invoice-menu" onToggle={event=>setMenuOpen(event.currentTarget.open)}><summary aria-label="More invoice actions"><span aria-hidden="true">⋯</span></summary><div className="portal-invoice-popover">
        <div className="portal-invoice-info"><p className="caption muted">{invoice.number || 'Unissued draft'}</p>{staff && <p className="caption">{invoice.email}</p>}{invoice.status==='draft' && <p className="caption muted">Approval creates the bill.</p>}</div>
        {invoice.hosted_invoice_url && <><a href={invoice.hosted_invoice_url} target="_blank" rel="noopener noreferrer">Open invoice</a><PaymentDocument clientId={clientId} entryId={`invoice:${invoice.id}`} purchase={false} api={api}/></>}
        {invoice.status==='open' && <button type="button" disabled={busy} onClick={()=>action('refresh')}>{working ? 'Checking…' : 'Check payment status'}</button>}
        {staff && (invoice.status==='draft'||invoice.status==='open') && <details className="portal-invoice-cancel"><summary>{invoice.status==='draft' ? 'Cancel draft' : 'Void invoice'}</summary><div className="stack"><p className="caption muted">{invoice.status==='draft' ? 'Cancel this draft to review an updated bill.' : 'This cancels the bill and returns its credits to the unbilled balance.'}</p><button type="button" disabled={busy} onClick={()=>action('void')}>{working ? 'Saving…' : invoice.status==='draft' ? 'Confirm cancellation' : 'Confirm void'}</button></div></details>}
      </div></details>
    </div>{copyError && <p className="caption portal-invoice-error" role="alert">{copyError}</p>}
  </div>;
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

function TaskStatus({task,showStatus=true}:{task:Task;showStatus?:boolean}) {
  return <span className="caption portal-task-meta">{showStatus && <span className={task.status==='completed' ? 'portal-success' : 'portal-status-neutral'}>{task.status==='completed' && <span aria-hidden="true">✓ </span>}{statusNames[task.status]}</span>}<span className="muted">{task.pricing_model==='fixed' ? 'Fixed price' : 'Hourly'} · {task.credits}{task.pricing_model==='fixed' ? ` / ${task.fixed_credits}` : ''} credits{task.status==='cancelled' ? ' returned' : ' charged'}</span></span>;
}
function ProjectCreatedToast({success,onDismiss}:{success:{id:string;credits:number;balance:number};onDismiss:()=>void}) {
  const [hovered,setHovered]=useState(false);
  const [focused,setFocused]=useState(false);
  const paused=hovered || focused;
  const dismiss=useRef(onDismiss);
  dismiss.current=onDismiss;
  useEffect(()=>{
    if(paused)return;
    const timer=window.setTimeout(()=>dismiss.current(),8000);
    return ()=>window.clearTimeout(timer);
  },[success.id,paused]);
  return createPortal(<div className="portal-project-toast" onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocus={()=>setFocused(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocused(false);}}>
    <svg className="portal-toast-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>
    <div role="status"><strong>Project created</strong><p>{success.credits} credits deducted · {Math.abs(success.balance)} credits {success.balance<0 ? 'owed' : 'available'}</p></div>
    <button type="button" className="portal-toast-dismiss" aria-label="Dismiss notification" onClick={onDismiss}>×</button>
  </div>,document.body);
}
function ProjectLink({task,clientId}:{task:Task;clientId:string}) {
  return <a className="portal-project-link" href={`/service/project/?client=${encodeURIComponent(clientId)}&project=${encodeURIComponent(task.id)}`}><span>{task.title}</span><span className="portal-task-meta"><TaskStatus task={task} showStatus={task.status==='completed' || task.status==='cancelled'}/><span aria-hidden="true">›</span></span></a>;
}
function ProjectPage({actor,client,projectId,api,setClient}:{actor:Actor;client:ClientDetail;projectId:string;api:Api;setClient:(client:ClientDetail)=>void}) {
  const task=client.tasks.find(task=>task.id===projectId);
  const target=document.getElementById('service-credit-action');
  return <>{target && createPortal(<a className="action" href={`/service/checkout/?client=${encodeURIComponent(client.id)}`}>Add credits</a>,target)}<div className="portal-back"><a href={clientUrl(client.id)}>&lt; All projects</a></div>{task ? <TaskView key={task.id} task={task} client={client} staff={actor.staff} api={api} setClient={setClient}/> : <section className="section stack"><h1>Project unavailable</h1><p>This project could not be found in your account.</p></section>}</>;
}

function ProjectAgreement({task,client,staff,api,setClient}:{task:Task;client:ClientDetail;staff:boolean;api:Api;setClient:(client:ClientDetail)=>void}) {
  const fixed=task.pricing_model==='fixed';
  const [editing,setEditing]=useState(false),[charging,setCharging]=useState(false),[busy,setBusy]=useState(false);
  const [model,setModel]=useState<'fixed'|'hourly'>(task.pricing_model || 'hourly');
  const [notice,setNotice]=useState('');
  const times=(client.timeEntries || []).filter(entry=>entry.task_id===task.id);
  const hours=times.reduce((sum,entry)=>sum+entry.hours,0);
  const charges=(client.projectCharges || []).filter(entry=>entry.task_id===task.id);
  const changes=(client.agreementChanges || []).filter(entry=>entry.task_id===task.id);
  const remaining=fixed ? (task.fixed_credits || 0)-task.credits : task.budget_credits ? task.budget_credits-task.credits : null;
  return <div className="stack portal-agreement">
    <div className="row"><div><h3>{fixed ? 'Fixed-price agreement' : 'Hourly agreement'}</h3><p className="caption muted">{fixed ? `${task.fixed_credits} credits · ${formatPrice((task.fixed_credits || 0)*creditPriceCents)} for the agreed scope` : '4 credits per hour · $300/hour'}{!fixed && task.budget_credits ? ` · ${task.budget_credits} credits approved` : ''}</p></div>{staff && task.status!=='cancelled' && <button type="button" className="plain-button" onClick={()=>{setModel(task.pricing_model || 'hourly');setEditing(true);}}>Change agreement</button>}</div>
    <div className="row"><p className="caption muted">{task.credits} credits charged{remaining!==null ? ` · ${remaining} ${fixed ? 'remaining to charge' : 'budget remaining'}` : ''}</p>{staff && fixed && task.status!=='cancelled' && !!remaining && <button type="button" className="plain-button" onClick={()=>setCharging(true)}>Charge milestone</button>}</div>
    {notice && <p className="caption" role="status">{notice}</p>}
    {fixed && charges.length>0 && <details><summary className="caption">Price charges</summary><ul>{charges.map(entry=><li key={entry.id}><time dateTime={entry.occurred_at}>{date(entry.occurred_at)}</time> · {entry.credits} credits · {entry.note}</li>)}</ul></details>}
    {staff && fixed && <details><summary className="caption">Internal time · {hours} hours · no additional charge</summary>{times.length ? <ul>{times.map(entry=><li key={entry.id}><time dateTime={entry.occurred_at}>{date(entry.occurred_at)}</time> · {entry.hours} hours · {entry.note}</li>)}</ul> : <p className="caption muted">Log hours with a progress update to track effort privately.</p>}</details>}
    {staff && changes.length>0 && <details><summary className="caption">Agreement history</summary><ul>{changes.map(change=><li key={change.id}>{date(change.created_at)} · {change.actor_email} · {change.approval_note}<p className="caption muted">{(()=>{const terms=JSON.parse(change.after_json);return terms.pricingModel==='fixed' ? `Fixed price: ${terms.fixedCredits} credits` : `Hourly budget: ${terms.budgetCredits ?? 'No cap'} credits`;})()}</p></li>)}</ul></details>}
    {staff && <ProjectDialog id="charge-project" title="Charge milestone" open={charging} busy={busy} onClose={()=>setCharging(false)}><MutationForm label="Charge credits" onBusyChange={setBusy} submit={async(form,id)=>{
      setClient(await api<ClientDetail>(`/clients/${client.id}/tasks/${task.id}/charges`,'POST',{id,credits:Number(form.get('credits')),occurredAt:new Date(String(form.get('occurredAt'))).toISOString(),note:form.get('note')}));setCharging(false);setNotice('Milestone charged.');
    }}><p className="caption muted">Up to {remaining} credits remain within the agreed price. This deducts credits once.</p><label>Credits<input name="credits" type="number" required min={1} max={remaining || 1} step={1}/></label><label>Charge date<input name="occurredAt" type="datetime-local" required step={1} defaultValue={localDateTime(new Date().toISOString())} max={localDateTime(new Date().toISOString())}/></label><label>Milestone summary<textarea name="note" required maxLength={2000} rows={3} placeholder="Visible to the client"/></label></MutationForm></ProjectDialog>}
    {staff && <ProjectDialog id="change-project-agreement" title="Change agreement" open={editing} busy={busy} onClose={()=>setEditing(false)}><MutationForm label="Save approved agreement" onBusyChange={setBusy} submit={async(form,id)=>{
      if(form.get('approved')!=='on')throw new Error('Confirm client approval before changing the agreement.');
      setClient(await api<ClientDetail>(`/clients/${client.id}/tasks/${task.id}/agreement`,'PATCH',{id,expectedVersion:task.details_version || 0,pricingModel:model,fixedCredits:model==='fixed' ? Number(form.get('fixedCredits')) : null,budgetCredits:model==='hourly' && form.get('budgetCredits') ? Number(form.get('budgetCredits')) : null,approvalNote:form.get('approvalNote')}));setEditing(false);setNotice('Agreement updated. Existing charges are unchanged.');
    }}><label>Project type<select value={model} onChange={event=>setModel(event.target.value as 'fixed'|'hourly')}><option value="fixed">Fixed price</option><option value="hourly">Hourly</option></select></label>{model==='fixed' ? <label>Approved fixed price (credits)<input name="fixedCredits" type="number" required min={Math.max(1,task.credits)} max={10000} step={1} defaultValue={task.fixed_credits ?? Math.max(1,task.credits)}/></label> : <label>Approved budget (credits, optional)<input name="budgetCredits" type="number" min={Math.max(1,task.credits)} max={10000} step={1} defaultValue={task.budget_credits ?? ''}/></label>}<p className="caption muted">Existing charges stay intact. A higher fixed price can be charged separately as a milestone.</p><label>Client approval reference<textarea name="approvalNote" required maxLength={2000} rows={3} placeholder="When and where the client approved this change; private to staff"/></label><label><input name="approved" type="checkbox" required/> The client has approved this agreement.</label></MutationForm></ProjectDialog>}
  </div>;
}

function TaskView({task,client,staff,api,setClient}:{task:Task; client:ClientDetail; staff:boolean; api:Api;setClient:(client:ClientDetail)=>void}) {
  const [editing,setEditing]=useState<Task|null>(null);
  const [editSaving,setEditSaving]=useState(false);
  const [projectNotice,setProjectNotice]=useState('');
  const [dateEditing,setDateEditing]=useState<Task|null>(null);
  const [dateSaving,setDateSaving]=useState(false);
  const [entryEditing,setEntryEditing]=useState<WorkEntry|null>(null);
  const [showHidden,setShowHidden]=useState(false);
  const [showAllActivity,setShowAllActivity]=useState(false);
  const [visibilityBusy,setVisibilityBusy]=useState('');
  const [visibilityError,setVisibilityError]=useState('');
  const [visibilityNotice,setVisibilityNotice]=useState('');
  const projectUpdates = client.updates.filter(update=>update.task_id===task.id);
  const hiddenUpdates=projectUpdates.filter(update=>update.hidden_at);
  const hiddenIds=new Set(hiddenUpdates.map(update=>update.id));
  const updates = projectUpdates.filter(update=>!update.hidden_at || (staff && showHidden));
  const entries=(client.workEntries || []).filter(entry=>entry.task_id===task.id);
  const timeline = [{id:`project:${task.id}`,at:task.created_at,update:null,entry:null},...updates.map(update=>({id:update.id,at:update.occurred_at || update.created_at,update,entry:null})),...entries.map(entry=>({id:`work:${entry.id}`,at:entry.occurred_at,update:null,entry}))].sort((a,b)=>b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const visibleTimeline=showAllActivity ? timeline : timeline.slice(0,3);
  const attachments = (client.attachments || []).filter(attachment=>attachment.task_id===task.id);
  const visibleAttachments=attachments.filter(file=>!file.update_id || !hiddenIds.has(file.update_id));
  const changeVisibility=async(updateId:string,restore:boolean)=>{
    setVisibilityBusy(updateId);setVisibilityError('');setVisibilityNotice('');
    try {
      const path=`/clients/${client.id}/tasks/${task.id}/updates/${updateId}`;
      setClient(await api<ClientDetail>(restore ? `${path}/restore` : path,restore ? 'POST' : 'DELETE'));
      setVisibilityNotice(restore ? 'Update restored.' : 'Update hidden. You can restore it from hidden updates.');
    } catch(error) {setVisibilityError(error instanceof Error ? error.message : 'Unable to change update visibility.');}
    finally {setVisibilityBusy('');}
  };
  const [files,setFiles]=useState<PendingFile[]>([]);
  const [fileError,setFileError]=useState('');
  const [pendingUpdate,setPendingUpdate]=useState('');
  const [progressHours,setProgressHours]=useState('');
  const [progressDate,setProgressDate]=useState(()=>localDateTime(new Date().toISOString()));
  const progressCredits=Number(progressHours)*normalCreditsPerHour;
  const body = <div className="stack details-body"><ProjectVisuals attachments={visibleAttachments} clientId={client.id} taskId={task.id} api={api}/><p className="portal-description">{task.description}</p>
    <AttachmentList attachments={attachments.filter(file=>!file.update_id)} clientId={client.id} taskId={task.id} api={api}/>
    <div className="stack"><div className="row"><h3>Activity</h3>{staff && hiddenUpdates.length>0 && <button type="button" className="portal-update-action" aria-pressed={showHidden} onClick={()=>setShowHidden(value=>!value)}>{showHidden ? 'Hide hidden updates' : `Show ${hiddenUpdates.length} hidden ${hiddenUpdates.length===1 ? 'update' : 'updates'}`}</button>}</div>
      {visibilityError && <p role="alert">{visibilityError}</p>}{visibilityNotice && <p className="caption muted" role="status">{visibilityNotice}</p>}
      <ol id={`project-activity-${task.id}`} className="portal-timeline">{visibleTimeline.map(item=><li key={item.id} className={item.update?.hidden_at ? 'portal-timeline-hidden' : undefined}><div className="row"><strong>{item.entry ? `${item.entry.hours} hours · ${item.entry.credits} credits` : item.update ? statusNames[item.update.status] : 'Project created'}</strong><div className="portal-actions"><time className="caption muted" dateTime={item.at}>{item.entry ? new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(item.at)) : date(item.at)}</time>{staff && item.entry && <button type="button" className="portal-update-action" onClick={()=>setEntryEditing(item.entry)}>Edit entry</button>}{item.update?.hidden_at && <span className="caption portal-status-neutral">Hidden</span>}{staff && item.update && <button type="button" className="portal-update-action" disabled={!!visibilityBusy} onClick={()=>void changeVisibility(item.id,!!item.update?.hidden_at)}>{visibilityBusy===item.id ? 'Saving…' : item.update.hidden_at ? 'Restore' : 'Hide update'}</button>}</div></div>{item.entry ? <p className="portal-description">{item.entry.note}</p> : item.update ? <><p className="portal-description">{item.update.note}</p>{staff && item.update.hidden_at && <p className="caption muted">Hidden {date(item.update.hidden_at)} by {item.update.hidden_actor_email}</p>}<AttachmentList attachments={attachments.filter(file=>file.update_id===item.id)} clientId={client.id} taskId={task.id} api={api}/></> : <p className="caption muted">Requested by {task.requested_by} via {task.source}</p>}</li>)}</ol>{timeline.length>3 && <button type="button" className="portal-update-action" aria-expanded={showAllActivity} aria-controls={`project-activity-${task.id}`} onClick={()=>setShowAllActivity(value=>!value)}>{showAllActivity ? 'Show less' : 'Show more'}</button>}</div>
    {staff && (task.status!=='cancelled' || pendingUpdate) && <MutationForm label="Save progress" submit={async(form,id)=>{
      if (fileError) throw new Error(fileError);
      // Publish the new status after uploads so moving sections preserves retry state.
      setPendingUpdate(id);
      const chosenDate=String(form.get('occurredAt') || '');
      if(progressHours && !chosenDate)throw new Error('Choose when the work happened.');
      setClient(await saveProgress({api,clientId:client.id,taskId:task.id,pricingModel:task.pricing_model,id,status:String(form.get('status')),note:String(form.get('note')),hours:Number(progressHours),occurredAt:chosenDate ? new Date(chosenDate).toISOString() : undefined,files}));
      setFiles([]); setPendingUpdate('');setProgressHours('');setProgressDate(localDateTime(new Date().toISOString()));setProjectNotice(progressCredits>0 ? task.pricing_model==='fixed' ? 'Progress saved · hours tracked privately, no credits deducted.' : `Progress saved · ${progressCredits} credits deducted.` : 'Progress saved.');
    }}><label>Status<select name="status" defaultValue={task.status}>{Object.entries(statusNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Progress note<textarea name="note" rows={3} required maxLength={2000} placeholder="Visible to the client"/></label>
      <AttachmentPicker helpId={`progress-attachments-${task.id}`} filesChanged={setFiles} errorChanged={setFileError}/>
      {fileError && <p role="alert">{fileError}</p>}
      <div className="fields"><label>Hours worked (optional)<input name="hours" type="number" min={0.25} max={2500} step={0.25} value={progressHours} onChange={event=>setProgressHours(event.target.value)} disabled={task.pricing_model!=='fixed' && task.billing_mode!=='entries'}/></label><label>Work date<input name="occurredAt" type="datetime-local" step={1} required={!!progressHours} value={progressDate} onChange={event=>setProgressDate(event.target.value)} max={localDateTime(new Date().toISOString())}/></label></div>
      {task.pricing_model==='fixed' ? <p className="caption muted">Hours are private to staff and do not change the agreed price.</p> : Number.isSafeInteger(progressCredits) && progressCredits>0 ? <p className="caption muted" role="status">{progressHours} hours = {progressCredits} credits · {formatPrice(progressCredits*creditPriceCents)}. Log only additional work that hasn’t already been recorded.</p> : <p className="caption muted">Leave hours blank to save progress without a charge.</p>}
      {task.pricing_model!=='fixed' && task.billing_mode!=='entries' && <p className="caption muted">Reallocate this project’s original charge before logging additional hours.</p>}
      <p className="caption muted">Cancelling returns {task.credits} credits and closes this work record.</p>
    </MutationForm>}
  </div>;
  return <section className="section stack portal-project-page"><div className="row"><div><h1>{task.title}</h1><p className="caption muted">{client.name}</p></div><div className="portal-actions"><TaskStatus task={task}/>{staff && <button type="button" className="plain-button" aria-haspopup="dialog" aria-controls="edit-project-details" onClick={()=>{setProjectNotice('');setEditing(task);}}>Edit details</button>}</div></div>
    {projectNotice && <p className="caption portal-edit-success" role="status">{projectNotice}</p>}
    <ProjectAgreement task={task} client={client} staff={staff} api={api} setClient={setClient}/>
    {task.billing_mode!=='entries' && <div className="portal-actions caption muted"><span>Work date · {date(task.occurred_at || task.created_at)}</span>{staff && <button type="button" className="portal-update-action" aria-haspopup="dialog" aria-controls="edit-project-date" onClick={()=>{setProjectNotice('');setDateEditing(task);}}>Change work date</button>}</div>}
    {staff && <ProjectDialog id="edit-work-entry" title="Edit work entry" open={!!entryEditing} busy={dateSaving} onClose={()=>setEntryEditing(null)}>{entryEditing && <MutationForm label="Save changes" reset={false} onBusyChange={setDateSaving} submit={async(form,id)=>{
      const chosen=String(form.get('occurredAt')),original=entryEditing.occurred_at;
      setClient(await api<ClientDetail>(`/clients/${client.id}/tasks/${task.id}/work-entries/${entryEditing.id}`,'PATCH',{id,expectedVersion:entryEditing.version,occurredAt:chosen===localDateTime(original) ? original : new Date(chosen).toISOString(),note:form.get('note')}));
      setEntryEditing(null);setProjectNotice('Work entry updated.');
    }}><label>Work date<input name="occurredAt" type="datetime-local" step={1} required defaultValue={localDateTime(entryEditing.occurred_at)} max={localDateTime(new Date().toISOString())}/></label><label>Work summary<textarea name="note" rows={3} required maxLength={2000} defaultValue={entryEditing.note}/></label><p className="caption muted">{entryEditing.hours} hours · {entryEditing.credits} credits. Billing uses UTC; billed entries cannot be changed.</p></MutationForm>}</ProjectDialog>}
    {staff && <ProjectDialog id="edit-project-date" title="Change work date" open={!!dateEditing} busy={dateSaving} onClose={()=>setDateEditing(null)}>{dateEditing && <MutationForm label="Save date" reset={false} onBusyChange={setDateSaving} submit={async(form,id)=>{
      const original=dateEditing.occurred_at || dateEditing.created_at,chosen=String(form.get('occurredAt'));
      const occurredAt=chosen===localDateTime(original) ? original : new Date(chosen).toISOString();
      setClient(await api<ClientDetail>(`/clients/${client.id}/tasks/${task.id}/date`,'PATCH',{id,occurredAt,expectedVersion:dateEditing.details_version ?? 0}));
      setDateEditing(null);setProjectNotice('Work date updated.');
    }}><label>When the work happened<input name="occurredAt" type="datetime-local" step={1} required defaultValue={localDateTime(dateEditing.occurred_at || dateEditing.created_at)} max={localDateTime(new Date().toISOString())}/></label><p className="caption muted">Uses your current time zone. Billing months use UTC. Changing this date does not deduct credits again.</p></MutationForm>}</ProjectDialog>}
    {staff && <ProjectDialog id="edit-project-details" title="Edit project" open={!!editing} busy={editSaving} onClose={()=>setEditing(null)}>{editing && <MutationForm label="Save changes" reset={false} onBusyChange={setEditSaving} submit={async(form,id)=>{
      const saved=await api<ClientDetail>(`/clients/${client.id}/tasks/${task.id}/details`,'PATCH',{id,title:form.get('title'),description:form.get('description'),requestedBy:form.get('requestedBy'),source:form.get('source'),expectedVersion:editing.details_version ?? 0});
      setClient(saved);setEditing(null);setProjectNotice('Project details updated.');
    }}><label>Project name<input name="title" required maxLength={160} defaultValue={editing.title}/></label><label>Brief<textarea name="description" required maxLength={2000} rows={4} defaultValue={editing.description}/></label><div className="fields"><label>Requested by<input name="requestedBy" required maxLength={254} defaultValue={editing.requested_by}/></label><label>Source channel<select name="source" defaultValue={editing.source}><option value="email">Email</option><option value="text">Text</option><option value="call">Call</option><option value="meeting">Meeting</option><option value="other">Other</option></select></label></div></MutationForm>}</ProjectDialog>}
    {body}</section>;
}

function ProjectVisuals({attachments,clientId,taskId,api}:{attachments:Attachment[];clientId:string;taskId:string;api:Api}) {
  const images=attachments.filter(file=>/\.(png|jpe?g|webp|gif|avif)$/i.test(file.name));
  return images.length ? <div className="portal-project-visuals" role="region" aria-label="Project images" tabIndex={images.length>1 ? 0 : undefined}>{images.map(file=><ProjectImage key={file.id} file={file} clientId={clientId} taskId={taskId} api={api}/>)}</div> : null;
}
function ProjectImage({file,clientId,taskId,api}:{file:Attachment;clientId:string;taskId:string;api:Api}) {
  const [url,setUrl]=useState(''), [failed,setFailed]=useState(false);
  useEffect(()=>{
    let active=true, objectUrl='';
    void api<Blob>(`/clients/${clientId}/tasks/${taskId}/attachments/${file.id}`,'GET',undefined,'blob').then(blob=>{
      if (!active) return;
      objectUrl=URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(()=>{if(active)setFailed(true);});
    return ()=>{active=false; if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[api,clientId,taskId,file.id]);
  return <figure>{url && !failed ? <a className="portal-image-frame" href={url} download={file.name}><img src={url} alt={file.name} onError={()=>setFailed(true)}/></a> : <div className="portal-image-frame portal-image-placeholder caption muted">{failed ? 'Preview unavailable' : 'Loading image…'}</div>}<figcaption className="caption muted" title={file.name}>{file.name}</figcaption></figure>;
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
  const [credits,setCredits] = useState<8 | 16 | 32 | 64>(32);
  const pack = creditPacks.find(pack=>pack.credits===credits)!;
  const testMode = import.meta.env.DEV;
  const link = checkoutLink(credits,testMode,{
    8:import.meta.env.PUBLIC_STRIPE_TEST_LINK_8,
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
    <div className="row"><h2>Add credits</h2><span className="caption muted">{client.name}</span></div>
    {testMode && <p className="caption muted" role="status">Stripe test mode · No real money is charged.</p>}
    <p className="muted">Choose a credit budget for your next task or project.</p>
    <div className="portal-checkout-layout">
      <fieldset className="portal-pack-options"><legend className="portal-pack-legend">Choose a credit pack</legend>{[...creditPacks].reverse().map(option=>{
        const savings = option.credits * creditPriceCents - option.amountCents;
        const lastPurchase = client.ledger.find(entry=>entry.kind==='purchase');
        return <label key={option.credits} className={`portal-pack ${credits===option.credits ? 'portal-pack-selected' : ''}`}>
          <input type="radio" name="credit-pack" value={option.credits} checked={credits===option.credits} onChange={()=>setCredits(option.credits as 8 | 16 | 32 | 64)}/>
          <span className="portal-pack-content">
            <span className="row portal-pack-heading"><span>{option.name}</span><span>{formatPrice(option.amountCents)}</span></span>
            <span className="muted">{option.credits} credits · {formatPrice(option.amountCents / option.credits)} per credit{savings>0 && ` · Save ${formatPrice(savings)}`}</span>
            <span className="muted">{option.description}</span>
            {lastPurchase?.credits===option.credits && <span className="portal-pack-badge caption">You bought this last time</span>}
          </span>
        </label>;
      })}</fieldset>
      <div className="stack portal-order-summary" aria-live="polite" aria-atomic="true">
        <div className="row"><h3>Order summary</h3><span className="portal-info portal-checkout-info"><button type="button" className="portal-info-button" aria-label="About credit purchases" aria-describedby="checkout-purchase-info">ⓘ</button><span id="checkout-purchase-info" role="tooltip"><span>We’ll confirm scope before starting.</span>{client.balance<0 && <span>Purchased credits first cover your {-client.balance} unbilled credits owed.</span>}{!!client.invoiced_credits && <span>Pay issued invoices separately.</span>}<span>{automaticPayments ? 'Credits are added automatically after Stripe confirms payment.' : 'Windward adds credits after confirming payment.'}</span></span></span></div>
        <div className="row"><span>{pack.name} · {pack.credits} credits</span><span>{formatPrice(pack.amountCents)}</span></div>
        <dl className="portal-checkout-balance"><div className="row"><dt>Before purchase</dt><dd>{client.balance<0 ? `${-client.balance} credits owed` : `${client.balance} credits`}</dd></div><div className="row"><dt>After purchase</dt><dd><strong>{client.balance+credits<0 ? `${-(client.balance+credits)} credits owed` : `${client.balance+credits} credits`}</strong></dd></div></dl>
        <div>{url ? <a className="action" href={url.href}>Continue to Stripe{testMode ? ' test checkout' : ''}</a> : <p role="alert">The test payment link for this pack has not been configured.</p>}</div>
      </div>
    </div>
  </section>;
}

function PaymentDocument({clientId,entryId,purchase,api}:{clientId:string;entryId:string;purchase:boolean;api:Api}) {
  const [busy,setBusy]=useState(false), [error,setError]=useState('');
  return <div className="portal-payment-document"><button type="button" className="portal-download-link caption" disabled={busy} onClick={async()=>{
    setBusy(true);setError('');
    try {
      const blob=await api<Blob>(`/clients/${clientId}/activity/${encodeURIComponent(entryId)}/document`,'GET',undefined,'blob');
      const url=URL.createObjectURL(blob), link=document.createElement('a');
      link.href=url; link.download=purchase ? 'payment-document.pdf' : 'invoice.pdf'; link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(error) {setError(error instanceof Error ? error.message : 'Unable to download the document.');}
    finally {setBusy(false);}
  }}>{busy ? 'Downloading…' : 'Download invoice'}</button>{error && <p className="caption" role="alert">{error}</p>}</div>;
}

function Field({label,...props}:{label:string;name:string;type?:string;maxLength?:number;placeholder?:string;min?:number;max?:number;step?:number}) { return <label>{label}<input {...props} required /></label>; }
function MutationForm({children,submit,label,reset=true,onBusyChange}:{children?:ReactNode; onBusyChange?:(busy:boolean)=>void;submit:(form:FormData,id:string)=>Promise<void>;label:string;reset?:boolean}) {
  const [busy,setBusy] = useState(false), [message,setMessage] = useState(''), [failed,setFailed] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  async function onSubmit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget, data = new FormData(form);
    setBusy(true); onBusyChange?.(true); setMessage(''); setFailed(false);
    try { await submit(data,requestId.current); if (reset) form.reset(); requestId.current=crypto.randomUUID(); setMessage('Saved.'); }
    catch(error) { setFailed(true); setMessage(error instanceof Error ? error.message : 'Unable to save. Please try again.'); }
    finally { setBusy(false); onBusyChange?.(false); }
  }
  return <form className="stack portal-form" onSubmit={onSubmit}><fieldset disabled={busy} className="portal-fieldset stack">{children}<div><button type="submit" className="action">{busy?'Saving…':label}</button></div></fieldset>{message && <p className="caption" role={failed?'alert':'status'}>{message}</p>}</form>;
}
