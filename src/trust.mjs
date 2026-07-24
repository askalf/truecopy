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
import { loadKey, keyId, normPem } from './sign.mjs';

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

/** Build the active trust set as a Map: normalized PUBLIC KEY → { id, name, publicKey }.
 *  Always includes your own key as `self`, so a locally-signed lock verifies with
 *  no extra trust step.
 *
 *  Keyed on the WHOLE key, not on `keyId`. The id is a 64-bit truncation of
 *  SHA-256 — fine as a human-readable handle, far too narrow to decide trust on:
 *  two distinct keys sharing an id would otherwise be interchangeable here, and
 *  whichever was inserted first would silently shadow the other. */
export function loadTrust({ trustPath, cwd = process.cwd() } = {}) {
  const map = new Map();
  const add = (k) => {
    if (!k || !k.publicKey) return;
    const pem = normPem(k.publicKey);
    const id = keyId(k.publicKey);
    if (!map.has(pem)) map.set(pem, { id, name: k.name || id.slice(0, 12), publicKey: k.publicKey });
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

/** Name of the trusted signer for a public key, or null if its key isn't trusted.
 *
 *  Matches the ENTIRE key. This used to look the key up by `keyId` and return the
 *  name it found without ever comparing the key itself — so anything that hashed
 *  to the same 16 hex chars was accepted as that publisher. 64 bits is not a
 *  trust boundary: grinding a second key to collide with one you already trust is
 *  a birthday search over ~2^32 keypairs, which is hours on one core and minutes
 *  spread out — cheap enough for "a vendor hands you key A, then signs a release
 *  with key B". The full key was already sitting in the entry, unused. */
export function trustedSigner(publicKey, trust) {
  if (!publicKey) return null;
  const entry = trust.get(normPem(publicKey));
  // Public keys are public, so there is no secret here to leak through timing —
  // a plain comparison is the honest primitive. The lookup is exact-keyed, but
  // compare anyway so a caller that builds its own Map cannot reintroduce the
  // truncated-id shortcut.
  if (!entry || normPem(entry.publicKey) !== normPem(publicKey)) return null;
  return entry.name;
}

/** Add a publisher public key to the trust set (global by default, or repo canon.trust). */
export function trustKey(publicKey, name, { repo = false, cwd = process.cwd() } = {}) {
  const file = repo ? resolveRepoTrust(cwd) : homeStore();
  const id = keyId(publicKey);
  if (!id) throw new Error('not a public key');
  const entry = { id, name: name || id.slice(0, 12), publicKey: normPem(publicKey) };
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
