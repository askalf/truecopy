// canon.lock — the pinned, vetted set. One entry per trusted skill: where it came
// from, the content hash you trusted, the scan verdict at pin time, and (optional)
// a signature. `verify` re-derives the hash and flags any drift from this file.
import fs from 'node:fs';

export const DEFAULT_LOCK = 'canon.lock';

export function readLock(p = DEFAULT_LOCK) {
  try {
    const l = JSON.parse(fs.readFileSync(p, 'utf8'));
    return l && typeof l === 'object' ? { version: 1, skills: {}, ...l } : { version: 1, skills: {} };
  } catch {
    return { version: 1, skills: {} };
  }
}

export function writeLock(lock, p = DEFAULT_LOCK) {
  fs.writeFileSync(p, JSON.stringify(lock, null, 2) + '\n');
}
