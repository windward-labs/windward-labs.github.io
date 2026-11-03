import {PortalError,requireStaff,id,text} from './domain.mjs';
import {requireAgentScope} from './agent-auth.mjs';
const query=(db,sql,...values)=>db.prepare(sql).bind(...values);
const only=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>keys.includes(key));

function input(body) {
  if(!only(body,['id','reason','entries']) || !Array.isArray(body.entries) || body.entries.length<1 || body.entries.length>100)throw new PortalError(400,'Send id, reason and 1–100 attribution entries. Financial fields cannot be changed.');
  const entries=body.entries.map(entry=>{
    if(!only(entry,['entryId','expectedRevision','expectedVersion','allocations']) || !Number.isSafeInteger(entry.expectedRevision) || entry.expectedRevision<0 || !Number.isSafeInteger(entry.expectedVersion) || entry.expectedVersion<0 || !Array.isArray(entry.allocations) || entry.allocations.length<1 || entry.allocations.length>100)throw new PortalError(400,'Send entryId, expectedRevision, expectedVersion and complete allocations.');
    const allocations=entry.allocations.map(allocation=>{
      if(!only(allocation,['taskId','hours','credits']) || !Number.isSafeInteger(allocation.credits) || allocation.credits<1 || allocation.credits>10000 || typeof allocation.hours!=='number' || allocation.hours*4!==allocation.credits)throw new PortalError(400,'Allocations require taskId, hours and credits at the original 4 credits/hour.');
      return {taskId:id(allocation.taskId),hours:allocation.hours,credits:allocation.credits};
    }).sort((a,b)=>a.taskId.localeCompare(b.taskId));
    if(new Set(allocations.map(a=>a.taskId)).size!==allocations.length)throw new PortalError(400,'Allocate each project only once.');
    return {entryId:id(entry.entryId),expectedRevision:entry.expectedRevision,expectedVersion:entry.expectedVersion,allocations};
  }).sort((a,b)=>a.entryId.localeCompare(b.entryId));
  if(new Set(entries.map(e=>e.entryId)).size!==entries.length)throw new PortalError(400,'Use unique affected entry IDs.');
  return {adjustmentId:id(body.id),reason:text(body.reason,'Correction reason'),payload:JSON.stringify(entries)};
}
export async function adjustProjectAttribution(db,actor,clientId,body) {
  requireStaff(actor);requireAgentScope(actor,'admin');
  const {adjustmentId,reason,payload}=input(body);
  // A single INSERT applies all revisions through a trigger. D1/SQLite rolls
  // back the header and every revision if any entry fails validation.
  await query(db,`INSERT INTO attribution_adjustments(id,client_id,reason,payload,created_by,actor_email)
    VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,adjustmentId,clientId,reason,payload,actor.id,actor.email).run();
  const saved=await query(db,'SELECT * FROM attribution_adjustments WHERE id=?',adjustmentId).first();
  if(saved.client_id!==clientId || saved.reason!==reason || saved.payload!==payload || saved.created_by!==actor.id || saved.actor_email!==actor.email)throw new PortalError(409,'Attribution idempotency key already used with different terms or actor.');
  return {adjustmentId};
}
export async function projectAttribution(db,clientId) {
  const rows=await query(db,`SELECT e.id,a.task_id,a.original_task_id,a.hours,a.credits,a.revision AS attribution_revision,
    e.occurred_at,e.note,e.kind,e.version,e.created_at,e.actor_email
    FROM current_work_allocations a JOIN work_entries e ON e.id=a.entry_id JOIN tasks t ON t.id=e.task_id
    WHERE t.client_id=? ORDER BY e.occurred_at,e.id,a.task_id`,clientId).all();
  const totals=await query(db,`SELECT t.id AS task_id,COALESCE(totals.hours,0) AS hours,COALESCE(totals.credits,0) AS credits
    FROM tasks t LEFT JOIN (SELECT a.task_id,SUM(a.hours) AS hours,SUM(a.credits) AS credits
      FROM current_work_allocations a JOIN tasks source ON source.id=a.original_task_id
      WHERE source.status!='cancelled' GROUP BY a.task_id) totals ON totals.task_id=t.id
    WHERE t.client_id=? AND (totals.task_id IS NOT NULL OR EXISTS(SELECT 1 FROM work_entries e WHERE e.task_id=t.id)) ORDER BY t.id`,clientId).all();
  return {projectWorkEntries:rows.results,projectAttributionTotals:totals.results};
}
export async function attributionHistory(db,actor,clientId) {
  requireStaff(actor);requireAgentScope(actor,'admin');
  const result=await query(db,`SELECT a.id,a.reason,a.created_by,a.actor_email,a.created_at,r.entry_id,r.revision,r.entry_version,r.before_json,r.after_json
    FROM attribution_adjustments a JOIN attribution_revisions r ON r.adjustment_id=a.id WHERE a.client_id=? ORDER BY a.created_at,a.id,r.entry_id`,clientId).all();
  return result.results;
}

// Read-only preview for an authorized admin or an offline sanitized snapshot.
// It is not a reservation: commit revalidates revisions inside SQLite.
export async function previewProjectAttribution(db,actor,clientId,body) {
  requireStaff(actor);requireAgentScope(actor,'admin');
  const {adjustmentId,reason,payload}=input(body),changes=JSON.parse(payload);
  const {projectWorkEntries,projectAttributionTotals}=await projectAttribution(db,clientId);
  const projects=(await query(db,'SELECT id,title,status FROM tasks WHERE client_id=? ORDER BY id',clientId).all()).results;
  if(!projects.length || !await query(db,'SELECT id FROM clients WHERE id=?',clientId).first())throw new PortalError(404,'Client or projects not found.');
  if(await query(db,'SELECT id FROM attribution_adjustments WHERE id=?',adjustmentId).first())throw new PortalError(409,'Preview requires an unused idempotency key; inspect history for an existing request.');
  const audited=[];
  for(const change of changes) {
    const entry=await query(db,'SELECT e.* FROM work_entries e JOIN tasks t ON t.id=e.task_id WHERE e.id=? AND t.client_id=?',change.entryId,clientId).first();
    const before=projectWorkEntries.filter(row=>row.id===change.entryId);
    if(!entry || entry.version!==change.expectedVersion || before[0]?.attribution_revision!==change.expectedRevision)throw new PortalError(409,'Attribution conflict: stale or missing source entry.');
    if(change.allocations.reduce((sum,a)=>sum+a.hours,0)!==entry.hours || change.allocations.reduce((sum,a)=>sum+a.credits,0)!==entry.credits || change.allocations.some(a=>!projects.some(p=>p.id===a.taskId && p.status!=='cancelled')))throw new PortalError(409,'Attribution conflict: invalid projects or totals.');
    if(before.length===change.allocations.length && before.every(a=>change.allocations.some(b=>a.task_id===b.taskId && a.hours===b.hours && a.credits===b.credits)))throw new PortalError(409,'Attribution conflict: allocations already match.');
    audited.push({entry,before:before.map(a=>({taskId:a.task_id,hours:a.hours,credits:a.credits})),after:change.allocations});
  }
  const revised=projectWorkEntries.flatMap(row=>changes.some(c=>c.entryId===row.id) ? [] : [row]);
  for(const change of changes) {
    const original=projectWorkEntries.find(row=>row.id===change.entryId);
    for(const a of change.allocations)revised.push({...original,task_id:a.taskId,hours:a.hours,credits:a.credits});
  }
  const totals=rows=>{
    const result=new Map();
    for(const row of [...projectWorkEntries,...revised]) {
      const period=row.occurred_at.slice(0,7),key=JSON.stringify([period,row.task_id]);
      result.set(key,{period,taskId:row.task_id,title:projects.find(p=>p.id===row.task_id)?.title,hours:0,credits:0});
    }
    for(const row of rows) {
      if(projects.find(p=>p.id===row.original_task_id)?.status==='cancelled')continue;
      const period=row.occurred_at.slice(0,7),key=JSON.stringify([period,row.task_id]);
      const total=result.get(key) || {period,taskId:row.task_id,title:projects.find(p=>p.id===row.task_id)?.title,hours:0,credits:0};
      total.hours+=row.hours;total.credits+=row.credits;result.set(key,total);
    }
    return [...result.values()].sort((a,b)=>a.period.localeCompare(b.period) || a.taskId.localeCompare(b.taskId));
  };
  return {dryRun:true,adjustmentId,clientId,reason,request:body,affectedEntries:audited,projectTotalsBefore:projectAttributionTotals,monthlyProjectTotalsBefore:totals(projectWorkEntries),monthlyProjectTotalsAfter:totals(revised),
    financialHistory:'Unchanged: source work, billable_work, ledger, invoices, payments and balance.',
    invoices:(await query(db,'SELECT * FROM invoices WHERE client_id=? ORDER BY period,id',clientId).all()).results,
    balance:(await query(db,'SELECT balance FROM clients WHERE id=?',clientId).first()).balance};
}
