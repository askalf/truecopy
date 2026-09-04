// watch-issues.mjs formats attacker-influenced text into a GFM table: the
// "matched text" column is a slice of whatever bytes a vendor shipped. Both ways
// that goes wrong are silent — the issue renders as garbage, or the row breaks
// and the evidence is unreadable — so the escaping is pinned here.
//
// CodeQL js/incomplete-sanitization caught the second one on the first cut of
// this file (alert #29): escaping `|` while leaving `\` alone turns source text
// that already reads `\|` into `\\|` — an escaped backslash then a BARE pipe —
// and the row gains a column. Skill docs are markdown full of tables, so `\|`
// arrives routinely.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GITHUB_REPOSITORY ??= 'askalf/truecopy';
const { cell, code, titleFor, body } = await import('./watch-issues.mjs');

// How GFM decides a row's columns: split on a `|` that is NOT escaped, i.e. one
// preceded by an even number of backslashes. Mirrors the parser, so a cell that
// would break a real table breaks this too.
function columns(row) {
  const out = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\') {
      cur += row[i + 1] ?? '';
      i++;
      continue;
    }
    if (ch === '|') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const row = (...cells) => `| ${cells.join(' | ')} |`;

test('a cell ending in a backslash cannot escape the row delimiter', () => {
  // Three columns plus the empty edges = 5.
  const r = row(cell('flag'), code('C:\\path\\'), code('x'));
  assert.equal(columns(r).length, 5, `row split wrong: ${r}`);
});

test('backslashes not adjacent to a pipe are left alone', () => {
  // Blanket doubling would satisfy the scanner and corrupt the evidence: inside
  // a code span the table extension unescapes `\|` but not `\\`, so `C:\path`
  // would render as `C:\\path` to whoever is triaging.
  assert.equal(cell('C:\\path\\'), 'C:\\path\\');
  assert.equal(cell('\\d+ \\w*'), '\\d+ \\w*');
});

test('a raw pipe in matched text stays inside its cell', () => {
  const r = row(cell('flag'), code('a | b'), code('grep -E "x|y"'));
  assert.equal(columns(r).length, 5, `row split wrong: ${r}`);
});

test('an already-escaped pipe in the source stays inside its cell', () => {
  // Skill docs are markdown and contain tables, so `\|` shows up verbatim.
  const r = row(cell('flag'), code('a \\| b'), code('x'));
  assert.equal(columns(r).length, 5, `row split wrong: ${r}`);
});

test('backslash doubling runs before pipe escaping, not after', () => {
  // Wrong order double-escapes the backslash this rule inserts, leaving the
  // pipe bare again.
  assert.equal(cell('a|b'), 'a\\|b');
});

test('newlines collapse — a row is one line', () => {
  assert.ok(!cell('a\nb').includes('\n'));
  assert.ok(!cell('a\r\nb').includes('\r'));
});

test('code() widens the fence past the longest backtick run', () => {
  // The mp-integrate line that broke the first cut: a single-backtick span
  // closes on the first inner backtick and renders as garbage.
  const t = code('Copy it, fill in `.env`, run `npm install`');
  assert.ok(t.startsWith('``') && t.endsWith('``'), t);
  const triple = code('a ``` b');
  assert.ok(triple.startsWith('````'), triple);
});

test('code() pads when the content itself starts or ends with a backtick', () => {
  const t = code('`x`');
  assert.ok(t.startsWith('`` `') && t.endsWith('` ``'), t);
});

test('code() of empty input is empty, not a bare fence', () => {
  assert.equal(code(''), '');
  assert.equal(code(null), '');
});

test('the title is stable and carries the skill name — it is the dedup key', () => {
  assert.equal(titleFor('acme:x'), 'watch triage: acme:x — flagged, awaiting review');
});

test('the body never calls a flagged skill poisoned, and says so', () => {
  const b = body({
    name: 'acme:x',
    findings: ['data-exfil (paraphrased)'],
    evidence: [{ flag: 'f', file: 'a.md', line: 1, text: 'fill in `.env`' }],
    triage: { files: { 'a.md': 'deadbeef' }, attributable: true },
  });
  assert.ok(b.includes('detector hit, not a verdict'), 'missing the under-review framing');
  assert.ok(!/\bpoisoned\b/.test(b.replace(/Do not describe this skill as poisoned[^.]*\./, '')),
    'body asserts a verdict it has not earned');
  assert.ok(b.includes('watch-accepted.json'), 'missing the acceptance path');
  assert.ok(b.includes('SECURITY.md'), 'missing the disclosure path');
  // Every evidence row must have the same column count as its header.
  const rows = b.split('\n').filter((l) => l.startsWith('| '));
  const widths = new Set(rows.map((l) => columns(l).length));
  assert.equal(widths.size, 1, `evidence table rows disagree on width: ${[...widths]}`);
});

test('a non-attributable entry warns that per-file acceptance will be refused', () => {
  const b = body({ name: 'acme:x', findings: [], evidence: [], triage: { attributable: false } });
  assert.ok(b.includes('not attributable'), 'missing the non-attributable warning');
});
