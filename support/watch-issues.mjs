#!/usr/bin/env node
// Turn the watch's flagged list into tracked work: one GitHub issue per skill
// awaiting triage, closed again when the skill clears.
//
//   node support/watch-issues.mjs <results.json>
//
// WHY: before this, a new flag turned the marketplace-watch run red and wrote a
// line into WATCH.md on the `watch` branch — and that was the entire signal. No
// issue, no queue, nothing with a number to work, review and close. The
// 2026-09-03 mercadopago:mp-integrate flag sat untriaged for exactly that
// reason. A red run says "something happened"; an issue says "this skill, these
// bytes, your move".
//
// A flag is NOT a verdict — see the "under review" discipline in
// marketplace-watch.mjs. The issue title and body say "awaiting review" and
// never "poisoned", because the whole point of the gate is that a detector hit
// is the question, not the answer.
//
// Dedup is by LABEL + exact TITLE, read from `gh issue list` (a LIST, not the
// search index — issue search lags minutes-to-hours and would double-file on
// nearby runs; same reasoning as npm-drift-watch.yml).
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID (optional, for the run link).
//      DRY_RUN=1 prints the issues it would file (bodies included) and the ones
//      it would close, and mutates nothing — how you check a body edit without
//      opening a real issue to look at it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LABEL = 'watch-triage';
const MAX_PER_RUN = 10; // a real supply-chain event must not open 200 issues
const DRY_RUN = process.env.DRY_RUN === '1';

const resultsPath = process.argv[2];
if (!resultsPath) {
  console.error('usage: watch-issues.mjs <results.json>');
  process.exit(2);
}
const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.error('GITHUB_REPOSITORY is required');
  process.exit(2);
}
const runId = process.env.GITHUB_RUN_ID;
const runLink = runId ? `https://github.com/${repo}/actions/runs/${runId}` : null;

// Read-only gh verbs still run under DRY_RUN — the point is to exercise the real
// dedup against real issues; only the mutations are held back.
const MUTATIONS = new Set(['create', 'close']);

function gh(args, { input } = {}) {
  if (DRY_RUN && MUTATIONS.has(args[1])) {
    console.log(`[dry-run] gh ${args.join(' ')}`);
    if (input) console.log(input.replace(/^/gm, '  | '));
    return '';
  }
  const r = spawnSync('gh', args, { encoding: 'utf8', input });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim();
    throw new Error(`gh ${args.join(' ')} failed (${r.status}): ${detail}`);
  }
  return r.stdout;
}

const titleFor = (name) => `watch triage: ${name} — flagged, awaiting review`;

// A table cell. Pipes are escaped even inside code spans — GFM splits on a raw
// `|` regardless — and newlines collapse, since a row is one line.
const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();

// Matched text is arbitrary source, and skill prose is full of backticks: the
// flagged mp-integrate line is "Copy it, fill in `.env`, run `npm install`",
// which inside a single-backtick span closes it early and renders as garbage.
// CommonMark's rule is that a span delimited by N backticks may contain runs of
// fewer than N, so pick a fence one longer than the longest run present, and pad
// when the content itself starts or ends with a backtick.
const code = (s) => {
  const t = cell(s);
  if (!t) return '';
  const longest = Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
};

function body(entry) {
  const L = [];
  L.push('<!-- truecopy-watch-triage -->');
  L.push('');
  L.push(`The marketplace watch flagged **${entry.name}** and no human has triaged it yet.`);
  L.push('');
  L.push(
    '**This is a detector hit, not a verdict.** A string matched a rule; what that means is the question this issue exists to answer. Most flags resolved so far have been benign — defensive prose quoting an attack in order to refuse it, or a security skill shipping the attack corpus that is its whole product. Do not describe this skill as poisoned anywhere public until the read below is done.',
  );
  L.push('');
  L.push('### Findings');
  L.push('');
  for (const f of entry.findings ?? []) L.push(`- ${f}`);
  L.push('');
  if (entry.evidence?.length) {
    L.push('### Evidence');
    L.push('');
    L.push('| flag | location | matched text |');
    L.push('| --- | --- | --- |');
    for (const e of entry.evidence) {
      L.push(`| ${cell(e.flag)} | ${code(e.file)}:${e.line ?? '?'} | ${code(cell(e.text).slice(0, 160))} |`);
    }
    L.push('');
  }
  L.push('### To resolve');
  L.push('');
  L.push('Read the finding-bearing files at the bytes above, then pick one:');
  L.push('');
  L.push(
    `1. **Benign** — record the acceptance and open a PR: \`node support/watch-accept.mjs <skill-dir>\` (add \`--files\` to key it to the finding-bearing files, \`--flags\` only where that file is itself what churns), then paste the entry into [\`support/watch-accepted.json\`](https://github.com/${repo}/blob/master/support/watch-accepted.json) with a \`class\` and a \`note\` saying what you read and why it is fine. Any content change re-flags it.`,
  );
  L.push(
    '2. **Actually malicious** — do not open a public dossier first. Follow the disclosure path in `SECURITY.md`, notify the vendor, and only then decide what this repo publishes.',
  );
  L.push(
    '3. **Detector is wrong in a way tuning should fix** — file the minimal repro against the detector (redstamp) and link it here, then still resolve this issue one of the two ways above.',
  );
  L.push('');
  L.push(
    'This issue auto-closes when the skill no longer appears under review — recording the acceptance is what closes it, so there is nothing to close by hand.',
  );
  L.push('');
  L.push('### Snapshot');
  L.push('');
  L.push(
    `- [WATCH.md](https://github.com/${repo}/blob/watch/WATCH.md) · [results.json](https://github.com/${repo}/blob/watch/results.json)`,
  );
  if (entry.triage?.files) {
    L.push('- finding-bearing files, at the bytes that were scanned:');
    for (const [file, hash] of Object.entries(entry.triage.files)) L.push(`  - \`${file}\` — \`${hash}\``);
  }
  if (entry.triage && entry.triage.attributable === false) {
    L.push(
      '- ⚠️ the findings are **not attributable** to individual files: no single file carries them, so per-file acceptance will be refused — read the skill as a whole.',
    );
  }
  if (runLink) L.push(`- flagged by [run #${runId}](${runLink})`);
  return L.join('\n');
}

const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
const flagged = Array.isArray(results.flagged) ? results.flagged : [];

// Make sure the label exists before it is used. --force updates an existing
// label instead of failing, so this is idempotent and cheaper than a lookup.
gh([
  'label',
  'create',
  LABEL,
  '-R',
  repo,
  '--color',
  'D93F0B',
  '--description',
  'Marketplace watch flagged a skill; awaiting human triage',
  '--force',
]);

// Tolerate the label not existing yet: on the very first run — and on any
// DRY_RUN before the create above has ever been allowed through — the filter has
// nothing to match, which is the same answer as "no issues are tracked".
let open = [];
try {
  open = JSON.parse(
    gh(['issue', 'list', '-R', repo, '--state', 'open', '--label', LABEL, '--limit', '200', '--json', 'number,title']),
  );
} catch (e) {
  console.log(`no existing ${LABEL} issues to read (${e.message.split('\n')[0]})`);
}
const byTitle = new Map(open.map((i) => [i.title, i.number]));

let filed = 0;
let deferred = 0;
for (const entry of flagged) {
  const title = titleFor(entry.name);
  if (byTitle.has(title)) {
    console.log(`already tracked: #${byTitle.get(title)} ${entry.name}`);
    byTitle.delete(title); // still flagged — must NOT be closed below
    continue;
  }
  if (filed >= MAX_PER_RUN) {
    deferred++;
    continue;
  }
  gh(['issue', 'create', '-R', repo, '--title', title, '--label', LABEL, '--body-file', '-'], { input: body(entry) });
  console.log(`filed: ${entry.name}`);
  filed++;
}

// Whatever is left carries the label but is no longer flagged: it was triaged
// and accepted, or the vendor removed the skill. Close it out.
let closed = 0;
for (const [title, number] of byTitle) {
  gh([
    'issue',
    'close',
    String(number),
    '-R',
    repo,
    '--comment',
    `Auto-closed: this skill no longer appears under review${runLink ? ` ([run #${runId}](${runLink}))` : ''}.`,
  ]);
  console.log(`closed: #${number} ${title}`);
  closed++;
}

console.log(JSON.stringify({ flagged: flagged.length, filed, closed, deferred }));
if (deferred > 0) {
  console.error(
    `::warning::${deferred} flagged skill(s) beyond the ${MAX_PER_RUN}-issue cap were not filed this run — they file on the next one`,
  );
}
