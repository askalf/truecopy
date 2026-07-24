// Content hashing + stable JSON, so a skill's identity is its bytes — not the
// order a tool happened to serialize its keys in.
import crypto from 'node:crypto';

export const sha256 = (s) =>
  crypto.createHash('sha256')
    .update(Buffer.isBuffer(s) ? s : typeof s === 'string' ? s : String(s ?? ''))
    .digest('hex');

const CIRCULAR = JSON.stringify('[circular]');
// Values JSON drops: omitted as an object member, `null` as an array element.
const drops = (x) => x === undefined || typeof x === 'function' || typeof x === 'symbol';
// A leaf's own serialization. BigInt has no JSON form, so it is stringified
// first (as it always was) rather than throwing.
const leaf = (x) => (typeof x === 'bigint' ? JSON.stringify(x.toString()) : JSON.stringify(x));

// An ARRAY INDEX in the JS property-order sense: a canonical numeric string in
// [0, 2^32-1). "01", "1.5", "-1" and "4294967295" are ordinary string keys.
const isIndexKey = (k) => /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < 4294967295;

/** Positions of `keys` in EMIT order — which is not their traversal order.
 *
 *  The recursive form sorted an object's keys and then rebuilt an object from
 *  them, so JS property ordering hoisted integer-like keys to the front in
 *  ascending numeric order regardless of insertion: `{ "b":1, "0":2 }`
 *  canonicalized as `{"0":2,"b":1}`, with "0" first even though "0" (0x30) sorts
 *  after '"' or '!'. Emitting text directly skips that rebuild, so the hoist has
 *  to be reproduced explicitly — otherwise every lock entry holding a
 *  numeric-string key (a JSON-schema `enum` map, a positional tool arg, an
 *  `items` tuple) silently changes hash and verifies as `drifted`. */
function emitOrder(keys) {
  const index = [], rest = [];
  for (let i = 0; i < keys.length; i++) (isIndexKey(keys[i]) ? index : rest).push(i);
  index.sort((a, b) => Number(keys[a]) - Number(keys[b]));
  return index.concat(rest);
}

/** Walk `v` and build a shadow tree, marking cycles as it goes.
 *  Traversal is depth-first in PLAIN SORTED key order — deliberately not the
 *  emit order above. Which of two references to the same object is the one
 *  stamped "[circular]" depends on visit order, so the two orders have to stay
 *  separate to keep hashes stable (the differential test pins this). */
function build(v) {
  // Objects: a WeakSet that is never cleared, so a SHARED reference — not just a
  // cyclic one — becomes "[circular]" on its second visit. Long-standing
  // behavior, baked into every lock file already written: preserved exactly.
  const seen = new WeakSet();
  // Arrays were never tracked at all, so `a = []; a.push(a)` recursed until the
  // stack blew. They get an ANCESTORS-only check: a true cycle terminates, while
  // a shared (non-cyclic) array still serializes in full, exactly as today.
  // Anything this changes is an input that currently throws — no hash moves.
  const onPath = new Set();

  const root = [null];
  const work = [{ target: root, idx: 0, value: v }];
  while (work.length) {
    const w = work.pop();
    if (w.release !== undefined) { onPath.delete(w.release); continue; }
    const x = w.value;

    if (Array.isArray(x)) {
      if (onPath.has(x)) { w.target[w.idx] = { t: 'leaf', s: CIRCULAR }; continue; }
      onPath.add(x);
      const node = { t: 'arr', kids: new Array(x.length).fill(null) };
      w.target[w.idx] = node;
      work.push({ release: x });                   // pops after every child: closes the ancestor scope
      for (let i = x.length - 1; i >= 0; i--) {     // reversed in, so children pop in index order
        const el = x[i];                            // a hole reads as undefined → `null`, as JSON does
        if (drops(el)) node.kids[i] = { t: 'leaf', s: 'null' };
        else work.push({ target: node.kids, idx: i, value: el });
      }
      continue;
    }

    if (x && typeof x === 'object') {
      if (seen.has(x)) { w.target[w.idx] = { t: 'leaf', s: CIRCULAR }; continue; }
      seen.add(x);
      const keys = Object.keys(x).sort();
      const vals = keys.map((k) => x[k]);           // read each property exactly once
      const node = { t: 'obj', keys, kids: new Array(keys.length).fill(null) };
      w.target[w.idx] = node;
      for (let i = keys.length - 1; i >= 0; i--) {
        if (drops(vals[i])) node.kids[i] = { t: 'drop' };
        else work.push({ target: node.kids, idx: i, value: vals[i] });
      }
      continue;
    }

    // Leaf. A dropped value reaches here only as the ROOT (members and elements
    // are handled above), and JSON.stringify(undefined) is undefined — which the
    // old form turned into '' via `?? ''`.
    const s = leaf(x);
    w.target[w.idx] = { t: 'leaf', s: s === undefined ? '' : s };
  }
  return root[0];
}

/** Render the shadow tree. Also iterative: JSON.stringify recurses too, and blew
 *  the stack at the same depth the walk did. */
function render(root) {
  const parts = [];
  const work = [root];
  while (work.length) {
    const w = work.pop();
    if (typeof w === 'string') { parts.push(w); continue; }
    if (w.t === 'leaf') { parts.push(w.s); continue; }

    const items = [];
    if (w.t === 'arr') {
      for (let i = 0; i < w.kids.length; i++) { if (i) items.push(','); items.push(w.kids[i]); }
      parts.push('[');
      work.push(']');
    } else {
      let n = 0;
      for (const i of emitOrder(w.keys)) {
        if (w.kids[i].t === 'drop') continue;
        if (n++) items.push(',');
        items.push(JSON.stringify(w.keys[i]) + ':');
        items.push(w.kids[i]);
      }
      parts.push('{');
      work.push('}');
    }
    for (let i = items.length - 1; i >= 0; i--) work.push(items[i]);
  }
  return parts.join('');
}

/** Deterministic JSON: object keys sorted recursively (arrays keep order).
 *  Fail-safe on hostile input — a circular ref becomes "[circular]" and a BigInt
 *  is stringified, so hashing a malformed tool definition can't throw.
 *
 *  ITERATIVE, and that is a security property rather than a style choice. The
 *  recursive form (a `sort` walk feeding JSON.stringify, both of which recurse)
 *  overflowed the stack at ~2,000 levels of nesting — and this function sits on
 *  the runtime trust boundary: gateTools() hashes every tool a downstream MCP
 *  server advertises, from inside a readline handler where nothing catches. A
 *  ~15 KB tools/list carrying a deeply nested inputSchema therefore killed the
 *  gate process outright. V8 parses that message happily, so "the JSON was
 *  valid" was no defense. Depth now costs heap, not call frames.
 *
 *  Deliberately NOT solved with a depth cap: truncating a subtree makes two tools
 *  that differ only below the cap hash identically — a pin-one-serve-another hole
 *  in the thing whose whole job is telling those two apart.
 *
 *  Output is byte-identical to the recursive form for every input that form could
 *  serialize; test/canonical-json-compat.test.mjs pins that against the original
 *  implementation over randomized structures. */
export function canonicalJson(v) {
  return render(build(v));
}
