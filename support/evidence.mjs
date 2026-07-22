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
// mid-escape and keep an opening backslash whose partner sits outside the
// window. That is the real cause of the live watch's `evidenceMismatches: 2`:
// both are SENSITIVE_PATH hits of `.aws\` on a Python list entry reading
// `".aws",`, where the trailing backslash is the one JSON added to escape the
// FOLLOWING quote.
//
// We deliberately DO NOT trim that backslash and retry. Trimming turns the
// needle into a four-byte FRAGMENT of the real match, and a fragment locates in
// places that have nothing to do with the finding -- when tried, both hits
// resolved to `.aws` inside an ordinary `docs.aws.amazon.com` documentation URL
// and would have been published as evidence of a sensitive-path reference.
//
// A citation that looks verified but points at the wrong line is worse than an
// honest "could not verify": the whole value of this feed is that evidence
// corresponds to the finding. So only the EXACT match, or its faithful
// unescaping, may be located. Anything else stays a counted mismatch until the
// detector can report the match OFFSET, which resolves it exactly (see #99).

export function locate(match, pieces) {
  for (const cand of [match, jsonUnescape(match)]) {
    if (!cand) continue;
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
