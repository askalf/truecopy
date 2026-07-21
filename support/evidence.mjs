// Evidence assembly + confabulation self-check for the marketplace watch.
//
// For each finding hit (redstamp now returns { flag, match } per hit), locate the
// matched substring in the pinned source pieces and VERIFY it is really there,
// returning its file + 1-based line. A hit that cannot be found in the bytes is
// DROPPED and counted (`mismatches`). So the published evidence — and therefore the
// site — can only ever show a fragment that provably exists at the linked line;
// the detector cannot surface a match the source does not contain. A nonzero total
// is itself a signal (a detector claim the bytes don't support) and is published.

export const EVIDENCE_CAP = 160;

const cap = (s) => (s.length > EVIDENCE_CAP ? s.slice(0, EVIDENCE_CAP - 1) + '…' : s);

// First source piece containing `match`, with the 1-based line the match starts on.
export function locate(match, pieces) {
  for (const p of (pieces || [])) {
    const text = p && typeof p.text === 'string' ? p.text : '';
    const idx = text.indexOf(match);
    if (idx >= 0) return { file: p.path, line: (text.slice(0, idx).match(/\n/g) || []).length + 1 };
  }
  return null;
}

// items: an array of redstamp findings (each may carry hits:[{flag,match}]).
// → { evidence: [{flag,text,file,line}], mismatches: <count dropped as unverifiable> }
export function evidenceOf(items, skill) {
  const evidence = [];
  let mismatches = 0;
  for (const f of (items || [])) {
    for (const h of ((f && f.hits) || [])) {
      if (!h || typeof h.match !== 'string' || !h.match) continue;
      const loc = locate(h.match, skill && skill.scanPieces);
      if (loc) evidence.push({ flag: h.flag, text: cap(h.match), file: loc.file, line: loc.line });
      else mismatches++;
    }
  }
  return { evidence, mismatches };
}
