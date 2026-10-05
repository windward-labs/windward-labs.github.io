import {PortalError,isStaffEmail,normalizeEmail} from './domain.mjs';

export const agentScopes=['admin','clients:read','projects:update','projects:moderate','projects:create','projects:cancel','attachments:write','billing:read','billing:dates','billing:draft','billing:issue','billing:void'];
export const jamesScopes=['admin'];
export async function tokenHash(token) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function authenticateAgent(token,env,now=new Date()) {
  const match=token.match(/^wwa_([a-f0-9]{32})_([A-Za-z0-9_-]{43})$/);
  if(!match || !env.DB)throw new PortalError(401,'Invalid agent API key.');
  const db=env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
  const key=await db.prepare('SELECT * FROM agent_keys WHERE id=?').bind(match[1]).first();
  const hash=await tokenHash(token);
  if(!key || key.revoked_at || (key.expires_at && (!Number.isFinite(Date.parse(key.expires_at)) || Date.parse(key.expires_at)<=now.getTime())) || key.token_hash.length!==hash.length || [...hash].reduce((difference,char,index)=>difference|(char.charCodeAt(0)^key.token_hash.charCodeAt(index)),0)!==0)throw new PortalError(401,'Invalid or expired agent API key.');
  const email=normalizeEmail(key.email), scopes=JSON.parse(key.scopes);
  if(!isStaffEmail(email) || !Array.isArray(scopes) || scopes.some(scope=>!agentScopes.includes(scope)))throw new PortalError(403,'Agent access is not configured correctly.');
  return {id:`agent:${key.id}`,email,staff:true,kind:'agent',keyId:key.id,scopes};
}
export function requireAgentScope(actor,scope) {
  if(actor.kind==='agent' && !actor.scopes?.includes('admin') && !actor.scopes?.includes(scope))throw new PortalError(403,`This agent key requires ${scope}.`);
}
export function authorizeAgent(actor,path,method) {
  if(actor.kind!=='agent')return;
  if(actor.scopes?.includes('admin'))return;
  if(path==='/v1/me' && method==='GET')return;
  let scope;
  if(method==='GET' && /^\/v1\/clients(?:\/[^/]+)?$/.test(path))scope='clients:read';
  else if(/^\/v1\/clients\/[^/]+\/tasks\/[^/]+\/attachments\/[^/]+$/.test(path))scope=method==='GET'?'clients:read':method==='POST'?'attachments:write':null;
  else if(method==='GET' && /^\/v1\/clients\/[^/]+\/(billing|activity\/[^/]+\/document)$/.test(path))scope='billing:read';
  else if(method==='POST' && /^\/v1\/clients\/[^/]+\/invoices$/.test(path))scope='billing:draft';
  else if(method==='POST' && /^\/v1\/clients\/[^/]+\/invoices\/[^/]+\/(issue|refresh|void)$/.test(path))scope={issue:'billing:issue',refresh:'billing:read',void:'billing:void'}[path.split('/').at(-1)];
  else if(method==='POST' && /^\/v1\/clients\/[^/]+\/tasks$/.test(path))scope='projects:create';
  else if(method==='PATCH' && /^\/v1\/clients\/[^/]+\/tasks\/[^/]+\/date$/.test(path))scope='billing:dates';
  else if((method==='DELETE' && /^\/v1\/clients\/[^/]+\/tasks\/[^/]+\/updates\/[^/]+$/.test(path)) || (method==='POST' && /^\/v1\/clients\/[^/]+\/tasks\/[^/]+\/updates\/[^/]+\/restore$/.test(path)))scope='projects:moderate';
  else if((method==='PATCH' && /^\/v1\/clients\/[^/]+\/tasks\/[^/]+(?:\/(?:updates\/[^/]+|details))?$/.test(path)) || (method==='POST' && /^\/v1\/clients\/[^/]+\/tasks\/[^/]+\/updates$/.test(path)))scope='projects:update';
  if(!scope)throw new PortalError(403,'This operation is not available to agent keys.');
  requireAgentScope(actor,scope);
}
