// HTML in the README as GitHub renders it: a tag whose quoted value runs over a
// line break is still one tag, and a backslash-escaped < is text, not a tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { targetsOf, checkFile } from '../scripts/check-readme-links.mjs';

/** A scratch tree: img/a.png and docs/guide.md, plus the README text given. */
function fixture(t, readme) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readme-links-html-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'img'));
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'img', 'a.png'), '');
  writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n');
  const file = path.join(dir, 'README.md');
  writeFileSync(file, readme);
  return file;
}

const failures = (r) => r.failures.map((m) => m.replace(/^.*:(\d+) → /, '$1 '));

test('targetsOf: a quoted attribute that spans lines keeps the tag open', () => {
  const src = '<img alt="first\nsecond" src="img/a.png">\n<img alt=\'one\n> two\' src=missing.png>\n';
  assert.deepEqual(targetsOf(src).map((x) => [x.t, x.line]), [['img/a.png', 2], ['missing.png', 4]]);
});

test('checkFile: a multiline quoted alt before an existing and a missing src', (t) => {
  const file = fixture(t, '<img alt="first\nsecond" src="img/a.png">\n\n<img alt="first\nsecond" src="missing.png">\n');
  const r = checkFile(file);
  assert.equal(r.checked, 2);
  assert.deepEqual(failures(r), ['5 missing.png (file not found)']);
});

test('checkFile: a quoted srcset value that spans lines checks every candidate', (t) => {
  const file = fixture(t, '<source srcset="img/a.png 1x,\n  img/missing.png 2x">\n<a id="multi\nline"></a> after\n');
  const r = checkFile(file);
  assert.equal(r.checked, 2);
  assert.deepEqual(failures(r), ['2 img/missing.png (file not found)']);
});

test('targetsOf: an escaped < is text, after \\\\ the tag is real', () => {
  const src = 'Write \\<img src="missing.png"> or \\\\\\<a href="gone.md"> and \\\\<img src="img/a.png">\n';
  assert.deepEqual(targetsOf(src).map((x) => x.t), ['img/a.png']);
});

test('checkFile: escaped image and anchor examples are text', (t) => {
  const file = fixture(t, [
    'An image is \\<img src="missing.png">; an anchor is \\<a id="custom">.',
    '\\\\<a id="real"></a> \\\\<img src="img/gone.png">',
    '',
    '[c](#custom) [r](#real)',
    '',
  ].join('\n'));
  const r = checkFile(file);
  assert.equal(r.checked, 3);
  assert.deepEqual(failures(r), [
    '2 img/gone.png (file not found)',
    '4 #custom (no heading or anchor "#custom" in this file)',
  ]);
});

test('checkFile: a tag that never closes is text, so the links after it are checked', (t) => {
  const file = fixture(t, [
    'Use <value',
    '',
    '[bad](missing.md)',
    '',
    'Or <img alt="x',
    'and [also](gone.md) [ok](docs/guide.md)',
    '',
  ].join('\n'));
  const r = checkFile(file);
  assert.equal(r.checked, 3);
  assert.deepEqual(failures(r), [
    '3 missing.md (file not found)',
    '6 gone.md (file not found)',
  ]);
});

test('checkFile: link syntax inside an alt attribute is attribute text', (t) => {
  const file = fixture(t, [
    '<img alt="[example](missing.md)" src="img/a.png">',
    '',
    '<img alt="x"',
    '  title="[example](missing.md)" src="img/a.png">',
    '',
  ].join('\n'));
  assert.deepEqual(checkFile(file), { checked: 2, failures: [] });
});

test('checkFile: backticks in alt and title do not hide the src between them', (t) => {
  const file = fixture(t, [
    '<img alt="a `b" src="missing.png" title="c` d">',
    '',
    '<img alt="a `b"',
    '  src="gone.png" title="c` d">',
    '',
  ].join('\n'));
  const r = checkFile(file);
  assert.equal(r.checked, 2);
  assert.deepEqual(failures(r), [
    '1 missing.png (file not found)',
    '4 gone.png (file not found)',
  ]);
});
