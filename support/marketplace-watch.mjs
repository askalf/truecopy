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
import { scan, scanSkill, skillHash, discoverMarketplaceSkills } from '../src/index.mjs';

const ADVISORY_ROWS_SHOWN = 80; // WATCH.md stays readable; results.json has every row

// Reviewed-benign findings, accepted with truecopy's `--force` semantics: each
// entry accepts a skill's findings for EXACTLY the bytes reviewed (keyed by
// skill hash). Any drift — or new findings on other skills — flags as usual.
// High-churn vendor skills can opt into per-file granularity (#68) with
// `"granularity": "finding-files"` + `"files": { <path>: <sha256>, … }`: the
// acceptance is keyed to the reviewed finding-bearing files instead of the
// whole-skill hash, so an unrelated upstream docs release no longer lapses it.
let accepted = {};
try { accepted = JSON.parse(fs.readFileSync(fileURLToPath(new URL('watch-accepted.json', import.meta.url)), 'utf8')); } catch { /* no accept file = accept nothing */ }

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
function covers(a, skill) {
  if (a.granularity !== 'finding-files') return a.hash === skillHash(skill);
  const reviewed = (a.files && typeof a.files === 'object') ? a.files : {};
  const hashOf = Object.fromEntries((skill.files || []).map((f) => [f.path, f.hash]));
  const rest = (skill.scanPieces || []).filter((p) => hashOf[p.path] !== reviewed[p.path]);
  if (!rest.length) return true;
  const s = scanSkill({ kind: 'skill', name: skill.name, scanTargets: [{ name: skill.name, description: rest.map((p) => p.text).join('\n') }] });
  return s.verdict === 'clean';
}

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
      skills.push({ name: inner, dir: s.dir });
    }
  }
  if (!plugins) {
    console.error(`corpus manifest ${manifestPath} lists no plugins — fetch step broke?`);
    process.exit(2);
  }
} else {
  for (const s of discoverMarketplaceSkills(root)) skills.push(s);
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
let advisoryCount = 0;
for (const s of skills) {
  const r = scan(s.dir);
  const advisories = (r.advisories || []).map((f) => `${f.tool}: ${f.flags.join('; ')}`);
  advisoryCount += advisories.length;
  if (r.verdict !== 'clean') {
    const findings = r.findings.map((f) => `${f.tool}: ${f.flags.join('; ')}`);
    const a = accepted[s.name];
    if (a && covers(a, r.skill)) acceptedRows.push({ name: s.name, findings, class: a.class, note: a.note, ...(a.granularity ? { granularity: a.granularity } : {}) });
    else flaggedRows.push({ name: s.name, verdict: r.verdict, findings });
  } else if (advisories.length) {
    advisoryRows.push({ name: s.name, advisories });
  }
}

const scannedAt = new Date().toISOString();
const poisoned = flaggedRows.length;
const summary = { scannedAt, plugins, skills: skills.length, poisoned, accepted: acceptedRows.length, advisories: advisoryCount, pinDrift: pinDrift.length, fetchErrors: fetchErrors.length };

fs.mkdirSync(outDir, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(outDir, name), data);

write('badge.json', JSON.stringify({
  schemaVersion: 1,
  label: 'marketplace watch',
  message: `${plugins} plugins · ${skills.length} skills · ${poisoned} poisoned · ${advisoryCount} advisories`,
  color: poisoned ? 'red' : (fetchErrors.length ? 'orange' : 'brightgreen'),
}) + '\n');

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
  for (const r of acceptedRows) {
    md.push(`- **${r.name}** — ${r.findings.join(' · ')} — *${r.class}${r.note ? `: ${r.note}` : ''}*${r.granularity === 'finding-files' ? ' *(per-file)*' : ''}`);
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
