import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Same isolation as the other suites: private mkdtemp base; CANON_CLAUDE_HOME
// stands in for the real home so plugin discovery never touches ~/.claude.
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-manifest-test-'));
process.env.CANON_HOME = path.join(baseDir, 'home');
process.env.CANON_CLAUDE_HOME = path.join(baseDir, 'chome');
import { loadSkill, skillHash } from '../src/index.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: baseDir, encoding: 'utf8', env: process.env });

const mkPluginSkill = (plugin, skill, body) => {
  const p = path.join(process.env.CANON_CLAUDE_HOME, '.claude', 'plugins', 'marketplaces', 'official', 'plugins', plugin);
  fs.mkdirSync(path.join(p, 'skills', skill), { recursive: true });
  fs.writeFileSync(path.join(p, 'skills', skill, 'SKILL.md'), body);
  return path.join(p, 'skills', skill);
};
const helperDir = mkPluginSkill('toolkit', 'helper', '# helper\nBe helpful.\n');
const extraDir = mkPluginSkill('toolkit', 'extra', '# extra\nDo extra things.\n');
mkPluginSkill('constructor', 'skill', '# skill\nA plugin named after a prototype member.\n');

const hashOf = (dir) => skillHash(loadSkill(dir));
const writeManifest = (name, m) => {
  const f = path.join(baseDir, name);
  fs.writeFileSync(f, JSON.stringify(m));
  return f;
};

test('check-manifest: byte-identical installs match, unlisted skills never fail', () => {
  // 'constructor:skill' is deliberately NOT in the manifest — with a plain `in`
  // lookup it would read Object.prototype.constructor as its expected hash.
  const f = writeManifest('m-ok.json', { scannedAt: '2026-07-17', skills: { 'toolkit:helper': hashOf(helperDir), 'toolkit:extra': hashOf(extraDir) } });
  const r = run(['check-manifest', f, '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.failing, 0);
  const byName = Object.fromEntries(j.results.map((x) => [x.name, x.status]));
  assert.equal(byName['toolkit:helper'], 'match');
  assert.equal(byName['toolkit:extra'], 'match');
  assert.equal(byName['constructor:skill'], 'unlisted');
});

test('check-manifest: an installed skill whose bytes differ from the watched hash fails', () => {
  const f = writeManifest('m-drift.json', { skills: { 'toolkit:helper': 'a'.repeat(64), 'toolkit:extra': hashOf(extraDir) } });
  const r = run(['check-manifest', f, '--json']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.failing, 1);
  const helper = j.results.find((x) => x.name === 'toolkit:helper');
  assert.equal(helper.status, 'drifted');
  assert.equal(helper.expected, 'a'.repeat(64));
});

test('check-manifest: a watch-flagged skill fails even byte-identical — match is not endorsement', () => {
  const f = writeManifest('m-flagged.json', { skills: { 'toolkit:helper': hashOf(helperDir) }, flagged: ['toolkit:helper'] });
  const r = run(['check-manifest', f, '--json']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).results.find((x) => x.name === 'toolkit:helper').status, 'flagged');
});

test('check-manifest: unreadable or shapeless manifests exit 2, not 0', () => {
  assert.equal(run(['check-manifest', path.join(baseDir, 'nope.json')]).status, 2);
  assert.equal(run(['check-manifest', writeManifest('m-shapeless.json', { hello: 'world' })]).status, 2);
  assert.equal(run(['check-manifest', writeManifest('m-array.json', { skills: ['not', 'a', 'map'] })]).status, 2);
  assert.equal(run(['check-manifest']).status, 2);
});
