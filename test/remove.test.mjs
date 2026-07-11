import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Private, randomized temp dir (mkdtemp → mode 0700, unguessable name) so fixture
// writes can't be pre-empted by a symlink planted at a predictable os.tmpdir() path.
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-remove-test-'));
process.env.CANON_HOME = path.join(baseDir, 'home'); // isolate the signing key
import { pin, unpin, verify, readLock } from '../src/index.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const tmp = (n) => path.join(baseDir, n);
const write = (p, o) => (fs.writeFileSync(p, JSON.stringify(o)), p);
const manifest = (name) => ({ name, tools: [{ name: 'read_file', description: 'Read the contents of a file.' }] });
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: baseDir, encoding: 'utf8', env: process.env });

test('unpin: removes the entry, is a no-op on a missing name, never creates a lock', () => {
  const lock = tmp('u.lock');
  pin(write(tmp('u.json'), manifest('fs')), { lockPath: lock });
  assert.equal(unpin('fs', { lockPath: lock }), 1);
  assert.deepEqual(readLock(lock).skills, {});
  assert.equal(unpin('fs', { lockPath: lock }), 0); // already gone — idempotent
  const absent = tmp('never.lock');
  assert.equal(unpin('ghost', { lockPath: absent }), 0);
  assert.ok(!fs.existsSync(absent), 'a no-op removal must not create a lock file');
});

test('canon remove: drops the entry — list no longer shows it, verify no longer fails on the vanished source', () => {
  const lock = tmp('r.lock'), src = write(tmp('r.json'), manifest('fs'));
  pin(src, { lockPath: lock });
  pin(write(tmp('r2.json'), manifest('other')), { lockPath: lock, name: 'other' });
  fs.rmSync(src); // the skill is uninstalled — the classic reason to un-pin
  assert.equal(verify({ lockPath: lock }).results.find((r) => r.name === 'fs').status, 'missing');
  const r = cli(['remove', 'fs', '--lock', lock]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /removed fs/);
  const l = JSON.parse(fs.readFileSync(lock, 'utf8')); // still valid JSON
  assert.ok(!('fs' in l.skills) && 'other' in l.skills);
  assert.equal(cli(['list', '--lock', lock]).stdout.includes('fs'), false);
  const v = verify({ lockPath: lock });
  assert.equal(v.ok, true, 'no stale missing-entry failing verify closed forever');
});

test('canon remove: a non-existent name is a notice, exit 0, lock unchanged (CI-safe)', () => {
  const lock = tmp('n.lock');
  pin(write(tmp('n.json'), manifest('fs')), { lockPath: lock });
  const before = fs.readFileSync(lock, 'utf8');
  const r = cli(['remove', 'ghost', '--lock', lock]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no matching entry: ghost/);
  assert.equal(fs.readFileSync(lock, 'utf8'), before);
});

test('canon remove: multiple names in one invocation, mixed hit/miss', () => {
  const lock = tmp('m.lock');
  pin(write(tmp('m1.json'), manifest('one')), { lockPath: lock, name: 'one' });
  pin(write(tmp('m2.json'), manifest('two')), { lockPath: lock, name: 'two' });
  const r = cli(['remove', 'one', 'ghost', 'two', '--lock', lock]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /removed one/);
  assert.match(r.stdout, /no matching entry: ghost/);
  assert.match(r.stdout, /removed two/);
  assert.deepEqual(readLock(lock).skills, {});
});

test('canon remove: no names is a usage error (exit 2); unpin alias works', () => {
  assert.equal(cli(['remove']).status, 2);
  const lock = tmp('a.lock');
  pin(write(tmp('a.json'), manifest('fs')), { lockPath: lock });
  assert.equal(cli(['unpin', 'fs', '--lock', lock]).status, 0);
  assert.deepEqual(readLock(lock).skills, {});
});
