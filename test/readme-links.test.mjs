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
import { slugify, proseLines, srcsetUrls, targetsOf, checkFile } from '../scripts/check-readme-links.mjs';

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

test('checkFile: whitespace around = in href, src and srcset still makes an attribute', (t) => {
  const file = fixture(t, [
    '<a href = "docs/guide.md">g</a> <img src =\'img/a.png\'> <source srcset= "img/a.png 1x, img/b.png 2x">',
    '<a href\t=\t"missing.md">m</a> <img src = "img/gone.png"> <source srcset = "img/a.png 1x, img/missing.png 2x">',
    '',
  ].join('\n'));
  const r = checkFile(file);
  assert.equal(r.checked, 8);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    'missing.md (file not found)',
    'img/gone.png (file not found)',
    'img/missing.png (file not found)',
  ]);
});

test('checkFile: whitespace around = in <a id> and <a name> still declares an anchor', (t) => {
  const file = fixture(t, [
    '<a id = "custom"></a> <a class="x" name =\'named\'></a> <a id\t=\tbare></a>',
    '',
    '[jump](#custom) [named](#named) [bare](#bare) [none](#nowhere)',
    '',
  ].join('\n'));
  const r = checkFile(file);
  assert.equal(r.checked, 4);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    '#nowhere (no heading or anchor "#nowhere" in this file)',
  ]);
});

test('checkFile: unquoted href, src and srcset values are targets', (t) => {
  const file = fixture(t, [
    '<a href=docs/guide.md>Guide</a> <img src=img/a.png> <source srcset=img/b.png> <a href = docs/guide.md#custom>c</a>',
    '<a href=missing.md>Guide</a> <img src=missing.png alt=x> <img srcset=img/gone.png>',
    '',
  ].join('\n'));
  const r = checkFile(file);
  assert.equal(r.checked, 7);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    'missing.md (file not found)',
    'missing.png (file not found)',
    'img/gone.png (file not found)',
  ]);
});

test('targetsOf: an attribute name only counts inside a tag', () => {
  const src = '[q](docs/guide.md?src=x.png) <img alt="src=gone.png" src=img/a.png> plain href=nope.md text\n';
  assert.deepEqual(targetsOf(src).map((x) => x.t), ['docs/guide.md?src=x.png', 'img/a.png']);
});

test('targetsOf: a tag that spans lines keeps its attributes', () => {
  const src = '<img alt="x"\n     src=img/a.png\n     srcset="img/b.png 2x">\nsrc=not-a-tag.png\n';
  assert.deepEqual(targetsOf(src).map((x) => x.t), ['img/a.png', 'img/b.png']);
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

test('checkFile: a query is not part of the file name, and the fragment after it is still checked', (t) => {
  const file = fixture(t, [
    '[a](docs/guide.md?plain=1) [b](docs/guide.md?plain=1#getting-started) ![c](img/a.png?raw=true)',
    '<img src="img/b.png?raw=true"> <source srcset="img/a.png?raw=true 1x, img/b.png?raw=true 2x">',
    '[d](docs/missing.md?plain=1) ![e](img/gone.png?raw=true) [f](docs/guide.md?plain=1#nope)',
    '',
  ].join('\n'));
  const r = checkFile(file);
  assert.equal(r.checked, 9);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    'docs/missing.md?plain=1 (file not found)',
    'img/gone.png?raw=true (file not found)',
    'docs/guide.md?plain=1#nope (no heading or anchor "#nope" in docs/guide.md)',
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

test('targetsOf: a code span keeps the text on either side of it apart', () => {
  assert.deepEqual(targetsOf('[example]`code`(missing.md) and [real](real.md)\n').map((x) => x.t), ['real.md']);
  assert.deepEqual(targetsOf('![alt]`x`(gone.png) [`code` text](real.md)\n').map((x) => x.t), ['real.md']);
});

test('checkFile: text split by a code span is not a link, a real broken link on the line still fails', (t) => {
  const file = fixture(t, '[example]`code`(missing.md) see [guide](docs/guide.md) and [bad](gone.md)\n');
  const r = checkFile(file);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), ['gone.md (file not found)']);
});

test('targetsOf: a link needs an unescaped [ before its ]', () => {
  assert.deepEqual(targetsOf('\\[example](missing.md) and [real](real.md)\n').map((x) => x.t), ['real.md']);
  assert.deepEqual(targetsOf('see ](missing.md) then [real](real.md)\n').map((x) => x.t), ['real.md']);
  assert.deepEqual(targetsOf('[real](real.md) then ](missing.md)\n').map((x) => x.t), ['real.md']);
  // After \\ the [ is not escaped, so the link renders.
  assert.deepEqual(targetsOf('\\\\[real](real.md)\n').map((x) => x.t), ['real.md']);
  // An image inside a link: both destinations are targets.
  assert.deepEqual(targetsOf('[![badge](img/a.png)](docs/guide.md) [a [b] c](x.md)\n').map((x) => x.t), ['img/a.png', 'docs/guide.md', 'x.md']);
});

test('checkFile: escaped-bracket examples and stray ] are text, real links on the line are checked', (t) => {
  const file = fixture(t, 'Write \\[example](missing.md) or ](also-missing.md); see [guide](docs/guide.md) and [bad](gone.md).\n');
  const r = checkFile(file);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), ['gone.md (file not found)']);
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

// The rendered text of each heading below is what GitHub's markdown API returned
// for it (2026-10-28); the slug is GitHub's slugger applied to that text.
test('slugify: follows GitHub on underscores, code, emphasis and punctuation', () => {
  const cases = [
    ['foo_bar', 'foo_bar'],
    ['`snake_case` in code', 'snake_case-in-code'],
    ['_emph_ word', 'emph-word'],
    ['__strong__ word', 'strong-word'],
    ['a _b_ c', 'a-b-c'],
    ['_private', '_private'],
    ['snake_case_name and more_', 'snake_case_name-and-more_'],
    ['**bold** and *it*', 'bold-and-it'],
    ['🚀 Launch', '-launch'],
    ['Café déjà vu', 'café-déjà-vu'],
    ['Use `--strict` mode', 'use---strict-mode'],
    ['[Link text](https://example.com) here', 'link-text-here'],
    ['<kbd>Ctrl</kbd> key', 'ctrl-key'],
    ["What's new? (v2.0)", 'whats-new-v20'],
    ['Two  spaces', 'two--spaces'],
    ['A & B', 'a--b'],
    ['Use `<file>`', 'use-file'],
    ['Pass `[a](b)` here', 'pass-ab-here'],
    ['Use ` x ` mode', 'use-x-mode'],
    ['[`run`](https://example.com) it', 'run-it'],
    ['See <https://example.com>', 'see-httpsexamplecom'],
    ['Note <!-- hidden --> this', 'note--this'],
    ['A &amp; B', 'a--b'],
    ['Caf&#233; &#x26; more', 'café--more'],
    ['`&amp;` code', 'amp-code'],
    ['&copy; 2026', '-2026'],
    ['\\&amp; escaped', 'amp-escaped'],
    ['![logo](x.png) Title', '-title'],
    ['\\_private\\_ name', '_private_-name'],
    ['\\<b>tag\\</b> text', 'btagb-text'],
    ['[a\\]b](x.md) link', 'ab-link'],
    ['_a\\_b_ word', 'a_b-word'],
    ['\\\\&amp; double', '-double'],
    ['`\\&amp;` code', 'amp-code'],
    ['a&#92;&amp;b heading', 'ab-heading'],
  ];
  for (const [heading, slug] of cases) assert.equal(slugify(heading), slug, heading);
});

test('slugify: a named reference outside the table gives no slug, not a guess', () => {
  // GitHub renders &frac12; as a character and leaves &bogus; as written; with
  // no table of every name the checker cannot tell which, so it claims neither.
  assert.equal(slugify('Half &frac12; cup'), null);
  assert.equal(slugify('&bogus; name'), null);
});

test('targetsOf: destinations with parentheses, brackets, titles and escapes', () => {
  const src = [
    '[a](x(1).md) [b](<y z.md>) [c](w.md \'t\') [d](v.md (t)) [e](\\(u\\).md)',
    '[f](q(.md) [g](a&amp;b.md) [h\\](h.md) <img src=\'s.png\'> <a href="r&#46;md">r</a>',
    '',
  ].join('\n');
  assert.deepEqual(targetsOf(src).map((x) => x.t), ['x(1).md', 'y z.md', 'w.md', 'v.md', '(u).md', 'a&b.md', 's.png', 'r.md']);
});

test('checkFile: a file name with parentheses resolves, a missing one fails', (t) => {
  const file = fixture(t, '[a](docs/guide(v2).md) [b](<docs/guide(v2).md>) [c](docs/guide(v2).md#v2 "t") [d](docs/gone(v2).md)\n');
  writeFileSync(path.join(path.dirname(file), 'docs', 'guide(v2).md'), '# V2\n');
  const r = checkFile(file);
  assert.equal(r.checked, 4);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), ['docs/gone(v2).md (file not found)']);
});

test('targetsOf: whitespace may lead a bare or <...> destination', () => {
  const src = '[a]( x.md ) [b](  <y z.md>  "t") [c](\tw.md\t)\n';
  assert.deepEqual(targetsOf(src).map((x) => x.t), ['x.md', 'y z.md', 'w.md']);
});

test('checkFile: a whitespace-led link resolves, a missing one fails', (t) => {
  const file = fixture(t, '[a]( docs/guide.md ) [b]( <docs/guide.md#custom> ) [c]( missing.md )\n');
  const r = checkFile(file);
  assert.equal(r.checked, 3);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), ['missing.md (file not found)']);
});

test('slugify: a link or image destination with parentheses leaves only the text', () => {
  assert.equal(slugify('[Guide](docs/guide(v2).md)'), 'guide');
  assert.equal(slugify('![logo](img/a(1).png) Title'), '-title');
  assert.equal(slugify('[A](a(1).md) and [B]( b.md "t")'), 'a-and-b');
});

test('checkFile: a heading linking to a parenthesized file slugs by its text', (t) => {
  const file = fixture(t, '## [Guide](docs/guide(v2).md)\n\n[jump](#guide) [bad](#guidemd)\n');
  writeFileSync(path.join(path.dirname(file), 'docs', 'guide(v2).md'), '# V2\n');
  assert.deepEqual(checkFile(file).failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    '#guidemd (no heading or anchor "#guidemd" in this file)',
  ]);
});

// Each href below is what GitHub's markdown API served for the destination
// (2026-10-28): references are decoded first, backslash escapes undone after.
test('targetsOf: references and escapes in a destination undo in GitHub order', () => {
  const src = [
    '[k](c&#92;&amp;d.md) [l](c&#92;_d.md) [m](e\\&#95;f.md) [n](a\\&amp;b.md)',
    '[o](<g\\&amp;h.md>) [esc\\\\](q.md)',
    '[r]: i\\&amp;j.md',
    '',
  ].join('\n');
  assert.deepEqual(targetsOf(src).map((x) => x.t), ['c&d.md', 'c_d.md', 'e_f.md', 'a&b.md', 'g&h.md', 'q.md', 'i&j.md']);
});

test('checkFile: an escaped & is literal in a heading, and a destination decodes before it unescapes', (t) => {
  const file = fixture(t, [
    '## \\&amp; escaped',
    '',
    '[h](#amp-escaped) [g](#-escaped) [x](docs/a\\&amp;b.md) [y](docs/a&amp;amp;b.md)',
    '',
  ].join('\n'));
  writeFileSync(path.join(path.dirname(file), 'docs', 'a&b.md'), '# A\n');
  const r = checkFile(file);
  assert.equal(r.checked, 4);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    '#-escaped (no heading or anchor "#-escaped" in this file)',
    'docs/a&amp;b.md (file not found)',
  ]);
});

test('checkFile: headings and anchors match after character references decode', (t) => {
  const file = fixture(t, [
    '## A &amp; B',
    '',
    '## Half &frac12; cup',
    '',
    '<a class="x" id=\'single\'></a>',
    '',
    '[good](#a--b) [bad](#a-amp-b) [q](#single) [h1](#half--cup) [h2](#half-frac12-cup)',
    '',
  ].join('\n'));
  assert.deepEqual(checkFile(file).failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    '#a-amp-b (no heading or anchor "#a-amp-b" in this file)',
    '#half--cup (no heading or anchor "#half--cup" in this file)',
    '#half-frac12-cup (no heading or anchor "#half-frac12-cup" in this file)',
  ]);
});

test('targetsOf: a backtick run with no closer of its length is literal', () => {
  // `` opens nothing here (no later run of exactly two), so the link renders.
  // A run never starts mid-run: the second backtick of `` cannot pair with `.
  assert.deepEqual(targetsOf('`` [bad](missing.md) `\n').map((x) => x.t), ['missing.md']);
  assert.deepEqual(targetsOf('`` a ` [hid](x.md) `` [b](b.md)\n').map((x) => x.t), ['b.md']);
  assert.deepEqual(targetsOf('\\`[c](c.md)\\` and \\``[d](d.md)`\n').map((x) => x.t), ['c.md']);
});

test('checkFile: a link hidden by mismatched backticks is still checked', (t) => {
  const file = fixture(t, '`` [bad](missing.md) `\n');
  assert.deepEqual(checkFile(file).failures.map((m) => m.replace(/^.*:\d+ → /, '')), ['missing.md (file not found)']);
});

test('checkFile: a repeated slug skips suffixes already taken', (t) => {
  const file = fixture(t, [
    '# Setup',
    '# Setup',
    '# Setup-1',
    '# Setup',
    '',
    '[a](#setup) [b](#setup-1) [c](#setup-1-1) [d](#setup-2) [e](#setup-3)',
    '',
  ].join('\n'));
  assert.deepEqual(checkFile(file).failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    '#setup-3 (no heading or anchor "#setup-3" in this file)',
  ]);
});

test('checkFile: a heading with angle brackets in code links by its code text', (t) => {
  const file = fixture(t, '## Use `<file>`\n\n[a](#use-file) [b](#use-)\n');
  assert.deepEqual(checkFile(file).failures.map((m) => m.replace(/^.*:\d+ → /, '')), [
    '#use- (no heading or anchor "#use-" in this file)',
  ]);
});

test('checkFile: links to headings with literal underscores resolve', (t) => {
  const file = fixture(t, '## foo_bar\n\n## `snake_case` here\n\n[a](#foo_bar) [b](#snake_case-here)\n');
  assert.deepEqual(checkFile(file), { checked: 2, failures: [] });
});

test('proseLines: a fence closes only on the same character, at least as long, alone', () => {
  const src = [
    '````md',     // 0 opens a 4-backtick fence
    '```',        // 1 shorter: stays inside
    '``` x',      // 2 trailing text: stays inside
    '~~~~',       // 3 other character: stays inside
    '`````',      // 4 longer, same character: closes
    'prose',      // 5
    '~~~',        // 6 opens a tilde fence
    '```',        // 7 other character: stays inside
    '~~~~',       // 8 closes
    '``` a`b',    // 9 backtick in the info string: not a fence
    '',
  ].join('\n');
  assert.deepEqual(proseLines(src).map((x) => x.i), [5, 9, 10]);
});

test('checkFile: a nested fence neither hides nor exposes links', (t) => {
  const file = fixture(t, [
    '````md',
    '```',
    '[example](missing.md)',
    '```',
    '````',
    '',
    '~~~',
    '```',
    '[also](missing-too.md)',
    '~~~',
    '',
    '[real](gone.md) [fine](docs/guide.md)',
    '',
  ].join('\n'));
  const r = checkFile(file);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.failures.map((m) => m.replace(/^.*:\d+ → /, '')), ['gone.md (file not found)']);
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
