// The guard's "someone else holds it" signal is not only EEXIST.
//
// On Windows, `open(wx)` on a guard that another process is unlinking at that
// instant fails with EPERM (delete-pending), not EEXIST. acquire() treated any
// non-EEXIST code as fatal, so one of twelve concurrent `truecopy add`s on the
// windows-latest CI leg exited 1 with "EPERM: operation not permitted, open
// …/race.lock.guard" while the other eleven pinned fine (run 35579991225).
// The guard was not lost — it was mid-release — so the right move is to wait
// and retry exactly as for EEXIST.
//
// Two tests. The first injects the codes deterministically through the fs
// module the lock uses (default-import object, so its methods are patchable),
// on every platform. The second is the real thing: six processes hammering one
// guard through updateLock, which on Windows produces EPERM ~1% of the time
// (measured) and must still end with every update applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truecopy-guard-win-'));
process.env.CANON_HOME = path.join(baseDir, 'home');
const { updateLock, readLock } = await import('../src/lock.mjs');

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`a transient ${code} from open(wx) on the guard is contention, not failure`, () => {
    const p = path.join(baseDir, `${code}.lock`);
    const real = fs.openSync;
    let injected = 0;
    // First two attempts on THIS guard fail with the platform's delete-pending
    // code; the third succeeds normally.
    fs.openSync = function (file, flags, ...rest) {
      if (String(file).endsWith(`${code}.lock.guard`) && flags === 'wx' && injected < 2) {
        injected++;
        const err = new Error(`${code}: operation not permitted, open '${file}'`);
        err.code = code;
        throw err;
      }
      return real.call(this, file, flags, ...rest);
    };
    try {
      const out = updateLock(p, (lock) => { lock.skills.a = { ok: true }; return 'applied'; }, { waitMs: 2_000 });
      assert.equal(out, 'applied');
      assert.equal(injected, 2, 'both injected failures were retried through');
      assert.deepEqual(Object.keys(readLock(p).skills), ['a']);
      assert.equal(fs.existsSync(`${p}.guard`), false, 'guard released');
    } finally {
      fs.openSync = real;
    }
  });
}

test('an unrelated open() error still fails loudly', () => {
  const p = path.join(baseDir, 'other.lock');
  const real = fs.openSync;
  fs.openSync = function (file, flags, ...rest) {
    if (String(file).endsWith('other.lock.guard') && flags === 'wx') {
      const err = new Error('ENOSPC: no space left on device'); err.code = 'ENOSPC'; throw err;
    }
    return real.call(this, file, flags, ...rest);
  };
  try {
    assert.throws(() => updateLock(p, () => {}, { waitMs: 500 }), /ENOSPC/);
  } finally {
    fs.openSync = real;
  }
});

test('six processes hammering one guard through updateLock all land their updates', async () => {
  const lock = path.join(baseDir, 'hammer.lock');
  const WORKERS = 6, ROUNDS = 40;
  const worker = path.join(baseDir, 'hammer.mjs');
  fs.writeFileSync(worker, `
    import { updateLock } from ${JSON.stringify(new URL('../src/lock.mjs', import.meta.url).href)};
    const [lock, id, rounds] = process.argv.slice(2);
    for (let r = 0; r < Number(rounds); r++) {
      updateLock(lock, (l) => { l.skills[id + '-' + r] = { r }; });
    }
  `);
  const run = (id) => new Promise((resolve) => {
    const c = spawn(process.execPath, [worker, lock, `w${id}`, String(ROUNDS)], { env: process.env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
  });
  const results = await Promise.all(Array.from({ length: WORKERS }, (_, i) => run(i)));
  for (const r of results) assert.equal(r.code, 0, r.out);
  const keys = Object.keys(readLock(lock).skills);
  assert.equal(keys.length, WORKERS * ROUNDS, `every update must survive — ${WORKERS * ROUNDS - keys.length} lost`);
  assert.equal(fs.existsSync(`${lock}.guard`), false, 'no guard left behind');
});
