// The lock rename: new pins write truecopy.lock, but an existing canon.lock is
// transparently read so a repo pinned before the rename keeps verifying with no
// change. resolveLock() is the single chokepoint the CLI + library share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLock, DEFAULT_LOCK, LEGACY_LOCK } from '../src/lock.mjs';
import { pin, verify } from '../src/index.mjs';

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lockresolve-'));

test('the rename constants are truecopy.lock (new) with canon.lock legacy', () => {
  assert.equal(DEFAULT_LOCK, 'truecopy.lock');
  assert.equal(LEGACY_LOCK, 'canon.lock');
});

test('resolveLock: an explicit --lock always wins', () => {
  assert.equal(resolveLock('custom.lock', mkdir()), 'custom.lock');
});

test('resolveLock: prefers truecopy.lock when both exist', () => {
  const d = mkdir();
  fs.writeFileSync(path.join(d, 'truecopy.lock'), '{}');
  fs.writeFileSync(path.join(d, 'canon.lock'), '{}');
  assert.equal(resolveLock(null, d), path.join(d, 'truecopy.lock'));
});

test('resolveLock: falls back to an existing canon.lock (pre-rename repo)', () => {
  const d = mkdir();
  fs.writeFileSync(path.join(d, 'canon.lock'), '{}');
  assert.equal(resolveLock(null, d), path.join(d, 'canon.lock'));
});

test('resolveLock: defaults to truecopy.lock when neither exists (fresh repo)', () => {
  const d = mkdir();
  assert.equal(resolveLock(null, d), path.join(d, 'truecopy.lock'));
});

test('end to end: a fresh pin writes truecopy.lock; an existing canon.lock is still used', () => {
  const cwd0 = process.cwd();
  // fresh dir → new pin lands in truecopy.lock
  const fresh = mkdir();
  try {
    process.chdir(fresh);
    const skill = path.join(fresh, 's.md');
    fs.writeFileSync(skill, '---\nname: s\ndescription: a harmless test skill\n---\nbody\n');
    pin(skill); // no lockPath → resolveLock() → truecopy.lock
    assert.ok(fs.existsSync(path.join(fresh, 'truecopy.lock')), 'fresh pin created truecopy.lock');
    assert.ok(!fs.existsSync(path.join(fresh, 'canon.lock')), 'did not create a canon.lock');
    assert.equal(verify().ok, true, 'verify() with no --lock reads the truecopy.lock it just wrote');
  } finally { process.chdir(cwd0); }

  // legacy dir: only a canon.lock present → pin appends to it, verify reads it
  const legacy = mkdir();
  try {
    process.chdir(legacy);
    const skill = path.join(legacy, 's.md');
    fs.writeFileSync(skill, '---\nname: s\ndescription: a harmless test skill\n---\nbody\n');
    pin(skill, { lockPath: 'canon.lock' }); // simulate a pre-rename lock
    assert.ok(fs.existsSync(path.join(legacy, 'canon.lock')));
    // no --lock now → resolveLock falls back to the existing canon.lock, does NOT orphan it
    assert.equal(resolveLock(null, legacy), path.join(legacy, 'canon.lock'));
    assert.equal(verify().ok, true, 'verify() with no --lock reads the legacy canon.lock');
    assert.ok(!fs.existsSync(path.join(legacy, 'truecopy.lock')), 'did not silently create a second lock');
  } finally { process.chdir(cwd0); }
});
