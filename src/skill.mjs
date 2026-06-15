// Resolve a skill SOURCE (a path) into a canonical, hashable representation.
// Three shapes a vetted thing comes in:
//   - an MCP manifest  (.json with a `tools` array)  → identity = the tool set
//   - a skill directory (SKILL.md + files)           → identity = a manifest of per-file hashes
//   - a single file     (e.g. a SKILL.md)            → identity = its bytes
// `hashInput` is what we hash (the identity); `scanTargets` is what we poison-scan.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, canonicalJson } from './hash.mjs';

const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|toml|js|mjs|cjs|ts|py|rb|sh|ps1|html?)$/i;
const SKIP_DIR = /(^|[\\/])(\.git|node_modules|\.canon)([\\/]|$)/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (SKIP_DIR.test(full)) continue;
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

export function loadSkill(source) {
  if (!fs.existsSync(source)) throw new Error(`no such skill source: ${source}`);
  const st = fs.statSync(source);

  if (st.isDirectory()) {
    const files = walk(source).sort();
    const entries = files.map((f) => ({
      path: path.relative(source, f).replace(/\\/g, '/'),
      hash: sha256(fs.readFileSync(f)),
    }));
    // scan the text/instruction files — that's where poisoned prompts hide
    const scanText = files
      .filter((f) => TEXT_EXT.test(f))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    return {
      source, kind: 'skill', name: path.basename(source.replace(/[\\/]$/, '')),
      files: entries, hashInput: canonicalJson(entries),
      scanTargets: [{ name: path.basename(source), description: scanText }],
    };
  }

  const raw = fs.readFileSync(source, 'utf8');
  if (/\.json$/i.test(source)) {
    let j = null;
    try { j = JSON.parse(raw); } catch {}
    const tools = j?.tools ?? (Array.isArray(j) ? j : null);
    if (tools && Array.isArray(tools)) {
      return {
        source, kind: 'mcp', name: j?.name ?? path.basename(source),
        tools, hashInput: canonicalJson(tools), scanTargets: tools,
      };
    }
  }
  return {
    source, kind: 'file', name: path.basename(source),
    hashInput: raw, scanTargets: [{ name: path.basename(source), description: raw }],
  };
}

/** The content hash that pins a skill's identity. */
export const skillHash = (skill) => sha256(skill.hashInput);
