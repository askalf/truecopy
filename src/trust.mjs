// The trust set — WHOSE signatures canon accepts. A signed lock entry only counts
// as vetted-by-a-publisher if its signing key is in this set. Three sources, unioned:
//   - your machine's own key (implicit, named `self`)  → local `--sign` just works
//   - a repo-committed `canon.trust`                   → travels with the repo, so a
//                                                         signed lock verifies in CI
//   - a user-global `~/.canon/trust.json`              → keys you trust everywhere
// `canon.trust` is the one that matters for sharing: commit it and a teammate's /
// CI's `canon verify` knows which publisher key to expect.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKey, keyId } from './sign.mjs';

// The repo-committed trust file was `canon.trust` before the rename. New writes
// go to `truecopy.trust`, but an existing `canon.trust` is still read and written
// (see resolveRepoTrust) for back-compat. The private global store stays at
// `~/.canon/trust.json` / `$CANON_HOME` — an internal path kept stable so a
// user's existing trust decisions aren't lost by the rename.
export const DEFAULT_REPO_TRUST = 'truecopy.trust';
export const LEGACY_REPO_TRUST = 'canon.trust';
const homeStore = () => path.join(process.env.CANON_HOME || os.homedir(), '.canon', 'trust.json');

/** The repo trust file to read/write: prefer branded `truecopy.trust`, fall back
 *  to an existing `canon.trust`, default to `truecopy.trust`. */
export function resolveRepoTrust(cwd = process.cwd()) {
  for (const name of [DEFAULT_REPO_TRUST, LEGACY_REPO_TRUST]) {
    const p = path.join(cwd, name);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return path.join(cwd, DEFAULT_REPO_TRUST);
}

function readStore(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j?.keys) ? j.keys : []; }
  catch { return []; }
}
function writeStore(file, keys, repo) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // global store is private (it's your trust decisions); a repo canon.trust is meant
  // to be committed, so don't lock it down to 0600.
  fs.writeFileSync(file, JSON.stringify({ version: 1, keys }, null, 2) + '\n', repo ? undefined : { mode: 0o600 });
}

/** Build the active trust set as a Map: keyId → { id, name, publicKey }.
 *  Always includes your own key as `self`, so a locally-signed lock verifies with
 *  no extra trust step. */
export function loadTrust({ trustPath, cwd = process.cwd() } = {}) {
  const map = new Map();
  const add = (k) => {
    if (!k || !k.publicKey) return;
    const id = keyId(k.publicKey);
    if (!map.has(id)) map.set(id, { id, name: k.name || id.slice(0, 12), publicKey: k.publicKey });
  };
  // self = the machine's PERSISTENT local key only — NOT a CANON_SIGNING_KEY env
  // key. A CI signing key signs; it isn't auto-trusted at verify time (that would
  // let env-var injection into a verify process mint a trusted signer). Its public
  // key belongs in canon.trust if you want to verify what it signed.
  const self = loadKey({ envAllowed: false }); if (self) add({ name: 'self', publicKey: self.publicKey });
  for (const k of readStore(homeStore())) add(k);
  for (const k of readStore(trustPath || resolveRepoTrust(cwd))) add(k);
  return map;
}

/** Name of the trusted signer for a public key, or null if its key isn't trusted. */
export function trustedSigner(publicKey, trust) {
  if (!publicKey) return null;
  const entry = trust.get(keyId(publicKey));
  return entry ? entry.name : null;
}

/** Add a publisher public key to the trust set (global by default, or repo canon.trust). */
export function trustKey(publicKey, name, { repo = false, cwd = process.cwd() } = {}) {
  const file = repo ? resolveRepoTrust(cwd) : homeStore();
  const id = keyId(publicKey);
  if (!id) throw new Error('not a public key');
  const entry = { id, name: name || id.slice(0, 12), publicKey: String(publicKey).replace(/\r\n/g, '\n').trim() };
  const keys = readStore(file).filter((k) => keyId(k.publicKey) !== id);
  keys.push(entry);
  writeStore(file, keys, repo);
  return entry;
}

const MIN_UNTRUST_PREFIX = 8;

/** Remove a trusted key by exact id or id-prefix (global store). → count removed.
 *
 *  Guarded, because the prefix match is greedy and this store is the thing that
 *  decides whose signatures count. `''.startsWith(x)` is true for every key, so
 *  `truecopy trust remove ""` silently emptied the entire trust set and cheerfully
 *  reported "removed 2 key(s)" — every publisher you had vetted, gone, and the
 *  next `verify --require-signed` failing for reasons that look nothing like the
 *  cause. A short prefix did the same thing more quietly, to whichever keys
 *  happened to share it.
 *
 *  So: at least 8 characters, and an ambiguous prefix is refused rather than
 *  applied — unless `all` says that was the intent. Removing the WRONG key is
 *  not a safe default in either direction, so this errors instead of guessing. */
export function untrustKey(idOrPrefix, { cwd = process.cwd(), all = false } = {}) {
  const prefix = String(idOrPrefix ?? '');
  if (prefix.length < MIN_UNTRUST_PREFIX) {
    throw new Error(`refusing to match trusted keys on '${prefix}' — give at least ${MIN_UNTRUST_PREFIX} characters of the key id (truecopy trust list)`);
  }
  const file = homeStore();
  const keys = readStore(file);
  const matches = (k) => k.id === prefix || (k.id || keyId(k.publicKey)).startsWith(prefix);
  const hit = keys.filter(matches);
  if (hit.length > 1 && !all) {
    throw new Error(`'${prefix}' matches ${hit.length} trusted keys (${hit.map((k) => k.name || k.id).join(', ')}) — use the full id, or --all to remove them together`);
  }
  if (!hit.length) return 0;
  writeStore(file, keys.filter((k) => !matches(k)), false);
  return hit.length;
}

/** The flattened trust set (incl. implicit `self`), for display. */
export function listTrust(opts) {
  return [...loadTrust(opts).values()];
}
