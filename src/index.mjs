// canon — own your agent skills. Vet (scan), pin (lock + hash), and verify
// (drift) every skill & MCP server before it runs. The supply-chain gate that
// pairs with warden's runtime firewall: vet it → contain it.
import { loadSkill, skillHash } from './skill.mjs';
import { scanSkill, detectionInfo } from './scan.mjs';
import { readLock, writeLock, DEFAULT_LOCK } from './lock.mjs';
import { signHash, verifyHashSig, keyId, ensureKey } from './sign.mjs';
import { loadTrust, trustedSigner, trustKey, untrustKey, listTrust } from './trust.mjs';
import { sha256, canonicalJson } from './hash.mjs';

export { loadSkill, skillHash, scanSkill, detectionInfo, readLock, writeLock, DEFAULT_LOCK };
export { signHash, verifyHashSig, keyId, ensureKey };
export { loadTrust, trustedSigner, trustKey, untrustKey, listTrust };
export { claudeSkillRoots, discoverClaudeSkills, discoverClaudePluginSkills, discoverMarketplaceSkills, resolveClaudeSkill } from './claude.mjs';

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
    ...(s.advisories?.length ? { advisories: s.advisories.length } : {}), // mentions noted at pin time, for the record
    ...((d) => (d ? { detection: d } : {}))(detectionInfo()), // WHAT this verdict was judged against — omitted if unreadable, never fatal
    parts: partsOf(skill),
    ...(sign ? { sig: signHash(hash), signed: true } : {}),
  };
  writeLock(lock, lockPath);
  return { ok: true, name: key, hash, verdict: s.verdict, signed: sign, skill, advisories: s.advisories?.length || 0 };
}

/** Un-pin a skill — remove its lock entry by exact name. → count removed (0 or 1).
 *  The guided mirror of `pin`: hand-deleting from a signed lock is exactly the
 *  manual editing canon exists to discourage. A no-op removal never writes (so it
 *  can't create an empty lock), and a corrupt lock still fails CLOSED via readLock. */
export function unpin(name, { lockPath = DEFAULT_LOCK } = {}) {
  const lock = readLock(lockPath);
  if (!(name in lock.skills)) return 0;
  delete lock.skills[name];
  writeLock(lock, lockPath);
  return 1;
}

/** Re-derive every pinned skill and classify it against the lock.
 *  Fails CLOSED on a missing or corrupt lock — a present-but-empty lock stays
 *  ok:true (legitimately nothing pinned). */
export function verify({ lockPath = DEFAULT_LOCK, trustPath } = {}) {
  let lock;
  try { lock = readLock(lockPath, { mustExist: true }); }
  catch (e) { return { ok: false, error: e.message, results: [] }; }
  const trust = loadTrust({ trustPath });
  const results = Object.entries(lock.skills).map(([name, entry]) => verifyOne(name, entry, trust));
  return { ok: results.every((r) => r.status === 'ok'), results };
}

function verifyOne(name, entry, trust) {
  let skill;
  try { skill = loadSkill(entry.source); }
  catch { return { name, status: 'missing', source: entry.source }; }
  const hash = skillHash(skill);
  // `entry.parts || {}` (not diffParts' default) because a hostile lock can carry
  // parts:null — the default only fills `undefined`, so `k in null` would throw an
  // uncaught TypeError up through verify() (diff() already guards this the same way).
  if (hash !== entry.hash) return { name, status: 'drifted', source: entry.source, ...diffParts(entry.parts || {}, partsOf(skill)) };
  const s = scanSkill(skill);
  // A `--force` pin recorded verdict:'flagged' — the human read these exact bytes
  // and accepted the findings, so an UNCHANGED artifact doesn't re-fail on them.
  // A skill pinned CLEAN that now scans flagged (same bytes, newer detection) still
  // fails: nobody accepted those findings.
  const accepted = s.verdict === 'flagged' && entry.verdict === 'flagged';
  if (s.verdict === 'flagged' && !accepted) {
    // Pinned CLEAN, flagged NOW, and the hash already matched above — so the bytes
    // did not change; the detection did. Same fail-closed `poisoned` (nobody
    // accepted these findings), but tagged so the CLI can say "this is not a
    // tamper" — only for entries that carry a pin-time detection stamp; older
    // locks get exactly today's bare report.
    const explain = entry.verdict === 'clean' && entry.detection
      ? { detectionChanged: true, pinnedDetection: entry.detection, currentDetection: detectionInfo() }
      : {};
    return { name, status: 'poisoned', source: entry.source, findings: s.findings, ...explain };
  }
  if (entry.signed || entry.sig) {
    // A signature that was STRIPPED or forged-against-a-different-hash fails the
    // crypto check → `unsigned` (trust the recorded `signed` flag, not just a
    // present `sig`, so deleting `sig` can't downgrade a tamper-stamp to "ok").
    if (!verifyHashSig(hash, entry.sig)) return { name, status: 'unsigned', source: entry.source };
    // Cryptographically valid, but anyone can sign with their OWN key — so the
    // signer must be in your trust set. A valid signature from an unknown key is
    // `untrusted` (fails closed), not silently accepted.
    const signer = trustedSigner(entry.sig.pub, trust);
    if (!signer) return { name, status: 'untrusted', source: entry.source, keyId: keyId(entry.sig.pub) };
    return { name, status: 'ok', source: entry.source, signed: true, signer, ...(accepted ? { accepted: true } : {}) };
  }
  return { name, status: 'ok', source: entry.source, signed: false, ...(accepted ? { accepted: true } : {}) };
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
