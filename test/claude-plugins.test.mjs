import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Same isolation as the other suites: private mkdtemp base; CANON_CLAUDE_HOME
// stands in for the real home so plugin discovery never touches ~/.claude.
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-plugins-test-'));
process.env.CANON_HOME = path.join(baseDir, 'home');
process.env.CANON_CLAUDE_HOME = path.join(baseDir, 'chome');
import { pin } from '../src/index.mjs';
import { discoverClaudePluginSkills, resolveClaudeSkill } from '../src/claude.mjs';

const proj = path.join(baseDir, 'proj');
fs.mkdirSync(proj, { recursive: true });
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const run = (args, { cwd = proj, input } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });
const skillCall = (skill) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill }, cwd: proj });

// marketplace fixtures — layout mirrors the real ~/.claude/plugins tree:
//   marketplaces/<mp>/{plugins,external_plugins}/<plugin>/skills/<skill>/SKILL.md
const mkPluginSkill = (mp, kind, pluginDir, skill, body, manifestName) => {
  const p = path.join(process.env.CANON_CLAUDE_HOME, '.claude', 'plugins', 'marketplaces', mp, kind, pluginDir);
  fs.mkdirSync(path.join(p, 'skills', skill), { recursive: true });
  if (manifestName !== undefined) {
    fs.mkdirSync(path.join(p, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: manifestName }));
  }
  fs.writeFileSync(path.join(p, 'skills', skill, 'SKILL.md'), body);
  return path.join(p, 'skills', skill);
};
// 'amkt' sorts before 'testmkt' → deterministic winner when both carry `toolkit`
const amktHelper = mkPluginSkill('amkt', 'plugins', 'toolkit', 'helper', '# helper (amkt)\nBe helpful.\n', 'toolkit');
mkPluginSkill('testmkt', 'plugins', 'toolkit', 'helper', '# helper (testmkt)\nBe helpful too.\n', 'toolkit');
const chatAccess = mkPluginSkill('testmkt', 'external_plugins', 'chatapp', 'access', '# access\nRead recent messages.\n'); // no manifest → dir-name fallback
mkPluginSkill('testmkt', 'plugins', 'dir-weird', 'skillx', '# skillx\nDo x.\n', 'renamed'); // manifest name wins over dir name

test('plugin discovery: namespaced names, external_plugins included, manifest name wins', () => {
  const names = discoverClaudePluginSkills().map((s) => s.name).sort();
  assert.deepEqual(names, ['chatapp:access', 'renamed:skillx', 'toolkit:helper']);
});

test('plugin resolve: deterministic across marketplaces; hostile forms are unresolvable', () => {
  assert.equal(resolveClaudeSkill('toolkit:helper'), amktHelper); // amkt sorts first
  assert.equal(resolveClaudeSkill('chatapp:access'), chatAccess);
  for (const bad of ['toolkit:../helper', '../evil:helper', 'a:b:c', 'unknown:skill', ':helper', 'toolkit:']) {
    assert.equal(resolveClaudeSkill(bad), null, `should not resolve: ${bad}`);
  }
});

test('add --claude-plugins pins under the plugin:skill invocation name', () => {
  const lock = path.join(baseDir, 'p1.lock');
  const r = run(['add', '--claude-plugins', '--lock', lock]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pinned = JSON.parse(fs.readFileSync(lock, 'utf8')).skills;
  assert.deepEqual(Object.keys(pinned).sort(), ['chatapp:access', 'renamed:skillx', 'toolkit:helper']);
});

test('hook gates a pinned plugin skill: clean allows, drift blocks', () => {
  const lock = path.join(baseDir, 'p2.lock');
  assert.equal(run(['add', '--claude-plugins', '--lock', lock]).status, 0);
  assert.equal(run(['hook', 'claude', '--lock', lock], { input: skillCall('toolkit:helper') }).status, 0);
  const skillMd = path.join(amktHelper, 'SKILL.md');
  const original = fs.readFileSync(skillMd, 'utf8');
  try {
    fs.appendFileSync(skillMd, '\n(silent update)\n');
    const r = run(['hook', 'claude', '--lock', lock], { input: skillCall('toolkit:helper') });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /DRIFTED/);
  } finally {
    fs.writeFileSync(skillMd, original); // restore in finally so a failure can't drift the shared fixture for later tests
  }
});

test('hook strict blocks an unresolvable plugin form; unpinned plugin form passes by default', () => {
  const lock = path.join(baseDir, 'p3.lock');
  fs.writeFileSync(lock, JSON.stringify({ version: 1, skills: {} }));
  assert.equal(run(['hook', 'claude', '--lock', lock], { input: skillCall('unknown:skill') }).status, 0);
  assert.equal(run(['hook', 'claude', '--lock', lock, '--strict'], { input: skillCall('unknown:skill') }).status, 2);
});

test('hook install: creates the project settings entry, idempotent, --strict updates in place', () => {
  const projDir = path.join(baseDir, 'inst1'); fs.mkdirSync(projDir, { recursive: true });
  assert.equal(run(['hook', 'install'], { cwd: projDir }).status, 0);
  const sp = path.join(projDir, '.claude', 'settings.json');
  let s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Skill');
  assert.ok(s.hooks.PreToolUse[0].hooks[0].command.includes('hook claude'));
  assert.equal(run(['hook', 'install'], { cwd: projDir }).status, 0); // idempotent
  assert.equal(run(['hook', 'install', '--strict'], { cwd: projDir }).status, 0); // update in place
  s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /--strict$/);
});

test('hook install: preserves unrelated settings and other hooks; refuses corrupt settings', () => {
  const projDir = path.join(baseDir, 'inst2'); fs.mkdirSync(path.join(projDir, '.claude'), { recursive: true });
  const sp = path.join(projDir, '.claude', 'settings.json');
  const before = { permissions: { defaultMode: 'auto' }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-gate' }] }] } };
  fs.writeFileSync(sp, JSON.stringify(before, null, 2));
  assert.equal(run(['hook', 'install'], { cwd: projDir }).status, 0);
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(s.permissions.defaultMode, 'auto');
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'other-gate'); // untouched, order kept

  fs.writeFileSync(sp, '{ definitely not json');
  const r = run(['hook', 'install'], { cwd: projDir });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(sp, 'utf8'), '{ definitely not json'); // refused, not clobbered
});

test('hook install: --settings targets an explicit file; --command overrides the hook command', () => {
  const sp = path.join(baseDir, 'inst3', 'my-settings.json');
  const r = run(['hook', 'install', '--settings', sp, '--command', 'node C:/somewhere/cli.mjs hook claude --strict']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'node C:/somewhere/cli.mjs hook claude --strict');
});

test('pinned plugin skills verify like any other pinned skill', () => {
  const lock = path.join(baseDir, 'p4.lock');
  assert.equal(pin(chatAccess, { lockPath: lock, name: 'chatapp:access' }).ok, true);
  assert.equal(run(['verify', '--lock', lock]).status, 0);
});
