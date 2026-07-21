#!/usr/bin/env node
// Author a watch-accepted.json entry for a skill you just hand-reviewed —
// prints the entry JSON to paste under its catalog name (fill in class/note).
//
//   node support/watch-accept.mjs <skill-dir>           # whole-skill hash entry
//   node support/watch-accept.mjs <skill-dir> --files   # per-file granularity (#68)
//
// --files keys the acceptance to the finding-bearing files: each file is scanned
// alone to attribute the findings, then the attribution is verified with exactly
// the predicate the watch uses (everything OUTSIDE the recorded files must scan
// clean). If that remainder still flags — e.g. a finding only matches across a
// file boundary — the helper refuses per-file mode rather than emit an entry
// that silences something no single file carries.
import { spawnSync } from 'node:child_process';
import { scan, scanSkill, skillHash, joinScanText } from '../src/index.mjs';

const args = process.argv.slice(2);
const wantFiles = args.includes('--files');
const dir = args.find((a) => a !== '--files');
if (!dir) {
  console.error('usage: watch-accept.mjs <skill-dir> [--files]');
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

if (!wantFiles) {
  console.log(JSON.stringify({ hash: skillHash(r.skill), ...entry }, null, 2));
  process.exit(0);
}

const pieces = r.skill.scanPieces || [];
if (!pieces.length) {
  console.error(`${dir}: not a skill directory — per-file granularity needs one`);
  process.exit(2);
}
const scanOne = (ps) => scanSkill({ kind: 'skill', name: r.skill.name, scanTargets: [{ name: r.skill.name, description: joinScanText(ps) }] });
const bearing = pieces.filter((p) => scanOne([p]).verdict !== 'clean');
if (scanOne(pieces.filter((p) => !bearing.includes(p))).verdict !== 'clean') {
  console.error(`${dir}: findings not attributable to individual files — use the whole-skill hash entry`);
  process.exit(2);
}
const hashOf = Object.fromEntries(r.skill.files.map((f) => [f.path, f.hash]));
const files = Object.fromEntries(bearing.map((p) => [p.path, hashOf[p.path]]));
console.error(`finding-bearing files: ${Object.keys(files).join(', ') || '(none)'}`);
console.log(JSON.stringify({ granularity: 'finding-files', files, ...entry }, null, 2));
