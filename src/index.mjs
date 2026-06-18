// canon — own your agent skills. Vet (scan), pin (lock + hash), and verify
// (drift) every skill & MCP server before it runs. The supply-chain gate that
// pairs with warden's runtime firewall: vet it → contain it.
import { loadSkill, skillHash } from './skill.mjs';
import { scanSkill } from './scan.mjs';
import { readLock, writeLock, DEFAULT_LOCK } from './lock.mjs';
import { signHash, verifyHashSig } from './sign.mjs';
import { sha256, canonicalJson } from './hash.mjs';

export { loadSkill, skillHash, scanSkill, readLock, writeLock, DEFAULT_LOCK };

// A per-part hash map (files of a skill dir, or tools of an MCP server), so a
// drift can be explained as added / removed / changed parts — not just "the hash moved".
function partsOf(skill) {
  if (skill.kind === 'skill') return Object.fromEntries(skill.files.map((f) => [f.path, f.hash]));
  if (skill.kind === 'mcp') {
    const parts = Object.fromEntries(skill.tools.map((t, i) => [t.name || `tool[${i}]`, sha256(canonicalJson(t))]));
    // The manifest envelope (name/instructions/command/args/env/url/…) is part of
    // the pinned identity too, so a renamed server or a swapped launch command is
    // an explainable drift, not an invisible one.
    if (skill.manifestEnvelope) parts['(manifest)'] = sha256(canonicalJson(skill.manifestEnvelope));
    return parts;
  }
  return { [skill.name]: sha256(skill.hashInput) };
}

/** Scan a source for poisoning. → { skill, verdict, findings } */
export function scan(source) {
  const skill = loadSkill(source);
  return { skill, ...scanSkill(skill) };
}

/** Pin a vetted skill into the lock. Refuses to pin a flagged skill unless force. */
export function pin(source, { lockPath = DEFAULT_LOCK, sign = false, force = false, name } = {}) {
  const skill = loadSkill(source);
  const s = scanSkill(skill);
  if (s.verdict === 'flagged' && !force) return { ok: false, reason: 'flagged', findings: s.findings, skill };
  const hash = skillHash(skill);
  const key = name || skill.name;
  const lock = readLock(lockPath);
  lock.skills[key] = {
    source: skill.source, kind: skill.kind, hash,
    scannedAt: new Date().toISOString(), verdict: s.verdict, findings: s.findings.length,
    parts: partsOf(skill),
    ...(sign ? { sig: signHash(hash), signed: true } : {}),
  };
  writeLock(lock, lockPath);
  return { ok: true, name: key, hash, verdict: s.verdict, signed: sign, skill };
}

/** Re-derive every pinned skill and classify it against the lock.
 *  Fails CLOSED on a missing or corrupt lock — a present-but-empty lock stays
 *  ok:true (legitimately nothing pinned). */
export function verify({ lockPath = DEFAULT_LOCK } = {}) {
  let lock;
  try { lock = readLock(lockPath, { mustExist: true }); }
  catch (e) { return { ok: false, error: e.message, results: [] }; }
  const results = Object.entries(lock.skills).map(([name, entry]) => verifyOne(name, entry));
  return { ok: results.every((r) => r.status === 'ok'), results };
}

function verifyOne(name, entry) {
  let skill;
  try { skill = loadSkill(entry.source); }
  catch { return { name, status: 'missing', source: entry.source }; }
  const hash = skillHash(skill);
  if (hash !== entry.hash) return { name, status: 'drifted', source: entry.source, ...diffParts(entry.parts, partsOf(skill)) };
  const s = scanSkill(skill);
  if (s.verdict === 'flagged') return { name, status: 'poisoned', source: entry.source, findings: s.findings };
  // A signature that was STRIPPED from a signed entry must still fail: trust the
  // recorded `signed` flag, not just a present `sig`, so deleting `sig` doesn't
  // downgrade a tamper-stamped entry to "unsigned-but-ok".
  if ((entry.signed || entry.sig) && !verifyHashSig(hash, entry.sig)) return { name, status: 'unsigned', source: entry.source };
  return { name, status: 'ok', source: entry.source, signed: !!entry.sig };
}

/** What changed in a source since it was pinned. */
export function diff(source, { lockPath = DEFAULT_LOCK, name } = {}) {
  const skill = loadSkill(source);
  const key = name || skill.name;
  const entry = readLock(lockPath).skills[key];
  if (!entry) return { name: key, status: 'unpinned' };
  const now = skillHash(skill);
  if (now === entry.hash) return { name: key, status: 'ok' };
  return { name: key, status: 'drifted', was: entry.hash, now, ...diffParts(entry.parts || {}, partsOf(skill)) };
}

function diffParts(before = {}, after = {}) {
  const added = [], removed = [], changed = [];
  for (const k of Object.keys(after)) if (!(k in before)) added.push(k); else if (before[k] !== after[k]) changed.push(k);
  for (const k of Object.keys(before)) if (!(k in after)) removed.push(k);
  return { added, removed, changed };
}

export { partsOf, diffParts };
