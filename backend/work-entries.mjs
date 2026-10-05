import { PortalError, id, text, workTimestamp } from './domain.mjs';
import { normalCreditsPerHour } from '../src/services/pricing.mjs';
const query=(db,sql,...values)=>db.prepare(sql).bind(...values);
export function entryInput(body) {
  if(!body || typeof body!=='object' || Array.isArray(body))throw new PortalError(400,'Send a work entry.');
  if(Object.keys(body).some(key=>!['id','occurredAt','hours','credits','note','source'].includes(key)))throw new PortalError(400,'Unexpected work-entry field.');
  const credits=body.credits,hours=body.hours;
  if(!Number.isSafeInteger(credits) || credits<1 || credits>10000 || typeof hours!=='number' || !Number.isFinite(hours) || hours<=0 || hours*normalCreditsPerHour!==credits)throw new PortalError(400,'Hours and credits must match: 1 hour = 4 credits, in quarter-hour increments.');
  let sourceType=null,sourceId=null;
  if(body.source!==undefined) {
    if(!body.source || typeof body.source!=='object' || Array.isArray(body.source) || Object.keys(body.source).some(key=>!['type','id'].includes(key)) || !['email','text','call','meeting','other'].includes(body.source.type))throw new PortalError(400,'Send a source with type and stable id.');
    sourceType=body.source.type;sourceId=text(body.source.id,'Source ID',500);
  }
  return {id:id(body.id),occurredAt:workTimestamp(body.occurredAt),hours,credits,note:text(body.note,'Work summary'),sourceType,sourceId};
}
function sameEntry(row,input) {
  return row.occurred_at===input.occurredAt && row.hours===input.hours && row.credits===input.credits && row.note===input.note && row.source_type===input.sourceType && row.source_id===input.sourceId;
}
async function project(db,clientId,taskId) {
  const task=await query(db,'SELECT * FROM tasks WHERE id=? AND client_id=?',taskId,clientId).first();
  if(!task)throw new PortalError(404,'Project not found.');
  return task;
}
export async function workEntries(db,actor,clientId,taskId=null) {
  const fields='e.id,e.task_id,e.occurred_at,e.hours,e.credits,e.note,e.kind,e.version,e.created_at,e.actor_email';
  const result=await query(db,`SELECT ${fields}${actor.staff ? ',e.source_type,e.source_id,e.reallocation_id' : ''} FROM work_entries e JOIN tasks t ON t.id=e.task_id WHERE t.client_id=? ${taskId ? 'AND t.id=?' : ''} ORDER BY e.occurred_at,e.id`,clientId,...(taskId ? [taskId] : [])).all();
  return result.results;
}
export async function addWorkEntry(db,actor,clientId,taskId,body) {
  await project(db,clientId,taskId);
  const entry=entryInput(body);
  const insert=query(db,`INSERT INTO work_entries(id,task_id,occurred_at,hours,credits,note,source_type,source_id,kind,created_by,actor_email)
    SELECT ?,id,?,?,?,?,?,?,'debit',?,? FROM tasks WHERE id=? AND client_id=?
    ON CONFLICT DO NOTHING`,entry.id,entry.occurredAt,entry.hours,entry.credits,entry.note,entry.sourceType,entry.sourceId,actor.id,actor.email,taskId,clientId);
  // Check identity before insertion (a retry remains a no-op after billing).
  async function existing() {
    const byId=await query(db,'SELECT * FROM work_entries WHERE id=?',entry.id).first();
    const bySource=entry.sourceId ? await query(db,'SELECT * FROM work_entries WHERE task_id=? AND source_type=? AND source_id=?',taskId,entry.sourceType,entry.sourceId).first() : null;
    if(byId && bySource && byId.id!==bySource.id)throw new PortalError(409,'Entry ID and source refer to different work.');
    const row=byId || bySource;
    if(row && (row.task_id!==taskId || !sameEntry(row,entry)))throw new PortalError(409,'Work entry or source already used with different terms.');
    return row;
  }
  if(await existing())return;
  await insert.run();
  if(!await existing())throw new PortalError(409,'Work entry changed. Refresh and retry.');
}
export async function reallocateWork(db,actor,clientId,taskId,body) {
  const task=await project(db,clientId,taskId),allocationId=id(body.id);
  if(Object.keys(body).some(key=>!['id','expectedCredits','entries'].includes(key)) || !Array.isArray(body.entries) || body.entries.length<1 || body.entries.length>100)throw new PortalError(400,'Send id, expectedCredits and 1–100 dated entries.');
  const entries=body.entries.map(entryInput).sort((a,b)=>a.id.localeCompare(b.id));
  if(new Set(entries.map(e=>e.id)).size!==entries.length || new Set(entries.filter(e=>e.sourceId).map(e=>JSON.stringify([e.sourceType,e.sourceId]))).size!==entries.filter(e=>e.sourceId).length)throw new PortalError(400,'Use unique entry IDs and source references.');
  const total=entries.reduce((sum,e)=>sum+e.credits,0);
  const payload=JSON.stringify({expectedCredits:body.expectedCredits,entries});
  const existing=await query(db,'SELECT * FROM work_reallocations WHERE id=?',allocationId).first();
  if(existing) {
    if(existing.task_id!==taskId || existing.payload!==payload)throw new PortalError(409,'Reallocation ID already used.');
    return;
  }
  if(task.billing_mode!=='legacy')throw new PortalError(409,'This project already uses dated work entries.');
  if(task.status==='cancelled')throw new PortalError(409,'Cancelled work cannot be reallocated.');
  if(!Number.isSafeInteger(body.expectedCredits) || body.expectedCredits!==task.original_credits || total!==task.original_credits)throw new PortalError(400,'Allocate exactly the existing charged credits; do not exceed or leave part of the charge undated.');
  const statements=[query(db,`INSERT INTO work_reallocations(id,task_id,credits,payload,created_by,actor_email) SELECT ?,id,original_credits,?,?,? FROM tasks WHERE id=? AND client_id=? AND billing_mode='legacy' AND credits=?`,allocationId,payload,actor.id,actor.email,taskId,clientId,body.expectedCredits)];
  for(const entry of entries)statements.push(query(db,`INSERT INTO work_entries(id,task_id,occurred_at,hours,credits,note,source_type,source_id,kind,reallocation_id,created_by,actor_email)
    SELECT ?,id,?,?,?,?,?,?,'allocation',?,?,? FROM tasks WHERE id=? AND billing_mode='legacy' AND credits=?`,entry.id,entry.occurredAt,entry.hours,entry.credits,entry.note,entry.sourceType,entry.sourceId,allocationId,actor.id,actor.email,taskId,body.expectedCredits));
  statements.push(query(db,`UPDATE tasks SET billing_mode='entries',details_version=details_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_by=?,updated_actor_email=? WHERE id=? AND client_id=? AND billing_mode='legacy' AND credits=?`,actor.id,actor.email,taskId,clientId,body.expectedCredits));
  await db.batch(statements);
  if(!await query(db,'SELECT id FROM work_reallocations WHERE id=?',allocationId).first())throw new PortalError(409,'Project changed. Refresh the charged credits before reallocating.');
}
export async function correctWorkEntry(db,actor,clientId,taskId,entryId,body) {
  await project(db,clientId,taskId);
  const row=await query(db,'SELECT * FROM work_entries WHERE id=? AND task_id=?',entryId,taskId).first();
  if(!row)throw new PortalError(404,'Work entry not found.');
  const changeId=id(body.id);
  if(Object.keys(body).some(key=>!['id','expectedVersion','occurredAt','note'].includes(key)) || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion<0 || (body.occurredAt===undefined && body.note===undefined))throw new PortalError(400,'Send id, expectedVersion and occurredAt or note. Credit amounts and sources are immutable.');
  const next={occurredAt:body.occurredAt===undefined ? row.occurred_at : workTimestamp(body.occurredAt),note:body.note===undefined ? row.note : text(body.note,'Work summary')};
  const existing=await query(db,'SELECT * FROM work_entry_changes WHERE id=?',changeId).first();
  if(existing) {
    const previousNext=JSON.parse(existing.after_json);
    if(existing.entry_id!==entryId || (body.occurredAt!==undefined && next.occurredAt!==previousNext.occurredAt) || (body.note!==undefined && next.note!==previousNext.note))throw new PortalError(409,'Correction ID already used.');
    return;
  }
  await db.batch([
    query(db,`INSERT INTO work_entry_changes(id,entry_id,before_json,after_json,created_by,actor_email) SELECT ?,id,?,?,?,? FROM work_entries WHERE id=? AND task_id=? AND version=?`,changeId,JSON.stringify({occurredAt:row.occurred_at,note:row.note}),JSON.stringify(next),actor.id,actor.email,entryId,taskId,body.expectedVersion),
    query(db,'UPDATE work_entries SET occurred_at=?,note=?,version=version+1 WHERE id=? AND task_id=? AND version=?',next.occurredAt,next.note,entryId,taskId,body.expectedVersion),
  ]);
  if(!await query(db,'SELECT id FROM work_entry_changes WHERE id=?',changeId).first())throw new PortalError(409,'Entry changed. Reload its version before correcting.');
}
