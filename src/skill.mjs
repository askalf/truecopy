// Resolve a skill SOURCE (a path) into a canonical, hashable representation.
// Three shapes a vetted thing comes in:
//   - an MCP manifest  (.json with a `tools` array)  → identity = the tool set
//   - a skill directory (SKILL.md + files)           → identity = a manifest of per-file hashes
//   - a single file     (e.g. a SKILL.md)            → identity = its bytes
// `hashInput` is what we hash (the identity); `scanTargets` is what we poison-scan.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, canonicalJson } from './hash.mjs';

// Scan everything that ISN'T known-binary, rather than an allowlist of "text"
// extensions — a poisoned prompt hides just as well in a `.bin`/`.dat`/`.mdx`
// file, a Dockerfile, a Makefile, or an extension-less script.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|mov|avi|mkv|flac|wasm|so|dylib|dll|exe|class|jar|o|a|node|pyc|pyd)$/i;
// node_modules is bundled runtime code that actually loads — it must be hashed
// AND scanned; only VCS/canon metadata is outside the trust boundary.
const SKIP_DIR = /(^|[\\/])(\.git|\.canon)([\\/]|$)/;

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
    // scan every non-binary file — that's where poisoned prompts hide, and an
    // attacker will pick whatever extension the scanner ignores
    const scanText = files
      .filter((f) => !BINARY_EXT.test(f))
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
      const manifestEnvelope = { ...j }; delete manifestEnvelope.tools;  // top-level fields: name/instructions/command/args/env/url/etc.
      return {
        source, kind: 'mcp', name: j?.name ?? path.basename(source),
        tools, manifestEnvelope,
        launch: { command: j?.command, args: j?.args, env: j?.env, url: j?.url },
        hashInput: canonicalJson(j),                          // whole manifest → renamed server / swapped command/env drifts
        scanTargets: [...tools, { name: (j?.name ?? 'manifest') + ' (manifest)', description: canonicalJson(manifestEnvelope) }],
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
