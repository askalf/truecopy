#!/usr/bin/env node
// canon CLI — vet, pin, and verify agent skills & MCP servers.
// Exit code is a CI gate: 0 = all clean, 1 = anything flagged / drifted / poisoned.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, pin, unpin, verify, diff, readLock, resolveLock, ensureKey, keyId, trustKey, untrustKey, listTrust, loadSkill, skillHash, scanSkill } from './index.mjs';
import { discoverClaudeSkills, discoverClaudePluginSkills, discoverMarketplaceSkills, resolveClaudeSkill } from './claude.mjs';

// This build's version — so `hook install` can PIN the gate command to a git tag
// (a released version always has one) instead of fetching an unpinned ref at every
// Skill invocation. Unreadable → unpinned fallback.
const PKG_VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const pre = sep >= 0 ? argv.slice(0, sep) : argv;
const post = sep >= 0 ? argv.slice(sep + 1) : []; // wrapped command, for `canon guard -- <cmd>`
const cmd = pre[0];
const opt = (name, def) => {
  const i = pre.indexOf(name);
  if (i >= 0) { const nx = pre[i + 1]; return nx !== undefined && !nx.startsWith('--') ? nx : true; } // `--name value` or bare `--name`
  const eq = pre.find((x) => x.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : def;
};
const VALUE_FLAGS = new Set(['--lock', '--name', '--trust', '--settings', '--command', '--marketplace']); // consume the next token as a value
const sources = (() => {
  const out = [];
  for (let i = 1; i < pre.length; i++) {
    const a = pre[i];
    if (a.startsWith('--')) { if (VALUE_FLAGS.has(a) && pre[i + 1] && !pre[i + 1].startsWith('--')) i++; continue; }
    out.push(a);
  }
  return out;
})();
// Default lock: prefer truecopy.lock, transparently fall back to an existing
// canon.lock (pre-rename repos), else write truecopy.lock. `--lock` overrides.
const lockPath = resolveLock(opt('--lock', null) || null);
const optTrust = () => { const t = opt('--trust', undefined); return typeof t === 'string' ? t : undefined; };
// `--json` — machine-readable output for scan/verify/list/diff: one JSON document
// on stdout, no ANSI, and the SAME exit codes (the CI gate contract is the exit
// code; --json only changes what a dashboard/PR-commenter can parse from stdout).
const jsonOut = !!opt('--json', false);

// `--claude` expands to every Claude Code skill visible from here (.claude/skills,
// project + user scope); `--claude-plugins` adds every skill shipped by installed
// marketplace plugins, pinned under the `plugin:skill` name Claude Code invokes it
// by (the dir basename alone would collide — discord:access vs telegram:access).
// Project-relative paths go into the lock with forward slashes so a committed
// canon.lock verifies on any OS / in CI.
const portable = (dir) => {
  const rel = path.relative(process.cwd(), dir);
  return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : dir).replace(/\\/g, '/');
};
const allSources = () => {
  const mkt = opt('--marketplace', undefined); // a CLONED marketplace/plugin repo (canon stays offline — you fetch, it scans)
  return [
    ...sources.map((src) => ({ src })),
    ...(opt('--claude', false) ? discoverClaudeSkills().map(({ dir }) => ({ src: portable(dir) })) : []),
    ...(opt('--claude-plugins', false) ? discoverClaudePluginSkills().map(({ name, dir }) => ({ src: portable(dir), name })) : []),
    ...(typeof mkt === 'string' ? discoverMarketplaceSkills(mkt).map(({ name, dir }) => ({ src: portable(dir), name })) : []),
  ];
};

const tty = process.stdout.isTTY;
const C = { red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', rst: '\x1b[0m' };
const c = (col, s) => (tty ? col + s + C.rst : s);
const out = (s = '') => process.stdout.write(s + '\n');
const mark = { ok: c(C.grn, '✓'), clean: c(C.grn, '✓'), flagged: c(C.red, '☠'), poisoned: c(C.red, '☠'), drifted: c(C.yel, '⚠'), missing: c(C.yel, '?'), unsigned: c(C.red, '⚠'), untrusted: c(C.red, '⚠'), unpinned: c(C.dim, '·') };
const findingLine = (f) => `      ${c(C.red, '☠')} ${f.tool}: ${f.flags.join('; ')}`;

function usage() {
  out(`${c(C.bold, 'truecopy')} — own your agent skills · vet · sign · pin · verify

  truecopy scan <source...>            poison-scan a skill / MCP manifest / directory
  truecopy add  <source...> [--sign]   vet + pin into ${lockPath} (refuses poisoned unless --force)
  truecopy scan --claude               poison-scan every Claude Code skill (.claude/skills, project + user)
  truecopy add  --claude [--sign]      vet + pin them all
  truecopy scan --claude-plugins       …and every skill shipped by installed marketplace plugins
  truecopy add  --claude-plugins       vet + pin those under their \`plugin:skill\` invocation name
  truecopy scan --marketplace <dir>    poison-scan a CLONED marketplace or plugin repo (you fetch, truecopy scans)
  truecopy verify [--lock <file>] [--trust <file>] [--require-signed]   re-check every pinned skill
                                    for drift / poisoning (--require-signed: also fail any entry
                                    without a valid signature from a trusted key)
  truecopy diff <source> [--name <n>]  show what changed since it was pinned
  truecopy list                        show the pinned set
  truecopy remove <name...>            un-pin a skill — drop its ${lockPath} entry (alias: unpin)
  truecopy check-manifest <file>       compare every INSTALLED marketplace plugin skill against a
                                    watch manifest (directory-manifest.json on the watch branch):
                                    drifted-from-watched or watch-flagged fails; takes --json
  truecopy guard [--lock <file>] [--require-signed] -- <cmd...>   verify the lock, then run <cmd> only if it's clean
  …scan / verify / list / diff take --json: machine-readable stdout, same exit codes

  truecopy key                         print this machine's public key + id (share it to be trusted)
  truecopy trust add <pubkey> --name <who> [--repo]   trust a publisher's key (--repo → commit it to truecopy.trust)
  truecopy trust list                  show the trusted signing keys
  truecopy trust remove <id> [--all]   stop trusting a key (≥8 chars of the id; --all if it matches several)

  truecopy hook claude [--strict]      Claude Code PreToolUse hook: block a pinned skill that
                                    drifted or turned poisonous at the moment it's invoked
                                    (--strict: only pinned skills may run at all)
  truecopy hook install [--strict] [--user] [--settings <file>]
                                    wire that hook into .claude/settings.json (idempotent;
                                    project file by default, --user for ~/.claude)

  truecopy-mcp [--lock] [--name] [--strict] -- <mcp-server cmd...>
                                    enforce the lock on a LIVE MCP server: only vetted,
                                    unmodified, unpoisoned tools reach the client

  \`canon\` / \`canon-mcp\` remain as back-compat aliases, and an existing canon.lock /
  canon.trust is read automatically (new pins write truecopy.lock / truecopy.trust).

  Exit 1 on any flagged / drifted / poisoned result — drop it in CI.`);
}

const advisoryLine = (f) => c(C.dim, `      · ${f.tool}: ${f.flags.join('; ')}  (advisory — capability mention, not an instruction)`);

function runScan() {
  const list = allSources();
  if (!list.length) return (usage(), 2);
  let bad = 0;
  const results = [];
  for (const { src, name } of list) {
    try {
      const r = scan(src);
      if (jsonOut) results.push({ name: name || r.skill.name, kind: r.skill.kind, verdict: r.verdict, findings: r.findings, advisories: r.advisories || [] });
      else {
        const adv = r.advisories?.length ? c(C.yel, `  · ${r.advisories.length} advisory`) : '';
        out(`${mark[r.verdict]} ${c(C.bold, name || r.skill.name)} ${c(C.dim, `(${r.skill.kind})`)}  ${r.verdict}${adv}`);
        r.findings.forEach((f) => out(findingLine(f)));
        (r.advisories || []).forEach((f) => out(advisoryLine(f)));
      }
      if (r.verdict !== 'clean') bad++;
    } catch (e) {
      // an unreadable source counts against `flagged` — it fails the gate today, and
      // a JSON consumer must see WHY the exit code is 1
      if (jsonOut) results.push({ name: name || src, error: e.message });
      else out(`${c(C.red, '✗')} ${src}: ${e.message}`);
      bad++;
    }
  }
  if (jsonOut) out(JSON.stringify({ results, flagged: bad }));
  return bad ? 1 : 0;
}

function runAdd() {
  const list = allSources();
  if (!list.length) return (usage(), 2);
  const sign = opt('--sign', false), force = opt('--force', false);
  let bad = 0;
  for (const { src, name } of list) {
    try {
      const r = pin(src, { lockPath, sign: !!sign, force: !!force, name: name || opt('--name', undefined) });
      if (r.ok) out(`${mark.ok} pinned ${c(C.bold, r.name)} ${c(C.dim, r.hash.slice(0, 12))}${r.signed ? c(C.dim, ' · signed') : ''}${r.advisories ? c(C.yel, ` · ${r.advisories} advisory`) : ''}`);
      else { out(`${mark.flagged} refused ${c(C.bold, name || src)} — poisoned (use --force to override):`); r.findings.forEach((f) => out(findingLine(f))); bad++; }
    } catch (e) { out(`${c(C.red, '✗')} ${src}: ${e.message}`); bad++; }
  }
  return bad ? 1 : 0;
}

function runVerify() {
  const { ok, results, error } = verify({ lockPath, trustPath: optTrust(), requireSigned: !!opt('--require-signed', false) });
  // the library return IS the documented shape — emit it verbatim (incl. `error`
  // for a missing/corrupt lock, which keeps failing closed with exit 1)
  if (jsonOut) { out(JSON.stringify(error === undefined ? { ok, results } : { ok, results, error })); return ok ? 0 : 1; }
  if (error) { out(c(C.red, `⛔ ${error}`)); return 1; }
  if (!results.length) { out(c(C.dim, `no pinned skills in ${lockPath}`)); return 0; }
  for (const r of results) {
    const sig = r.signer ? c(C.dim, ` · signed by ${r.signer}`) : (r.signed ? c(C.dim, ' · signed') : '');
    const acc = r.accepted ? c(C.yel, ' · accepted findings (--force pin)') : '';
    out(`${mark[r.status] || '?'} ${c(C.bold, r.name)}  ${r.status}${sig}${acc}`);
    if (r.status === 'drifted') out(c(C.dim, `      ${summary(r)}`));
    if (r.status === 'untrusted') out(c(C.dim, `      key ${r.keyId} not trusted — canon trust add <pubkey> --name <publisher>`));
    if (r.requiredSignature) out(c(C.dim, `      --require-signed: no trusted signature — sign it (canon add --sign) and trust the key`));
    if (r.status === 'poisoned') {
      r.findings.forEach((f) => out(findingLine(f)));
      // the single most confusing verify outcome, disambiguated: the bytes did not
      // move — the detection did. Still fails closed; a human must re-accept.
      if (r.detectionChanged) out(c(C.dim, `      same bytes — flagged by newer detection (${r.pinnedDetection.engine} ${r.pinnedDetection.version} → ${r.currentDetection?.version || 'unknown'}); review, then re-accept with: canon add --force ${r.source}`));
    }
  }
  out(ok ? c(C.grn, `\nall ${results.length} pinned skills verified`) : c(C.red, `\n${results.filter((r) => r.status !== 'ok').length}/${results.length} FAILED — review above`));
  return ok ? 0 : 1;
}

function runDiff() {
  if (!sources.length) return (usage(), 2);
  let r;
  try { r = diff(sources[0], { lockPath, name: opt('--name', undefined) }); }
  catch (e) {
    // an unreadable source / corrupt lock must not break the --json contract
    // (one JSON document on stdout) — emit a JSON error, still exit 1
    if (jsonOut) { out(JSON.stringify({ name: opt('--name', undefined) || sources[0], status: 'error', error: e.message })); return 1; }
    out(`${c(C.red, '✗')} ${e.message}`); return 1;
  }
  if (jsonOut) { out(JSON.stringify(r)); return r.status === 'drifted' || r.status === 'unpinned' ? 1 : 0; }
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
  let lock;
  try { lock = readLock(lockPath); }
  catch (e) {
    // a corrupt lock throws — keep the --json contract instead of an empty stdout
    if (jsonOut) { out(JSON.stringify({ error: e.message, skills: [] })); return 1; }
    out(`${c(C.red, '⛔ ')}${e.message}`); return 1;
  }
  const names = Object.keys(lock.skills);
  if (jsonOut) {
    const skills = names.map((n) => { const e = lock.skills[n]; return { name: n, kind: e.kind, hash: e.hash, scannedAt: e.scannedAt, signed: !!(e.sig || e.signed), ...(e.detection ? { detection: e.detection } : {}) }; });
    out(JSON.stringify({ skills }));
    return 0;
  }
  if (!names.length) { out(c(C.dim, `no pinned skills in ${lockPath}`)); return 0; }
  const short = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '?'); // a hand-edited entry may lack hash/scannedAt
  for (const n of names) {
    const e = lock.skills[n];
    out(`${c(C.grn, '●')} ${c(C.bold, n)} ${c(C.dim, `${e.kind || '?'} · ${short(e.hash, 12)} · ${short(e.scannedAt, 10)}${e.detection ? ` · ${e.detection.engine} ${e.detection.version}` : ''}${e.sig ? ' · signed' : ''}`)}`);
  }
  return 0;
}

// The lock lifecycle's other half: `add` pins, `remove` un-pins. Names are lock
// keys matched exactly (no disk access), so removing an already-uninstalled skill
// works. Idempotent — a missing name is a notice, not a failure — so CI can call it.
function runRemove() {
  if (!sources.length) { out(`usage: canon remove <name...> [--lock <file>]`); return 2; }
  for (const name of sources) {
    const n = unpin(name, { lockPath });
    out(n ? `${mark.ok} removed ${c(C.bold, name)}` : c(C.dim, `no matching entry: ${name}`));
  }
  return 0;
}

// A watch manifest maps `plugin:skill` names to skill hashes — the weekly
// marketplace watch publishes one for the official plugin directory
// (directory-manifest.json on the watch branch). check-manifest compares every
// INSTALLED marketplace plugin skill on this machine against it: same name +
// same bytes as the watch scanned → `match`; same name, different bytes →
// `drifted` (exit 1 — what's on disk is not what was scanned); a name the
// manifest flagged as poisoned → `flagged` (exit 1 even byte-identical: match
// is not endorsement); a name the manifest doesn't know → `unlisted` (reported,
// never fatal — your own plugins and other marketplaces are normal). Manifest
// skills that aren't installed here are ignored: the check is about what CAN
// run on this machine. Offline like everything else — you fetch the manifest,
// truecopy only reads it.
function runCheckManifest() {
  const file = sources[0];
  if (!file) { out('usage: truecopy check-manifest <manifest.json>   (directory-manifest.json from the watch branch)'); return 2; }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { out(`${c(C.red, '✗')} unreadable manifest ${file}: ${e.message}`); return 2; }
  const skills = manifest && typeof manifest.skills === 'object' && manifest.skills !== null && !Array.isArray(manifest.skills) ? manifest.skills : null;
  if (!skills) { out(`${c(C.red, '✗')} ${file}: not a watch manifest (no "skills" name→hash map)`); return 2; }
  const flaggedSet = new Set(Array.isArray(manifest.flagged) ? manifest.flagged.filter((n) => typeof n === 'string') : []);
  const installed = discoverClaudePluginSkills();
  let bad = 0;
  const results = [];
  for (const { name, dir, marketplace } of installed) {
    let row;
    try {
      const hash = skillHash(loadSkill(dir));
      // Object.hasOwn, not `in` / direct read: a hostile manifest can carry
      // `__proto__`/`toString` keys, and a skill named after a prototype member
      // must not read the inherited value as its "expected hash".
      const expected = Object.hasOwn(skills, name) && typeof skills[name] === 'string' ? skills[name] : null;
      const status = flaggedSet.has(name) ? 'flagged' : expected === null ? 'unlisted' : expected === hash ? 'match' : 'drifted';
      row = { name, marketplace, status, hash, ...(expected && expected !== hash ? { expected } : {}) };
    } catch (e) {
      row = { name, marketplace, status: 'error', error: e.message }; // unreadable installed skill fails the gate — same posture as scan
    }
    if (row.status !== 'match' && row.status !== 'unlisted') bad++;
    results.push(row);
  }
  const summary = { manifest: { scannedAt: manifest.scannedAt, skills: Object.keys(skills).length }, installed: installed.length, failing: bad };
  if (jsonOut) out(JSON.stringify({ ...summary, results }));
  else {
    const markOf = { match: mark.ok, drifted: mark.drifted, flagged: mark.poisoned, unlisted: mark.unpinned, error: c(C.red, '✗') };
    for (const r of results) {
      const detail = r.status === 'drifted' ? c(C.dim, `  installed ${r.hash.slice(0, 12)} ≠ watched ${r.expected.slice(0, 12)}`)
        : r.status === 'flagged' ? c(C.red, '  flagged poisoned by the watch — do not run')
        : r.status === 'error' ? c(C.red, `  ${r.error}`) : '';
      out(`${markOf[r.status]} ${c(C.bold, r.name)} ${c(C.dim, `(${r.marketplace})`)}  ${r.status}${detail}`);
    }
    out(c(C.dim, `${installed.length} installed plugin skills checked against ${Object.keys(skills).length} watched (manifest ${manifest.scannedAt || 'undated'})`));
  }
  return bad ? 1 : 0;
}

function runGuard() {
  if (!post.length) { out('usage: canon guard [--lock <file>] -- <command...>'); return 2; }
  const { ok, results, error } = verify({ lockPath, trustPath: optTrust(), requireSigned: !!opt('--require-signed', false) });
  if (error) { out(`${c(C.red, '⛔ canon: refusing to launch —')} ${error}`); return 1; }
  if (!ok) {
    const bad = results.filter((r) => r.status !== 'ok');
    out(`${c(C.red, '⛔ canon: refusing to launch —')} ${bad.length} of ${results.length} skill(s) failed:`);
    bad.forEach((r) => out(`   ${mark[r.status] || '?'} ${c(C.bold, r.name)}: ${r.status}`));
    return 1;
  }
  out(c(C.dim, `canon: ${results.length} pinned skill(s) verified — launching`));
  const res = spawnSync(post[0], post.slice(1), { stdio: 'inherit' });
  return res.status ?? (res.error ? 127 : 0);
}

function runKey() {
  const { publicKey } = ensureKey();
  const id = keyId(publicKey);
  if (opt('--json', false)) { out(JSON.stringify({ id, publicKey: publicKey.trim() })); return 0; }
  out(`${c(C.bold, 'key id')}  ${id}`);
  out(publicKey.trim());
  out(c(C.dim, `\nShare this key; whoever trusts you runs:  canon trust add <this-key-file> --name <you>`));
  return 0;
}

function readKeyArg(arg) {
  // accept a PEM file, or a JSON key file / `canon key --json` output ({ publicKey })
  const raw = fs.readFileSync(arg, 'utf8');
  if (raw.trim().startsWith('{')) { try { return JSON.parse(raw).publicKey; } catch {} }
  return raw;
}

function runTrust() {
  const action = sources[0] || 'list';
  if (action === 'list') {
    const keys = listTrust({ trustPath: optTrust() });
    if (!keys.length) { out(c(C.dim, 'no trusted keys')); return 0; }
    for (const k of keys) out(`${c(C.grn, '●')} ${c(C.bold, k.name)} ${c(C.dim, k.id)}`);
    return 0;
  }
  if (action === 'add') {
    if (!sources[1]) { out('usage: canon trust add <publicKeyFile> --name <label> [--repo]'); return 2; }
    let pub;
    try { pub = readKeyArg(sources[1]); } catch (e) { out(`${c(C.red, '✗')} ${e.message}`); return 1; }
    try {
      const repo = !!opt('--repo', false);
      const r = trustKey(pub, opt('--name', undefined), { repo });
      out(`${mark.ok} trusted ${c(C.bold, r.name)} ${c(C.dim, r.id)}${repo ? c(C.dim, ' · truecopy.trust') : ''}`);
      return 0;
    } catch (e) { out(`${c(C.red, '✗')} ${e.message}`); return 1; }
  }
  if (action === 'remove' || action === 'rm') {
    if (!sources[1]) { out('usage: canon trust remove <keyId> [--all]'); return 2; }
    let n;
    // A too-short or ambiguous prefix is refused, not guessed at — removing the
    // wrong trusted key is as bad as keeping one you meant to drop.
    try { n = untrustKey(sources[1], { all: !!opt('--all', false) }); }
    catch (e) { out(`${c(C.red, '✗')} ${e.message}`); return 2; }
    out(n ? `${mark.ok} removed ${n} key(s)` : c(C.dim, 'no matching key'));
    return 0;
  }
  out(`canon trust: unknown action '${action}' (add | list | remove)`);
  return 2;
}

// `canon hook claude` — a Claude Code PreToolUse hook (matcher: Skill). Reads the
// hook payload from stdin, resolves the SAME skill directory Claude Code is about
// to run, and re-checks it against the lock right then. Exit 2 blocks the call
// (Claude Code feeds stderr back to the model); exit 0 lets it through.
//
// Policy — default protects the PINNED set; --strict turns the lock into a whitelist:
//                        default   --strict
//   pinned + unchanged     allow     allow
//   pinned + drifted       BLOCK     BLOCK
//   pinned + poisoned      BLOCK     BLOCK
//   pinned, dir missing    BLOCK     BLOCK     (can't verify what will run → fail closed)
//   not pinned             allow     BLOCK     (adoption-friendly vs lockdown)
//   no lock / hook error   allow     BLOCK     (a crashed gate must not be a bypass in strict)
function runHookClaude() {
  const strict = !!opt('--strict', false);
  const deny = (msg) => { process.stderr.write(`canon: ${msg}\n`); return 2; };
  try {
    let payload = null, parsed = true;
    try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { parsed = false; }
    // A payload we couldn't read/parse is a HOOK ERROR, not a non-Skill call: we
    // don't know what's being invoked. Fail CLOSED in strict (the decision table's
    // "hook error → BLOCK"); allow in default (adoption-friendly). A successfully
    // parsed NON-Skill object is a mis-wired matcher — return 0 in both modes so
    // other tools never break.
    if (!parsed || !payload || typeof payload !== 'object' || Array.isArray(payload))
      return strict ? deny('unreadable hook payload — failing closed (strict)') : 0;
    if (payload.tool_name !== 'Skill') return 0; // mis-wired matcher — never break other tools
    const name = payload.tool_input && payload.tool_input.skill;
    if (!name) return 0;

    // lock: explicit --lock > truecopy.lock (project/cwd) > canon.lock (back-compat, project/cwd).
    // Hooks run in the project dir; prefer the branded name, still honor a pre-rename canon.lock.
    const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
    const explicit = opt('--lock', undefined);
    const candidates = typeof explicit === 'string' ? [explicit]
      : [path.join(projectDir, 'truecopy.lock'), 'truecopy.lock', path.join(projectDir, 'canon.lock'), 'canon.lock'];
    const lp = candidates.find((p) => fs.existsSync(p));
    if (!lp) return strict ? deny(`no truecopy.lock — pin your skills first: truecopy add --claude`) : 0;

    let lock;
    try { lock = readLock(lp, { mustExist: true }); }
    catch (e) { return deny(`refusing skill '${name}' — ${e.message}`); } // corrupt lock fails CLOSED, both modes
    const entry = lock.skills[name];
    if (!entry) return strict ? deny(`skill '${name}' is not pinned in ${lp} — vet it first: canon add .claude/skills/${name}`) : 0;

    const dir = resolveClaudeSkill(name, { projectDir });
    if (!dir) return deny(`skill '${name}' is pinned but not found under .claude/skills — can't verify what will run`);
    const skill = loadSkill(dir);
    if (skillHash(skill) !== entry.hash) return deny(`skill '${name}' DRIFTED since it was pinned — review with: canon diff ${dir.replace(/\\/g, '/')}`);
    const s = scanSkill(skill);
    // findings the human accepted with a --force pin (verdict:'flagged' in the
    // lock) don't re-block the same bytes; flagged-but-pinned-clean still does
    if (s.verdict === 'flagged' && entry.verdict !== 'flagged') return deny(`skill '${name}' is POISONED: ${s.findings.map((f) => `${f.tool}: ${f.flags.join('; ')}`).join(' · ')}`);
    return 0;
  } catch (e) {
    return strict ? deny(`hook error — ${e && e.message || e}`) : 0;
  }
}

// `canon hook install` — wire the gate into Claude Code settings without hand-
// editing JSON. Manages exactly ONE canon-owned PreToolUse entry (recognized by
// its command containing `hook claude`), updating it in place on re-runs; every
// other hook is left untouched. An unparseable settings file is REFUSED, never
// clobbered — a config gate must not destroy config.
function runHookInstall() {
  const strict = !!opt('--strict', false);
  const explicit = opt('--settings', undefined);
  const target = typeof explicit === 'string' ? explicit
    : (opt('--user', false) ? path.join(os.homedir(), '.claude', 'settings.json') : path.join('.claude', 'settings.json'));
  const cmdOverride = opt('--command', undefined);
  // Pin to THIS version's git tag (released versions have one) — a supply-chain
  // gate should not fetch a moving ref on every Skill call. Correct repo name
  // (truecopy, not the legacy canon). Re-run `hook install` after upgrading to
  // repoint; `--command` still overrides for a global-install / offline setup.
  const ref = PKG_VERSION ? `#v${PKG_VERSION}` : '';
  const command = typeof cmdOverride === 'string' ? cmdOverride
    : `npx -y github:askalf/truecopy${ref} hook claude${strict ? ' --strict' : ''}`;

  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (e) {
    if (!e || e.code !== 'ENOENT') { out(`${c(C.red, '✗')} ${target} exists but can't be used: ${e.message} — fix it, or point --settings elsewhere`); return 1; }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) { out(`${c(C.red, '✗')} ${target} is not a settings object — refusing to rewrite it`); return 1; }
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks) || settings.hooks === null)) { out(`${c(C.red, '✗')} ${target} has a non-object "hooks" — refusing to rewrite it`); return 1; }
  settings.hooks = settings.hooks || {};
  if (settings.hooks.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse)) { out(`${c(C.red, '✗')} ${target} has a non-array hooks.PreToolUse — refusing to rewrite it`); return 1; }
  const pre = settings.hooks.PreToolUse || (settings.hooks.PreToolUse = []);

  const ours = (h) => h && Array.isArray(h.hooks) && h.hooks.some((x) => x && typeof x.command === 'string' && x.command.includes('hook claude'));
  const entry = { matcher: 'Skill', hooks: [{ type: 'command', command, timeout: 20 }] }; // 20s: margin for a cold (pinned) npx fetch on the first gated call
  const i = pre.findIndex(ours);
  const action = i >= 0 ? 'updated' : 'installed';
  if (i >= 0) pre[i] = entry; else pre.push(entry);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
  out(`${mark.ok} ${action} the canon Skill gate in ${target}${strict ? ` ${c(C.yel, '(strict)')}` : ''}`);
  out(c(C.dim, `   command: ${command}`));
  out(c(C.dim, '   already-running Claude Code sessions snapshot hooks at start — restart them to pick this up'));
  if (typeof explicit !== 'string' && !opt('--user', false)) out(c(C.dim, `   commit ${target} together with ${lockPath} and this repo's gate travels with it`));
  return 0;
}

function runHook() {
  const sub = sources[0] || '';
  if (sub === 'claude') return runHookClaude();
  if (sub === 'install') return runHookInstall();
  out('usage: canon hook claude [--lock <file>] [--strict]   ·   canon hook install [--strict] [--user] [--settings <file>] [--command <cmd>]');
  return 2;
}

const table = { scan: runScan, add: runAdd, remove: runRemove, unpin: runRemove, verify: runVerify, diff: runDiff, list: runList, 'check-manifest': runCheckManifest, guard: runGuard, key: runKey, trust: runTrust, hook: runHook };
if (!cmd || cmd === '-h' || cmd === '--help' || !table[cmd]) { usage(); process.exit(cmd && cmd !== '-h' && cmd !== '--help' ? 2 : 0); }
try { process.exit(table[cmd]()); }
catch (e) { process.stderr.write(`canon: ${e && e.message || e}\n`); process.exit(1); }
