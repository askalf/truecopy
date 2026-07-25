// Concurrent pins must not lose entries.
//
// readLock → mutate → writeLock is three operations, and pin/unpin ran them
// unguarded: two `truecopy add` runs against one lock both read the same state,
// each added its entry, and the second write erased the first. The CLI printed
// "✓ pinned" for a skill that is not in the lock — the worst shape a bug can
// take here, because the gate then enforces a lock that has never heard of a
// skill someone was told was vetted.
//
// The real test is the multi-process one: atomic writes alone do not fix this
// (they prevent a torn file, not a lost update), so anything short of separate
// processes racing would not have caught it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-lock-concurrency-'));
process.env.CANON_HOME = path.join(baseDir, 'home');
const { readLock, updateLock } = await import('../src/lock.mjs');
const { unpin } = await import('../src/index.mjs');

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const WRITERS = 12;

const run = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...args], { cwd: baseDir, encoding: 'utf8', env: process.env });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  c.on('exit', (code) => resolve({ code, out }));
});

test(`${WRITERS} concurrent pins all survive`, async () => {
  const lock = path.join(baseDir, 'race.lock');
  const dirs = [];
  for (let i = 0; i < WRITERS; i++) {
    const d = path.join(baseDir, 'skills', `s${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), `# s${i}\nSummarize politely.\n`);
    dirs.push(d);
  }

  // Launched together, not in sequence — the whole point is the overlap.
  const results = await Promise.all(dirs.map((d, i) => run(['add', d, '--lock', lock, '--name', `s${i}`])));
  for (const r of results) assert.equal(r.code, 0, r.out);

  const pinned = Object.keys(readLock(lock).skills).sort();
  const expected = dirs.map((_, i) => `s${i}`).sort();
  assert.deepEqual(pinned, expected,
    `every skill the CLI reported as pinned must be in the lock — ${expected.length - pinned.length} lost`);
});

test('the guard leaves nothing behind', () => {
  const files = fs.readdirSync(baseDir).filter((f) => f.includes('.guard') || f.includes('.tmp-'));
  assert.deepEqual(files, [], 'no guard or temp residue after the race');
});

test('a no-op update does not create a lock file', () => {
  const p = path.join(baseDir, 'absent.lock');
  assert.equal(unpin('nothing-here', { lockPath: p }), 0);
  assert.equal(fs.existsSync(p), false, 'unpinning a name that was never pinned must not create a lock');
  // And ctx.skip() is what makes that work, directly.
  assert.equal(updateLock(p, (lock, ctx) => { ctx.skip(); return 'untouched'; }), 'untouched');
  assert.equal(fs.existsSync(p), false);
});

test('a guard left by a dead process is reclaimed, not waited on forever', () => {
  const p = path.join(baseDir, 'stale.lock');
  const guard = `${p}.guard`;
  fs.writeFileSync(guard, JSON.stringify({ pid: 999999, at: 'yesterday' }));
  const old = Date.now() / 1000 - 600;                  // ten minutes ago
  fs.utimesSync(guard, old, old);

  const started = Date.now();
  updateLock(p, (lock) => { lock.skills.after = { hash: 'x' }; }, { staleMs: 60_000 });
  assert.ok(Date.now() - started < 5_000, 'stolen promptly rather than waited out');
  assert.deepEqual(Object.keys(readLock(p).skills), ['after']);
  assert.equal(fs.existsSync(guard), false, 'and the guard is released again');
});

test('a guard held by a live process makes the update fail loudly, not silently', () => {
  const p = path.join(baseDir, 'held.lock');
  const guard = `${p}.guard`;
  fs.writeFileSync(guard, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try {
    // Fresh guard, so it is not stale; a short wait keeps the test quick.
    assert.throws(() => updateLock(p, (lock) => { lock.skills.x = {}; }, { waitMs: 200 }), /timed out waiting/);
    assert.equal(fs.existsSync(p), false, 'and it did not write the lock anyway');
  } finally { fs.unlinkSync(guard); }
});
