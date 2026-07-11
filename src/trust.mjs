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

export const DEFAULT_REPO_TRUST = 'canon.trust';
const homeStore = () => path.join(process.env.CANON_HOME || os.homedir(), '.canon', 'trust.json');

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
  for (const k of readStore(trustPath || path.join(cwd, DEFAULT_REPO_TRUST))) add(k);
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
  const file = repo ? path.join(cwd, DEFAULT_REPO_TRUST) : homeStore();
  const id = keyId(publicKey);
  if (!id) throw new Error('not a public key');
  const entry = { id, name: name || id.slice(0, 12), publicKey: String(publicKey).replace(/\r\n/g, '\n').trim() };
  const keys = readStore(file).filter((k) => keyId(k.publicKey) !== id);
  keys.push(entry);
  writeStore(file, keys, repo);
  return entry;
}

/** Remove a trusted key by exact id or id-prefix (global store). → count removed. */
export function untrustKey(idOrPrefix, { cwd = process.cwd() } = {}) {
  const file = homeStore();
  const keys = readStore(file);
  const kept = keys.filter((k) => !(k.id === idOrPrefix || (k.id || keyId(k.publicKey)).startsWith(idOrPrefix)));
  if (kept.length !== keys.length) writeStore(file, kept, false);
  return keys.length - kept.length;
}

/** The flattened trust set (incl. implicit `self`), for display. */
export function listTrust(opts) {
  return [...loadTrust(opts).values()];
}
