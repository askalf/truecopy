import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Private, randomized temp dir (mkdtemp → mode 0700, unguessable name) so fixture
// writes can't be pre-empted by a symlink planted at a predictable os.tmpdir() path.
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-lockhard-'));
process.env.CANON_HOME = path.join(baseDir, 'home'); // isolate the signing key
process.env.CANON_NO_KEYCHAIN = '1';                 // never touch the real OS keychain
import { pin, unpin, verify, readLock } from '../src/index.mjs';

const tmp = (n) => path.join(baseDir, n);
const write = (p, o) => (fs.writeFileSync(p, JSON.stringify(o)), p);
const manifest = (name) => ({ name, tools: [{ name: 'read_file', description: 'Read the contents of a file.' }] });

// Prototype-member names, the class gate.mjs already hardened for TOOL names — now
// exercised on the LOCK KEY surface (pin/unpin/verify all index into lock.skills).
const PROTO_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

for (const evil of PROTO_NAMES) {
  test(`pin(${evil}) writes a real entry, not a silently-dropped [[Set]]`, () => {
    const lock = tmp(`p-${evil.replace(/\W/g, '')}.lock`);
    const r = pin(write(tmp(`m-${evil.replace(/\W/g, '')}.json`), manifest(evil)), { lockPath: lock, name: evil });
    assert.equal(r.ok, true);
    const skills = readLock(lock).skills;
    // the entry is actually present and hashed — operator's "pinned" is truthful
    assert.ok(Object.hasOwn(skills, evil), `${evil} is an own key in the lock`);
    assert.equal(skills[evil].hash.length, 64);
    // and it round-trips through the on-disk JSON
    const raw = JSON.parse(fs.readFileSync(lock, 'utf8'));
    assert.ok(evil in raw.skills || Object.hasOwn(raw.skills, evil));
    // verify sees it and it is NOT a prototype-pollution vector
    assert.equal(verify({ lockPath: lock }).results.some((x) => x.name === evil), true);
    assert.equal(({}).polluted, undefined);
  });
}

test('unpin(prototype-name) on a missing lock is a no-op — returns 0 and creates no file', () => {
  const missing = tmp('never.lock');
  for (const evil of PROTO_NAMES) assert.equal(unpin(evil, { lockPath: missing }), 0, `${evil} matched a phantom`);
  assert.ok(!fs.existsSync(missing), 'no-op removal must not create a lock');
});

test('unpin(prototype-name) removes only a really-present entry', () => {
  const lock = tmp('u.lock');
  pin(write(tmp('u.json'), manifest('__proto__')), { lockPath: lock, name: '__proto__' });
  assert.equal(unpin('toString', { lockPath: lock }), 0, 'a non-present prototype name is not removed');
  assert.equal(unpin('__proto__', { lockPath: lock }), 1);
  assert.deepEqual(Object.keys(readLock(lock).skills), []);
});

test('verify does not throw on a hostile parts:null entry — reports drifted, fails closed', () => {
  const lock = tmp('null.lock');
  const src = write(tmp('null.json'), manifest('fs'));
  fs.writeFileSync(lock, JSON.stringify({ version: 1, skills: { fs: { source: src, kind: 'mcp', hash: '0'.repeat(64), verdict: 'clean', parts: null } } }));
  let v;
  assert.doesNotThrow(() => { v = verify({ lockPath: lock }); });
  assert.equal(v.ok, false);
  assert.equal(v.results[0].status, 'drifted');
});
