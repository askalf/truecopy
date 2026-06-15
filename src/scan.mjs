// Poison scan — reuse warden's supply-chain scanner (the OpenClaw poisoned-skill
// class: injection / exfil instructions hidden in a tool's name, description, or
// schema). canon adds the provenance layer on top; warden owns the detection.
import { scanMcpTools } from '@askalf/warden/mcp';

/** Scan a loaded skill for poisoning. → { verdict: 'clean'|'flagged', findings } */
export function scanSkill(skill) {
  const findings = scanMcpTools(skill.scanTargets || []);
  return { verdict: findings.length ? 'flagged' : 'clean', findings };
}
