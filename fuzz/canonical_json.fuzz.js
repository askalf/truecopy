// Fuzz the content hasher and its canonical-JSON serializer — the function that
// turns a skill / tool definition into the bytes canon pins and drift-checks.
// Its fail-safe contract is absolute: it must NEVER throw on hostile input (a
// circular ref, a BigInt, a prototype-named key, deeply nested junk), it must
// always return a STRING, and sha256() over that string must always be 64 hex
// chars. A throw here is a denial-of-service on pin/verify; a non-string breaks
// hashing outright.
import { canonicalJson, sha256 } from '../src/hash.mjs';

export function fuzz(data) {
  const s = data.toString('utf8');
  // Derive a variety of JS values from the bytes so the serializer sees more than
  // strings: a parsed JSON value when it parses, plus deliberately hostile shapes
  // (a circular ref, a computed __proto__ own-key, a BigInt) keyed off the input.
  const values = [s, s.length, null, undefined];
  try { values.push(JSON.parse(s)); } catch {}
  values.push({ [s.slice(0, 32)]: s, ['__proto__']: s, nested: { a: [s, s.length] } });
  const circ = { s }; circ.self = circ; values.push(circ);
  const circArr = [s]; circArr.push(circArr); values.push(circArr);   // arrays cycle too
  if (s.length) { try { values.push(BigInt(s.length)); } catch {} }

  // DEPTH is the one hostile shape the corpus cannot stumble into — reaching
  // ~2,000 levels by random mutation effectively never happens, which is why
  // this target ran green for months while the recursive serializer died there
  // on a 15 KB tools/list. Derive the depth from the input so every run crosses
  // the old cliff instead of hoping a mutation finds it.
  const depth = 1 + (data.length * 37) % 4000;
  let obj = {}; const objRoot = obj;
  let arr = []; const arrRoot = arr;
  for (let i = 0; i < depth; i++) {
    obj.a = {}; obj = obj.a;
    const next = []; arr.push(next); arr = next;
  }
  values.push(objRoot, arrRoot);

  for (const v of values) {
    const j = canonicalJson(v);
    if (typeof j !== 'string') {
      throw new Error(`canonicalJson returned ${typeof j} for ${JSON.stringify(String(v).slice(0, 64))}`);
    }
    const h = sha256(j);
    if (!/^[0-9a-f]{64}$/.test(h)) {
      throw new Error(`sha256 produced a non-hex digest: ${JSON.stringify(h)}`);
    }
  }
}
