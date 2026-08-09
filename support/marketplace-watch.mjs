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
// Exit 0 when nothing flags; exit 1 the moment anything does, so the scheduled
// run goes red and someone looks. What flags is published as `poisoned` in the
// JSON (the schema history.jsonl compares across runs) but rendered as UNDER
// REVIEW for humans — until a person triages it, a detector hit is not a verdict
// about a named vendor (#152). Offline like the rest of truecopy:
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

// ── Byte-keyed review index (#149) ──
// Every acceptance above is keyed `plugin:skill`, but what a human actually read
// is BYTES. When a vendor republishes the same skill under a second catalog name
// (Salesforce shipped the Agentforce skills again from their official CLI repo:
// 7 of the 8 finding-bearing files were byte-identical to files already reviewed
// under `agentforce-adlc`), or forks one, or re-pins without touching the
// finding-bearing file, the name key matches nothing and a reviewer re-derives a
// conclusion the repo already holds. The review is a property of the content, so
// index it by content: every per-file entry already records the sha256 of each
// finding-bearing file, so the index is a VIEW over watch-accepted.json rather
// than a second file to keep in sync. A malformed or stale hash simply never
// matches — the index can only ever fail closed.
//
// Two sources, both meaning "a human read exactly these bytes":
//   - a per-file entry's `files` map, which is also what that entry gates on;
//   - any entry's `reviewedFiles` map (#151), which gates nothing. A per-flag
//     entry deliberately lets its files drift, so it cannot key acceptance to
//     their hashes — but "these bytes were read on this date" stays true after
//     they churn, and that is the only claim this index makes. Without it a
//     per-flag review is invisible to a republish under another catalog name,
//     which is exactly how the Agentforce rename cost a re-review of bytes
//     that had already been read twice.
//
// Not indexed: whole-skill entries. They record one hash over the JOINED skill,
// never a file, so there is nothing here to match — and treating one as a file
// hash would silently widen a legacy entry to any skill sharing a file.
const reviewedBytes = new Map();
const isHashMap = (m) => m && typeof m === 'object' && !Array.isArray(m);
for (const [name, a] of Object.entries(accepted)) {
  if (!a) continue;
  const maps = [];
  if (a.granularity === 'finding-files' && isHashMap(a.files)) maps.push(a.files);
  if (isHashMap(a.reviewedFiles)) maps.push(a.reviewedFiles);
  for (const m of maps) for (const [file, hash] of Object.entries(m)) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) continue;
    if (!reviewedBytes.has(hash)) reviewedBytes.set(hash, { file, reviewedIn: name, class: a.class, reviewed: a.reviewed });
  }
}

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

/**
 * Does the byte index alone cover this flagged skill? (#149)
 *
 * Same remainder proof `finding-files` relies on — everything OUTSIDE the
 * reviewed files must scan clean, so a clean remainder proves every current
 * finding lives in a reviewed, byte-identical file — plus one requirement
 * per-file does not carry: the reviewed files must actually FLAG on their own.
 * per-file gets attribution for free because a human named that skill and the
 * authoring helper refused to emit an entry it could not attribute; byte
 * coverage applies with no entry for this skill at all, so it proves attribution
 * instead of assuming it. A finding that exists only across a join boundary —
 * carried by no single reviewed file — is therefore NOT covered, and flags.
 *
 * Hash is the whole key: identical bytes are identical wherever they sit, so the
 * reviewed path is recorded for provenance and never matched on. What this does
 * NOT do is widen a review to bytes nobody read — an attacker who copies a
 * reviewed file into a poisoned skill gets that file excluded and their own
 * payload scanned exactly as before, because it lives in the remainder.
 */
function coveredByReviewedBytes(skill) {
  if (!reviewedBytes.size) return null;
  const hashOf = Object.fromEntries((skill.files || []).map((f) => [f.path, f.hash]));
  const pieces = skill.scanPieces || [];
  const isReviewed = (p) => reviewedBytes.has(hashOf[p.path]);
  const inside = pieces.filter(isReviewed);
  if (!inside.length) return null;                                            // nothing reviewed here
  const outside = pieces.filter((p) => !isReviewed(p));
  if (outside.length && scanPieces(skill, outside).verdict !== 'clean') return null;
  if (scanPieces(skill, inside).verdict === 'clean') return null;             // unattributable — fail closed
  const rows = inside.map((p) => reviewedBytes.get(hashOf[p.path]));
  const sources = [...new Set(rows.map((r) => r.reviewedIn))];
  return {
    class: [...new Set(rows.map((r) => r.class).filter(Boolean))].join(' + ') || 'reviewed bytes',
    note: `every finding-bearing file here is byte-identical to one already read end to end under ${sources.join(', ')} — same bytes, different catalog name`,
    files: inside.map((p) => p.path),
    reviewedIn: sources,
  };
}

/**
 * The finding-bearing files of a flagged skill, for whoever triages it (#153).
 *
 * `evidence` names the FIRST hit per flag, which is not the same set: a skill
 * can carry four flags across six files, and a reviewer working from the
 * evidence rows alone would read four of them and write an under-scoped review.
 * This is the same attribution `watch-accept.mjs --files` performs — each file
 * scanned alone, then the remainder checked — so the reviewer starts from the
 * complete set instead of re-deriving it after materializing the corpus.
 *
 * `attributable: false` means no single file carries the findings on its own
 * (a match spanning a join boundary), which is exactly when per-file
 * granularity must NOT be used — surfacing it here saves discovering it at
 * authoring time.
 *
 * Deliberately NOT published: a paste-ready acceptance entry. The whole system
 * rests on a human having actually read the bytes, and a pre-filled entry on a
 * public page invites pasting instead of reading. Facts, not a shortcut past
 * the part that matters.
 */
function findingBearingFiles(skill) {
  const pieces = skill.scanPieces || [];
  if (!pieces.length) return null;
  const hashOf = Object.fromEntries((skill.files || []).map((f) => [f.path, f.hash]));
  const bearing = pieces.filter((p) => scanPieces(skill, [p]).verdict !== 'clean');
  if (!bearing.length) return { files: {}, attributable: false };
  const rest = pieces.filter((p) => !bearing.includes(p));
  return {
    files: Object.fromEntries(bearing.map((p) => [p.path, hashOf[p.path]])),
    attributable: !rest.length || scanPieces(skill, rest).verdict === 'clean',
  };
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
// Skill/plugin directories that are symlinks pointing OUT of the fetched tree.
// Refusing to follow them is deliberate (the alternative is reading and
// publishing evidence from paths outside the corpus), but they are still things
// the catalog offered and this run did not scan — so they are counted and named.
// The published skill total is a claim; anything it excludes has to be visible
// next to it.
const linkSkips = [];
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
    // Scan from the plugin directory, but let a link reach anywhere inside the
    // repo that was fetched for it — a git-subdir plugin symlinking to canonical
    // skills at the repo top is an ordinary monorepo layout, not an escape.
    for (const s of discoverMarketplaceSkills(row.dir, { skipped: linkSkips, confine: row.repoDir })) {
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
  for (const s of discoverMarketplaceSkills(root, { skipped: linkSkips })) skills.push({ ...s, skillPath: path.relative(root, s.dir).replace(/\\/g, '/') });
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
    // A name-keyed acceptance wins; the byte index is the fallback, so a skill
    // with its own reviewed entry keeps that entry's class, note and expiry.
    const named = a && covers(a, r.skill) ? a : null;
    const bytes = named ? null : coveredByReviewedBytes(r.skill);
    if (named) acceptedRows.push({
      name: s.name, findings, class: named.class, note: named.note, evidence,
      ...(named.granularity ? { granularity: named.granularity } : {}),
      ...(named.expires ? { expires: named.expires } : {}),
      ...(named.reviewedHash ? { drifted: named.reviewedHash !== skillHash(r.skill) } : {}),
    });
    else if (bytes) acceptedRows.push({
      name: s.name, findings, class: bytes.class, note: bytes.note, evidence,
      granularity: 'reviewed-bytes', reviewedIn: bytes.reviewedIn, reviewedFiles: bytes.files,
    });
    else flaggedRows.push({ name: s.name, verdict: r.verdict, findings, evidence, triage: findingBearingFiles(r.skill) });
  } else if (advisories.length) {
    const ev = evidenceOf(r.advisories, r.skill); evidenceMismatches += ev.mismatches;
    advisoryRows.push({ name: s.name, advisories, evidence: withRepoPaths(ev.evidence, s.skillPath) });
  }
}

const scannedAt = new Date().toISOString();
const poisoned = flaggedRows.length;

// `plugins` stays the CATALOG total — it is the published schema and what
// history.jsonl compares across runs, so its meaning must not shift. What it is
// NOT is coverage: a row the fetch step could not materialize was `continue`d
// above and never scanned. Reporting the catalog total as though it were the
// scanned total is the same class of dishonesty as dropping a refused symlink
// from the count, so the two numbers are published separately and every human
// surface renders "N of M" whenever they diverge.
const pluginsScanned = plugins - fetchErrors.length;
const coverage = fetchErrors.length ? `${pluginsScanned} of ${plugins}` : `${plugins}`;

const summary = { scannedAt, plugins, pluginsScanned, skills: skills.length, poisoned, accepted: acceptedRows.length, advisories: advisoryCount, pinDrift: pinDrift.length, fetchErrors: fetchErrors.length, linkSkips: linkSkips.length, evidenceMismatches };

fs.mkdirSync(outDir, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(outDir, name), data);

write('badge.json', JSON.stringify({
  schemaVersion: 1,
  label: 'marketplace watch',
  // Coverage gaps are named in the TEXT, never hidden in the colour and never
  // dropped from the counts: "274 of 276 plugins" says exactly what was scanned,
  // and a refused symlink adds "· N unscanned".
  message: `${coverage} plugins · ${skills.length} skills · ${poisoned} under review · ${advisoryCount} advisories${linkSkips.length ? ` · ${linkSkips.length} unscanned` : ''}`,
  // The colour answers exactly ONE question: did anything we scanned come back
  // poisoned? red = yes. Nothing else is allowed to borrow that alarm.
  //
  // A vendor deleting their repo upstream is a coverage loss, not a verdict
  // about the corpus — it used to turn the badge orange, which reads as "this
  // project is in trouble" for someone else's dead repo, with no visible cause
  // because the count still claimed full coverage. It now degrades brightgreen
  // → yellowgreen ("clean, but we could not see all of it") and states the gap
  // in the text, so the colour is never the only evidence.
  //
  // A refused symlink stays brightgreen: declining to follow a link out of the
  // tree is a deliberate, bounded refusal — the design working, not a failure —
  // and it is already counted in the message.
  color: poisoned ? 'red' : (fetchErrors.length ? 'yellowgreen' : 'brightgreen'),
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
  // The calibration the "under review" rows need to be read honestly, published
  // rather than left for a reader to count by hand: how many skills have ever
  // been triaged and come back benign. Deliberately NOT in the stdout summary —
  // that line is appended to history.jsonl and compared across runs, so it stays
  // the per-run facts only.
  triagedBenign: Object.keys(accepted).length,
  flagged: flaggedRows,
  acceptedDetail: acceptedRows,
  advisoryDetail: advisoryRows,
  pinDriftDetail: pinDrift.map((r) => ({ name: r.name, url: r.url, sha: r.sha, ref: r.ref, actualSha: r.actualSha, error: r.error })),
  fetchErrorDetail: fetchErrors.map((r) => ({ name: r.name, url: r.url, status: r.status, error: r.error })),
  linkSkipDetail: linkSkips.map((r) => ({ name: r.name, reason: r.reason })),
}, null, 2) + '\n');

const md = [];
md.push('# truecopy marketplace watch');
md.push('');
md.push(`> The official Claude Code plugin directory ([anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)) — every catalog plugin, including the external vendor plugins fetched at their catalog-pinned SHAs — re-scanned on a schedule by [truecopy](https://github.com/askalf/truecopy). Latest snapshot — history in [history.jsonl](./history.jsonl), methodology in [the 2,019-skill study](https://sprayberrylabs.com/blog/auditing-the-skills-supply-chain).`);
md.push('');
md.push(`**${scannedAt.slice(0, 10)}** — ${fetchErrors.length ? `**${pluginsScanned}** of **${plugins}**` : `**${plugins}**`} plugins · **${skills.length}** skills scanned · **${poisoned}** under review · **${advisoryCount}** advisories${fetchErrors.length ? ` · **${fetchErrors.length}** unfetched (see below)` : ''}`);
md.push('');
if (poisoned) {
  // TRIAGE GATE (#152). This section names a third-party vendor's skill on a
  // public page, and until a human has looked, all it holds is raw detector
  // output — a regex matched a string. Every skill triaged to date has come
  // back benign (they are the accepted list below): defensive quoting, shipped
  // red-team fixtures, docs teaching credential handling. Publishing "poisoned"
  // against a named vendor on that base is a claim the evidence does not
  // support, so the heading states what is actually true — flagged, awaiting
  // review — and a confirmed finding gets reported to the vendor and rendered
  // as its own thing when there ever is one.
  //
  // The alarm is unchanged: the run still exits 1, the badge still goes red,
  // and the `poisoned` key stays in results.json/history.jsonl because that is
  // the published schema history.jsonl compares across runs. This is how the
  // number is DESCRIBED, not what is counted or how loudly.
  md.push('## ⏳ Under review');
  md.push('');
  md.push(`Skills the scanner flagged that a human has **not yet triaged**. These are detector hits, not verdicts — a string matched a rule, and what that means is exactly the question a person still has to answer. For calibration: **${Object.keys(accepted).length}** skills have been triaged and accepted as benign so far (listed below), most of them defensive prose quoting an attack in order to refuse it, or a security-testing skill shipping the attack corpus that is its whole product.`);
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
  md.push('Entries marked *reviewed bytes* carry no entry of their own: every finding-bearing file in them is byte-identical to a file already read end to end under the skill named in the note — the same content republished under a second catalog name, forked, or re-pinned untouched. The remainder of the skill must still scan clean, the reviewed files must still carry the findings themselves, and a single changed byte drops the skill back to a normal scan.');
  md.push('');
  for (const r of acceptedRows) {
    const gran = r.granularity === 'finding-files' ? ' *(per-file)*'
      : r.granularity === 'reviewed-bytes' ? ' *(reviewed bytes)*'
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
if (linkSkips.length) {
  md.push('## ⚠ Not followed');
  md.push('');
  md.push('Skill or plugin directories that are **symlinks pointing outside the fetched tree**. truecopy does not follow them — reading and publishing evidence from a path outside the corpus is exactly what a hostile vendor repo would want — so they are counted here rather than folded into the scanned total. A directory that resolves *within* the tree is followed and scanned normally.');
  md.push('');
  for (const r of linkSkips) {
    md.push(`- **${r.name}** — ${r.reason}`);
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
