// Trust is decided on the WHOLE public key.
//
// It used to be decided on `keyId` — the first 16 hex chars of SHA-256 over the
// PEM. trustedSigner() looked the id up in the trust set and returned whatever
// name it found, without ever comparing the key. 64 bits is not a trust
// boundary: grinding a second keypair that collides with one you already trust
// is a birthday search over ~2^32 keys — hours on a core, minutes spread out —
// which makes "a vendor hands you key A, then signs a release with key B" a
// practical attack rather than a theoretical one. The full key was already in
// the entry, unused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-trust-identity-'));
process.env.CANON_HOME = path.join(baseDir, 'home');
process.env.CANON_NO_KEYCHAIN = '1';
const { loadTrust, trustedSigner, trustKey, listTrust } = await import('../src/trust.mjs');
const { keyId, signHash, verifyHashSig } = await import('../src/sign.mjs');

const kp = () => crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const acme = kp(), attacker = kp();

test('a trust entry whose id matches but whose key differs is NOT a signer', () => {
  // The shape a keyId collision produces: the attacker's key indexes the entry,
  // the trusted publisher's key is what the entry holds. Under the old
  // id-keyed lookup this returned "acme-publisher" — a forged release verifying
  // as a trusted vendor. Grinding the real collision is the attacker's problem,
  // not the test's; what is asserted here is that finding an entry is not
  // sufficient to be its signer.
  const collided = new Map([[
    normalize(attacker.publicKey),
    { id: keyId(acme.publicKey), name: 'acme-publisher', publicKey: acme.publicKey },
  ]]);
  assert.equal(trustedSigner(attacker.publicKey, collided), null);
  // The genuine key still resolves through an honestly-built set.
  const real = new Map([[normalize(acme.publicKey), { id: keyId(acme.publicKey), name: 'acme-publisher', publicKey: acme.publicKey }]]);
  assert.equal(trustedSigner(acme.publicKey, real), 'acme-publisher');
});

// The normalization the trust set keys on — mirrored here so the test would
// notice if the two ever drifted apart.
function normalize(pem) { return String(pem).replace(/\r\n/g, '\n').trim(); }

test('a trust file that lies about a key id is resolved by the real key', () => {
  const file = path.join(baseDir, 'lying.trust');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    keys: [{ id: keyId(acme.publicKey), name: 'acme-publisher', publicKey: attacker.publicKey }],
  }));
  const trust = loadTrust({ trustPath: file, cwd: baseDir });
  // The stored id is display metadata; identity is recomputed from the key.
  assert.equal(trustedSigner(acme.publicKey, trust), null, 'the claimed id must not confer the claimed identity');
  assert.equal(trustedSigner(attacker.publicKey, trust), 'acme-publisher', 'the key actually stored is the one that resolves');
  assert.equal([...trust.values()][0].id, keyId(attacker.publicKey), 'the id is recomputed, not taken from the file');
});

test('normal trust still works: a signature from a trusted publisher verifies', () => {
  const file = path.join(baseDir, 'good.trust');
  fs.writeFileSync(file, JSON.stringify({ version: 1, keys: [] }));
  trustKey(acme.publicKey, 'acme-publisher', { repo: true, cwd: baseDir });

  const hash = 'a'.repeat(64);
  const sig = signHash(hash, acme);
  assert.ok(verifyHashSig(hash, sig), 'signature is cryptographically valid');

  const trust = loadTrust({ cwd: baseDir });
  assert.equal(trustedSigner(sig.pub, trust), 'acme-publisher');
  assert.equal(trustedSigner(attacker.publicKey, trust), null, 'an unrelated key is still untrusted');
});

test('two distinct keys both stay in the trust set', () => {
  // Under an id-keyed map a collision meant the second key was silently dropped
  // — a denial of trust to a key its owner had explicitly added.
  trustKey(attacker.publicKey, 'globex', { repo: true, cwd: baseDir });
  const names = listTrust({ cwd: baseDir }).map((k) => k.name).sort();
  assert.deepEqual(names.filter((n) => n === 'acme-publisher' || n === 'globex'), ['acme-publisher', 'globex']);
});

test('an empty or malformed key is never a signer', () => {
  const trust = loadTrust({ cwd: baseDir });
  for (const bad of [null, undefined, '', 0, false]) assert.equal(trustedSigner(bad, trust), null);
});
