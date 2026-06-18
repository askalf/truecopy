// Poison scan — reuse warden's supply-chain scanner (the OpenClaw poisoned-skill
// class: injection / exfil instructions hidden in a tool's name, description, or
// schema). canon adds the provenance layer on top; warden owns the detection.
import { scanMcpTools } from '@askalf/warden/mcp';
import { decide } from '@askalf/warden';
import { canonicalJson } from './hash.mjs';

/** Scan a loaded skill for poisoning. → { verdict: 'clean'|'flagged', findings } */
export function scanSkill(skill) {
  const findings = scanMcpTools((skill && skill.scanTargets) || []);
  // An MCP manifest's launch fields (command/args/env) actually RUN when the
  // server starts — an RCE or key-exfil hidden there must be caught too, not just
  // poison in the tool descriptions.
  const lz = skill && skill.launch;
  if (lz && (lz.command || lz.args || lz.env)) {
    const cmd = [lz.command, ...(Array.isArray(lz.args) ? lz.args : []), lz.env ? canonicalJson(lz.env) : '']
      .filter(Boolean).join(' ');
    const v = decide({ tool: 'shell', input: { command: cmd } });
    if (v.tier === 'black' || v.tier === 'red') {
      findings.push({ tool: (skill.name || 'server') + ' (launch)', flags: (v.why || []).filter((w) => /[☠⚠]/.test(w)) });
    }
  }
  return { verdict: findings.length ? 'flagged' : 'clean', findings };
}
