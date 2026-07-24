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
 *  Concurrency is a separate, unfixed problem: readLock→mutate→writeLock is not
 *  atomic as a whole, so two `truecopy add` runs racing on the same lock still
 *  end with one entry lost. That needs real locking; this at least guarantees
 *  the file is never left half-written. */
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
