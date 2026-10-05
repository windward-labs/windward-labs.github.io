import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(settings, flags = []) {
  const dir = mkdtempSync(join(tmpdir(), 'windward-deploy-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
    copyFileSync(resolve('scripts/deploy-production.mjs'), join(dir, 'scripts/deploy-production.mjs'));
    const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const config = JSON.parse(process.env.DEPLOY_TEST_SETTINGS);
fs.appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify([name, ...args]) + '\\n');
if (name === 'git') {
 if (args[0] === 'branch') console.log(config.branch || 'main');
 if (args[0] === 'status' && config.dirty) console.log(' M src/page.tsx');
 if (args[0] === 'rev-parse') console.log(args[1] === 'HEAD' ? 'new-sha' : 'old-sha');
 if (args[0] === 'diff') console.log(config.changed || 'src/page.tsx');
}
if (name === 'wrangler' && args[0] === 'd1' && config.failMigration) process.exit(1);
if (name === 'gh' && args[1] === 'list') console.log(JSON.stringify([{databaseId: 123, url: 'https://example.com/release'}]));
`;
    for (const cmd of ['git', 'npm', 'gh']) writeFileSync(join(dir, 'bin', cmd), mock, { mode: 0o755 });
    writeFileSync(join(dir, 'node_modules/.bin/wrangler'), mock, { mode: 0o755 });
    const log = join(dir, 'calls');
    const result = spawnSync(process.execPath, [join(dir, 'scripts/deploy-production.mjs'), ...flags], {
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, DEPLOY_TEST_SETTINGS: JSON.stringify(settings), DEPLOY_TEST_LOG: log }, encoding: 'utf8', timeout: 15000,
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    return { ...result, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('frontend release skips local duplicate checks and watches the pushed commit', () => {
  const result = fixture({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.some(([cmd]) => cmd === 'npm' || cmd === 'wrangler'), false);
  assert.ok(result.calls.some(call => call[0] === 'git' && call[1] === 'push' && call.includes('new-sha:refs/heads/main')));
  assert.ok(result.calls.some(call => call[0] === 'gh' && call.includes('--commit') && call.includes('new-sha')));
  assert.ok(result.calls.some(call => call[0] === 'gh' && call[2] === 'watch' && call.includes('--exit-status')));
});
test('API release applies migrations before Worker deployment and frontend push', () => {
  const result = fixture({ changed: 'backend/api.mjs\nbackend/migrations/0010.sql' });
  assert.equal(result.status, 0, result.stderr);
  const migration = result.calls.findIndex(call => call[0] === 'wrangler' && call[1] === 'd1');
  const deploy = result.calls.findIndex(call => call[0] === 'wrangler' && call[1] === 'deploy');
  const push = result.calls.findIndex(call => call[0] === 'git' && call[1] === 'push');
  assert.ok(migration > 0 && deploy > migration && push > deploy);
});
test('failed migrations stop before Worker deployment or push', () => {
  const result = fixture({ changed: 'backend/api.mjs', failMigration: true });
  assert.equal(result.status, 1);
  assert.equal(result.calls.some(call => call[0] === 'wrangler' && call[1] === 'deploy'), false);
  assert.equal(result.calls.some(call => call[0] === 'git' && call[1] === 'push'), false);
});
test('dirty tracked files and non-main branches prevent deployment', () => {
  for (const settings of [{ dirty: true }, { branch: 'feature' }]) {
    const result = fixture(settings);
    assert.equal(result.status, 1);
    assert.equal(result.calls.some(call => ['npm', 'gh', 'wrangler'].includes(call[0]) || call[1] === 'fetch' || call[1] === 'push'), false);
  }
});
test('dry run inspects a release without any network or mutation', () => {
  const result = fixture({ changed: 'backend/api.mjs' }, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.some(call => ['npm', 'gh', 'wrangler'].includes(call[0]) || call[1] === 'fetch' || call[1] === 'push'), false);
});
