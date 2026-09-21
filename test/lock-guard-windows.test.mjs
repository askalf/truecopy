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
// The flip side, and why the retry window is bounded: EPERM and EACCES ALSO
// mean a permanent ACL/parent-directory denial. Retrying those forever would
// turn a clear "permission denied" into a CLI that hangs on every lock update.
// So the loop tells the two apart by outcome — a delete-pending guard clears in
// milliseconds, a denied path never does — and rethrows the access error at the
// deadline.
//
// Four groups of tests. The injected ones drive the codes deterministically
// through the fs module the lock uses (default-import object, so its methods
// are patchable), on every platform. The last is the real thing: six processes
// hammering one guard through updateLock, which on Windows produces EPERM ~1%
// of the time (measured) and must still end with every update applied.
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

// ---- the permanent-denial side of the same two codes --------------------------

/** Make BOTH open(wx) and stat on `<name>.lock.guard` fail with `code`, the way
 *  an unreadable lock directory does — you cannot create the guard and you
 *  cannot stat it either. Returns a restore function. */
function denyGuard(name, code) {
  const realOpen = fs.openSync, realStat = fs.statSync;
  const deny = (file) => {
    const err = new Error(`${code}: permission denied, '${file}'`);
    err.code = code;
    throw err;
  };
  fs.openSync = function (file, flags, ...rest) {
    if (String(file).endsWith(`${name}.lock.guard`) && flags === 'wx') deny(file);
    return realOpen.call(this, file, flags, ...rest);
  };
  fs.statSync = function (file, ...rest) {
    if (String(file).endsWith(`${name}.lock.guard`)) deny(file);
    return realStat.call(this, file, ...rest);
  };
  return () => { fs.openSync = realOpen; fs.statSync = realStat; };
}

for (const code of ['EACCES', 'EPERM']) {
  test(`a PERMANENT ${code} on the guard path reports the denial instead of looping`, () => {
    // Before the retry window was bounded this spun forever: open(wx) gave
    // ${code} (now "contention"), the stat that follows gave ${code} too,
    // guardAge() swallowed it as null, and `age === null` short-circuited to
    // `continue` ahead of the deadline check. Nothing pinned, nothing timed
    // out, nothing reported — every lock update on an inaccessible path hung.
    const p = path.join(baseDir, `denied-${code}.lock`);
    const restore = denyGuard(`denied-${code}`, code);
    try {
      const started = Date.now();
      // The ORIGINAL access error must surface — not a "another truecopy
      // process is finishing" timeout, which would send the operator hunting a
      // holder that does not exist.
      assert.throws(
        () => updateLock(p, (lock) => { lock.skills.a = { ok: true }; }, { waitMs: 300 }),
        (e) => e.code === code && !/timed out waiting/.test(e.message),
      );
      // Bounded by waitMs, and generously so: the assertion that matters is
      // "terminates at all", and a loose ceiling keeps this off CI's flaky list.
      assert.ok(Date.now() - started < 10_000, 'gave up at the deadline rather than spinning');
      assert.equal(fs.existsSync(p), false, 'nothing written to an inaccessible lock');
    } finally {
      restore();
    }
  });
}

test('a guard that keeps vanishing between open and stat still hits the deadline', () => {
  // The age === null path had the same unbounded shape as the denial above —
  // it `continue`d without ever consulting the deadline. A guard that loses
  // every race (EEXIST on open, gone by the stat) is contention, so a TIMEOUT
  // is the right answer here, but it has to arrive.
  const p = path.join(baseDir, 'vanishing.lock');
  const realOpen = fs.openSync, realStat = fs.statSync;
  fs.openSync = function (file, flags, ...rest) {
    if (String(file).endsWith('vanishing.lock.guard') && flags === 'wx') {
      const err = new Error(`EEXIST: file already exists, open '${file}'`); err.code = 'EEXIST'; throw err;
    }
    return realOpen.call(this, file, flags, ...rest);
  };
  fs.statSync = function (file, ...rest) {
    if (String(file).endsWith('vanishing.lock.guard')) {
      const err = new Error(`ENOENT: no such file or directory, stat '${file}'`); err.code = 'ENOENT'; throw err;
    }
    return realStat.call(this, file, ...rest);
  };
  try {
    const started = Date.now();
    assert.throws(() => updateLock(p, () => {}, { waitMs: 300 }), /timed out waiting/);
    assert.ok(Date.now() - started < 10_000, 'gave up at the deadline rather than spinning');
  } finally {
    fs.openSync = realOpen; fs.statSync = realStat;
  }
});

test('a stat that recovers within the window is still treated as contention', () => {
  // The Windows case this PR exists for: the delete-pending guard fails the
  // stat transiently. That must NOT be mistaken for a permanent denial — the
  // retry window has to survive a few failed stats and then land the update.
  const p = path.join(baseDir, 'flaky-stat.lock');
  const realOpen = fs.openSync, realStat = fs.statSync;
  let openFails = 3, statFails = 3;
  fs.openSync = function (file, flags, ...rest) {
    if (String(file).endsWith('flaky-stat.lock.guard') && flags === 'wx' && openFails > 0) {
      openFails--;
      const err = new Error(`EPERM: operation not permitted, open '${file}'`); err.code = 'EPERM'; throw err;
    }
    return realOpen.call(this, file, flags, ...rest);
  };
  fs.statSync = function (file, ...rest) {
    if (String(file).endsWith('flaky-stat.lock.guard') && statFails > 0) {
      statFails--;
      const err = new Error(`EPERM: operation not permitted, stat '${file}'`); err.code = 'EPERM'; throw err;
    }
    return realStat.call(this, file, ...rest);
  };
  try {
    const out = updateLock(p, (lock) => { lock.skills.a = { ok: true }; return 'applied'; }, { waitMs: 5_000 });
    assert.equal(out, 'applied');
    assert.equal(openFails, 0, 'all injected open failures were retried through');
    assert.equal(statFails, 0, 'all injected stat failures were retried through');
    assert.deepEqual(Object.keys(readLock(p).skills), ['a']);
    assert.equal(fs.existsSync(`${p}.guard`), false, 'guard released');
  } finally {
    fs.openSync = realOpen; fs.statSync = realStat;
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
