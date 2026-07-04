#!/usr/bin/env node
// Standing watch over a cloned marketplace repo: discover every plugin skill,
// scan each, and emit machine-readable results for the `watch` branch —
// badge.json (shields.io endpoint), WATCH.md (human report), results.json
// (full rows), and a history.jsonl line appended by the workflow.
//
//   node support/marketplace-watch.mjs <marketplace-clone> <out-dir>
//
// Exit 0 when nothing is poisoned; exit 1 the moment anything flags, so the
// scheduled run goes red and someone looks. Offline like the rest of canon:
// the workflow fetches the clone, this script only reads disk.
import fs from 'node:fs';
import path from 'node:path';
import { scan, discoverMarketplaceSkills } from '../src/index.mjs';

const [root, outDir] = process.argv.slice(2);
if (!root || !outDir) {
  console.error('usage: marketplace-watch.mjs <marketplace-clone> <out-dir>');
  process.exit(2);
}

const skills = discoverMarketplaceSkills(root);
if (!skills.length) {
  console.error(`no plugin skills discovered under ${root} — wrong clone, or the marketplace layout changed`);
  process.exit(2);
}

const flaggedRows = [];
const advisoryRows = [];
let advisoryCount = 0;
for (const s of skills) {
  const r = scan(s.dir);
  const advisories = (r.advisories || []).map((f) => `${f.tool}: ${f.flags.join('; ')}`);
  advisoryCount += advisories.length;
  if (r.verdict !== 'clean') {
    flaggedRows.push({ name: s.name, verdict: r.verdict, findings: r.findings.map((f) => `${f.tool}: ${f.flags.join('; ')}`) });
  } else if (advisories.length) {
    advisoryRows.push({ name: s.name, advisories });
  }
}

const scannedAt = new Date().toISOString();
const poisoned = flaggedRows.length;
const summary = { scannedAt, skills: skills.length, poisoned, advisories: advisoryCount };

fs.mkdirSync(outDir, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(outDir, name), data);

write('badge.json', JSON.stringify({
  schemaVersion: 1,
  label: 'marketplace watch',
  message: `${skills.length} skills · ${poisoned} poisoned · ${advisoryCount} advisories`,
  color: poisoned ? 'red' : 'brightgreen',
}) + '\n');

write('results.json', JSON.stringify({ ...summary, flagged: flaggedRows, advisoryDetail: advisoryRows }, null, 2) + '\n');

const md = [];
md.push('# canon marketplace watch');
md.push('');
md.push(`> The official Claude Code plugin marketplace ([anthropics/claude-code](https://github.com/anthropics/claude-code) \`plugins/\` tree), re-scanned on a schedule by [canon](https://github.com/askalf/canon). Latest snapshot — history in [history.jsonl](./history.jsonl), methodology in [the 2,019-skill study](https://sprayberrylabs.com/blog/auditing-the-skills-supply-chain).`);
md.push('');
md.push(`**${scannedAt.slice(0, 10)}** — **${skills.length}** skills scanned · **${poisoned}** poisoned · **${advisoryCount}** advisories`);
md.push('');
if (poisoned) {
  md.push('## ☠ Poisoned');
  md.push('');
  for (const r of flaggedRows) {
    md.push(`- **${r.name}** — ${r.findings.join(' · ')}`);
  }
  md.push('');
}
md.push('## Advisories');
md.push('');
md.push('Capability *mentions* (sensitive paths, secret env vars) in skill prose — shown, never blocking. Documentation legitimately teaches credential handling; only *instructions* block.');
md.push('');
if (advisoryRows.length) {
  for (const r of advisoryRows) {
    md.push(`- **${r.name}** — ${r.advisories.join(' · ')}`);
  }
} else {
  md.push('*(none)*');
}
md.push('');
write('WATCH.md', md.join('\n'));

console.log(JSON.stringify(summary));
process.exit(poisoned ? 1 : 0);
