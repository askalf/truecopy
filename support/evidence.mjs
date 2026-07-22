// Evidence assembly + confabulation self-check for the marketplace watch.
//
// For each finding hit (redstamp now returns { flag, match } per hit), locate the
// matched substring in the pinned source pieces and VERIFY it is really there,
// returning its file + 1-based line. A hit that cannot be found in the bytes is
// DROPPED and counted (`mismatches`). So the published evidence — and therefore the
// site — can only ever show a fragment that provably exists at the linked line;
// the detector cannot surface a match the source does not contain. A nonzero total
// is itself a signal (a detector claim the bytes don't support) and is published.

import { scanTextOf } from '@askalf/redstamp/mcp';
import { joinScanText, PIECE_JOIN } from '../src/skill.mjs';
import { locateByOffset, hitIsOutsideDescription } from './offset-map.mjs';

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
// Resolve a finding's hits against the scan target that produced them, so an
// offset can be interpreted in the coordinate space it belongs to.
function targetFor(skill, finding) {
  const targets = (skill && skill.scanTargets) || [];
  if (targets.length === 1) return targets[0];
  return targets.find((t) => t && t.name === (finding && finding.tool)) || null;
}

export function evidenceOf(items, skill) {
  const evidence = [];
  let mismatches = 0;
  const pieces = (skill && skill.scanPieces) || [];
  const joined = joinScanText(pieces);

  for (const f of (items || [])) {
    const target = targetFor(skill, f);
    // Offsets are only meaningful if the text the detector scanned really is
    // the pieces we are about to cite. If the target was assembled some other
    // way, fall back rather than map into the wrong coordinate space.
    const mappable = !!target && typeof target.description === 'string' && target.description === joined;
    const scanText = mappable ? scanTextOf(target) : null;

    for (const h of ((f && f.hits) || [])) {
      if (!h || typeof h.match !== 'string' || !h.match) continue;

      // Preferred path: locate by OFFSET. This is exact -- it cites the place
      // the detector actually matched, even when the match spans a quote or a
      // sliced escape, and it cannot drift onto a coincidental occurrence.
      if (mappable && typeof h.start === 'number') {
        const at = locateByOffset(h, { scanText, description: target.description, pieces, join: PIECE_JOIN });
        if (at) { evidence.push({ flag: h.flag, text: cap(at.text), file: at.file, line: at.line }); continue; }
        // A hit can legitimately match a field that is not a scanned FILE — a
        // tool's own `name`, for instance (`memory-leak-debugging` matches
        // 'exfiltration intent' on "leak"). Real, supported by the bytes, and
        // simply not citable to a line. `mismatches` is the confabulation alarm,
        // so that case must not inflate it — otherwise the alarm sits
        // permanently above zero and everyone learns to ignore it.
        if (hitIsOutsideDescription(h, { scanText, description: target.description })) continue;
        // Offsets were present and should have attributed, but did not. Do NOT
        // fall back to a text search: that is what produced citations pointing at
        // unrelated lines (#100). An honest mismatch beats a confident wrong line.
        mismatches++;
        continue;
      }

      // Compatibility path for a detector that predates offsets: locate the
      // EXACT match text. Still safe -- the published text provably occurs --
      // though it cites the first occurrence rather than the match site.
      const loc = locate(h.match, pieces);
      if (loc) evidence.push({ flag: h.flag, text: cap(loc.text ?? h.match), file: loc.file, line: loc.line });
      else mismatches++;
    }
  }
  return { evidence, mismatches };
}
