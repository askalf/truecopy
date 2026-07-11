import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-clirobust-'));
process.env.CANON_HOME = path.join(baseDir, 'home');
process.env.CANON_NO_KEYCHAIN = '1';
import { pin } from '../src/index.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const tmp = (n) => path.join(baseDir, n);
const write = (p, o) => (fs.writeFileSync(p, JSON.stringify(o)), p);
const manifest = (name) => ({ name, tools: [{ name: 'read_file', description: 'Read a file.' }] });
const cli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: baseDir, encoding: 'utf8', env: process.env, ...opts });

test('hook install: default command targets truecopy and is PINNED to this version tag (not the legacy canon, not unpinned)', () => {
  const proj = tmp('proj'); fs.mkdirSync(proj, { recursive: true });
  assert.equal(cli(['hook', 'install'], { cwd: proj }).status, 0);
  const cmd = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  assert.ok(cmd.includes(`github:askalf/truecopy#v${pkgVersion} hook claude`), `pinned to this version: ${cmd}`);
  assert.doesNotMatch(cmd, /askalf\/canon/, 'no longer the legacy repo name');
});

test('hook claude --strict: an UNREADABLE stdin payload fails closed (exit 2); default allows (exit 0)', () => {
  const proj = tmp('hookp'); fs.mkdirSync(proj, { recursive: true });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: proj };
  const strict = spawnSync(process.execPath, [CLI, 'hook', 'claude', '--strict'], { cwd: proj, env, encoding: 'utf8', input: '{ this is not json' });
  assert.equal(strict.status, 2, 'strict blocks when it cannot read what is being invoked');
  const lax = spawnSync(process.execPath, [CLI, 'hook', 'claude'], { cwd: proj, env, encoding: 'utf8', input: '{ this is not json' });
  assert.equal(lax.status, 0, 'default stays adoption-friendly');
  // a well-formed NON-Skill payload is a mis-wired matcher — 0 in both modes
  const other = spawnSync(process.execPath, [CLI, 'hook', 'claude', '--strict'], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash' }) });
  assert.equal(other.status, 0, 'strict must not break other tools');
});

test('list --json: a corrupt lock emits a JSON error (exit 1), not empty stdout', () => {
  const lock = tmp('corrupt.lock');
  fs.writeFileSync(lock, '{ definitely not json');
  const r = cli(['list', '--json', '--lock', lock]);
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout); // must still be one parseable JSON document
  assert.ok(j.error && Array.isArray(j.skills));
});

test('diff --json: a missing source emits a JSON error (exit 1), not empty stdout', () => {
  const lock = tmp('d.lock');
  pin(write(tmp('d.json'), manifest('fs')), { lockPath: lock });
  const r = cli(['diff', '--json', tmp('no-such.json'), '--lock', lock]);
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.status, 'error');
  assert.ok(j.error);
});

test('list (human): an entry missing hash/scannedAt does not crash', () => {
  const lock = tmp('partial.lock');
  fs.writeFileSync(lock, JSON.stringify({ version: 1, skills: { weird: { kind: 'mcp' } } })); // no hash/scannedAt
  const r = cli(['list', '--lock', lock]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /weird/);
});
