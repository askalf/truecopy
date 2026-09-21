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

// The guard's mtime, or `age: null` when it vanished between our open and this
// stat (ENOENT — a raced-away guard, which simply means try again).
//
// Any OTHER stat failure is reported as `error` rather than swallowed. It used
// to come back as null too, and that conflated two very different situations:
// a guard that raced away, and a lock path we cannot reach AT ALL. An
// inaccessible lock directory answers open(wx) with EACCES *and* stat with
// EACCES, so the retry loop treated a permanent denial as contention and spun
// on it forever — never pinning, never timing out, never saying "permission
// denied". acquire() decides what to do with it.
const guardAge = (g) => {
  try { return { age: Date.now() - fs.statSync(g).mtimeMs }; }
  catch (e) { return e && e.code === 'ENOENT' ? { age: null } : { error: e }; }
};

// "Someone else holds the guard" is EEXIST on every platform. On Windows it is
// ALSO EPERM (and, on some filesystems, EACCES / EBUSY) for the few
// microseconds a guard sits in the delete-pending state while its holder is
// unlinking it: `open(wx)` collides with the unlink and comes back "not
// permitted" instead of "exists". Measured on Windows 11 / Node 22: six
// processes hammering one guard saw EPERM on ~1% of attempts. Treating only
// EEXIST as contention made that 1% a hard failure — one of twelve concurrent
// `truecopy add`s exited 1 on the windows-latest CI leg while the other eleven
// pinned fine, and the lock was correct. The guard is not lost, it is
// mid-release; the right move is the same as for EEXIST: wait and retry.
//
// EPERM and EACCES are genuinely ambiguous, though: the same two codes also
// mean a permanent ACL or parent-directory denial. The retry loop below tells
// them apart by OUTCOME rather than by code — a mid-release guard clears within
// milliseconds, a denied path never does — so a permanent denial is bounded by
// the same deadline as any other wait and then thrown.
const GUARD_CONTENTION = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

/** Take the guard for `p`, or throw if someone else holds it too long.
 *  `wx` is create-if-absent in ONE syscall, which is what makes this a lock and
 *  not another race. */
function acquire(p, { waitMs = GUARD_WAIT_MS, staleMs = GUARD_STALE_MS } = {}) {
  const g = GUARD(p);
  const deadline = Date.now() + waitMs;
  const timedOutError = () =>
    new Error(`timed out waiting for another truecopy process to finish updating ${p} (holder: ${g}) — delete it if no truecopy is running`);
  for (;;) {
    try {
      const fd = fs.openSync(g, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { fs.closeSync(fd); }
      return g;
    } catch (e) {
      if (!GUARD_CONTENTION.has(e.code)) throw e;
      // A process that crashed mid-update would otherwise wedge the lock file
      // forever. Guards are held for milliseconds, so anything this old is dead.
      const { age, error } = guardAge(g);
      const timedOut = Date.now() > deadline;
      if (error) {
        // Not a guard we can see. Windows can fail the stat transiently on a
        // delete-pending guard, so this still gets the normal retry window —
        // but when the window closes, the access error itself is the honest
        // answer, not a "another process is holding it" timeout and certainly
        // not an endless loop.
        if (timedOut) throw error;
      } else if (age === null) {
        if (!timedOut) continue;                        // vanished between open and stat: retry
        throw timedOutError();
      } else if (age > staleMs) {
        // Reaping a stale guard is the one path that can loop without ever
        // sleeping, so it needs the same deadline as the others. A directory
        // ACL can permit stat while denying unlink — a permanent denial then
        // reads as "stale guard I keep failing to delete", and an
        // unconditional `continue` would spin on it at full speed instead of
        // eventually reporting the access error.
        try { fs.unlinkSync(g); continue; }
        catch (unlinkError) { if (timedOut) throw unlinkError; }
      } else if (timedOut) throw timedOutError();
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
