import { spawn } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import { readLocalEnv,localEnvPath } from './local-env.mjs';

const env = readLocalEnv();
if (env.STRIPE_MODE!=='test' || !env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new Error('A local Stripe test key is required.');
const cli = new URL('../node_modules/.bin/stripe',import.meta.url);
const child = spawn(cli.pathname,['listen','--events','checkout.session.completed,checkout.session.async_payment_succeeded','--forward-to','http://localhost:8787/v1/stripe/webhook','--color','off'],{
  env:{...process.env,STRIPE_API_KEY:env.STRIPE_SECRET_KEY,STRIPE_DEVICE_NAME:'windward-local'},stdio:['ignore','pipe','pipe'],
});
let buffered='';
function output(chunk) {
  buffered+=chunk.toString();
  const secret=buffered.match(/whsec_[A-Za-z0-9]+/)?.[0];
  if (secret) {
    const current=readFileSync(localEnvPath,'utf8');
    const next=current.replace(/^STRIPE_WEBHOOK_SECRET=.*\n?/gm,'').trimEnd()+`\nSTRIPE_WEBHOOK_SECRET=${secret}\n`;
    if (current!==next) { writeFileSync(localEnvPath,next,{mode:0o600}); console.log('Local webhook signing secret saved. Restart the API if it is already running.'); }
  }
  const lines=buffered.split('\n'); buffered=lines.pop();
  for (const line of lines) console.log(line.replace(/(?:whsec_|sk_test_)[A-Za-z0-9]+/g,'[secret hidden]'));
}
child.stdout.on('data',output); child.stderr.on('data',output);
child.on('error',()=>{ console.error('Unable to start Stripe CLI. Run npm install first.'); process.exitCode=1; });
child.on('exit',code=>{ process.exitCode=code || 0; });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
