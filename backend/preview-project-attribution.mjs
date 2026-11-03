// Offline only. Never loads .env files, credentials, Wrangler, or network clients.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {previewProjectAttribution} from './project-attribution.mjs';
export async function previewSnapshot(databasePath,clientId,request) {
  const sqlite=new DatabaseSync(databasePath,{readOnly:true});
  const wrap=(sql,values=[])=>({bind(...args){return wrap(sql,args);},async first(){return sqlite.prepare(sql).get(...values) ?? null;},async all(){return {results:sqlite.prepare(sql).all(...values)};}});
  try {
    return await previewProjectAttribution({prepare:wrap},{id:'offline-review',email:'offline-review@windwardlabs.xyz',staff:true},clientId,request);
  } finally {sqlite.close();}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [databasePath,clientId,requestPath,...extra]=process.argv.slice(2);
  if(!databasePath || !clientId || !requestPath || extra.length)throw new Error('Usage: node backend/preview-project-attribution.mjs SANITIZED_LOCAL.sqlite CLIENT_UUID REQUEST.json');
  console.log(JSON.stringify(await previewSnapshot(databasePath,clientId,JSON.parse(readFileSync(requestPath,'utf8'))),null,2));
}
