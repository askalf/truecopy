import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-reqsig-'));
process.env.CANON_HOME = path.join(baseDir, 'home'); // isolate the signing key + trust store
process.env.CANON_NO_KEYCHAIN = '1';                 // never touch the real OS keychain
import { pin, verify, loadSkill, skillHash, partsOf } from '../src/index.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const tmp = (n) => path.join(baseDir, n);
const write = (p, o) => (fs.writeFileSync(p, JSON.stringify(o)), p);
const manifest = (name, extra = []) => ({ name, tools: [{ name: 'read_file', description: 'Read a file.' }, ...extra] });
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: baseDir, encoding: 'utf8', env: process.env });

test('verify --require-signed: an unsigned-but-clean entry FAILS (default still passes it)', () => {
  const lock = tmp('u.lock');
  pin(write(tmp('u.json'), manifest('fs')), { lockPath: lock }); // no --sign
  assert.equal(verify({ lockPath: lock }).ok, true, 'default: unsigned clean entry is ok');
  const v = verify({ lockPath: lock, requireSigned: true });
  assert.equal(v.ok, false);
  assert.equal(v.results[0].status, 'unsigned');
  assert.equal(v.results[0].requiredSignature, true);
});

test('verify --require-signed: a trusted-signed entry passes', () => {
  const lock = tmp('s.lock');
  pin(write(tmp('s.json'), manifest('fs')), { lockPath: lock, sign: true }); // signed by self (implicitly trusted)
  const v = verify({ lockPath: lock, requireSigned: true });
  assert.equal(v.ok, true);
  assert.equal(v.results[0].status, 'ok');
  assert.equal(v.results[0].signed, true);
});

test('the downgrade attack: strip signature + swap bytes → plain verify passes, --require-signed catches it', () => {
  const lock = tmp('d.lock');
  const legit = write(tmp('legit.json'), manifest('fs'));
  pin(legit, { lockPath: lock, sign: true });
  // attacker rewrites the entry: drop sig+signed, point at DIFFERENT clean bytes, fix hash/parts
  const evil = write(tmp('evil.json'), manifest('fs', [{ name: 'sync_all', description: 'Sync everything to the cloud.' }]));
  const l = JSON.parse(fs.readFileSync(lock, 'utf8'));
  const e = l.skills.fs;
  delete e.sig; delete e.signed;
  e.source = evil; e.verdict = 'clean';
  const sk = loadSkill(evil); e.hash = skillHash(sk); e.parts = partsOf(sk);
  fs.writeFileSync(lock, JSON.stringify(l));
  assert.equal(verify({ lockPath: lock }).ok, true, 'plain verify is fooled (the vulnerability)');
  assert.equal(verify({ lockPath: lock, requireSigned: true }).ok, false, '--require-signed rejects the unsigned substitute');
});

test('CLI: verify/guard honor --require-signed (exit codes)', () => {
  const lock = tmp('c.lock');
  pin(write(tmp('c.json'), manifest('fs')), { lockPath: lock }); // unsigned
  assert.equal(cli(['verify', '--lock', lock]).status, 0, 'default passes');
  const v = cli(['verify', '--require-signed', '--lock', lock]);
  assert.equal(v.status, 1);
  assert.match(v.stdout, /no trusted signature/);
  // guard refuses to launch under --require-signed
  const g = cli(['guard', '--require-signed', '--lock', lock, '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(g.status, 1);
  assert.match(g.stdout, /refusing to launch/);
  // ...and a signed lock lets guard run the command
  const slock = tmp('cs.lock');
  pin(write(tmp('cs.json'), manifest('fs')), { lockPath: slock, sign: true });
  const g2 = cli(['guard', '--require-signed', '--lock', slock, '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(g2.status, 0);
});
