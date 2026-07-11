// Publisher trust: a signature only counts as vetted-by-a-publisher if its signing
// key is in your trust set. A valid signature from an UNKNOWN key fails closed
// (`untrusted`) rather than passing — that's the whole point of provenance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Isolate the trust store + signing key under a private temp CANON_HOME.
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-trust-'));
process.env.CANON_HOME = path.join(baseDir, 'home');
process.env.CANON_NO_KEYCHAIN = '1'; // never touch the real OS keychain (would clobber a dev's genuine key + race the suite)
import { pin, verify, readLock, writeLock, signHash, keyId, trustKey, untrustKey } from '../src/index.mjs';

const tmp = (n) => path.join(baseDir, n);
const clean = { name: 'fs', tools: [{ name: 'read_file', description: 'Read the contents of a file.' }] };
const write = (p, o) => (fs.writeFileSync(p, JSON.stringify(o)), p);
const genKey = () => crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Pin clean+unsigned, then stamp the entry with a signature from `key`.
function pinSignedBy(tag, key) {
  const lock = tmp(tag + '.lock');
  pin(write(tmp(tag + '.json'), clean), { lockPath: lock, name: 'fs' });
  const l = readLock(lock);
  l.skills.fs.sig = signHash(l.skills.fs.hash, key);
  l.skills.fs.signed = true;
  writeLock(l, lock);
  return lock;
}

test('keyId is a stable 16-char fingerprint, invariant to line-ending differences', () => {
  const k = genKey();
  const id = keyId(k.publicKey);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, keyId(k.publicKey.replace(/\n/g, '\r\n')), 'CRLF vs LF PEM → same key id');
  assert.notEqual(id, keyId(genKey().publicKey), 'a different key → a different id');
});

test('a cryptographically VALID signature from an UNtrusted key is `untrusted` (fails closed)', () => {
  const pub = genKey();
  const lock = pinSignedBy('u', pub);
  const v = verify({ lockPath: lock });
  assert.equal(v.results[0].status, 'untrusted');
  assert.equal(v.results[0].keyId, keyId(pub.publicKey));
  assert.equal(v.ok, false, 'a signature from a key you never trusted must not pass');
});

test('trusting the publisher key flips untrusted → ok (signed by <name>); untrust reverses it', () => {
  const pub = genKey();
  const lock = pinSignedBy('t', pub);
  const t = trustKey(pub.publicKey, 'acme');
  let v = verify({ lockPath: lock });
  assert.equal(v.results[0].status, 'ok');
  assert.equal(v.results[0].signer, 'acme');
  assert.equal(v.ok, true);
  assert.equal(untrustKey(t.id), 1, 'one key removed');
  assert.equal(verify({ lockPath: lock }).results[0].status, 'untrusted', 'untrust returns it to untrusted');
});

test('a repo-committed canon.trust makes a signed lock verify (CI / cross-machine story)', () => {
  const pub = genKey();
  const lock = pinSignedBy('r', pub);
  const trustFile = tmp('canon.trust');
  fs.writeFileSync(trustFile, JSON.stringify({ version: 1, keys: [{ id: keyId(pub.publicKey), name: 'acme', publicKey: pub.publicKey }] }));
  const v = verify({ lockPath: lock, trustPath: trustFile });
  assert.equal(v.results[0].status, 'ok');
  assert.equal(v.results[0].signer, 'acme');
  assert.equal(verify({ lockPath: lock }).results[0].status, 'untrusted', 'without the trust file it is untrusted');
});

test('a locally-signed entry is trusted with no extra step (implicit self key)', () => {
  const lock = tmp('self.lock');
  const r = pin(write(tmp('self.json'), clean), { lockPath: lock, name: 'fs', sign: true });
  assert.equal(r.signed, true);
  const v = verify({ lockPath: lock });
  assert.equal(v.results[0].status, 'ok');
  assert.equal(v.results[0].signer, 'self');
});

test('a signed entry whose signature is stripped is `unsigned`, not `untrusted`', () => {
  const pub = genKey();
  const lock = pinSignedBy('s', pub);
  const l = readLock(lock);
  delete l.skills.fs.sig;            // signed:true remains, but the sig is gone
  writeLock(l, lock);
  assert.equal(verify({ lockPath: lock }).results[0].status, 'unsigned');
});
