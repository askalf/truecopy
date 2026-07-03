// Poison scan — reuse warden's supply-chain scanner (the OpenClaw poisoned-skill
// class: injection / exfil instructions hidden in a tool's name, description, or
// schema). canon adds the provenance layer on top; warden owns the detection.
import { scanMcpTools } from '@askalf/warden/mcp';
import { decide } from '@askalf/warden';
import { canonicalJson } from './hash.mjs';

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
