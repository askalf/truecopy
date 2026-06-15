// Optional local attestation. `--sign` stamps a pinned entry with an Ed25519
// signature over its content hash, using a key in ~/.canon (0600). It's a
// tamper-stamp, not a PKI root: it proves THIS machine's key signed the pinned
// hash, so editing a hash in canon.lock without the key is detectable on verify.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Resolved at call time (not import) so CANON_HOME can be set per-test/per-run.
const keyFile = () => path.join(process.env.CANON_HOME || os.homedir(), '.canon', 'signing-key.json');

export function ensureKey() {
  const file = keyFile();
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ publicKey, privateKey }), { mode: 0o600 });
  return { publicKey, privateKey };
}

/** Sign a content hash → { alg, pub, val }. */
export function signHash(hash) {
  const { publicKey, privateKey } = ensureKey();
  const val = crypto.sign(null, Buffer.from(hash), privateKey).toString('base64');
  return { alg: 'ed25519', pub: publicKey, val };
}

/** Verify a signature object against a hash. Pins to the local key by default,
 *  so only entries signed by THIS machine's key are accepted. */
export function verifyHashSig(hash, sig, { pinLocal = true } = {}) {
  if (!sig || sig.alg !== 'ed25519' || !sig.val) return false;
  let pub = sig.pub;
  if (pinLocal) {
    try { pub = ensureKey().publicKey; } catch { return false; }
    if (sig.pub && sig.pub.trim() !== pub.trim()) return false; // signed by a different key
  }
  try { return crypto.verify(null, Buffer.from(hash), pub, Buffer.from(sig.val, 'base64')); }
  catch { return false; }
}
