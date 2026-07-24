// The Skill hook's decision table says a PINNED skill it cannot check is a BLOCK
// in both modes — the "pinned, dir missing → can't verify what will run" row.
// That only held for a missing directory. Any error raised while actually
// checking the skill (loadSkill / skillHash / scanSkill) fell through to the
// outer catch, which returns 0 in DEFAULT mode — the mode this gate ships in and
// the one wired on real boxes. So making one file in a pinned skill unreadable
// was enough to have the gate wave the skill through without verifying it.
//
// The trigger used here is a file larger than fs.readFileSync can return
// (ERR_FS_FILE_TOO_LARGE): deterministic on every platform, created sparse so it
// costs a millisecond and no real disk. Equivalent real-world triggers are a
// file another process holds open, EACCES, EIO, or a file removed mid-walk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-hook-unverifiable-'));
process.env.CANON_HOME = path.join(baseDir, 'home');
process.env.CANON_CLAUDE_HOME = path.join(baseDir, 'chome');
const { pin } = await import('../src/index.mjs');
const { loadSkill } = await import('../src/skill.mjs');

const proj = path.join(baseDir, 'proj');
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const skillDir = path.join(proj, '.claude', 'skills', 'notes');
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# notes\nSummarize the diff politely.\n');
fs.writeFileSync(path.join(skillDir, 'reference.md'), 'background reading\n');

const lock = path.join(baseDir, 'hook.lock');
pin(skillDir, { lockPath: lock, name: 'notes' });

const hook = (strict) =>
  spawnSync(process.execPath, [CLI, 'hook', 'claude', '--lock', lock, ...(strict ? ['--strict'] : [])], {
    cwd: proj, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'notes' }, cwd: proj }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });

// Sparse: sets the length without writing 2 GiB of zeroes.
const oversized = path.join(skillDir, 'oversized.bin');
const makeUnreadable = () => { const fd = fs.openSync(oversized, 'w'); fs.ftruncateSync(fd, 2 ** 31); fs.closeSync(fd); };

test('hook: the pinned skill is allowed while it verifies', () => {
  assert.equal(hook(false).status, 0);
  assert.equal(hook(true).status, 0);
});

test('hook: a pinned skill that cannot be read is BLOCKED in both modes', () => {
  makeUnreadable();
  try {
    // Precondition: this really is an unverifiable skill, not a drifted one —
    // the load itself throws, so no hash is ever computed.
    assert.throws(() => loadSkill(skillDir), (e) => e.code === 'ERR_FS_FILE_TOO_LARGE');

    for (const strict of [false, true]) {
      const r = hook(strict);
      assert.equal(r.status, 2, `${strict ? 'strict' : 'default'} mode should block, got ${r.status}`);
      assert.match(r.stderr, /could NOT be verified/);
      // The reason has to reach the model, not just an opaque refusal.
      assert.match(r.stderr, /notes/);
    }
  } finally {
    fs.unlinkSync(oversized);
  }
});

test('hook: allowing resumes once the skill can be read again', () => {
  assert.equal(hook(false).status, 0);
});
