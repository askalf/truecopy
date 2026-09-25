// A release is cut by bumping package.json alone (auto-release.yml), so nothing
// else would notice a bump that forgot its CHANGELOG section (the GitHub release
// silently falls back to "Release vX") or left the documented pins on the old
// version (users copy those lines verbatim).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;

test('CHANGELOG has a section for the package.json version', () => {
  const released = read('CHANGELOG.md').split(/\r?\n/)
    .map((l) => /^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/.exec(l)?.[1]).filter(Boolean);
  assert.ok(released.includes(version),
    `add "## [${version}] - YYYY-MM-DD" to CHANGELOG.md: auto-release cuts the GitHub release notes from it`);
});

test('package-lock.json carries the package.json version', () => {
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
});

test('documented pins name the package.json version', () => {
  const pins = [
    ['docs/commands.md', /@askalf\/truecopy@(\d+\.\d+\.\d+)/g],
    ['docs/claude-code.md', /github:askalf\/truecopy#v(\d+\.\d+\.\d+)/g],
    ['.github/ISSUE_TEMPLATE/bug.yml', /placeholder: '(\d+\.\d+\.\d+) /g],
    ['.github/ISSUE_TEMPLATE/false-positive.yml', /placeholder: '(\d+\.\d+\.\d+) /g],
  ];
  for (const [file, re] of pins) {
    const found = [...read(file).matchAll(re)].map((m) => m[1]);
    assert.ok(found.length > 0, `${file}: expected a version pin matching ${re}`);
    for (const v of found) assert.equal(v, version, `${file} pins ${v}, package.json is ${version}`);
  }
});
