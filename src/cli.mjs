#!/usr/bin/env node
// canon CLI — vet, pin, and verify agent skills & MCP servers.
// Exit code is a CI gate: 0 = all clean, 1 = anything flagged / drifted / poisoned.
import { scan, pin, verify, diff, readLock } from './index.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, def) => {
  const a = argv.find((x) => x === name || x.startsWith(name + '='));
  if (!a) return def;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
const sources = argv.slice(1).filter((a) => !a.startsWith('--'));
const lockPath = opt('--lock', 'canon.lock');

const tty = process.stdout.isTTY;
const C = { red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', rst: '\x1b[0m' };
const c = (col, s) => (tty ? col + s + C.rst : s);
const out = (s = '') => process.stdout.write(s + '\n');
const mark = { ok: c(C.grn, '✓'), clean: c(C.grn, '✓'), flagged: c(C.red, '☠'), poisoned: c(C.red, '☠'), drifted: c(C.yel, '⚠'), missing: c(C.yel, '?'), unsigned: c(C.yel, '⚠'), unpinned: c(C.dim, '·') };
const findingLine = (f) => `      ${c(C.red, '☠')} ${f.tool}: ${f.flags.join('; ')}`;

function usage() {
  out(`${c(C.bold, 'canon')} — own your agent skills · vet · sign · pin · verify

  canon scan <source...>            poison-scan a skill / MCP manifest / directory
  canon add  <source...> [--sign]   vet + pin into ${lockPath} (refuses poisoned unless --force)
  canon verify [--lock <file>]      re-check every pinned skill for drift / poisoning
  canon diff <source> [--name <n>]  show what changed since it was pinned
  canon list                        show the pinned set

  Exit 1 on any flagged / drifted / poisoned result — drop it in CI.`);
}

function runScan() {
  if (!sources.length) return (usage(), 2);
  let bad = 0;
  for (const s of sources) {
    try {
      const r = scan(s);
      out(`${mark[r.verdict]} ${c(C.bold, r.skill.name)} ${c(C.dim, `(${r.skill.kind})`)}  ${r.verdict}`);
      r.findings.forEach((f) => out(findingLine(f)));
      if (r.verdict !== 'clean') bad++;
    } catch (e) { out(`${c(C.red, '✗')} ${s}: ${e.message}`); bad++; }
  }
  return bad ? 1 : 0;
}

function runAdd() {
  if (!sources.length) return (usage(), 2);
  const sign = opt('--sign', false), force = opt('--force', false);
  let bad = 0;
  for (const s of sources) {
    try {
      const r = pin(s, { lockPath, sign: !!sign, force: !!force, name: opt('--name', undefined) });
      if (r.ok) out(`${mark.ok} pinned ${c(C.bold, r.name)} ${c(C.dim, r.hash.slice(0, 12))}${r.signed ? c(C.dim, ' · signed') : ''}`);
      else { out(`${mark.flagged} refused ${c(C.bold, s)} — poisoned (use --force to override):`); r.findings.forEach((f) => out(findingLine(f))); bad++; }
    } catch (e) { out(`${c(C.red, '✗')} ${s}: ${e.message}`); bad++; }
  }
  return bad ? 1 : 0;
}

function runVerify() {
  const { ok, results } = verify({ lockPath });
  if (!results.length) { out(c(C.dim, `no pinned skills in ${lockPath}`)); return 0; }
  for (const r of results) {
    out(`${mark[r.status] || '?'} ${c(C.bold, r.name)}  ${r.status}${r.signed ? c(C.dim, ' · signed') : ''}`);
    if (r.status === 'drifted') out(c(C.dim, `      ${summary(r)}`));
    if (r.status === 'poisoned') r.findings.forEach((f) => out(findingLine(f)));
  }
  out(ok ? c(C.grn, `\nall ${results.length} pinned skills verified`) : c(C.red, `\n${results.filter((r) => r.status !== 'ok').length}/${results.length} FAILED — review above`));
  return ok ? 0 : 1;
}

function runDiff() {
  if (!sources.length) return (usage(), 2);
  const r = diff(sources[0], { lockPath, name: opt('--name', undefined) });
  out(`${mark[r.status] || '?'} ${c(C.bold, r.name)}  ${r.status}`);
  if (r.status === 'drifted') {
    out(c(C.dim, `      was ${r.was.slice(0, 12)} → now ${r.now.slice(0, 12)}`));
    out(`      ${summary(r)}`);
  }
  return r.status === 'drifted' || r.status === 'unpinned' ? 1 : 0;
}

function summary(r) {
  const bits = [];
  if (r.added?.length) bits.push(c(C.grn, `+${r.added.join(' +')}`));
  if (r.changed?.length) bits.push(c(C.yel, `~${r.changed.join(' ~')}`));
  if (r.removed?.length) bits.push(c(C.red, `-${r.removed.join(' -')}`));
  return bits.join('  ') || c(C.dim, '(content changed)');
}

function runList() {
  const lock = readLock(lockPath);
  const names = Object.keys(lock.skills);
  if (!names.length) { out(c(C.dim, `no pinned skills in ${lockPath}`)); return 0; }
  for (const n of names) {
    const e = lock.skills[n];
    out(`${c(C.grn, '●')} ${c(C.bold, n)} ${c(C.dim, `${e.kind} · ${e.hash.slice(0, 12)} · ${e.scannedAt.slice(0, 10)}${e.sig ? ' · signed' : ''}`)}`);
  }
  return 0;
}

const table = { scan: runScan, add: runAdd, verify: runVerify, diff: runDiff, list: runList };
if (!cmd || cmd === '-h' || cmd === '--help' || !table[cmd]) { usage(); process.exit(cmd && cmd !== '-h' && cmd !== '--help' ? 2 : 0); }
process.exit(table[cmd]());
