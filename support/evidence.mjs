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

// The detector matches against a JSON-STRINGIFIED view of the scan target and
// un-escapes only `\n` before matching (see redstamp scanMcpTools). JSON also
// escapes `"` -> `\"`, `\` -> `\\` and TAB -> `\t`, and those are never
// reversed — so a match spanning a quote or a backslash carries escapes that do
// not exist anywhere in the source file. Those hits located nowhere and were
// silently dropped as `evidenceMismatches`, which is why the count sat at a
// stable nonzero: quoted text is extremely common in skill prose (a skill that
// QUOTES an attack string is the single most common false-positive shape).
//
// Reverse the escapes JSON added and try again. This is strictly additive: the
// literal match is tried first, the un-escaped form only as a fallback, and the
// anti-confabulation guarantee is untouched — evidence is still published ONLY
// when the text provably occurs in the pinned bytes. What changes is that a
// verifiable fragment is no longer thrown away for carrying a quote.
const JSON_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
export function jsonUnescape(s) {
  return String(s).replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_m, g) =>
    (g[0] === 'u' ? String.fromCharCode(parseInt(g.slice(1), 16)) : (JSON_ESCAPES[g] ?? g)));
}

// First source piece containing `text`, with the 1-based line it starts on.
function find(text, pieces) {
  // indexOf('') is 0 — an empty needle would "locate" in the first piece at
  // line 1 and publish a fabricated citation. Nothing may reach find() empty.
  if (!text) return null;
  for (const p of (pieces || [])) {
    const body = p && typeof p.text === 'string' ? p.text : '';
    const idx = body.indexOf(text);
    if (idx >= 0) return { file: p.path, line: (body.slice(0, idx).match(/\n/g) || []).length + 1 };
  }
  return null;
}

// A detector match is a WINDOW into the stringified text, so its edge can fall
// in the middle of an escape sequence and keep the opening backslash while its
// partner character stays outside the window. That trailing backslash exists
// nowhere in the source, and jsonUnescape cannot reverse it because a lone
// backslash is not a complete escape.
//
// This is exactly what produced the long-standing `evidenceMismatches: 2` on the
// live watch. Both were SENSITIVE_PATH hits on source that reads:
//
//     ".aws",                     (aws-core/launch-with-aws archive.py:45)
//
// stringified to `\".aws\",`, where the detector matched `.aws\` — the real four
// bytes `.aws` plus the backslash that JSON added to escape the FOLLOWING quote.
// Trailing backslashes come in pairs when the source genuinely contains one (`\\`),
// so only an ODD number of them ends in a sliced escape; strip exactly that one.
const stripSlicedEscape = (s) => {
  const tail = /\\+$/.exec(s);
  return tail && tail[0].length % 2 === 1 ? s.slice(0, -1) : s;
};

/** Locate a detector match in the pinned source. Returns the location AND the
 *  text as it actually appears in the file, so published evidence always quotes
 *  real bytes rather than an escaped intermediate.
 *
 *  Candidates are tried literal-first and each must still be found verbatim in
 *  the pinned bytes, so the anti-confabulation guarantee is unchanged: these
 *  fallbacks only stop a VERIFIABLE fragment from being discarded over an
 *  artifact of how the detector views the text. Invented text still locates
 *  nowhere and is still dropped and counted. */
export function locate(match, pieces) {
  const seen = new Set();
  for (const cand of [match, jsonUnescape(match),
                      stripSlicedEscape(match), jsonUnescape(stripSlicedEscape(match))]) {
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);
    const at = find(cand, pieces);
    if (at) return { ...at, text: cand };
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
      // publish the text as it appears in the FILE (loc.text), never the escaped form
      if (loc) evidence.push({ flag: h.flag, text: cap(loc.text ?? h.match), file: loc.file, line: loc.line });
      else mismatches++;
    }
  }
  return { evidence, mismatches };
}
