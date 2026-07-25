// A `git-subdir` plugin lives in one directory of a larger repo, and a vendor
// with several plugins reasonably keeps canonical skills at the top and
// symlinks them in. Redis ships exactly that: eight
// `plugins/redis-development/skills/x -> ../../../skills/x` links.
//
// Confined to the plugin directory those resolve "outside" and were refused —
// even though the fetch materializes the WHOLE repo, so the targets are sitting
// right there. Eight real skills in the official directory went unscanned, and
// before the escaping-link work they were skipped without a word.
//
// `confine` widens the boundary to the fetched repo. It is one-directional: a
// value that is not an ancestor of the scanned root is ignored, so it can only
// narrow back, never redirect discovery somewhere unrelated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-intra-repo-'));
process.env.CANON_HOME = path.join(baseDir, 'home');
const { discoverMarketplaceSkills } = await import('../src/claude.mjs');

const mkSkill = (dir, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), body); return dir; };
const linkDir = (target, at) => fs.symlinkSync(path.resolve(target), at, process.platform === 'win32' ? 'junction' : 'dir');

// The Redis shape: repo root holds the canonical skills, the plugin subdir
// links to them, and something genuinely outside the repo is also linked in.
const repo = path.join(baseDir, 'vendor-repo');
const plugin = path.join(repo, 'plugins', 'the-plugin');
fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'the-plugin' }));
mkSkill(path.join(plugin, 'skills', 'local-one'), '# local-one\nLives in the plugin.\n');
mkSkill(path.join(repo, 'skills', 'canonical'), '# canonical\nLives at the repo top.\n');
const outside = mkSkill(path.join(baseDir, 'elsewhere', 'foreign'), '# foreign\nOutside the repo entirely.\n');

let linksWork = true;
try {
  linkDir(path.join(repo, 'skills', 'canonical'), path.join(plugin, 'skills', 'canonical'));
  linkDir(outside, path.join(plugin, 'skills', 'foreign'));
} catch { linksWork = false; }

const names = (opts) => discoverMarketplaceSkills(plugin, opts).map((s) => s.name).sort();

test('without a wider boundary, an intra-repo link is refused (the old behaviour)', { skip: !linksWork && 'directory links unavailable here' }, () => {
  const skipped = [];
  assert.deepEqual(names({ skipped }), ['the-plugin:local-one']);
  assert.equal(skipped.length, 2, 'both the intra-repo and the foreign link are refused');
});

test('confined to the fetched repo, the intra-repo link is scanned and the foreign one is still refused', { skip: !linksWork && 'directory links unavailable here' }, () => {
  const skipped = [];
  assert.deepEqual(names({ skipped, confine: repo }), ['the-plugin:canonical', 'the-plugin:local-one']);
  assert.equal(skipped.length, 1, 'only the link leaving the repo is refused');
  assert.match(skipped[0].name, /foreign/);
  assert.match(skipped[0].reason, /leaves the scanned tree/);
});

test('a confine that is not an ancestor is ignored — widening cannot redirect discovery', { skip: !linksWork && 'directory links unavailable here' }, () => {
  // Pointing the boundary at an unrelated directory must NOT make the foreign
  // link followable; it falls back to the scanned root.
  const skipped = [];
  assert.deepEqual(names({ skipped, confine: path.join(baseDir, 'elsewhere') }), ['the-plugin:local-one']);
  assert.equal(skipped.length, 2);
  // Nor may a bogus path widen anything.
  assert.deepEqual(names({ confine: path.join(baseDir, 'does-not-exist') }), ['the-plugin:local-one']);
});

test('confine changes nothing when there are no links to follow', { skip: !linksWork && 'directory links unavailable here' }, () => {
  const plain = path.join(baseDir, 'plain-repo', 'plugins', 'p');
  fs.mkdirSync(path.join(plain, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plain, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p' }));
  mkSkill(path.join(plain, 'skills', 'only'), '# only\n');
  assert.deepEqual(
    discoverMarketplaceSkills(plain).map((s) => s.name),
    discoverMarketplaceSkills(plain, { confine: path.join(baseDir, 'plain-repo') }).map((s) => s.name),
  );
});
