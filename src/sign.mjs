// Ed25519 attestation. `--sign` stamps a pinned entry with a signature over its
// content hash. WHO signed it is identified by the public key embedded in the
// signature; WHETHER you accept that signer is a separate decision — the trust set
// (see trust.mjs). Your machine's own key (in ~/.canon) is implicitly trusted, so a
// local `--sign` round-trips with no extra step; a publisher you trust signs with
// THEIR key and you add it once via `canon trust add`.
//
// The PRIVATE key is held in the OS keychain (keychain.mjs) — never written as
// plaintext — when one is available; only the PUBLIC key lives in signing-key.json
// (public is not secret). Hosts with no keychain fall back to a 0600 plaintext file,
// and a pre-keychain plaintext key is migrated into the keychain on first sign. In CI,
// set CANON_SIGNING_KEY (the private key) to sign without any local key at all —
// signing moves off developer boxes into CI, and everyone else only `verify`s.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keychainAvailable, keychainGet, keychainSet } from './keychain.mjs';

// Resolved at call time (not import) so CANON_HOME can be set per-test/per-run.
const keyFile = () => path.join(process.env.CANON_HOME || os.homedir(), '.canon', 'signing-key.json');

// PEM bytes can differ only by line endings (CRLF on Windows, a trailing newline
// from a file read) yet be the same key — normalize before hashing/verifying so a
// key's identity is stable across platforms.
const normPem = (p) => String(p).replace(/\r\n/g, '\n').trim();
const enc64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const dec64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// A signing key injected via the environment — CI mode. CANON_SIGNING_KEY holds the
// PRIVATE key (base64-encoded PEM, or a raw PEM); the PUBLIC key is DERIVED from it,
// so the CI secret is just the private half and signing needs no file or keychain.
// Read-only: never writes to disk/keychain (CI runners are ephemeral). Takes priority
// over the local key, so `canon … --sign` in CI signs with this identity. Because the
// public key is derived, a key minted locally and exported here keeps the same keyId.
function envKey() {
  const raw = process.env.CANON_SIGNING_KEY;
  if (!raw) return null;
  try {
    const privateKey = raw.includes('-----BEGIN') ? raw : dec64(raw);
    const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    return { publicKey, privateKey };
  } catch {
    return null;                                             // malformed → fall through to the local key
  }
}

/** A stable short fingerprint for a public key — how the trust set addresses it. */
export function keyId(publicKey) {
  if (!publicKey) return '';
  return crypto.createHash('sha256').update(normPem(publicKey)).digest('hex').slice(0, 16);
}

// The file half of the key record: { publicKey } (+ a legacy plaintext privateKey on
// pre-keychain installs). Null when there's no key file at all.
const readFile = () => { try { return JSON.parse(fs.readFileSync(keyFile(), 'utf8')); } catch { return null; } };

/** The local key if it already exists, else null — never generates one (so a
 *  read-only path like `verify` building its trust set can't create key material).
 *  The private half comes from the OS keychain; a legacy plaintext private in the
 *  file is honored as a fallback so existing installs keep working pre-migration.
 *
 *  `envAllowed:false` skips the CANON_SIGNING_KEY env key and returns ONLY the
 *  machine's persistent local identity. The trust set uses this: the CI signing
 *  key is for signing, not for auto-trusting — folding it into the verify-time
 *  trust set as `self` would let anyone who can inject that env var into a verify
 *  process become a trusted signer. (Commit its public key to canon.trust to
 *  verify a lock it signed — the documented flow.) */
export function loadKey({ envAllowed = true } = {}) {
  if (envAllowed) { const env = envKey(); if (env) return env; } // CI: key from CANON_SIGNING_KEY
  const file = readFile();
  if (!file || !file.publicKey) return file;                 // no key (or unreadable)
  if (keychainAvailable()) {
    const stored = keychainGet();
    if (stored) return { publicKey: file.publicKey, privateKey: dec64(stored) };
  }
  // keychain empty/unavailable → honor a legacy plaintext private if present.
  return file.privateKey ? { publicKey: file.publicKey, privateKey: file.privateKey } : { publicKey: file.publicKey };
}

export function ensureKey() {
  const env = envKey();
  if (env) return env;                                       // CI: sign with the injected key; never generate/migrate
  const file = keyFile();
  const existing = readFile();
  if (existing && existing.publicKey) {
    // Migrate a legacy plaintext private key into the keychain, then strip it from
    // the file. Same keypair → canon's identity is preserved. One-time, on first
    // sign after the upgrade.
    if (existing.privateKey && keychainAvailable()) {
      keychainSet(enc64(existing.privateKey));
      fs.writeFileSync(file, JSON.stringify({ publicKey: existing.publicKey }), { mode: 0o600 });
    }
    return loadKey();
  }
  // Generate a fresh keypair.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (keychainAvailable()) {
    keychainSet(enc64(privateKey));
    fs.writeFileSync(file, JSON.stringify({ publicKey }), { mode: 0o600 });
  } else {
    fs.writeFileSync(file, JSON.stringify({ publicKey, privateKey }), { mode: 0o600 });
  }
  return { publicKey, privateKey };
}

/** Sign a content hash → { alg, pub, val }. Signs with the local key by default;
 *  pass a { publicKey, privateKey } to sign as a specific publisher. */
export function signHash(hash, key) {
  const { publicKey, privateKey } = key || ensureKey();
  const val = crypto.sign(null, Buffer.from(hash), privateKey).toString('base64');
  return { alg: 'ed25519', pub: publicKey, val };
}

/** Cryptographically verify a signature object against a hash, using the public key
 *  embedded in the signature. This proves the bytes were signed by whoever holds
 *  that key — NOT that you trust that key. Trust (key ∈ your trust set) is a
 *  separate gate, in trust.mjs, so a valid signature from an unknown key still
 *  surfaces as `untrusted` rather than silently passing. */
export function verifyHashSig(hash, sig) {
  if (!sig || sig.alg !== 'ed25519' || !sig.val || !sig.pub) return false;
  try { return crypto.verify(null, Buffer.from(hash), normPem(sig.pub), Buffer.from(sig.val, 'base64')); }
  catch { return false; }
}
