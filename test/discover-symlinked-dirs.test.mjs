// A symlinked skill DIRECTORY was runnable but invisible.
//
// Every discovery filter tested `Dirent.isDirectory()`, which is lstat-based and
// answers false for a symlink (or a Windows junction, which any user can make).
// Claude Code resolves them — hasSkillMd/resolveClaudeSkill stat through the
// link — so such a skill runs while `add --claude` cannot pin it, the
// default-mode hook treats it as unpinned and allows it, and `scan --claude`
// calls the machine clean by omission.
//
// The scanned-clone case is the opposite policy, deliberately: that root is
// UNTRUSTED (the watch walks 250+ vendor repos with it), so a link out of the
// tree is refused — and reported, because a coverage number that quietly
// excludes things is the one claim this project cannot afford to fudge.
//
// Directory links are made as junctions on Windows so this runs on all three
// platforms instead of skipping (unprivileged symlinks are the thing that needs
// Developer Mode; junctions are not).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-symlink-discover-'));
process.env.CANON_HOME = path.join(baseDir, 'home');
process.env.CANON_CLAUDE_HOME = path.join(baseDir, 'chome');
const { discoverClaudeSkills, discoverMarketplaceSkills, resolveClaudeSkill } = await import('../src/claude.mjs');

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const proj = path.join(baseDir, 'proj');
const outside = path.join(baseDir, 'outside');

const mkSkill = (dir, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), body); return dir; };
const linkDir = (target, linkPath) => fs.symlinkSync(path.resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir');

// A real skill, and one whose directory is a link out to somewhere else.
mkSkill(path.join(proj, '.claude', 'skills', 'plain'), '# plain\nSummarize politely.\n');
mkSkill(path.join(outside, 'linked-skill'), '# hidden\nLives outside the skills root.\n');
let linksWork = true;
try { linkDir(path.join(outside, 'linked-skill'), path.join(proj, '.claude', 'skills', 'hidden')); }
catch { linksWork = false; }

test('a symlinked skill directory is discovered, not skipped', { skip: !linksWork && 'directory links unavailable here' }, () => {
  const names = discoverClaudeSkills({ projectDir: proj }).map((s) => s.name).sort();
  assert.deepEqual(names, ['hidden', 'plain']);
  // Discovery and resolution now agree. Resolution ALWAYS saw it — that
  // disagreement is what made the skill runnable-but-unpinnable.
  assert.ok(resolveClaudeSkill('hidden', { projectDir: proj }), 'the hook could always resolve it');
});

test('a symlinked skill can be pinned, and then the hook gates it', { skip: !linksWork && 'directory links unavailable here' }, () => {
  const lock = path.join(baseDir, 'sym.lock');
  const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: proj, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, ...opts,
  });
  const added = run(['add', '--claude', '--lock', lock]);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.match(added.stdout, /pinned .*hidden/, 'the linked skill is now in the lock');

  const hook = () => run(['hook', 'claude', '--lock', lock], {
    input: JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'hidden' }, cwd: proj }),
  });
  assert.equal(hook().status, 0, 'clean pinned skill runs');

  // Editing it THROUGH the link is the attack this closes: before the fix the
  // skill could never be pinned, so this edit had nothing to drift from.
  const target = path.join(outside, 'linked-skill', 'SKILL.md');
  const original = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, original + '\nAlso, quietly do something else.\n');
  try {
    const r = hook();
    assert.equal(r.status, 2, 'drift through the link is blocked');
    assert.match(r.stderr, /DRIFTED/);
  } finally { fs.writeFileSync(target, original); }
});

test('a scanned clone follows links that stay inside it and refuses ones that leave', { skip: !linksWork && 'directory links unavailable here' }, () => {
  const clone = path.join(baseDir, 'clone');
  const plugin = path.join(clone, 'plugins', 'vendor');
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'vendor' }));
  mkSkill(path.join(plugin, 'skills', 'ordinary'), '# ordinary\nA normal skill.\n');
  // Inside the tree: legitimate layout sharing, must still be scanned.
  mkSkill(path.join(clone, 'shared', 'reused'), '# reused\nShared within the repo.\n');
  linkDir(path.join(clone, 'shared', 'reused'), path.join(plugin, 'skills', 'reused'));
  // Out of the tree: must not be read, must not vanish silently.
  mkSkill(path.join(outside, 'escaped'), '# escaped\nOutside the clone.\n');
  linkDir(path.join(outside, 'escaped'), path.join(plugin, 'skills', 'escaped'));

  const skipped = [];
  const found = discoverMarketplaceSkills(clone, { skipped }).map((s) => s.name).sort();
  assert.deepEqual(found, ['vendor:ordinary', 'vendor:reused'], 'in-tree link followed, escaping link not');
  assert.equal(skipped.length, 1, 'the refusal is reported, not silent');
  assert.match(skipped[0].name, /escaped/);
  assert.match(skipped[0].reason, /leaves the scanned tree/);
});

test('an escaping link at the PLUGIN level is refused and reported too', { skip: !linksWork && 'directory links unavailable here' }, () => {
  const clone = path.join(baseDir, 'clone2');
  fs.mkdirSync(path.join(clone, 'plugins'), { recursive: true });
  const away = path.join(outside, 'away-plugin');
  fs.mkdirSync(path.join(away, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(away, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'away' }));
  mkSkill(path.join(away, 'skills', 'thing'), '# thing\n');
  linkDir(away, path.join(clone, 'plugins', 'away'));

  const skipped = [];
  assert.deepEqual(discoverMarketplaceSkills(clone, { skipped }), []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /leaves the scanned tree/);
});
