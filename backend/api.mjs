import { PortalError, requireStaff, normalizeEmail, text, id, workInput, statusInput } from './domain.mjs';
import { fulfillCheckout } from './stripe.mjs';
import {authorizeAgent,requireAgentScope} from './agent-auth.mjs';
import { paymentDocument } from './payment-documents.mjs';
import { handleAttachment } from './attachments.mjs';
import { invoicedCreditsSql, billingPreview, createInvoiceDraft, issueInvoice, refreshInvoice, voidInvoice } from './billing.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const query = (db, sql, ...values) => db.prepare(sql).bind(...values);
async function bodyOf(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new PortalError(415,'Send JSON.');
  const raw = await request.text();
  if (raw.length > 12000) throw new PortalError(413,'Request too large.');
  try { const body = JSON.parse(raw); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); return body; }
  catch { throw new PortalError(400,'Invalid JSON.'); }
}
async function clientAccess(db, actor, clientId) {
  const client = await query(db, 'SELECT * FROM clients WHERE id = ?', clientId).first();
  if (!client) throw new PortalError(404,'Client not found.');
  if (!actor.staff && !await query(db, 'SELECT 1 FROM client_members WHERE client_id = ? AND email = ?',clientId,actor.email).first()) throw new PortalError(404,'Client not found.');
  return client;
}
async function detail(db, actor, clientId) {
  // Read authorization and data in a single primary database session.
  const client = await clientAccess(db,actor,clientId);
  const [members,tasks,updates,ledger,attachments,invoices,balances,sources] = await db.batch([
    query(db,'SELECT email FROM client_members WHERE client_id = ? ORDER BY email',clientId),
    query(db,'SELECT * FROM tasks WHERE client_id = ? ORDER BY created_at DESC, id',clientId),
    query(db,'SELECT u.* FROM task_updates u JOIN tasks t ON t.id = u.task_id WHERE t.client_id = ? ORDER BY u.created_at DESC, u.id',clientId),
    query(db,'SELECT * FROM ledger WHERE client_id = ? ORDER BY created_at DESC, id',clientId),
    query(db,'SELECT a.id,a.task_id,a.update_id,a.name,a.size,a.created_at FROM attachments a JOIN tasks t ON t.id=a.task_id WHERE t.client_id=? AND a.ready=1 ORDER BY a.created_at,a.id',clientId),
    query(db,`SELECT id,period,email,credits,amount_cents,status,hosted_invoice_url,number,created_at FROM invoices WHERE client_id=? ${actor.staff ? '' : 'AND stripe_invoice_id IS NOT NULL'} ORDER BY created_at DESC,id`,clientId),
    query(db,`SELECT c.balance,${invoicedCreditsSql} AS invoiced_credits FROM clients c WHERE c.id=?`,clientId),
    query(db,`SELECT s.* FROM update_sources s JOIN tasks t ON t.id=s.task_id WHERE t.client_id=? AND ?=1`,clientId,actor.staff ? 1 : 0),
  ]);
  return { ...client,...balances.results[0], members: members.results.map(row => row.email), tasks: tasks.results, updates: updates.results, ledger: ledger.results, attachments:attachments.results, invoices:invoices.results,...(actor.staff ? {sourceReferences:sources.results} : {}) };
}

async function addProjectUpdate(db,actor,clientId,taskId,body) {
  const task=await query(db,'SELECT * FROM tasks WHERE id=? AND client_id=?',taskId,clientId).first();
  if(!task)throw new PortalError(404,'Work not found.');
  const update=statusInput({...body,status:body.status ?? task.status});
  if(update.status==='cancelled')requireAgentScope(actor,'projects:cancel');
  let source=null;
  if(body.source!==undefined) {
    if(!body.source || !['email','text','meeting','other'].includes(body.source.type))throw new PortalError(400,'Choose a valid source type.');
    source={type:body.source.type,id:text(body.source.id,'External message ID',500),url:null};
    if(body.source.url!==undefined) {
      source.url=text(body.source.url,'Source URL',2000);
      let url;try{url=new URL(source.url);}catch{throw new PortalError(400,'Use an HTTPS source URL.');}
      if(url.protocol!=='https:' || url.username || url.password)throw new PortalError(400,'Use an HTTPS source URL.');
    }
  }
  let existing=await query(db,'SELECT * FROM task_updates WHERE id=?',update.id).first();
  if(!existing && source)existing=await query(db,'SELECT u.* FROM task_updates u JOIN update_sources s ON s.update_id=u.id WHERE s.task_id=? AND s.source_type=? AND s.external_id=?',taskId,source.type,source.id).first();
  if(existing) {
    const savedSource=await query(db,'SELECT * FROM update_sources WHERE update_id=?',existing.id).first();
    if(existing.task_id!==taskId || existing.note!==update.note || (body.status!==undefined && existing.status!==update.status) || (source ? savedSource?.source_type!==source.type || savedSource?.external_id!==source.id || savedSource?.source_url!==source.url : !!savedSource))throw new PortalError(409,'Update ID or message reference already used.');
    return;
  }
  if(task.status==='cancelled')throw new PortalError(409,'Cancelled work cannot be changed.');
  const statements=[
    query(db,`INSERT INTO task_updates (id,task_id,status,note,created_by,actor_email) SELECT ?,id,?,?,?,? FROM tasks WHERE id=? AND client_id=? AND status!='cancelled'`,update.id,update.status,update.note,actor.id,actor.email,taskId,clientId),
    query(db,`UPDATE tasks SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_by=?,updated_actor_email=? WHERE id=? AND client_id=? AND status!='cancelled'`,update.status,actor.id,actor.email,taskId,clientId),
  ];
  if(source)statements.push(query(db,`INSERT INTO update_sources (update_id,task_id,source_type,external_id,source_url) SELECT id,task_id,?,?,? FROM task_updates WHERE id=? AND task_id=?`,source.type,source.id,source.url,update.id,taskId));
  await db.batch(statements);
  if(!await query(db,'SELECT 1 FROM task_updates WHERE id=?',update.id).first())throw new PortalError(409,'Work changed. Refresh and try again.');
}

// authenticate is dependency-injected in tests; production verifies Privy or agent keys.
export async function handleApi(request, env, authenticate) {
  let auditId;
  const response=await handleAuthorizedApi(request,env,async(request,env)=>{
    const actor=await authenticate(request,env);
    if(actor.kind==='agent' && !['GET','HEAD','OPTIONS'].includes(request.method)) {
      auditId=crypto.randomUUID();
      await query(env.DB,`INSERT INTO agent_activity (id,key_id,actor_email,method,path) VALUES (?,?,?,?,?)`,auditId,actor.keyId,actor.email,request.method,new URL(request.url).pathname).run();
    }
    return actor;
  });
  if(auditId) {
    try{await query(env.DB,'UPDATE agent_activity SET response_status=? WHERE id=?',response.status,auditId).run();}
    catch{console.error('Unable to finalize agent activity log',auditId);}
  }
  return response;
}

async function handleAuthorizedApi(request, env, authenticate) {
  try {
    const actor = await authenticate(request,env);
    const db = env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
    const path = new URL(request.url).pathname.replace(/\/$/,'');
    const method = request.method;
    authorizeAgent(actor,path,method);
    if (path === '/v1/me' && method === 'GET') return json({...actor,automaticPayments:
      ['test','live'].includes(env.STRIPE_MODE) && !!env.STRIPE_SECRET_KEY?.startsWith(env.STRIPE_MODE==='live' ? 'sk_live_' : 'sk_test_')});
    if (path === '/v1/clients' && method === 'GET') {
      const result = await (actor.staff
        ? query(db,`SELECT c.*,${invoicedCreditsSql} AS invoiced_credits, (SELECT count(*) FROM tasks t WHERE t.client_id=c.id AND t.status IN ('queued','in_progress')) AS active_tasks FROM clients c ORDER BY c.name`)
        : query(db,`SELECT c.*,${invoicedCreditsSql} AS invoiced_credits, (SELECT count(*) FROM tasks t WHERE t.client_id=c.id AND t.status IN ('queued','in_progress')) AS active_tasks FROM clients c JOIN client_members m ON m.client_id=c.id WHERE m.email=? ORDER BY c.name`,actor.email)).all();
      return json({clients: result.results});
    }
    if (path === '/v1/clients' && method === 'POST') {
      requireStaff(actor);
      const body = await bodyOf(request);
      const clientId = id(body.id), name = text(body.name,'Client name',160), email = normalizeEmail(body.email);
      const existing = await query(db,'SELECT * FROM clients WHERE id=?',clientId).first();
      if (existing) {
        if (existing.name !== name || !await query(db,'SELECT 1 FROM client_members WHERE client_id=? AND email=?',clientId,email).first()) throw new PortalError(409,'Record ID already used.');
      } else await db.batch([
        query(db,'INSERT INTO clients (id,name) VALUES (?,?)',clientId,name),
        query(db,'INSERT INTO client_members (client_id,email) VALUES (?,?)',clientId,email),
      ]);
      return json(await detail(db,actor,clientId),201);
    }
    const updateRoute=path.match(/^\/v1\/clients\/([^/]+)\/tasks\/([^/]+)\/updates$/);
    if(updateRoute) {
      if(method!=='POST')throw new PortalError(405,'Method not allowed.');
      requireStaff(actor);
      const clientId=id(updateRoute[1]);await clientAccess(db,actor,clientId);
      await addProjectUpdate(db,actor,clientId,id(updateRoute[2]),await bodyOf(request));
      return json(await detail(db,actor,clientId));
    }
    const documentRoute=path.match(/^\/v1\/clients\/([^/]+)\/activity\/([^/]+)\/document$/);
    if (documentRoute) {
      const clientId=id(documentRoute[1]);
      await clientAccess(db,actor,clientId);
      if (method!=='GET') throw new PortalError(405,'Method not allowed.');
      return await paymentDocument(env,db,clientId,decodeURIComponent(documentRoute[2]));
    }
    const attachmentRoute = path.match(/^\/v1\/clients\/([^/]+)\/tasks\/([^/]+)\/attachments\/([^/]+)$/);
    if (attachmentRoute) {
      const clientId = id(attachmentRoute[1]);
      await clientAccess(db,actor,clientId);
      return await handleAttachment(request,env,db,actor,clientId,attachmentRoute[2],attachmentRoute[3]);
    }
    const billingRoute=path.match(/^\/v1\/clients\/([^/]+)\/(billing|invoices)(?:\/([^/]+)\/(issue|refresh|void))?$/);
    if (billingRoute) {
      const clientId=id(billingRoute[1]);
      await clientAccess(db,actor,clientId);
      const resource=billingRoute[2], invoiceId=billingRoute[3], action=billingRoute[4];
      if (resource==='billing' && method==='GET' && !invoiceId) {
        requireStaff(actor);
        return json(await billingPreview(db,clientId,new URL(request.url).searchParams.get('period')));
      }
      if (resource==='invoices' && method==='POST') {
        if (action!=='refresh') requireStaff(actor);
        if (!invoiceId) await createInvoiceDraft(env,db,actor,clientId,await bodyOf(request));
        else if (action==='issue') await issueInvoice(env,db,clientId,invoiceId);
        else if (action==='refresh') await refreshInvoice(env,db,clientId,invoiceId);
        else if (action==='void') await voidInvoice(env,db,clientId,invoiceId);
        return json(await detail(db,actor,clientId));
      }
      throw new PortalError(405,'Method not allowed.');
    }
    const route = path.match(/^\/v1\/clients\/([^/]+)(?:\/(members|purchases|tasks|checkout)(?:\/([^/]+))?)?$/);
    if (!route) throw new PortalError(404,'Not found.');
    const clientId = id(route[1]), resource = route[2], taskId = route[3];
    if (!resource && method === 'GET') return json(await detail(db,actor,clientId));
    if (resource === 'checkout' && method === 'POST' && !taskId) {
      await clientAccess(db,actor,clientId);
      const body = await bodyOf(request);
      const result = await fulfillCheckout(env,db,body.sessionId,clientId);
      if (result.status==='ignored') throw new PortalError(400,'Payment is not for a Windward credit pack.');
      return json({...result,client:await detail(db,actor,clientId)});
    }
    requireStaff(actor);
    await clientAccess(db,actor,clientId);
    const body = await bodyOf(request);
    if (resource === 'members' && method === 'POST' && !taskId) {
      const email = normalizeEmail(body.email);
      await query(db,'INSERT OR IGNORE INTO client_members (client_id,email) VALUES (?,?)',clientId,email).run();
    } else if (resource === 'members' && method === 'DELETE' && !taskId) {
      const email = normalizeEmail(body.email);
      await query(db,'DELETE FROM client_members WHERE client_id=? AND email=?',clientId,email).run();
    } else if (resource === 'purchases' && method === 'POST' && !taskId) {
      if (![8,16,32,64].includes(body.credits)) throw new PortalError(400,'Choose a purchased credit pack.');
      const reference = text(body.reference,'Stripe payment reference',200);
      if (!/^pi_[A-Za-z0-9]+$/.test(reference)) throw new PortalError(400,'Use the Stripe PaymentIntent ID (pi_) from the successful payment.');
      const note = text(body.note,'Payment verification note');
      const existing = await query(db,'SELECT * FROM ledger WHERE reference=?',reference).first();
      if (existing) {
        if (existing.client_id !== clientId || existing.credits !== body.credits) throw new PortalError(409,'Payment reference already used.');
      } else await query(db,`INSERT INTO ledger (id,client_id,kind,credits,reference,note,created_by,actor_email) VALUES (?,?,'purchase',?,?,?,?,?)`,crypto.randomUUID(),clientId,body.credits,reference,note,actor.id,actor.email).run();
    } else if (resource === 'tasks' && method === 'POST' && !taskId) {
      const work = workInput(body);
      const existing = await query(db,'SELECT * FROM tasks WHERE id=?',work.id).first();
      if (existing) {
        if (existing.client_id !== clientId || existing.title !== work.title || existing.description !== work.description || existing.credits !== work.credits || existing.source !== work.source || existing.requested_by !== work.requestedBy) throw new PortalError(409,'Work record ID already used.');
      } else await query(db,`INSERT INTO tasks (id,client_id,title,description,requested_by,source,credits,status,created_by,actor_email) VALUES (?,?,?,?,?,?,?,?,?,?)`,work.id,clientId,work.title,work.description,work.requestedBy,work.source,work.credits,work.status,actor.id,actor.email).run();
    } else if (resource === 'tasks' && method === 'PATCH' && taskId) {
      await addProjectUpdate(db,actor,clientId,id(taskId),body);
    } else throw new PortalError(405,'Method not allowed.');
    return json(await detail(db,actor,clientId));
  } catch (error) {
    if (error instanceof PortalError) return json({error:error.message},error.status);
    if (/UNIQUE constraint failed: invoices.client_id, invoices.period/i.test(String(error))) return json({error:'This month already has an invoice. Open the existing bill before creating another.'},409);
    if (/UNIQUE constraint/i.test(String(error))) return json({error:'This record or payment reference already exists. Refresh before trying again.'},409);
    console.error('Portal request failed',error instanceof Error ? error.name : 'Unknown error');
    return json({error:'Unable to complete this request. Please try again.'},500);
  }
}
