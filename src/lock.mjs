// truecopy.lock — the pinned, vetted set. One entry per trusted skill: where it
// came from, the content hash you trusted, the scan verdict at pin time, and
// (optional) a signature. `verify` re-derives the hash and flags any drift from
// this file.
import fs from 'node:fs';
import path from 'node:path';

// The lock filename was `canon.lock` before the rename. New locks are written as
// `truecopy.lock`, but an existing `canon.lock` is still read (see resolveLock)
// so a repo pinned before the rename keeps verifying with zero changes.
export const DEFAULT_LOCK = 'truecopy.lock';
export const LEGACY_LOCK = 'canon.lock';

/** Pick the lock file when the caller didn't pass one explicitly: prefer the
 *  branded `truecopy.lock`, transparently fall back to an existing `canon.lock`,
 *  and default to `truecopy.lock` when neither exists (so fresh pins are branded). */
export function resolveLock(explicit, dir = '.') {
  if (typeof explicit === 'string' && explicit) return explicit;
  for (const name of [DEFAULT_LOCK, LEGACY_LOCK]) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return path.join(dir, DEFAULT_LOCK);
}

// `skills` is ALWAYS a NULL-PROTOTYPE map, on every readLock path — so a skill
// keyed by a prototype member ("__proto__", "toString", "constructor", …) can't
// hijack `[[Set]]`/`[[Get]]`. On a plain object `lock.skills["__proto__"] = entry`
// invokes the __proto__ setter (the entry is silently dropped — pin reports
// success but writes nothing), and `"toString" in lock.skills` is always true
// (unpin "removes" a phantom, and on a fresh lock even CREATES the file). A
// null-proto map makes every key an ordinary own property. Also guards the
// corrupt/hostile `skills: null | array | string` shape (would crash
// Object.entries / index assignment).
const asSkills = (s) =>
  Object.assign(Object.create(null), s && typeof s === 'object' && !Array.isArray(s) ? s : {});
const emptyLock = () => ({ version: 1, skills: asSkills(null) });

// A MISSING lock and a CORRUPT lock are different: an absent lock with
// mustExist=false is a legitimately empty trust set; a present-but-unparseable
// lock (truncated, merge-conflict markers, non-object) must fail CLOSED — never
// silently degrade to "nothing pinned, all clear".
export function readLock(p = DEFAULT_LOCK, { mustExist = false } = {}) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') {
      if (mustExist) { const err = new Error(`no lock file at ${p}`); err.code = 'ELOCKMISSING'; throw err; }
      return emptyLock();
    }
    throw e;
  }
  let l;
  try { l = JSON.parse(raw); }
  catch (e) { const err = new Error(`lock file at ${p} is present but unparseable: ${e.message}`); err.code = 'ELOCKCORRUPT'; throw err; }
  if (!l || typeof l !== 'object' || Array.isArray(l)) { const err = new Error(`lock file at ${p} is not a lock object`); err.code = 'ELOCKCORRUPT'; throw err; }
  return { version: 1, ...l, skills: asSkills(l.skills) };
}

/** Write the lock ATOMICALLY — a temp file in the same directory, then a rename.
 *
 *  A plain writeFileSync truncates first, so an interrupted write (crash, full
 *  disk, Ctrl-C mid-`add --claude` over a few hundred skills) leaves a truncated
 *  lock. readLock fails CLOSED on that, which is the right call and also means
 *  the damage is loud: `verify` refuses, and the Skill hook blocks EVERY pinned
 *  skill until someone restores the file. Rename replaces in one step, so the
 *  lock on disk is always either the old one or the new one.
 *
 *  This makes a single WRITE atomic. Making a whole read-modify-write atomic is
 *  updateLock's job — use that for anything that edits the lock. */
export function writeLock(lock, p = DEFAULT_LOCK) {
  const body = JSON.stringify(lock, null, 2) + '\n';
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, p);            // replaces an existing file on POSIX and Windows alike
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}   // never leave the temp behind on failure
    throw e;
  }
}

// ---- exclusive updates -------------------------------------------------------

const GUARD = (p) => `${p}.guard`;
const GUARD_WAIT_MS = 10_000;   // how long to queue behind another writer before giving up
const GUARD_STALE_MS = 30_000;  // a guard older than this belonged to a process that died

// A real sleep in synchronous code. The whole lock API is sync, and a spin loop
// would burn a core while a concurrent `add` does its work.
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* fall through to a spin */ } };

const guardAge = (g) => { try { return Date.now() - fs.statSync(g).mtimeMs; } catch { return null; } };

/** Take the guard for `p`, or throw if someone else holds it too long.
 *  `wx` is create-if-absent in ONE syscall, which is what makes this a lock and
 *  not another race. */
function acquire(p, { waitMs = GUARD_WAIT_MS, staleMs = GUARD_STALE_MS } = {}) {
  const g = GUARD(p);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(g, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { fs.closeSync(fd); }
      return g;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A process that crashed mid-update would otherwise wedge the lock file
      // forever. Guards are held for milliseconds, so anything this old is dead.
      const age = guardAge(g);
      if (age === null) continue;                       // vanished between open and stat: retry
      if (age > staleMs) { try { fs.unlinkSync(g); } catch {} continue; }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for another truecopy process to finish updating ${p} (holder: ${g}) — delete it if no truecopy is running`);
      }
      sleepSync(20);
    }
  }
}

/** Read the lock, hand it to `mutate`, and write it back — with no other
 *  truecopy process able to interleave.
 *
 *  readLock → mutate → writeLock is three operations, and pin/unpin did them
 *  unguarded. Two `truecopy add` runs against one lock therefore both read the
 *  same state, each added its own entry, and the second write erased the first:
 *  a skill reported as `pinned` that is silently absent from the lock. That is
 *  the worst shape a bug can take here — the CLI says it vetted something, and
 *  the gate that enforces the lock has never heard of it. It is not exotic
 *  either: a CI job pinning while a hook re-pins, two shells, or one
 *  `add --claude` beside an editor task is enough.
 *
 *  Serialized with a guard FILE rather than an in-process mutex, because the
 *  racing writers are separate processes. Atomic writes alone cannot fix this:
 *  they stop a torn file, not a lost update.
 *
 *  `mutate(lock, ctx)` may call `ctx.skip()` to leave the file untouched — an
 *  idempotent no-op must not create a lock that did not exist. Whatever `mutate`
 *  returns is returned to the caller.
 *
 *  NOT reentrant: calling updateLock inside another updateLock on the same path
 *  waits for a guard the same process is holding. Do the reads you need first,
 *  then take it once. Scanning and hashing belong OUTSIDE — the guard should be
 *  held for a file read and a rename, not for a poison scan. */
export function updateLock(p = DEFAULT_LOCK, mutate, opts = {}) {
  const g = acquire(p, opts);
  try {
    const lock = readLock(p);
    let write = true;
    const result = mutate(lock, { skip: () => { write = false; } });
    if (write) writeLock(lock, p);
    return result;
  } finally {
    try { fs.unlinkSync(g); } catch {}
  }
}
