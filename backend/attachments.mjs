import { PortalError, requireStaff, text, id } from './domain.mjs';

export const maxAttachmentBytes = 10 * 1024 * 1024;
const query = (db, sql, ...values) => db.prepare(sql).bind(...values);
const key = (clientId, taskId, attachmentId) => `${clientId}/${taskId}/${attachmentId}`;

async function readFile(request) {
  if (Number(request.headers.get('Content-Length')) > maxAttachmentBytes) throw new PortalError(413,'Attachments must be 10 MB or smaller.');
  if (!request.body) throw new PortalError(400,'Choose a nonempty file.');
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxAttachmentBytes) { await reader.cancel(); throw new PortalError(413,'Attachments must be 10 MB or smaller.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new PortalError(400,'Choose a nonempty file.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return bytes;
}

// The caller checks current client membership before either operation.
export async function handleAttachment(request,env,db,actor,clientId,taskId,attachmentId) {
  id(taskId); id(attachmentId);
  if (request.method !== 'GET' && request.method !== 'POST') throw new PortalError(405,'Method not allowed.');
  if (request.method === 'POST') requireStaff(actor);
  const task = await query(db,'SELECT id FROM tasks WHERE id=? AND client_id=?',taskId,clientId).first();
  if (!task) throw new PortalError(404,'Work not found.');
  if (!env.ATTACHMENTS) throw new PortalError(503,'Attachment storage is not configured.');
  if (request.method === 'GET') {
    const attachment = await query(db,'SELECT * FROM attachments WHERE id=? AND task_id=? AND ready=1',attachmentId,taskId).first();
    if (!attachment) throw new PortalError(404,'Attachment not found.');
    const object = await env.ATTACHMENTS.get(key(clientId,taskId,attachmentId));
    if (!object) throw new PortalError(404,'Attachment not found.');
    const filename = encodeURIComponent(attachment.name).replace(/['()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(object.body,{headers:{
      'Content-Type':'application/octet-stream',
      'Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${filename}`,
      'Content-Length':String(attachment.size),
      'X-Content-Type-Options':'nosniff',
      'Cache-Control':'no-store',
    }});
  }
  let name;
  try { name = decodeURIComponent(request.headers.get('X-File-Name') || ''); }
  catch { throw new PortalError(400,'Invalid file name.'); }
  name = text(name,'File name',255);
  if (/[\x00-\x1f\x7f]/.test(name)) throw new PortalError(400,'Invalid file name.');
  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
  if (contentType.length > 200) throw new PortalError(400,'Invalid file type.');
  const bytes = await readFile(request);
  const digest = await crypto.subtle.digest('SHA-256',bytes);
  const sha256 = Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  // Reserve the ID and slot before storing bytes. Retries must contain the same
  // file; a failed R2 upload can resume without charging for the task again.
  await query(db,`INSERT INTO attachments (id,task_id,name,content_type,size,sha256,created_by,actor_email)
    SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM attachments WHERE task_id=?) < 5
    ON CONFLICT(id) DO NOTHING`,attachmentId,taskId,name,contentType,bytes.byteLength,sha256,actor.id,actor.email,taskId).run();
  const attachment = await query(db,'SELECT * FROM attachments WHERE id=?',attachmentId).first();
  if (!attachment) throw new PortalError(409,'Each work record can have up to 5 attachments.');
  if (attachment.task_id !== taskId || attachment.name !== name || attachment.size !== bytes.byteLength || attachment.content_type !== contentType || attachment.sha256 !== sha256) throw new PortalError(409,'Attachment ID already used for a different file.');
  if (!attachment.ready) {
    await env.ATTACHMENTS.put(key(clientId,taskId,attachmentId),bytes,{httpMetadata:{contentType}});
    await query(db,'UPDATE attachments SET ready=1 WHERE id=?',attachmentId).run();
  }
  return Response.json({id:attachmentId,name,size:bytes.byteLength},{headers:{'Cache-Control':'no-store'}});
}
