// Poison scan — reuse warden's supply-chain scanner (the OpenClaw poisoned-skill
// class: injection / exfil instructions hidden in a tool's name, description, or
// schema). canon adds the provenance layer on top; warden owns the detection.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { scanMcpTools } from '@askalf/redstamp/mcp';
import { decide } from '@askalf/redstamp';
import { canonicalJson } from './hash.mjs';

// Which detection engine vetted a pin. redstamp is a pinned dependency that gets
// bumped, so "clean" is always clean-as-of-some-ruleset — recording the version at
// pin time lets verify explain the "same bytes, suddenly poisoned" outcome as
// detection-improved rather than looking like a tamper. Resolved locally and
// offline; redstamp's exports map hides ./package.json, so resolve the entry
// module and walk up to its package.json. Never throws — provenance is an
// enrichment, and an unreadable version must not break pinning.
const resolveEngineEntry = () => createRequire(import.meta.url).resolve('@askalf/redstamp');
let cached; // per-process: the engine version can't change mid-run
export function detectionInfo(resolveEntry) {
  if (!resolveEntry && cached !== undefined) return cached;
  let det = null;
  try {
    let dir = path.dirname((resolveEntry || resolveEngineEntry)());
    for (let up = path.dirname(dir); ; dir = up, up = path.dirname(dir)) {
      const p = path.join(dir, 'package.json');
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (pkg && pkg.name === '@askalf/redstamp' && pkg.version) { det = { engine: 'redstamp', version: pkg.version }; break; }
      }
      if (up === dir) break;
    }
  } catch { det = null; }
  if (!resolveEntry) cached = det;
  return det;
}

/** Scan a loaded skill for poisoning. → { verdict: 'clean'|'flagged', findings, advisories }
 *
 *  Severity-aware by SURFACE. Long-form skill/file prose flags only on a
 *  CRITICAL finding — an injection/exfil *instruction*; a bare sensitive-path or
 *  secret-env *mention* comes back as an advisory instead (documentation
 *  legitimately teaches credential handling — the official Claude Code
 *  marketplace flagged 19/29 skills on mentions alone). MCP tool definitions
 *  keep the strict any-finding rule: short descriptions are exactly the surface
 *  the mention heuristics were tuned for. A finding without a `severity` field
 *  (an older warden) is treated as critical — fail closed, never laxer. */
export function scanSkill(skill) {
  const all = scanMcpTools((skill && skill.scanTargets) || []);
  const prose = !!skill && (skill.kind === 'skill' || skill.kind === 'file');
  const findings = prose ? all.filter((f) => (f && f.severity) !== 'advisory') : all;
  const advisories = prose ? all.filter((f) => f && f.severity === 'advisory') : [];
  // An MCP manifest's launch fields (command/args/env) actually RUN when the
  // server starts — an RCE or key-exfil hidden there must be caught too, not just
  // poison in the tool descriptions.
  const lz = skill && skill.launch;
  if (lz && (lz.command || lz.args || lz.env)) {
    const cmd = [lz.command, ...(Array.isArray(lz.args) ? lz.args : []), lz.env ? canonicalJson(lz.env) : '']
      .filter(Boolean).join(' ');
    const v = decide({ tool: 'shell', input: { command: cmd } });
    if (v.tier === 'black' || v.tier === 'red') {
      findings.push({ tool: (skill.name || 'server') + ' (launch)', flags: (v.why || []).filter((w) => /[☠⚠]/.test(w)), severity: 'critical' });
    }
  }
  return { verdict: findings.length ? 'flagged' : 'clean', findings, advisories };
}
