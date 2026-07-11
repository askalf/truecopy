import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-xos-'));
import { loadSkill, skillHash } from '../src/index.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const mkSkill = (n, files) => {
  const dir = path.join(baseDir, n);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
};

// The separator-collation trap: sibling dirs where one name prefixes another.
// On POSIX, walk() yields '/'-paths; on Windows, '\'-paths that sort differently.
const FILES = {
  'SKILL.md': '# skill\n',
  'lib/x.md': 'X\n',
  'lib2/x.md': 'Y\n',
  'lib/deep/y.md': 'Z\n',
};

test('skill file order is sorted by the portable relative path (subdirs present)', () => {
  const s = loadSkill(mkSkill('order', FILES));
  const got = s.files.map((f) => f.path);
  const want = [...got].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(got, want, 'entries are in forward-slash lexicographic order');
  // explicitly: the prefix-colliding siblings are lib before lib2, deep nested first
  assert.deepEqual(got, ['SKILL.md', 'lib/deep/y.md', 'lib/x.md', 'lib2/x.md']);
});

test('hashInput is separator-independent — matches the POSIX-canonical hash exactly', () => {
  const s = loadSkill(mkSkill('canon', FILES));
  // Reconstruct the identity the way a POSIX box would: entries ordered by
  // forward-slash relative path, each { path, hash } — then canonicalJson + sha256.
  // (canonicalJson sorts object keys; arrays keep order — so this is order-sensitive.)
  const canonical = JSON.stringify(
    [...s.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({ hash: f.hash, path: f.path })) // keys already sorted (hash < path)
  );
  assert.equal(skillHash(s), sha(canonical), 'the pinned hash equals the OS-independent identity');
});

test('two dirs with identical bytes but built in different insertion order hash identically', () => {
  const a = mkSkill('a', FILES);
  const b = mkSkill('b', { 'lib2/x.md': 'Y\n', 'SKILL.md': '# skill\n', 'lib/deep/y.md': 'Z\n', 'lib/x.md': 'X\n' });
  assert.equal(skillHash(loadSkill(a)), skillHash(loadSkill(b)));
});
