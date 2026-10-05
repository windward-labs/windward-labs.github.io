#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const repo = 'windward-labs/windward-labs.github.io';
const dryRun = args.has('--dry-run');
if (args.has('--help')) {
  console.log('Usage: npm run deploy:production -- [--dry-run] [--api]\nDeploy committed main; automatically deploy API changes before pushing Pages.');
  process.exit(0);
}
for (const arg of args) {
  if (!['--dry-run', '--api'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
}

function read(command, argv) {
  const result = spawnSync(command, argv, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error || result.status}`);
  return result.stdout.trim();
}
async function run(command, argv) {
  console.log(`\n> ${command} ${argv.join(' ')}`);
  await new Promise((accept, reject) => {
    const child = spawn(command, argv, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function main() {
  if (read('git', ['branch', '--show-current']) !== 'main') throw new Error('Switch to main before deploying.');
  if (read('git', ['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Commit the intended changes first. This script never stages files or includes untracked files.');
  }
  if (!dryRun) await run('git', ['fetch', 'origin', 'main']);
  const sha = read('git', ['rev-parse', 'HEAD']);
  const base = read('git', ['rev-parse', 'origin/main']);
  read('git', ['merge-base', '--is-ancestor', base, sha]);
  const changed = read('git', ['diff', '--name-only', `${base}..${sha}`]).split('\n').filter(Boolean);
  const dependenciesChanged = changed.includes('package.json') && ['dependencies', 'devDependencies'].some(key => {
    const previous = JSON.parse(read('git', ['show', `${base}:package.json`]));
    const current = JSON.parse(read('git', ['show', `${sha}:package.json`]));
    return JSON.stringify(previous[key]) !== JSON.stringify(current[key]);
  });
  const api = args.has('--api') || dependenciesChanged || changed.some(path => /^backend\/.*\.(mjs|jsonc|sql)$/.test(path) || path === 'package-lock.json');
  console.log(`\nProduction commit: ${sha}\nAPI: ${api ? 'validate, migrate, deploy' : 'unchanged'}\nPages: ${sha === base ? 'already pushed' : 'push and wait for CI'}`);
  if (dryRun) {
    console.log('Dry run: no tests, migrations, deployment, push, or network requests performed.');
    return;
  }
  // Frontend-only changes are validated once in CI. API changes must pass locally
  // before touching production, then migrations must succeed before Worker deploy.
  if (api) {
    await Promise.all([run('npm', ['run', 'typecheck']), run('npm', ['test'])]);
    if (read('git', ['rev-parse', 'HEAD']) !== sha || read('git', ['status', '--porcelain', '--untracked-files=no'])) {
      throw new Error('Checkout changed during validation. Commit and rerun before deploying.');
    }
    const config = ['--config', 'backend/wrangler.jsonc'];
    await run('node_modules/.bin/wrangler', ['d1', 'migrations', 'apply', 'windward-service', '--remote', ...config]);
    await run('node_modules/.bin/wrangler', ['deploy', ...config]);
  }
  if (sha === base) {
    console.log('No new frontend commit to publish.');
    return;
  }
  if (read('git', ['rev-parse', 'HEAD']) !== sha || read('git', ['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Checkout changed during deployment. API may be live; review before pushing.');
  }
  await run('git', ['push', `git@github.com:${repo}.git`, `${sha}:refs/heads/main`]);
  let release;
  for (let attempt = 0; attempt < 24; attempt++) {
    const runs = JSON.parse(read('gh', ['run', 'list', '--repo', repo, '--workflow', 'deploy.yml', '--commit', sha, '--event', 'push', '--json', 'databaseId,url', '--limit', '1']));
    if (runs.length) { release = runs[0]; break; }
    console.log('Waiting for GitHub to register this commit’s deployment…');
    await new Promise(accept => setTimeout(accept, 5000));
  }
  if (!release) throw new Error(`Push succeeded, but no deployment appeared for ${sha}. Inspect GitHub Actions; do not push again blindly.`);
  console.log(`Release: ${release.url}`);
  await run('gh', ['run', 'watch', String(release.databaseId), '--repo', repo, '--exit-status', '--interval', '10']);
  console.log(`\nProduction deployed successfully: https://windwardlabs.xyz (${sha.slice(0, 7)})`);
}
main().catch(error => { console.error(`\nDeployment stopped: ${error.message}`); process.exitCode = 1; });
