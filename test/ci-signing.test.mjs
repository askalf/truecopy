// CI signing: the private key is injected via CANON_SIGNING_KEY (a secret), the
// public key is derived from it, and signing happens with no local file/keychain —
// so signing moves off developer boxes into CI while identity (keyId) is preserved.
import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKey, ensureKey, signHash, verifyHashSig, keyId } from '../src/sign.mjs';

const genKey = () => crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// A temp home + no real keychain, so the local-key path can't interfere.
function isolate(prefix = 'canon-ci-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.CANON_HOME = home;
  process.env.CANON_NO_KEYCHAIN = '1';
  delete process.env.CANON_SIGNING_KEY;
  return home;
}

test('CANON_SIGNING_KEY (base64) signs without a local key, identity preserved', () => {
  isolate();
  const { publicKey, privateKey } = genKey();
  process.env.CANON_SIGNING_KEY = b64(privateKey);
  try {
    const k = ensureKey();
    assert.ok(k.publicKey && k.privateKey, 'returns a keypair from the env');
    assert.strictEqual(keyId(k.publicKey), keyId(publicKey), 'derived public key has the SAME keyId (identity preserved)');
    assert.strictEqual(keyId(loadKey().publicKey), keyId(publicKey), 'loadKey also serves the env key');

    const sig = signHash('deadbeef');                 // signHash -> ensureKey -> env key
    assert.strictEqual(keyId(sig.pub), keyId(publicKey), 'signature carries the (derived) public key');
    assert.strictEqual(verifyHashSig('deadbeef', sig), true, 'signs + verifies end to end');
  } finally { delete process.env.CANON_SIGNING_KEY; }
});

test('CANON_SIGNING_KEY accepts a raw PEM too (not only base64)', () => {
  isolate();
  const { publicKey, privateKey } = genKey();
  process.env.CANON_SIGNING_KEY = privateKey;        // raw PEM
  try {
    assert.strictEqual(keyId(ensureKey().publicKey), keyId(publicKey));
    const sig = signHash('a1b2');
    assert.strictEqual(verifyHashSig('a1b2', sig), true);
  } finally { delete process.env.CANON_SIGNING_KEY; }
});

test('the env (CI) key takes priority over a local file key and never rewrites it', () => {
  const home = isolate();
  const local = genKey();
  fs.mkdirSync(path.join(home, '.canon'), { recursive: true });
  const keyPath = path.join(home, '.canon', 'signing-key.json');
  fs.writeFileSync(keyPath, JSON.stringify({ publicKey: local.publicKey, privateKey: local.privateKey }));

  const ci = genKey();
  process.env.CANON_SIGNING_KEY = b64(ci.privateKey);
  try {
    const k = ensureKey();
    assert.strictEqual(keyId(k.publicKey), keyId(ci.publicKey), 'uses the env key');
    assert.notStrictEqual(keyId(k.publicKey), keyId(local.publicKey), 'not the local file key');
    assert.strictEqual(JSON.parse(fs.readFileSync(keyPath, 'utf8')).privateKey, local.privateKey,
      'CI mode leaves the local key file untouched (no migration/write)');
  } finally { delete process.env.CANON_SIGNING_KEY; }
});

test('a malformed CANON_SIGNING_KEY falls through to the local key', () => {
  isolate();
  process.env.CANON_SIGNING_KEY = 'not-a-valid-key';
  try {
    assert.strictEqual(loadKey(), null, 'malformed env + no local key -> null, not a bad key');
    const k = ensureKey();                            // falls back to generating a local key
    assert.ok(k.publicKey && k.privateKey, 'falls back to a generated local key');
  } finally { delete process.env.CANON_SIGNING_KEY; }
});
