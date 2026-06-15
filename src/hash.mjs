// Content hashing + stable JSON, so a skill's identity is its bytes — not the
// order a tool happened to serialize its keys in.
import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Deterministic JSON: object keys sorted recursively (arrays keep order). */
export function canonicalJson(v) {
  const sort = (x) =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]))
        : x;
  return JSON.stringify(sort(v));
}
