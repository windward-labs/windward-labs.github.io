import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync,chmodSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {agentScopes,jamesScopes,tokenHash} from './agent-auth.mjs';
import {normalizeEmail,isStaffEmail} from './domain.mjs';
import {readLocalEnv} from './local-env.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const [command,...args]=process.argv.slice(2);
const value=(flag,fallback)=>{const index=args.indexOf(flag);return index<0?fallback:args[index+1];};
const remote=args.includes('--remote');
const mode=remote?'production':'local';
const sqlText=value=>`'${String(value).replaceAll("'","''")}'`;
function execute(sql) {
  const dir=mkdtempSync(join(tmpdir(),'windward-agent-'));
  try {
    const path=join(dir,'query.sql');writeFileSync(path,sql,{mode:0o600});
    return execFileSync(resolve(root,'node_modules/.bin/wrangler'),['d1','execute','windward-service',remote?'--remote':'--local','--config','backend/wrangler.jsonc','--file',path,'--json'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  } finally {rmSync(dir,{recursive:true,force:true});}
}
try {
  if(command==='create') {
    const email=normalizeEmail(value('--email','james@windwardlabs.xyz'));
    if(!isStaffEmail(email))throw new Error('Agent keys require a Windward staff email.');
    const scopes=value('--scopes',jamesScopes.join(',')).split(',');
    if(!scopes.length || scopes.some(scope=>!agentScopes.includes(scope)))throw new Error('Unknown scope.');
    const days=Number(value('--expires-days','90'));
    if(!Number.isInteger(days) || days<1 || days>365)throw new Error('Expiry must be 1–365 days.');
    const expiresAt=new Date(Date.now()+days*86400000).toISOString();
    const keyId=randomBytes(16).toString('hex');
    const token=`wwa_${keyId}_${randomBytes(32).toString('base64url')}`;
    const label=value('--label',`James ${mode}`);
    if(!label || label.length>160)throw new Error('Label must contain 1–160 characters.');
    const dir=resolve(root,'.agent-secrets');mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
    const path=join(dir,`${email.split('@')[0].replace(/[^a-z0-9_-]/g,'_')}.${mode}.${keyId}.env`);
    // Save before registration so a network interruption cannot lose the credential.
    writeFileSync(path,`WINDWARD_API_BASE_URL=${remote?'https://windward-service-api.windwardlabs.workers.dev':'http://localhost:8787'}/v1\nWINDWARD_API_TOKEN=${token}\nWINDWARD_API_KEY_ID=${keyId}\nWINDWARD_API_KEY_EXPIRES_AT=${expiresAt}\n`,{mode:0o600,flag:'wx'});
    const sql=`INSERT INTO agent_keys (id,email,label,token_hash,scopes,expires_at) VALUES (${[keyId,email,label,await tokenHash(token),JSON.stringify(scopes),expiresAt].map(sqlText).join(',')});`;
    try{execute(sql);}catch{throw new Error(`Registration failed or is unconfirmed. Credential saved at ${path}; check keys with list before retrying. No token was printed.`);}
    console.log(JSON.stringify({email,keyId,scopes,expiresAt,credentialFile:path,mode},null,2));
  } else if(command==='verify') {
    const path=value('--credentials','');if(!path)throw new Error('Provide --credentials with the private credential file path.');
    const env=readLocalEnv(resolve(root,path));
    const expected=`${remote?'https://windward-service-api.windwardlabs.workers.dev':'http://localhost:8787'}/v1`;
    if(env.WINDWARD_API_BASE_URL!==expected || !env.WINDWARD_API_TOKEN)throw new Error('Credential file must match the selected local or production API.');
    const get=async resource=>{
      const response=await fetch(`${expected}/${resource}`,{headers:{Authorization:`Bearer ${env.WINDWARD_API_TOKEN}`},signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error(`API verification failed: ${resource} returned HTTP ${response.status}.`);
      return response.json();
    };
    const identity=await get('me'),clients=await get('clients');
    if(identity.keyId!==env.WINDWARD_API_KEY_ID)throw new Error('Unexpected key identity.');
    const detail=clients.clients.length ? await get(`clients/${encodeURIComponent(clients.clients[0].id)}`) : null;
    console.log(JSON.stringify({mode,email:identity.email,keyId:identity.keyId,scopes:identity.scopes,clientCount:clients.clients.length,clientDetailVerified:!!detail,verified:true},null,2));
  } else if(command==='list') {
    console.log(execute('SELECT id,email,label,scopes,created_at,expires_at,revoked_at FROM agent_keys ORDER BY created_at DESC;'));
  } else if(command==='revoke') {
    const keyId=value('--id','');if(!/^[a-f0-9]{32}$/.test(keyId))throw new Error('Provide --id with a key ID from list.');
    console.log(execute(`UPDATE agent_keys SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=${sqlText(keyId)}; SELECT id,email,revoked_at FROM agent_keys WHERE id=${sqlText(keyId)};`));
  } else if(command==='audit') {
    console.log(execute('SELECT a.id,a.key_id,a.actor_email,a.method,a.path,a.response_status,a.created_at FROM agent_activity a ORDER BY a.created_at DESC LIMIT 100;'));
  } else throw new Error('Usage: node backend/manage-agent.mjs create|list|audit|revoke|verify [--remote] [--email EMAIL] [--scopes admin] [--expires-days 90] [--id KEY_ID] [--credentials FILE]');
} catch(error) {
  // Wrangler errors may contain SQL. Never print registration SQL or credentials.
  console.error(error instanceof Error && error.message.startsWith('Command failed:')?'Database command failed. Check Cloudflare access and migrations.':error.message);
  process.exitCode=1;
}
