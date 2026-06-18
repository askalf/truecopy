// Runtime enforcement logic — classify the tools an MCP server actually advertises
// against what you pinned in canon.lock. Only a tool that is pinned, unmodified,
// and unpoisoned is "vetted"; everything else is dropped so it never reaches the
// agent. This is the runtime half of canon: vet (scan/add) → pin → ENFORCE.
import { sha256, canonicalJson } from './hash.mjs';
import { scanSkill } from './scan.mjs';

export const toolHash = (t) => sha256(canonicalJson(t));   // export it for mcp.mjs

/**
 * → { report: [{ tool, hash, status }], allowed: Set<contentHash> }
 * status: vetted | drifted | unvetted | unpinned | poisoned
 */
export function gateTools(tools = [], entry = null) {
  // Fail-safe: a hostile MCP server can advertise a non-array tool list or
  // null/primitive entries. A non-array yields an empty gate (nothing vetted →
  // everything dropped downstream); malformed entries are filtered out (they're
  // never "vetted", so dropping them is the safe outcome).
  if (!Array.isArray(tools)) return { report: [], allowed: new Set() };
  tools = tools.filter((t) => t && typeof t === 'object');
  const parts = (entry && entry.parts && typeof entry.parts === 'object') ? entry.parts : {};
  const poisoned = new Set(scanSkill({ scanTargets: tools }).findings.map((f) => f.tool));
  const nameCounts = {};
  for (const t of tools) nameCounts[t.name] = (nameCounts[t.name] || 0) + 1;
  const report = tools.map((t) => {
    const h = toolHash(t);
    const status =
      poisoned.has(t.name) ? 'poisoned'        // injection/exfil in name/desc/schema — never serve
        : !entry ? 'unpinned'                  // this server isn't in the lock at all
          : nameCounts[t.name] > 1 ? 'drifted' // duplicate name → not trustworthy by name
            : !(t.name in parts) ? 'unvetted'  // a tool you never pinned (e.g. silently added)
              : parts[t.name] !== h ? 'drifted' // pinned, but its definition changed
                : 'vetted';
    return { tool: t.name, hash: h, status };
  });
  // allowed keyed by CONTENT HASH so the runtime filter can drop a same-named drifted twin
  return { report, allowed: new Set(report.filter((r) => r.status === 'vetted').map((r) => r.hash)) };
}
