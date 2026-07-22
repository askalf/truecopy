#!/usr/bin/env node
// Standing watch over the official plugin directory: scan every catalog
// plugin's skills and emit machine-readable results for the `watch` branch —
// badge.json (shields.io endpoint), WATCH.md (human report), results.json
// (full rows), and a history.jsonl line appended by the workflow.
//
//   node support/marketplace-watch.mjs <corpus-or-clone> <out-dir>
//
// The root is either a corpus materialized by marketplace-fetch.mjs (detected
// by its canon-corpus.json — the full directory: in-repo plugins + external
// vendor plugins at their catalog-pinned SHAs) or, legacy mode, a plain
// marketplace clone (`plugins/` + `external_plugins/` trees) scanned in place.
// Exit 0 when nothing is poisoned; exit 1 the moment anything flags, so the
// scheduled run goes red and someone looks. Offline like the rest of truecopy:
// the workflow fetches, this script only reads disk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, scanSkill, skillHash, joinScanText, discoverMarketplaceSkills } from '../src/index.mjs';
import { evidenceOf } from './evidence.mjs';

const ADVISORY_ROWS_SHOWN = 80; // WATCH.md stays readable; results.json has every row

// Reviewed-benign findings, accepted with truecopy's `--force` semantics: each
// entry accepts a skill's findings for EXACTLY the bytes reviewed (keyed by
// skill hash). Any drift — or new findings on other skills — flags as usual.
// High-churn vendor skills can opt into per-file granularity (#68) with
// `"granularity": "finding-files"` + `"files": { <path>: <sha256>, … }`: the
// acceptance is keyed to the reviewed finding-bearing files instead of the
// whole-skill hash, so an unrelated upstream docs release no longer lapses it.
// When the churning file IS the finding-bearing file, neither helps — see
// `finding-flags` below (#87).
let accepted = {};
try { accepted = JSON.parse(fs.readFileSync(fileURLToPath(new URL('watch-accepted.json', import.meta.url)), 'utf8')); } catch { /* no accept file = accept nothing */ }

const scanPieces = (skill, pieces) =>
  scanSkill({ kind: 'skill', name: skill.name, scanTargets: [{ name: skill.name, description: joinScanText(pieces) }] });

// `finding-flags` acceptance lapses on a mandatory date, and an entry may not
// hold one further out than this. It is the only granularity that survives a
// content change, so it is the only one where "reviewed once" could otherwise
// mean "never looked at again" — the cap forces the reviewer back on a schedule
// instead of leaving a standing exemption in the file.
const MAX_FLAG_ACCEPT_DAYS = 90;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Does an accept entry still cover this scanned skill?
//   whole-skill (default) — `hash` must equal today's skill hash: any byte
//   anywhere re-flags. Fail-closed and churn-prone by design.
//   finding-files — every file listed in `files` that is still present at its
//   reviewed bytes is EXCLUDED, and the REMAINDER of the skill must scan clean
//   on the same detection pipeline. Since we only get here when the full skill
//   flagged, a clean remainder proves every current finding lives in a reviewed,
//   byte-identical file: a reviewed file that drifts rejoins the scan (its
//   fixtures re-flag), and a new finding in a new or changed file flags on its
//   own. An entry with no usable `files` map excludes nothing — the remainder is
//   the whole flagged skill, so it fails closed.
//   finding-flags — the reviewed files may DRIFT, but only within the reviewed
//   set of flags. See coversFlags().
function covers(a, skill) {
  if (a.granularity === 'finding-flags') return coversFlags(a, skill);
  if (a.granularity !== 'finding-files') return a.hash === skillHash(skill);
  const reviewed = (a.files && typeof a.files === 'object') ? a.files : {};
  const hashOf = Object.fromEntries((skill.files || []).map((f) => [f.path, f.hash]));
  const rest = (skill.scanPieces || []).filter((p) => hashOf[p.path] !== reviewed[p.path]);
  if (!rest.length) return true;
  return scanPieces(skill, rest).verdict === 'clean';
}

/**
 * finding-flags (#87) — for a vendor whose finding-bearing FILE is the thing
 * that churns. Neither hash- nor file-keyed acceptance helps there: the only
 * file changing upstream is the one carrying the findings, so every edit lapses
 * the review and re-publishes a "poisoned" claim naming the vendor until a human
 * re-reads bytes they have already read (AWS's HyperPod NCCL skill produced
 * three distinct hashes in a few hours).
 *
 * The entry names the files it reviewed and the flags it accepted:
 *   { granularity: 'finding-flags', files: [ <path>, … ], flags: [ <flag>, … ],
 *     expires: 'YYYY-MM-DD', reviewedHash: <sha256>, class, note, reviewed }
 *
 * `reviewedHash` is the skill hash the reviewer actually read. It does NOT gate
 * acceptance — gating on it would just be the whole-skill entry again — but the
 * watch reports `drifted` when today's bytes differ, so an accepted-by-flag skill
 * that the vendor has since edited stays visible as such instead of going quiet.
 *
 * It holds only while ALL of these are true — any one failing re-flags:
 *   - every listed file is still present in the skill;
 *   - everything OUTSIDE the listed files scans clean, so a finding anywhere
 *     else in the skill flags normally (the same remainder proof finding-files
 *     relies on);
 *   - the listed files, scanned together, still produce findings, and every flag
 *     they produce is one the reviewer enumerated — a NEW flag re-flags;
 *   - `expires` is a real date, not past, and no further out than
 *     MAX_FLAG_ACCEPT_DAYS.
 *
 * KNOWN LIMIT, deliberately accepted (askalf/redstamp#84): a genuinely malicious
 * change to a reviewed file that produces only an already-reviewed flag would be
 * covered until the entry expires. That is the price of not shipping a detector
 * downgrade, and it was the cheaper risk: every severity heuristic tried for this
 * FP was evadable by writing a decoy string, which hands the attacker a switch to
 * turn detection off for EVERY skill. This confines the weaker guarantee to
 * named files, named flags, and a bounded window, and it stays visible as such on
 * the public board.
 */
function coversFlags(a, skill, now = Date.now()) {
  if (!ISO_DATE.test(String(a.expires || ''))) return false;
  if (a.expires < isoDay(now)) return false;                            // lapsed
  if (a.expires > isoDay(now + MAX_FLAG_ACCEPT_DAYS * 86400000)) return false; // over-long
  const flags = new Set(Array.isArray(a.flags) ? a.flags : []);
  const files = new Set(Array.isArray(a.files) ? a.files : []);
  if (!flags.size || !files.size) return false;
  const pieces = skill.scanPieces || [];
  const inside = pieces.filter((p) => files.has(p.path));
  if (inside.length !== files.size) return false;   // a reviewed file was renamed or removed
  const outside = pieces.filter((p) => !files.has(p.path));
  if (outside.length && scanPieces(skill, outside).verdict !== 'clean') return false;
  const got = scanPieces(skill, inside);
  // No findings in the reviewed files, yet the whole skill flagged: the finding
  // is an artifact of something outside them. Fail closed rather than silence it.
  if (!got.findings.length) return false;
  return got.findings.every((f) => (f.flags || []).every((w) => flags.has(w)));
}

// evidenceOf() locates matches against `skill.scanPieces`, which are paths
// relative to the SKILL's own directory — but a plugin's declared source (what
// the site resolves a github.com/.../tree/<sha> link from, in marketplace.json)
// points at the plugin REPO root, and a skill is often nested under it
// (skills/<name>/…). So a bare skill-relative `file` can't be appended to that
// tree link to build a working blob/#Lline deep link. `skillPath` (the skill's
// own directory relative to the repo root the tree link resolves to) closes
// that gap; '.' means the skill IS the repo root, so there's nothing to join.
const repoRelative = (skillPath, file) => (skillPath && skillPath !== '.') ? `${skillPath}/${file}` : file;
const withRepoPaths = (evidence, skillPath) => evidence.map((e) => ({ ...e, file: repoRelative(skillPath, e.file) }));

const [rootArg, outDir] = process.argv.slice(2);
if (!rootArg || !outDir) {
  console.error('usage: marketplace-watch.mjs <corpus-or-clone> <out-dir>');
  process.exit(2);
}
const root = path.resolve(rootArg);
const manifestPath = path.join(root, 'canon-corpus.json');
const corpusMode = fs.existsSync(manifestPath);

// ── Collect the skills to scan: [{ name, dir }] plus per-plugin bookkeeping ──
const skills = [];
const pinDrift = []; // scanned, but at the catalog ref, not the pinned sha
const fetchErrors = []; // catalog rows the fetch step could not materialize
let plugins = 0;
if (corpusMode) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {
    console.error(`unreadable corpus manifest ${manifestPath}: ${e.message}`);
    process.exit(2);
  }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  plugins = entries.length;
  const seen = new Set();
  for (const row of entries) {
    if (row.status !== 'ok' && row.status !== 'ref-fallback') { fetchErrors.push(row); continue; }
    if (row.status === 'ref-fallback') pinDrift.push(row);
    for (const s of discoverMarketplaceSkills(row.dir)) {
      // Namespace by the CATALOG name; keep the inner name when a vendor repo
      // nests its own plugin name (or a whole plugins/ tree) under it.
      const inner = s.name.startsWith(`${row.name}:`) ? s.name : `${row.name}/${s.name}`;
      if (seen.has(inner)) continue;
      seen.add(inner);
      skills.push({ name: inner, dir: s.dir, skillPath: path.relative(row.dir, s.dir).replace(/\\/g, '/') });
    }
  }
  if (!plugins) {
    console.error(`corpus manifest ${manifestPath} lists no plugins — fetch step broke?`);
    process.exit(2);
  }
} else {
  for (const s of discoverMarketplaceSkills(root)) skills.push({ ...s, skillPath: path.relative(root, s.dir).replace(/\\/g, '/') });
  plugins = new Set(skills.map((s) => s.name.split(':')[0])).size;
  if (!skills.length) {
    console.error(`no plugin skills discovered under ${root} — wrong clone, or the marketplace layout changed`);
    process.exit(2);
  }
}

// ── Scan ──
const flaggedRows = [];
const acceptedRows = [];
const advisoryRows = [];
// name → skillHash for EVERY scanned skill, published as directory-manifest.json
// so `truecopy check-manifest` can compare a machine's installed plugin skills
// against exactly the bytes this watch scanned. Null-proto: catalog names are
// validated but 'constructor'-shaped ones must stay plain data keys.
const manifestSkills = Object.create(null);
let advisoryCount = 0;

// evidenceOf() (support/evidence.mjs) locates each finding hit in the pinned source
// and verifies it — dropping any that don't exist in the bytes and reporting the
// count. That published `evidenceMismatches` is the confabulation guard.
let evidenceMismatches = 0;

for (const s of skills) {
  const r = scan(s.dir);
  manifestSkills[s.name] = skillHash(r.skill);
  const advisories = (r.advisories || []).map((f) => `${f.tool}: ${f.flags.join('; ')}`);
  advisoryCount += advisories.length;
  if (r.verdict !== 'clean') {
    const findings = r.findings.map((f) => `${f.tool}: ${f.flags.join('; ')}`);
    const ev = evidenceOf(r.findings, r.skill); evidenceMismatches += ev.mismatches;
    const evidence = withRepoPaths(ev.evidence, s.skillPath);
    const a = accepted[s.name];
    if (a && covers(a, r.skill)) acceptedRows.push({
      name: s.name, findings, class: a.class, note: a.note, evidence,
      ...(a.granularity ? { granularity: a.granularity } : {}),
      ...(a.expires ? { expires: a.expires } : {}),
      ...(a.reviewedHash ? { drifted: a.reviewedHash !== skillHash(r.skill) } : {}),
    });
    else flaggedRows.push({ name: s.name, verdict: r.verdict, findings, evidence });
  } else if (advisories.length) {
    const ev = evidenceOf(r.advisories, r.skill); evidenceMismatches += ev.mismatches;
    advisoryRows.push({ name: s.name, advisories, evidence: withRepoPaths(ev.evidence, s.skillPath) });
  }
}

const scannedAt = new Date().toISOString();
const poisoned = flaggedRows.length;
const summary = { scannedAt, plugins, skills: skills.length, poisoned, accepted: acceptedRows.length, advisories: advisoryCount, pinDrift: pinDrift.length, fetchErrors: fetchErrors.length, evidenceMismatches };

fs.mkdirSync(outDir, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(outDir, name), data);

write('badge.json', JSON.stringify({
  schemaVersion: 1,
  label: 'marketplace watch',
  message: `${plugins} plugins · ${skills.length} skills · ${poisoned} poisoned · ${advisoryCount} advisories`,
  color: poisoned ? 'red' : (fetchErrors.length ? 'orange' : 'brightgreen'),
}) + '\n');

// The consumable artifact: what the watch scanned, as name → hash. `flagged`
// rides along so a byte-identical install of a poisoned skill still fails
// check-manifest (a hash match is not an endorsement).
write('directory-manifest.json', JSON.stringify({
  schemaVersion: 1,
  source: 'anthropics/claude-plugins-official',
  scannedAt,
  plugins,
  skills: { ...manifestSkills },
  flagged: flaggedRows.map((r) => r.name),
}, null, 2) + '\n');

write('results.json', JSON.stringify({
  ...summary,
  flagged: flaggedRows,
  acceptedDetail: acceptedRows,
  advisoryDetail: advisoryRows,
  pinDriftDetail: pinDrift.map((r) => ({ name: r.name, url: r.url, sha: r.sha, ref: r.ref, actualSha: r.actualSha, error: r.error })),
  fetchErrorDetail: fetchErrors.map((r) => ({ name: r.name, url: r.url, status: r.status, error: r.error })),
}, null, 2) + '\n');

const md = [];
md.push('# truecopy marketplace watch');
md.push('');
md.push(`> The official Claude Code plugin directory ([anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)) — every catalog plugin, including the external vendor plugins fetched at their catalog-pinned SHAs — re-scanned on a schedule by [truecopy](https://github.com/askalf/truecopy). Latest snapshot — history in [history.jsonl](./history.jsonl), methodology in [the 2,019-skill study](https://sprayberrylabs.com/blog/auditing-the-skills-supply-chain).`);
md.push('');
md.push(`**${scannedAt.slice(0, 10)}** — **${plugins}** plugins · **${skills.length}** skills scanned · **${poisoned}** poisoned · **${advisoryCount}** advisories`);
md.push('');
if (poisoned) {
  md.push('## ☠ Poisoned');
  md.push('');
  for (const r of flaggedRows) {
    md.push(`- **${r.name}** — ${r.findings.join(' · ')}`);
  }
  md.push('');
}
if (acceptedRows.length) {
  md.push('## Accepted findings (reviewed benign)');
  md.push('');
  md.push('Skills whose findings were manually reviewed and accepted for **exactly these bytes** ([watch-accepted.json](https://github.com/askalf/truecopy/blob/master/support/watch-accepted.json), truecopy\'s `--force` semantics) — any content change re-flags them. Entries marked *per-file* key the acceptance to the reviewed finding-bearing files instead: those files changing re-flags, and everything else in the skill must still scan clean, but unrelated upstream churn no longer lapses the review.');
  md.push('');
  md.push('Entries marked *per-flag* are the weakest of the three and say so: the reviewed file may change, and the acceptance holds while the flags it produces stay within the reviewed set. Used only where the finding-bearing file is itself the thing that churns. Everything outside the reviewed files must still scan clean, a **new** flag re-flags, the entry lapses on the date shown — at which point a human re-reads it or it goes back on the board — and *changed since review* means the vendor has edited the skill since the bytes a human actually read.');
  md.push('');
  for (const r of acceptedRows) {
    const gran = r.granularity === 'finding-files' ? ' *(per-file)*'
      : r.granularity === 'finding-flags' ? ` *(per-flag, expires ${r.expires}${r.drifted ? ', changed since review' : ''})*` : '';
    md.push(`- **${r.name}** — ${r.findings.join(' · ')} — *${r.class}${r.note ? `: ${r.note}` : ''}*${gran}`);
  }
  md.push('');
}
if (pinDrift.length) {
  md.push('## ⚠ Pin drift');
  md.push('');
  md.push('The catalog-pinned sha was unfetchable from the vendor repo (rewritten history, or the pin never existed there); the scan proceeded on the catalog ref instead. A pin that stops resolving is itself supply-chain signal.');
  md.push('');
  for (const r of pinDrift) {
    md.push(`- **${r.name}** — ${r.error || `pinned ${String(r.sha).slice(0, 12)} unfetchable, scanned ${r.ref}@${String(r.actualSha).slice(0, 12)}`}`);
  }
  md.push('');
}
if (fetchErrors.length) {
  md.push('## ✗ Not scanned');
  md.push('');
  md.push('Catalog plugins the fetch step could not materialize this run (vendor repo gone or unreachable, or a broken catalog row) — counted, never silently dropped.');
  md.push('');
  for (const r of fetchErrors) {
    md.push(`- **${r.name}** — ${r.error || r.status}`);
  }
  md.push('');
}
md.push('## Advisories');
md.push('');
md.push('Capability *mentions* (sensitive paths, secret env vars) in skill prose — shown, never blocking. Documentation legitimately teaches credential handling; only *instructions* block.');
md.push('');
if (advisoryRows.length) {
  for (const r of advisoryRows.slice(0, ADVISORY_ROWS_SHOWN)) {
    md.push(`- **${r.name}** — ${r.advisories.join(' · ')}`);
  }
  if (advisoryRows.length > ADVISORY_ROWS_SHOWN) {
    md.push(`- …and ${advisoryRows.length - ADVISORY_ROWS_SHOWN} more skills with advisories — full rows in [results.json](./results.json)`);
  }
} else {
  md.push('*(none)*');
}
md.push('');
write('WATCH.md', md.join('\n'));

console.log(JSON.stringify(summary));
process.exit(poisoned ? 1 : 0);
