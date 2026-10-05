import {PortalError,id,text,workTimestamp} from './domain.mjs';
const query=(db,sql,...values)=>db.prepare(sql).bind(...values);
export async function agreementRecords(db,actor,clientId) {
  const projectCharges=(await query(db,'SELECT e.* FROM project_charges e JOIN tasks t ON t.id=e.task_id WHERE t.client_id=? ORDER BY e.occurred_at,e.id',clientId).all()).results;
  if(!actor.staff)return {projectCharges};
  const timeEntries=(await query(db,'SELECT e.* FROM time_entries e JOIN tasks t ON t.id=e.task_id WHERE t.client_id=? ORDER BY e.occurred_at,e.id',clientId).all()).results;
  const agreementChanges=(await query(db,'SELECT e.* FROM project_agreement_changes e JOIN tasks t ON t.id=e.task_id WHERE t.client_id=? ORDER BY e.created_at,e.id',clientId).all()).results;
  return {projectCharges,timeEntries,agreementChanges};
}
export async function recordAgreementWork(db,actor,taskId,resource,body) {
  const internal=resource==='time-entries',table=internal ? 'time_entries' : 'project_charges';
  const allowed=internal ? ['id','occurredAt','hours','note','source'] : ['id','occurredAt','credits','note'];
  if(Object.keys(body).some(key=>!allowed.includes(key)))throw new PortalError(400,'Unexpected entry field.');
  const entryId=id(body.id),occurredAt=workTimestamp(body.occurredAt),note=text(body.note,'Summary');
  const quantity=internal ? body.hours : body.credits;
  if(typeof quantity!=='number' || !Number.isFinite(quantity) || quantity<=0 || (internal ? quantity>2500 || !Number.isSafeInteger(quantity*4) : quantity>10000 || !Number.isSafeInteger(quantity)))throw new PortalError(400,internal ? 'Enter hours in quarter-hour increments, up to 2,500.' : 'Enter 1–10,000 whole credits.');
  let sourceType=null,sourceId=null;
  if(body.source!==undefined) {
    if(!body.source || Object.keys(body.source).some(key=>!['type','id'].includes(key)) || !['email','text','call','meeting','other'].includes(body.source.type))throw new PortalError(400,'Send a source type and stable id.');
    sourceType=body.source.type;sourceId=text(body.source.id,'Source ID',500);
  }
  async function existing() {
    const byId=await query(db,`SELECT * FROM ${table} WHERE id=?`,entryId).first();
    const bySource=sourceId ? await query(db,'SELECT * FROM time_entries WHERE task_id=? AND source_type=? AND source_id=?',taskId,sourceType,sourceId).first() : null;
    if(byId && bySource && byId.id!==bySource.id)throw new PortalError(409,'Entry ID and source refer to different time.');
    const row=byId || bySource;
    if(row && (row.task_id!==taskId || row.occurred_at!==occurredAt || row.note!==note || row[internal?'hours':'credits']!==quantity || (internal && (row.source_type!==sourceType || row.source_id!==sourceId))))throw new PortalError(409,'Entry or source already used with different terms.');
    return row;
  }
  if(await existing())return;
  if(internal)await query(db,'INSERT INTO time_entries(id,task_id,occurred_at,hours,note,source_type,source_id,created_by,actor_email) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',entryId,taskId,occurredAt,quantity,note,sourceType,sourceId,actor.id,actor.email).run();
  else await query(db,'INSERT INTO project_charges(id,task_id,occurred_at,credits,note,created_by,actor_email) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',entryId,taskId,occurredAt,quantity,note,actor.id,actor.email).run();
  if(!await existing())throw new PortalError(409,'Entry changed. Refresh and retry.');
}
export async function changeAgreement(db,actor,task,body) {
  if(Object.keys(body).some(key=>!['id','expectedVersion','pricingModel','fixedCredits','budgetCredits','approvalNote'].includes(key)))throw new PortalError(400,'Unexpected agreement field.');
  const changeId=id(body.id),approval=text(body.approvalNote,'Client approval reference');
  const pricingModel=body.pricingModel,fixedCredits=body.fixedCredits ?? null,budgetCredits=body.budgetCredits ?? null;
  if(!['fixed','hourly'].includes(pricingModel) || !Number.isSafeInteger(body.expectedVersion))throw new PortalError(400,'Send pricingModel and expectedVersion.');
  for(const value of [fixedCredits,budgetCredits])if(value!==null && (!Number.isSafeInteger(value) || value<1 || value>10000))throw new PortalError(400,'Agreement credits must be a whole number from 1 to 10,000.');
  if(pricingModel==='fixed' ? fixedCredits===null || fixedCredits<task.credits || budgetCredits!==null : fixedCredits!==null || (budgetCredits!==null && budgetCredits<task.credits))throw new PortalError(400,'The agreement must cover credits already charged.');
  if(pricingModel==='fixed' && task.billing_mode!=='entries')throw new PortalError(409,'Reallocate the original project charge before switching to fixed price.');
  const after=JSON.stringify({pricingModel,fixedCredits,budgetCredits,version:body.expectedVersion+1});
  const old=await query(db,'SELECT * FROM project_agreement_changes WHERE id=?',changeId).first();
  if(old) {
    if(old.task_id!==task.id || old.after_json!==after || old.approval_note!==approval)throw new PortalError(409,'Agreement change ID already used.');
    return;
  }
  if(task.status==='cancelled')throw new PortalError(409,'Cancelled project agreements cannot change.');
  if(task.details_version!==body.expectedVersion)throw new PortalError(409,'Project changed. Refresh before changing its agreement.');
  const before=JSON.stringify({pricingModel:task.pricing_model,fixedCredits:task.fixed_credits,budgetCredits:task.budget_credits,version:task.details_version});
  await db.batch([
    query(db,`INSERT INTO project_agreement_changes(id,task_id,before_json,after_json,approval_note,created_by,actor_email) SELECT ?,id,?,?,?,?,? FROM tasks WHERE id=? AND details_version=? AND status!='cancelled'`,changeId,before,after,approval,actor.id,actor.email,task.id,body.expectedVersion),
    query(db,`UPDATE tasks SET pricing_model=?,fixed_credits=?,budget_credits=?,details_version=details_version+1,updated_by=?,updated_actor_email=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND details_version=? AND EXISTS(SELECT 1 FROM project_agreement_changes WHERE id=?)`,pricingModel,fixedCredits,budgetCredits,actor.id,actor.email,task.id,body.expectedVersion,changeId)
  ]);
  if(!await query(db,'SELECT id FROM project_agreement_changes WHERE id=?',changeId).first())throw new PortalError(409,'Project changed. Refresh before changing its agreement.');
}
