// Runtime enforcement logic — classify the tools an MCP server actually advertises
// against what you pinned in canon.lock. Only a tool that is pinned, unmodified,
// and unpoisoned is "vetted"; everything else is dropped so it never reaches the
// agent. This is the runtime half of canon: vet (scan/add) → pin → ENFORCE.
import { sha256, canonicalJson } from './hash.mjs';
import { scanSkill } from './scan.mjs';

const toolHash = (t) => sha256(canonicalJson(t));

/**
 * → { report: [{ tool, status }], allowed: Set<name> }
 * status: vetted | drifted | unvetted | unpinned | poisoned
 */
export function gateTools(tools = [], entry = null) {
  const parts = (entry && entry.parts) || {};
  const poisoned = new Set(scanSkill({ scanTargets: tools }).findings.map((f) => f.tool));
  const report = tools.map((t) => {
    const status =
      poisoned.has(t.name) ? 'poisoned'        // injection/exfil in name/desc/schema — never serve
        : !entry ? 'unpinned'                  // this server isn't in the lock at all
          : !(t.name in parts) ? 'unvetted'    // a tool you never pinned (e.g. silently added)
            : parts[t.name] !== toolHash(t) ? 'drifted' // pinned, but its definition changed
              : 'vetted';
    return { tool: t.name, status };
  });
  return { report, allowed: new Set(report.filter((r) => r.status === 'vetted').map((r) => r.tool)) };
}
