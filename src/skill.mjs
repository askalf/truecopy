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
// file, a Dockerfile, a Makefile, or an extension-less script. Executable code
// formats (wasm/so/dll/exe/…) are NOT on this skip-list: they're loaded+run, can
// carry readable injection/exfil strings, and an attacker will pick exactly the
// extension the scanner ignores — so we scan their text (best-effort) too.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|mov|avi|mkv|flac)$/i;

// Decode a file to text for SCANNING (not hashing — hashing always uses raw
// bytes). Handles UTF-16 LE/BE by BOM, so an injection encoded as UTF-16 in a
// .md/.txt can't slip past a naive utf8 read (which would mangle it to U+FFFD).
function decodeForScan(buf) {
  // swap16() needs an even-length buffer AND mutates in place — so copy + trim to
  // even first. And never let a decode edge case throw: a scanner that crashes on
  // a crafted file is itself a bypass (the scan is skipped / errors out).
  const swap16 = (b) => Buffer.from(b.length % 2 ? b.subarray(0, b.length - 1) : b).swap16();
  try {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return swap16(buf).toString('utf16le');
    // Heuristic: lots of NUL bytes among ASCII ⇒ likely UTF-16 without a BOM.
    let nul = 0; const cap = Math.min(buf.length, 4096);
    for (let i = 0; i < cap; i++) if (buf[i] === 0) nul++;
    if (cap > 0 && nul / cap > 0.2) {
      const le = (buf.length >= 2 && buf[1] === 0) ? buf : swap16(buf);
      return le.toString('utf16le');
    }
    return buf.toString('utf8');
  } catch { return buf.toString('latin1'); } // byte-preserving best-effort; never throw
}
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
      .map((f) => decodeForScan(fs.readFileSync(f)))
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
