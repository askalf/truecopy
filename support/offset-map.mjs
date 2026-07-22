// Map a detector match OFFSET back to the source piece and line it came from.
//
// The detector matches against a JSON-stringified, newline-normalized view of a
// scan target (redstamp's `scanTextOf`), so a hit's `start`/`end` index into
// THAT string -- not into any file. Reversing it is the only way to cite the
// place the detector actually matched.
//
// Why offsets rather than re-searching for the matched text (see #99):
//   - a short match recurs. A bare sensitive-path token appeared 73 times across
//     9 files in one real marketplace skill, so "first occurrence" can cite a
//     line that has nothing to do with the finding.
//   - a match window can slice a JSON escape in half, keeping the opening
//     backslash while its partner sits outside the window. That text exists in
//     no file and is unfindable by search.
//
// The transform is NOT invertible after the fact: escaping is not 1:1 and the
// newline normalization is lossy (a literal backslash-n in the source becomes a
// backslash followed by a real newline). So we build it FORWARDS instead,
// recording which source index produced each emitted character.

// JSON.stringify's string escapes. Anything else below U+0020 becomes \uXXXX.
const ESCAPES = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** Escape `src` as JSON would, recording the source index behind each output char. */
function escapeWithMap(src) {
  let out = '';
  const map = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    let piece = ESCAPES[ch];
    if (piece === undefined) {
      const code = ch.charCodeAt(0);
      piece = code < 0x20 ? '\\u' + code.toString(16).padStart(4, '0') : ch;
    }
    for (let k = 0; k < piece.length; k++) map.push(i);
    out += piece;
  }
  return { text: out, map };
}

/** Apply the scanner's newline normalization, keeping the index map in step.
 *  Each collapsed escape sequence yields one character, attributed to the
 *  source index that opened it. */
function normalizeWithMap(text, map) {
  let out = '';
  const outMap = [];
  const re = /\\r\\n|\\n|\\r/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    for (let i = last; i < m.index; i++) { out += text[i]; outMap.push(map[i]); }
    out += '\n';
    outMap.push(map[m.index]);
    last = m.index + m[0].length;
  }
  for (let i = last; i < text.length; i++) { out += text[i]; outMap.push(map[i]); }
  return { text: out, map: outMap };
}

/** The scanned form of `description` plus an index map back into it.
 *  Returns null if our escaping does not reproduce JSON.stringify exactly --
 *  fail safe rather than emit a citation from a mapping we cannot trust. */
export function scannedDescription(description) {
  const escaped = escapeWithMap(description);
  // Cross-check against the real serializer. If they disagree (an exotic code
  // point, a lone surrogate, a future engine change), refuse to map rather than
  // guess: an unlocatable hit is counted honestly, a wrong one is not.
  if (JSON.stringify(description).slice(1, -1) !== escaped.text) return null;
  return normalizeWithMap(escaped.text, escaped.map);
}

/** Resolve an index within the joined description to its piece and 1-based line.
 *  Returns null when the index lands inside the join separator, which belongs to
 *  no file. */
export function pieceAt(descIndex, pieces, join) {
  let acc = 0;
  for (const p of (pieces || [])) {
    const body = p && typeof p.text === 'string' ? p.text : '';
    const end = acc + body.length;
    if (descIndex < end) {
      const line = (body.slice(0, descIndex - acc).match(/\n/g) || []).length + 1;
      return { file: p.path, line };
    }
    acc = end + join.length;
    if (descIndex < acc) return null; // inside the separator between two pieces
  }
  return null;
}

/** Does this hit's span fall inside the DESCRIPTION's region of the scan text?
 *
 *  A detector can legitimately match a field that is not the scanned files at
 *  all. Real case: `chrome-devtools-mcp:memory-leak-debugging` matches
 *  'exfiltration intent' on the substring "leak" — inside the tool's own NAME,
 *  at offset 16, well before the description begins.
 *
 *  Such a hit is REAL and fully supported by the bytes; it simply has no file
 *  and line to cite. That is a different thing from a detector claiming
 *  something the bytes do not contain, and only the latter belongs in
 *  `evidenceMismatches` — a counter whose whole job is to be an alarm. Folding
 *  the former in would pin it permanently above zero and train everyone to
 *  ignore it. Returns false when the answer cannot be established, so an
 *  undecidable case still counts as a mismatch (fail loud, not quiet). */
export function hitIsOutsideDescription(hit, { scanText, description }) {
  if (!hit || typeof hit.start !== 'number' || typeof hit.end !== 'number') return false;
  if (typeof scanText !== 'string' || typeof description !== 'string') return false;
  const scanned = scannedDescription(description);
  if (!scanned) return false;
  const delta = scanText.indexOf(scanned.text);
  if (delta < 0) return false;
  if (scanText.indexOf(scanned.text, delta + 1) >= 0) return false; // ambiguous: don't claim
  return hit.start < delta || hit.end > delta + scanned.text.length;
}

/** Locate a hit by offset.
 *
 *  `scanText` is the exact string the detector matched against (redstamp's
 *  scanTextOf). The description's scanned form is located inside it, which
 *  yields the delta between the two coordinate spaces without this module
 *  needing to know how the surrounding object was serialized -- key order,
 *  extra fields and future shape changes are all irrelevant.
 *
 *  Returns { file, line, text } where `text` is the real source substring, or
 *  null if the offset cannot be attributed. Null is a normal outcome and must
 *  be counted, never guessed around. */
export function locateByOffset(hit, { scanText, description, pieces, join }) {
  if (!hit || typeof hit.start !== 'number' || typeof hit.end !== 'number') return null;
  if (typeof scanText !== 'string' || typeof description !== 'string') return null;

  const scanned = scannedDescription(description);
  if (!scanned) return null;

  const delta = scanText.indexOf(scanned.text);
  if (delta < 0) return null;                       // description not found verbatim: refuse
  if (scanText.indexOf(scanned.text, delta + 1) >= 0) return null; // ambiguous: refuse

  const rel = hit.start - delta;
  const relEnd = hit.end - delta;
  if (rel < 0 || relEnd > scanned.map.length) return null;         // match sits outside the description

  const from = scanned.map[rel];
  // `end` is exclusive; the last mapped char is at relEnd-1.
  const toChar = scanned.map[relEnd - 1];
  if (from === undefined || toChar === undefined) return null;

  const at = pieceAt(from, pieces, join);
  if (!at) return null;

  // The REAL source bytes spanned by the match, not the escaped form.
  const text = description.slice(from, toChar + 1);

  // Final invariant: the text we are about to cite must occur verbatim in the
  // file we are about to cite it in. Today the separator contains both a
  // newline and a period, so the clause-bounded detectors cannot span two
  // pieces and this always holds -- but it holds by accident of the separator's
  // content, not by construction. A future pattern that is not clause-bounded
  // would otherwise publish text straddling the join, which exists in no file.
  // Check it rather than rely on that coincidence.
  const cited = (pieces || []).find((p) => p && p.path === at.file);
  if (!cited || typeof cited.text !== 'string' || !cited.text.includes(text)) return null;

  return { ...at, text };
}
