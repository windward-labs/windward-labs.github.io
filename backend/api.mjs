import {agreementRecords,recordAgreementWork,changeAgreement} from './project-agreements.mjs';
import { PortalError, requireStaff, normalizeEmail, text, id, workInput, statusInput,eventTimestamp,workTimestamp } from './domain.mjs';
import { fulfillCheckout } from './stripe.mjs';
import {authorizeAgent,requireAgentScope} from './agent-auth.mjs';
import { paymentDocument } from './payment-documents.mjs';
import { handleAttachment } from './attachments.mjs';
import { invoicedCreditsSql, ledgerEventDate, billingPreview, createInvoiceDraft, issueInvoice, refreshInvoice, voidInvoice } from './billing.mjs';
import {workEntries,addWorkEntry,reallocateWork,correctWorkEntry} from './work-entries.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const query = (db, sql, ...values) => db.prepare(sql).bind(...values);
async function bodyOf(request,max=12000) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new PortalError(415,'Send JSON.');
  const raw = await request.text();
  if (raw.length > max) throw new PortalError(413,'Request too large.');
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
  const [members,tasks,updates,ledger,attachments,invoices,balances,sources,workDates] = await db.batch([
    query(db,'SELECT email FROM client_members WHERE client_id = ? ORDER BY email',clientId),
    query(db,'SELECT * FROM tasks WHERE client_id = ? ORDER BY created_at DESC, id',clientId),
    query(db,'SELECT u.* FROM task_updates u JOIN tasks t ON t.id = u.task_id WHERE t.client_id = ? AND (u.hidden_at IS NULL OR ?=1) ORDER BY COALESCE(u.occurred_at,u.created_at) DESC, u.created_at DESC, u.id',clientId,actor.staff ? 1 : 0),
    query(db,`SELECT l.*,${ledgerEventDate} AS occurred_at FROM ledger l WHERE l.client_id=? ORDER BY occurred_at DESC,l.rowid DESC`,clientId),
    query(db,'SELECT a.id,a.task_id,a.update_id,a.name,a.size,a.created_at FROM attachments a JOIN tasks t ON t.id=a.task_id LEFT JOIN task_updates u ON u.id=a.update_id WHERE t.client_id=? AND a.ready=1 AND (?=1 OR a.update_id IS NULL OR (u.id IS NOT NULL AND u.hidden_at IS NULL)) ORDER BY a.created_at,a.id',clientId,actor.staff ? 1 : 0),
    query(db,`SELECT id,period,email,credits,amount_cents,status,hosted_invoice_url,number,created_at FROM invoices WHERE client_id=? ${actor.staff ? '' : 'AND stripe_invoice_id IS NOT NULL'} ORDER BY created_at DESC,id`,clientId),
    query(db,`SELECT c.balance,${invoicedCreditsSql} AS invoiced_credits FROM clients c WHERE c.id=?`,clientId),
    query(db,`SELECT s.* FROM update_sources s JOIN tasks t ON t.id=s.task_id WHERE t.client_id=? AND ?=1`,clientId,actor.staff ? 1 : 0),
    query(db,'SELECT d.* FROM project_date_changes d JOIN tasks t ON t.id=d.task_id WHERE t.client_id=? AND ?=1 ORDER BY d.created_at,d.id',clientId,actor.staff ? 1 : 0),
  ]);
  return { ...client,...balances.results[0],...await agreementRecords(db,actor,clientId), members: members.results.map(row => row.email), tasks: tasks.results, updates: updates.results, ledger: ledger.results, attachments:attachments.results, invoices:invoices.results,workEntries:await workEntries(db,actor,clientId),...(actor.staff ? {sourceReferences:sources.results,workDateHistory:workDates.results} : {}) };
}

async function addProjectUpdate(db,actor,clientId,taskId,body) {
  const task=await query(db,'SELECT * FROM tasks WHERE id=? AND client_id=?',taskId,clientId).first();
  if(!task)throw new PortalError(404,'Work not found.');
  if(body.createdAt!==undefined || body.date!==undefined)throw new PortalError(400,'Use occurredAt for the email date; created_at is the server audit timestamp.');
  const update=statusInput({...body,status:body.status ?? task.status});
  const occurredAt=body.occurredAt===undefined ? null : eventTimestamp(body.occurredAt);
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
    if(existing.task_id!==taskId || existing.note!==update.note || (body.status!==undefined && existing.status!==update.status) || (occurredAt!==null && (existing.occurred_at ?? existing.created_at)!==occurredAt) || (source ? savedSource?.source_type!==source.type || savedSource?.external_id!==source.id || savedSource?.source_url!==source.url : !!savedSource))throw new PortalError(409,'Update ID or message reference already used.');
    return;
  }
  if(task.status==='cancelled')throw new PortalError(409,'Cancelled work cannot be changed.');
  const statements=[
    query(db,`INSERT INTO task_updates (id,task_id,status,note,created_by,actor_email,occurred_at) SELECT ?,id,?,?,?,?,? FROM tasks WHERE id=? AND client_id=? AND status!='cancelled'`,update.id,update.status,update.note,actor.id,actor.email,occurredAt,taskId,clientId),
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
    const agreementRoute=path.match(/^\/v1\/clients\/([^/]+)\/tasks\/([^/]+)\/(charges|time-entries|agreement)$/);
    if(agreementRoute) {
      const clientId=id(agreementRoute[1]),taskId=id(agreementRoute[2]),resource=agreementRoute[3];
      await clientAccess(db,actor,clientId);
      const task=await query(db,'SELECT * FROM tasks WHERE id=? AND client_id=?',taskId,clientId).first();
      if(!task)throw new PortalError(404,'Project not found.');
      if(method==='GET' && resource!=='agreement') {
        if(resource==='time-entries')requireStaff(actor);
        const records=await agreementRecords(db,actor,clientId),key=resource==='charges' ? 'projectCharges' : 'timeEntries';
        return json({[key]:records[key].filter(row=>row.task_id===taskId)});
      }
      requireStaff(actor);
      if(resource==='agreement' && method==='PATCH')await changeAgreement(db,actor,task,await bodyOf(request));
      else if(resource!=='agreement' && method==='POST')await recordAgreementWork(db,actor,taskId,resource,await bodyOf(request));
      else throw new PortalError(405,'Method not allowed.');
      return json(await detail(db,actor,clientId));
    }
    const entryRoute=path.match(/^\/v1\/clients\/([^/]+)\/tasks\/([^/]+)\/work-entries(?:\/(reallocate|[^/]+))?$/);
    if(entryRoute) {
      const clientId=id(entryRoute[1]),taskId=id(entryRoute[2]),action=entryRoute[3];
      await clientAccess(db,actor,clientId);
      if(!await query(db,'SELECT id FROM tasks WHERE id=? AND client_id=?',taskId,clientId).first())throw new PortalError(404,'Project not found.');
      if(method==='GET' && !action)return json({workEntries:await workEntries(db,actor,clientId,taskId)});
      requireStaff(actor);
      if(method==='POST' && !action)await addWorkEntry(db,actor,clientId,taskId,await bodyOf(request));
      else if(method==='POST' && action==='reallocate')await reallocateWork(db,actor,clientId,taskId,await bodyOf(request,300000));
      else if(method==='PATCH' && action && action!=='reallocate')await correctWorkEntry(db,actor,clientId,taskId,id(action),await bodyOf(request));
      else throw new PortalError(405,'Method not allowed.');
      return json(await detail(db,actor,clientId));
    }
    const workDateRoute=path.match(/^\/v1\/clients\/([^/]+)\/tasks\/([^/]+)\/date$/);
    if(workDateRoute) {
      if(method!=='PATCH')throw new PortalError(405,'Method not allowed.');
      requireStaff(actor);
      requireAgentScope(actor,'billing:dates');
      const clientId=id(workDateRoute[1]),taskId=id(workDateRoute[2]);await clientAccess(db,actor,clientId);
      const task=await query(db,'SELECT * FROM tasks WHERE id=? AND client_id=?',taskId,clientId).first();
      if(!task)throw new PortalError(404,'Project not found.');
      if(task.billing_mode==='entries')throw new PortalError(409,'Correct the dated work entries; a project date does not determine their billing month.');
      const body=await bodyOf(request),changeId=id(body.id),occurredAt=workTimestamp(body.occurredAt);
      if(Object.keys(body).some(key=>!['id','occurredAt','expectedVersion','emailMessageId'].includes(key)))throw new PortalError(400,'This endpoint only changes the project work date.');
      if(!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion<0)throw new PortalError(400,'Send the project details_version as expectedVersion.');
      const messageId=body.emailMessageId===undefined ? null : text(body.emailMessageId,'Email message ID',500);
      const existing=await query(db,'SELECT * FROM project_date_changes WHERE id=?',changeId).first();
      if(existing) {
        if(existing.task_id!==taskId || existing.occurred_at!==occurredAt || existing.source_message_id!==messageId)throw new PortalError(409,'Work-date change ID already used.');
      } else {
        await db.batch([
          query(db,`INSERT INTO project_date_changes (id,task_id,previous_date,occurred_at,source_message_id,created_by,actor_email) SELECT ?,id,COALESCE(occurred_at,created_at),?,?,?,? FROM tasks WHERE id=? AND client_id=? AND details_version=?`,changeId,occurredAt,messageId,actor.id,actor.email,taskId,clientId,body.expectedVersion),
          query(db,`UPDATE tasks SET occurred_at=?,details_version=details_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_by=?,updated_actor_email=? WHERE id=? AND client_id=? AND details_version=?`,occurredAt,actor.id,actor.email,taskId,clientId,body.expectedVersion),
        ]);
        if(!await query(db,'SELECT 1 FROM project_date_changes WHERE id=?',changeId).first())throw new PortalError(409,'Project changed. Reload before correcting its work date.');
      }
      return json(await detail(db,actor,clientId));
    }
    const editRoute=path.match(/^\/v1\/clients\/([^/]+)\/tasks\/([^/]+)\/details$/);
    if(editRoute) {
      if(method!=='PATCH')throw new PortalError(405,'Method not allowed.');
      requireStaff(actor);
      const clientId=id(editRoute[1]),taskId=id(editRoute[2]);await clientAccess(db,actor,clientId);
      const task=await query(db,'SELECT * FROM tasks WHERE id=? AND client_id=?',taskId,clientId).first();
      if(!task)throw new PortalError(404,'Project not found.');
      const body=await bodyOf(request),editId=id(body.id);
      if(Object.keys(body).some(key=>!['id','title','description','requestedBy','source','expectedVersion'].includes(key)))throw new PortalError(400,'Edit only the project title, brief, requester and source.');
      const next={title:text(body.title,'Title',160),description:text(body.description,'Work description'),requestedBy:text(body.requestedBy,'Requested by',254),source:body.source};
      if(!['email','text','call','meeting','other'].includes(next.source))throw new PortalError(400,'Choose a source channel.');
      if(!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion<0)throw new PortalError(400,'Send the project details_version as expectedVersion.');
      const serialized=JSON.stringify(next),expected=body.expectedVersion;
      const existing=await query(db,'SELECT * FROM project_edits WHERE id=?',editId).first();
      if(existing) {
        if(existing.task_id!==taskId || existing.updated_details!==serialized)throw new PortalError(409,'Edit ID already used.');
      } else {
        const previous=JSON.stringify({title:task.title,description:task.description,requestedBy:task.requested_by,source:task.source});
        await db.batch([
          query(db,`INSERT INTO project_edits (id,task_id,previous_details,updated_details,created_by,actor_email) SELECT ?,id,?,?,?,? FROM tasks WHERE id=? AND client_id=? AND details_version=?`,editId,previous,serialized,actor.id,actor.email,taskId,clientId,expected),
          query(db,`UPDATE tasks SET title=?,description=?,requested_by=?,source=?,details_version=details_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_by=?,updated_actor_email=? WHERE id=? AND client_id=? AND details_version=?`,next.title,next.description,next.requestedBy,next.source,actor.id,actor.email,taskId,clientId,expected),
        ]);
        if(!await query(db,'SELECT 1 FROM project_edits WHERE id=?',editId).first())throw new PortalError(409,'Project changed. Reload before editing its details.');
      }
      return json(await detail(db,actor,clientId));
    }
    const dateRoute=path.match(/^\/v1\/clients\/([^/]+)\/tasks\/([^/]+)\/updates\/([^/]+)(?:\/(restore))?$/);
    if(dateRoute) {
      if(dateRoute[4] ? method!=='POST' : !['PATCH','DELETE'].includes(method))throw new PortalError(405,'Method not allowed.');
      requireStaff(actor);
      const clientId=id(dateRoute[1]),taskId=id(dateRoute[2]),updateId=id(dateRoute[3]);
      await clientAccess(db,actor,clientId);
      if(!await query(db,'SELECT 1 FROM task_updates u JOIN tasks t ON t.id=u.task_id WHERE u.id=? AND t.id=? AND t.client_id=?',updateId,taskId,clientId).first())throw new PortalError(404,'Progress update not found.');
      if(method==='DELETE' || dateRoute[4]) {
        const hide=method==='DELETE',condition=hide ? 'hidden_at IS NULL' : 'hidden_at IS NOT NULL';
        await db.batch([
          query(db,`INSERT INTO update_visibility_changes (id,update_id,action,created_by,actor_email) SELECT ?,id,?,?,? FROM task_updates WHERE id=? AND ${condition}`,crypto.randomUUID(),hide ? 'hide' : 'restore',actor.id,actor.email,updateId),
          hide ? query(db,`UPDATE task_updates SET hidden_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),hidden_by=?,hidden_actor_email=? WHERE id=? AND ${condition}`,actor.id,actor.email,updateId)
            : query(db,`UPDATE task_updates SET hidden_at=NULL,hidden_by=NULL,hidden_actor_email=NULL WHERE id=? AND ${condition}`,updateId),
        ]);
        return json(await detail(db,actor,clientId));
      }
      const body=await bodyOf(request);
      if(Object.keys(body).some(key=>key!=='occurredAt'))throw new PortalError(400,'This endpoint only changes occurredAt.');
      const occurredAt=eventTimestamp(body.occurredAt);
      await db.batch([
        query(db,`INSERT INTO update_date_changes (id,update_id,previous_date,occurred_at,created_by,actor_email) SELECT ?,id,COALESCE(occurred_at,created_at),?,?,? FROM task_updates WHERE id=? AND COALESCE(occurred_at,created_at)!=?`,crypto.randomUUID(),occurredAt,actor.id,actor.email,updateId,occurredAt),
        query(db,'UPDATE task_updates SET occurred_at=? WHERE id=?',occurredAt,updateId),
      ]);
      return json(await detail(db,actor,clientId));
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
      if (![8,16,32,64,192].includes(body.credits)) throw new PortalError(400,'Choose a purchased credit pack.');
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
        if (existing.client_id !== clientId || existing.title !== work.title || existing.description !== work.description || existing.original_credits !== work.credits || existing.pricing_model!==work.pricingModel || existing.fixed_credits!==work.fixedCredits || existing.budget_credits!==work.budgetCredits || existing.source !== work.source || existing.requested_by !== work.requestedBy || (work.occurredAt && (existing.occurred_at ?? existing.created_at)!==work.occurredAt)) throw new PortalError(409,'Work record ID already used.');
        if(work.emailMessageId && (await query(db,'SELECT source_message_id FROM project_date_changes WHERE id=?',work.id).first())?.source_message_id!==work.emailMessageId)throw new PortalError(409,'Work record source already used.');
      } else {
        const statements=[query(db,`INSERT INTO tasks (id,client_id,title,description,requested_by,source,credits,status,created_by,actor_email,occurred_at,billing_mode,original_credits,pricing_model,fixed_credits,budget_credits) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,work.id,clientId,work.title,work.description,work.requestedBy,work.source,work.credits,work.status,actor.id,actor.email,work.occurredAt,work.credits ? 'legacy' : 'entries',work.credits,work.pricingModel,work.fixedCredits,work.budgetCredits)];
        if(work.occurredAt)statements.push(query(db,`INSERT INTO project_date_changes (id,task_id,previous_date,occurred_at,source_message_id,created_by,actor_email) SELECT ?,id,created_at,occurred_at,?,?,? FROM tasks WHERE id=?`,work.id,work.emailMessageId,actor.id,actor.email,work.id));
        await db.batch(statements);
      }
    } else if (resource === 'tasks' && method === 'PATCH' && taskId) {
      await addProjectUpdate(db,actor,clientId,id(taskId),body);
    } else throw new PortalError(405,'Method not allowed.');
    return json(await detail(db,actor,clientId));
  } catch (error) {
    if (error instanceof PortalError) return json({error:error.message},error.status);
    if (/Work date is covered by an issued invoice/i.test(String(error))) return json({error:'An issued invoice covers this work date. Resolve that invoice before changing its billing attribution.'},409);
    if (/Work entry is covered by an issued invoice|Cancelled projects cannot record work|Allocation exceeds original charge|Reallocate the original project charge first|Work entry charge is immutable|Fixed-price|Approved hourly budget|Internal time entries|Invalid project agreement|Agreement changes require approval/i.test(String(error)))return json({error:String(error).replace(/^.*?(Work entry is covered|Cancelled projects|Allocation exceeds|Reallocate the original|Work entry charge|Fixed-price|Approved hourly budget|Internal time entries|Invalid project agreement|Agreement changes require approval)/,'$1')},409);
    if (/UNIQUE constraint failed: invoices.client_id, invoices.period/i.test(String(error))) return json({error:'This month already has an invoice. Open the existing bill before creating another.'},409);
    if (/UNIQUE constraint/i.test(String(error))) return json({error:'This record or payment reference already exists. Refresh before trying again.'},409);
    console.error('Portal request failed',error instanceof Error ? error.name : 'Unknown error');
    return json({error:'Unable to complete this request. Please try again.'},500);
  }
}
