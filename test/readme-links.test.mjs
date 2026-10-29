// scripts/check-readme-links.mjs guards the README and docs/ in CI. A checker
// that wrongly passes hides a broken link; one that wrongly fails blocks every
// PR. These fixtures pin both sides: srcset candidates are checked one by one
// without their descriptors, and a missing image, file or anchor still fails.
// The last tests run the script itself, because an entry-point guard that never
// fires would make the CI step exit 0 having checked nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { srcsetUrls, targetsOf, checkFile } from '../scripts/check-readme-links.mjs';

const script = fileURLToPath(new URL('../scripts/check-readme-links.mjs', import.meta.url));

/** A scratch tree: img/a.png, img/b.png and docs/guide.md, plus the README text given. */
function fixture(t, readme) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readme-links-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'img'));
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'img', 'a.png'), '');
  writeFileSync(path.join(dir, 'img', 'b.png'), '');
  writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n\n## Getting started\n\n<a id="custom"></a>\n');
  const file = path.join(dir, 'README.md');
  writeFileSync(file, readme);
  return file;
}

test('srcsetUrls: one URL per candidate, descriptors dropped', () => {
  assert.deepEqual(srcsetUrls('img/a.png'), ['img/a.png']);
  assert.deepEqual(srcsetUrls('img/a.png 1x, img/b.png 2x'), ['img/a.png', 'img/b.png']);
  assert.deepEqual(srcsetUrls('small.png 480w,large.png 1080w'), ['small.png', 'large.png']);
  assert.deepEqual(srcsetUrls('a.png, b.png'), ['a.png', 'b.png']);
  assert.deepEqual(srcsetUrls('  a.png  1x ,  b.png  '), ['a.png', 'b.png']);
});

test('srcsetUrls: a comma inside a URL stays part of it', () => {
  assert.deepEqual(srcsetUrls('img/a,b.png 1x'), ['img/a,b.png']);
});

test('srcsetUrls: an empty value has no candidates', () => {
  assert.deepEqual(srcsetUrls(''), []);
  assert.deepEqual(srcsetUrls(' , '), []);
});

test('targetsOf: links in fenced code are not targets', () => {
  const src = 'See [a](a.md).\n\n```md\n[b](b.md)\n```\n\n~~~\n<img src="c.png">\n~~~\n';
  assert.deepEqual(targetsOf(src).map((x) => x.t), ['a.md']);
});

test('checkFile: a srcset with every candidate present passes', (t) => {
  const file = fixture(t, '<picture>\n  <source srcset="img/a.png 1x, img/b.png 2x">\n  <img src="img/a.png" alt="">\n</picture>\n');
  assert.deepEqual(checkFile(file), { checked: 3, failures: [] });
});

test('checkFile: a single-candidate srcset passes', (t) => {
  const file = fixture(t, '<source srcset="img/b.png">\n');
  assert.deepEqual(checkFile(file), { checked: 1, failures: [] });
});

test('checkFile: a missing srcset candidate fails by its own URL', (t) => {
  const file = fixture(t, '<source srcset="img/a.png 1x, img/missing.png 2x">\n');
  const r = checkFile(file);
  assert.equal(r.checked, 2);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /:1 → img\/missing\.png \(file not found\)$/);
});

test('checkFile: a missing <img src> or markdown image fails', (t) => {
  const file = fixture(t, '<img src="img/gone.png">\n\n![x](img/also-gone.png)\n');
  const r = checkFile(file);
  assert.equal(r.failures.length, 2);
  assert.match(r.failures[0], /img\/gone\.png \(file not found\)/);
  assert.match(r.failures[1], /img\/also-gone\.png \(file not found\)/);
});

test('checkFile: links and anchors resolve across files and within one', (t) => {
  const file = fixture(t, [
    '# Intro',
    '',
    '## Setup',
    '',
    '## Setup',
    '',
    '[top](#intro) [second setup](#setup-1) [guide](docs/guide.md)',
    '[start](docs/guide.md#getting-started) [custom](docs/guide.md#custom)',
    '[ref]: docs/guide.md',
    '<a href="docs/">docs</a>',
    '',
  ].join('\n'));
  assert.deepEqual(checkFile(file), { checked: 7, failures: [] });
});

test('checkFile: a missing file, heading or anchor fails', (t) => {
  const file = fixture(t, [
    '# Intro',
    '[a](docs/nope.md) [b](#nowhere) [c](docs/guide.md#nope) [d](img/a.png#x) [e](docs/#x)',
    '',
  ].join('\n'));
  const r = checkFile(file);
  assert.equal(r.checked, 5);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    'docs/nope.md (file not found)',
    '#nowhere (no heading or anchor "#nowhere" in this file)',
    'docs/guide.md#nope (no heading or anchor "#nope" in docs/guide.md)',
    'img/a.png#x (fragment on a non-markdown file)',
    'docs/#x (fragment on a directory)',
  ]);
});

test('checkFile: external and data targets are not checked', (t) => {
  const file = fixture(t, '[w](https://example.com/x) [m](mailto:a@example.com) <img src="data:image/png;base64,AA==">\n<source srcset="https://example.com/a.png 1x, img/a.png 2x">\n');
  assert.deepEqual(checkFile(file), { checked: 1, failures: [] });
});

test('targetsOf: links in inline code spans are not targets', () => {
  const src = 'Write `[a](missing.md)` or `` `<img src="x.png">` ``, see [b](b.md).\n';
  assert.deepEqual(targetsOf(src).map((x) => x.t), ['b.md']);
});

test('checkFile: a percent-encoded fragment matches its decoded heading', (t) => {
  const file = fixture(t, '# Café\n\n[encoded](#caf%C3%A9) [plain](#café)\n');
  assert.deepEqual(checkFile(file), { checked: 2, failures: [] });
});

test('checkFile: a malformed percent-escape fails with its own message', (t) => {
  const file = fixture(t, '# Café\n\n[frag](#caf%E9) [path](img/%E9.png)\n');
  const r = checkFile(file);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    '#caf%E9 (malformed percent-escape)',
    'img/%E9.png (malformed percent-escape)',
  ]);
});

test('checkFile: an anchor that only appears in code does not count', (t) => {
  const file = fixture(t, [
    '```html',
    '<a id="fenced"></a>',
    '```',
    '',
    'Mark a section with `<a id="inline"></a>`.',
    '',
    '<a id="real"></a>',
    '',
    '[a](#fenced) [b](#inline) [c](#real)',
    '',
  ].join('\n'));
  const r = checkFile(file);
  assert.equal(r.checked, 3);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    '#fenced (no heading or anchor "#fenced" in this file)',
    '#inline (no heading or anchor "#inline" in this file)',
  ]);
});

test('the script exits 0 on a clean file and 1 on a broken one', (t) => {
  const good = fixture(t, '<source srcset="img/a.png 1x, img/b.png 2x">\n');
  const ok = spawnSync(process.execPath, [script, good], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /ok .*README\.md: 2 relative links\/anchors checked/);

  const bad = fixture(t, '<source srcset="img/a.png 1x, img/missing.png 2x">\n');
  const no = spawnSync(process.execPath, [script, bad], { encoding: 'utf8' });
  assert.equal(no.status, 1);
  assert.match(no.stderr, /FAIL: .*img\/missing\.png \(file not found\)/);
});
