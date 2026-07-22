#!/usr/bin/env node
// Author a watch-accepted.json entry for a skill you just hand-reviewed —
// prints the entry JSON to paste under its catalog name (fill in class/note).
//
//   node support/watch-accept.mjs <skill-dir>           # whole-skill hash entry
//   node support/watch-accept.mjs <skill-dir> --files   # per-file granularity (#68)
//   node support/watch-accept.mjs <skill-dir> --flags   # per-flag granularity (#87)
//
// --files keys the acceptance to the finding-bearing files: each file is scanned
// alone to attribute the findings, then the attribution is verified with exactly
// the predicate the watch uses (everything OUTSIDE the recorded files must scan
// clean). If that remainder still flags — e.g. a finding only matches across a
// file boundary — the helper refuses per-file mode rather than emit an entry
// that silences something no single file carries.
//
// --flags is the same attribution, but records the FLAGS instead of the file
// hashes: the reviewed files may then change, and the acceptance holds only
// while the flags they produce stay inside the reviewed set. For vendors whose
// finding-bearing file is itself what churns, where --files buys nothing. It is
// the weakest granularity, so it carries a mandatory expiry — read the entry
// contract in marketplace-watch.mjs (coversFlags) before reaching for it.
import { spawnSync } from 'node:child_process';
import { scan, scanSkill, skillHash, joinScanText } from '../src/index.mjs';

const ACCEPT_DAYS = 90; // must stay <= MAX_FLAG_ACCEPT_DAYS in marketplace-watch.mjs

const args = process.argv.slice(2);
const wantFiles = args.includes('--files');
const wantFlags = args.includes('--flags');
const dir = args.find((a) => a !== '--files' && a !== '--flags');
if (!dir || (wantFiles && wantFlags)) {
  console.error('usage: watch-accept.mjs <skill-dir> [--files | --flags]');
  process.exit(2);
}

const r = scan(dir);
if (r.verdict === 'clean') {
  console.error(`${dir}: scans clean — nothing to accept`);
  process.exit(2);
}
console.error(`${r.skill.name}: ${r.findings.length} finding(s)`);
for (const f of r.findings) console.error(`  ${f.tool}: ${f.flags.join('; ')}`);

// A skill hash is over RAW BYTES, so a checkout that CONVERTED line endings
// (git's core.autocrlf=true turning LF into CRLF) hashes different bytes than the
// watch does, and the emitted entry can never match — the acceptance silently
// never applies and the skill stays flagged forever.
//
// Detect the CONVERSION, not the mere presence of CRLF. A skill may legitimately
// ship CRLF files (a .bat/.ps1 is scanned as text, not skipped by BINARY_EXT), and
// marketplace-fetch.mjs fetches the corpus with core.autocrlf=false so those TRUE
// bytes are exactly what the watch hashes — refusing on CRLF presence alone would
// block a correct entry for such a skill. `git ls-files --eol` reports index (i/)
// vs working-tree (w/) endings, so i/lf + w/crlf is precisely the converted case,
// while a natively-CRLF file reads i/crlf + w/crlf and is fine. Outside a git work
// tree (a corpus dir, an unpacked tarball) we cannot tell, so we skip rather than
// guess -- this is an authoring aid, not a security control.
function convertedFiles(dir) {
  const r = spawnSync('git', ['ls-files', '--eol', '--', '.'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0 || !r.stdout) return null; // no git / not a work tree
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^i\/(\S+)\s+w\/(\S+)\s+attr\/\S*\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, idx, work, file] = m;
    if (idx !== 'crlf' && work === 'crlf') out.push(file.trim());
  }
  return out;
}

const converted = convertedFiles(dir);
if (converted && converted.length) {
  console.error(`${dir}: refusing to emit an entry -- this checkout converted LF to CRLF in ${converted.length} file(s)`);
  console.error('  The hash would be over converted bytes and could never match the watch.');
  console.error('  Re-clone with `git -c core.autocrlf=false clone ...` (or set it in the repo) and retry.');
  for (const f of converted.slice(0, 5)) console.error(`    ${f}`);
  if (converted.length > 5) console.error(`    ...and ${converted.length - 5} more`);
  process.exit(2);
}

const reviewed = new Date().toISOString().slice(0, 10);
const entry = { class: 'FILL ME IN', note: 'FILL ME IN', reviewed };

if (!wantFiles && !wantFlags) {
  console.log(JSON.stringify({ hash: skillHash(r.skill), ...entry }, null, 2));
  process.exit(0);
}

const pieces = r.skill.scanPieces || [];
if (!pieces.length) {
  console.error(`${dir}: not a skill directory — per-file/per-flag granularity needs one`);
  process.exit(2);
}
const scanOne = (ps) => scanSkill({ kind: 'skill', name: r.skill.name, scanTargets: [{ name: r.skill.name, description: joinScanText(ps) }] });
const bearing = pieces.filter((p) => scanOne([p]).verdict !== 'clean');
if (scanOne(pieces.filter((p) => !bearing.includes(p))).verdict !== 'clean') {
  console.error(`${dir}: findings not attributable to individual files — use the whole-skill hash entry`);
  process.exit(2);
}

if (wantFlags) {
  // The flags the reviewed files actually produce, scanned exactly as the watch
  // scans them (together, through the same piece join) — never a hand-typed list.
  const flags = [...new Set(scanOne(bearing).findings.flatMap((f) => f.flags || []))].sort();
  if (!flags.length) {
    console.error(`${dir}: the finding-bearing files produce no flags on their own — use the whole-skill hash entry`);
    process.exit(2);
  }
  const expires = new Date(Date.now() + ACCEPT_DAYS * 86400000).toISOString().slice(0, 10);
  console.error(`finding-bearing files: ${bearing.map((p) => p.path).join(', ')}`);
  console.error(`accepted flags       : ${flags.join(' | ')}`);
  console.error(`expires              : ${expires} (${ACCEPT_DAYS}d) — re-review or it goes back on the board`);
  console.error('Read EVERY listed file end to end before pasting this: the files may change under it.');
  console.log(JSON.stringify({
    granularity: 'finding-flags', files: bearing.map((p) => p.path), flags, expires,
    reviewedHash: skillHash(r.skill), // audit anchor + drift reporting; does NOT gate acceptance
    ...entry,
  }, null, 2));
  process.exit(0);
}

const hashOf = Object.fromEntries(r.skill.files.map((f) => [f.path, f.hash]));
const files = Object.fromEntries(bearing.map((p) => [p.path, hashOf[p.path]]));
console.error(`finding-bearing files: ${Object.keys(files).join(', ') || '(none)'}`);
console.log(JSON.stringify({ granularity: 'finding-files', files, ...entry }, null, 2));
