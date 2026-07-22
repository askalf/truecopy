import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanTextOf } from '@askalf/redstamp/mcp';
import { scanSkill } from '../src/scan.mjs';
import { PIECE_JOIN, joinScanText } from '../src/skill.mjs';
import { locateByOffset, pieceAt, scannedDescription } from './offset-map.mjs';
import { locate } from './evidence.mjs';

// Build a scan target the way the watch does, and return everything needed to
// resolve a hit: the real hits (with offsets), plus the coordinate spaces.
function scanPieces(pieces) {
  const description = joinScanText(pieces);
  const target = { name: 'fixture', description };
  const r = scanSkill({ kind: 'skill', name: 'fixture', scanTargets: [target] });
  const hits = [...(r.findings || []), ...(r.advisories || [])].flatMap((f) => f.hits || []);
  return { hits, ctx: { scanText: scanTextOf(target), description, pieces, join: PIECE_JOIN } };
}

// ── the defect this module exists to fix ─────────────────────────────────────
// Reproduces a real misattribution from the pinned marketplace corpus
// (aws-core:amazon-bedrock). The detector matches the word "leak" WITH word
// boundaries, so it does not match inside "leakage". `locate()` searches with
// indexOf, which has no notion of boundaries, so it lands on the earlier
// substring -- citing prose that describes a defensive security control as
// evidence of exfiltration intent.
//
// No refinement of text search fixes this: indexOf cannot reproduce a regex's
// boundaries, lookarounds or clause context. Only the offset can.
test('resolves to the MATCH SITE, not an earlier substring the regex never matched', () => {
  const pieces = [
    { path: 'controls.md', text: 'A security control that caps credential leakage and the replay window.\n' },
    { path: 'risks.md', text: 'Sensitive data can leak to users when chunks are unsanitized.\n' },
  ];
  const { hits, ctx } = scanPieces(pieces);
  const hit = hits.find((h) => h.match === 'leak');
  assert.ok(hit, `expected a bare "leak" match; got ${hits.map((h) => JSON.stringify(h.match)).join(', ')}`);

  const byOffset = locateByOffset(hit, ctx);
  assert.ok(byOffset, 'the offset must attribute');
  assert.equal(byOffset.file, 'risks.md', 'must cite the line the detector actually matched');
  assert.equal(byOffset.line, 1);

  // and demonstrate the defect it corrects: the text search lands on "leakage"
  const byText = locate(hit.match, pieces);
  assert.equal(byText.file, 'controls.md', 'text search still lands on the earlier substring');
  assert.notEqual(byText.file, byOffset.file, 'the two disagree -- that disagreement is the bug');
});

// ── escape-spanning matches ──────────────────────────────────────────────────
test('resolves a match whose window slices a JSON escape', () => {
  // A quoted path token: the scanned form carries the backslash JSON added to
  // escape the following quote, so the matched text exists in no file and is
  // unfindable by search. The offset still places it exactly.
  const pieces = [{ path: 'scripts/archive.py', text: 'dirs = [\n    ".aws",\n]\n' }];
  const { hits, ctx } = scanPieces(pieces);
  const hit = hits.find((h) => h.match.includes('.aws'));
  assert.ok(hit, 'fixture must produce a sensitive-path hit');

  const at = locateByOffset(hit, ctx);
  assert.ok(at, 'offset must attribute even though the text is unsearchable');
  assert.equal(at.file, 'scripts/archive.py');
  assert.equal(at.line, 2);
  // the published text is real source bytes, not the escaped intermediate
  assert.ok(pieces[0].text.includes(at.text), 'cited text must occur verbatim in the source');
  assert.ok(!at.text.includes('\\"'), 'must not publish the escaped form');

  assert.equal(locate(hit.match, pieces), null, 'text search cannot find it -- that is the gap');
});

// ── fail-safes: refusing beats guessing ──────────────────────────────────────
test('refuses rather than guesses when it cannot attribute', () => {
  const pieces = [{ path: 'a.md', text: 'nothing interesting here\n' }];
  const ctx = { scanText: 'irrelevant', description: joinScanText(pieces), pieces, join: PIECE_JOIN };
  // description not present in the scan text -> refuse
  assert.equal(locateByOffset({ match: 'x', start: 0, end: 1 }, ctx), null);
  // missing offsets -> refuse (caller falls back deliberately)
  assert.equal(locateByOffset({ match: 'x' }, ctx), null);
  // offsets outside the description -> refuse
  const good = { scanText: scanTextOf({ name: 'f', description: joinScanText(pieces) }), description: joinScanText(pieces), pieces, join: PIECE_JOIN };
  assert.equal(locateByOffset({ match: 'x', start: 10 ** 7, end: 10 ** 7 + 1 }, good), null);
});

test('an index inside the piece separator belongs to no file', () => {
  const pieces = [{ path: 'a.md', text: 'aaa' }, { path: 'b.md', text: 'bbb' }];
  assert.equal(pieceAt(0, pieces, PIECE_JOIN).file, 'a.md');
  assert.equal(pieceAt(3, pieces, PIECE_JOIN), null, 'first char of the separator');
  assert.equal(pieceAt(3 + PIECE_JOIN.length, pieces, PIECE_JOIN).file, 'b.md');
});

test('scannedDescription agrees with the real serializer, or refuses', () => {
  for (const s of ['plain', 'has "quotes"', 'back\\slash', 'tab\there', 'nl\nhere', 'ctrlchar', 'unicode ☠ ok']) {
    const got = scannedDescription(s);
    assert.ok(got, `must map: ${JSON.stringify(s)}`);
    assert.equal(got.map.length, got.text.length, 'index map must stay in step with the text');
  }
});
