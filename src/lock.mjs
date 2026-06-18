// canon.lock — the pinned, vetted set. One entry per trusted skill: where it came
// from, the content hash you trusted, the scan verdict at pin time, and (optional)
// a signature. `verify` re-derives the hash and flags any drift from this file.
import fs from 'node:fs';

export const DEFAULT_LOCK = 'canon.lock';

// A MISSING lock and a CORRUPT lock are different: an absent lock with
// mustExist=false is a legitimately empty trust set; a present-but-unparseable
// lock (truncated, merge-conflict markers, non-object) must fail CLOSED — never
// silently degrade to "nothing pinned, all clear".
export function readLock(p = DEFAULT_LOCK, { mustExist = false } = {}) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') {
      if (mustExist) { const err = new Error(`no canon.lock at ${p}`); err.code = 'ELOCKMISSING'; throw err; }
      return { version: 1, skills: {} };
    }
    throw e;
  }
  let l;
  try { l = JSON.parse(raw); }
  catch (e) { const err = new Error(`canon.lock at ${p} is present but unparseable: ${e.message}`); err.code = 'ELOCKCORRUPT'; throw err; }
  if (!l || typeof l !== 'object' || Array.isArray(l)) { const err = new Error(`canon.lock at ${p} is not a lock object`); err.code = 'ELOCKCORRUPT'; throw err; }
  // Guarantee `skills` is a plain object — a corrupt/hostile lock with
  // `skills: null` (or an array/string) would otherwise crash verify()'s
  // Object.entries and pin()'s index assignment.
  const skills = l.skills && typeof l.skills === 'object' && !Array.isArray(l.skills) ? l.skills : {};
  return { version: 1, ...l, skills };
}

export function writeLock(lock, p = DEFAULT_LOCK) {
  fs.writeFileSync(p, JSON.stringify(lock, null, 2) + '\n');
}
