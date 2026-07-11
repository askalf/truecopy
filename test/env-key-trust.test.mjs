import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pin, verify, trustKey } from '../src/index.mjs';

const genKey = () => crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const manifest = (name) => ({ name, tools: [{ name: 'read_file', description: 'Read a file.' }] });

function isolate() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-envtrust-'));
  process.env.CANON_HOME = home;
  process.env.CANON_NO_KEYCHAIN = '1';
  delete process.env.CANON_SIGNING_KEY;
  return home;
}
const write = (home, o) => { const p = path.join(home, 'm.json'); fs.writeFileSync(p, JSON.stringify(o)); return p; };

test('CANON_SIGNING_KEY signs but is NOT auto-trusted as self — an env-signed lock is untrusted', () => {
  const home = isolate();
  const ci = genKey();
  process.env.CANON_SIGNING_KEY = b64(ci.privateKey);
  try {
    const lock = path.join(home, 'e.lock');
    pin(write(home, manifest('fs')), { lockPath: lock, sign: true }); // signed by the env key
    const v = verify({ lockPath: lock });
    assert.equal(v.ok, false, 'the CI signing key is not implicitly trusted at verify time');
    assert.equal(v.results[0].status, 'untrusted');
  } finally { delete process.env.CANON_SIGNING_KEY; }
});

test('the documented flow works: commit the CI pubkey to the trust set → env-signed lock verifies', () => {
  const home = isolate();
  const ci = genKey();
  process.env.CANON_SIGNING_KEY = b64(ci.privateKey);
  try {
    const lock = path.join(home, 't.lock');
    pin(write(home, manifest('fs')), { lockPath: lock, sign: true });
    trustKey(ci.publicKey, 'ci-publisher'); // add the CI pubkey to the (isolated) trust store
    const v = verify({ lockPath: lock });
    assert.equal(v.ok, true);
    assert.equal(v.results[0].status, 'ok');
    assert.equal(v.results[0].signer, 'ci-publisher');
  } finally { delete process.env.CANON_SIGNING_KEY; }
});

test('a LOCAL machine key still self-trusts — plain `--sign` round-trips with no env, no extra step', () => {
  const home = isolate(); // no CANON_SIGNING_KEY
  const lock = path.join(home, 'l.lock');
  pin(write(home, manifest('fs')), { lockPath: lock, sign: true }); // signs with a generated local key
  const v = verify({ lockPath: lock });
  assert.equal(v.ok, true, 'local self-signing still verifies with no extra trust step');
  assert.equal(v.results[0].signer, 'self');
});
