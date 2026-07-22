// truecopy-mcp STANDALONE — serve truecopy's own tools over stdio, with no
// downstream server to gate.
//
// Why this exists: `truecopy-mcp` is a GATE, so with a downstream it advertises
// that server's vetted tools and none of its own. Run bare, it had nothing to
// advertise at all — an empty tools/list — which is why the container image had
// to wrap a reference server just to have a surface to introspect. Standalone
// mode gives the gate a first-class surface of its own: an agent can ask whether
// the tools it is about to use are still the ones that were vetted.
//
// SECURITY — the exposed surface is deliberately tiny and read-only:
//   * Both tools operate ONLY on the lock this process was configured with.
//     Neither accepts a caller-supplied path.
//   * `truecopy-scan` is deliberately NOT exposed. Findings now carry `evidence`
//     (the matched source text), so a scan tool taking a caller path would be an
//     arbitrary file-content disclosure primitive — point it at .env or
//     ~/.ssh/config and it returns fragments of the file. A gate that leaks file
//     contents on request is worse than no gate.
//   * Nothing here writes, re-pins, or mutates the lock. Pinning is an
//     operator decision made deliberately via the CLI, never something an agent
//     can talk the gate into.
//
// This module does NOT touch the proxy path in mcp.mjs — the fail-closed gating
// that protects a live downstream is unchanged.
import readline from 'node:readline';
import { verify, readLock, resolveLock } from './index.mjs';

const PROTOCOL = '2024-11-05';

export const TOOLS = [
  {
    name: 'truecopy-verify',
    title: 'Verify pinned tools against the lock',
    description:
      'Re-derive the hash of every skill and MCP server pinned in this truecopy lock and report whether each still matches what was vetted. ' +
      'Use this before trusting a tool surface, or to answer "has anything changed underneath me?". ' +
      'Each entry comes back as one of: ok (bytes identical to what was pinned), drifted (content changed since it was vetted), ' +
      'poisoned (re-scan found an injection or exfiltration pattern), untrusted (signed by a key that is not in the trust store), ' +
      'unsigned (a signature was required but is absent), or missing (the pinned source is no longer on disk). ' +
      'Read-only: it never re-pins, never edits the lock, and never fetches anything over the network.',
    inputSchema: {
      type: 'object',
      properties: {
        requireSigned: {
          type: 'boolean',
          default: false,
          description: 'When true, an entry that verifies but carries no valid signature from a trusted key is reported as "unsigned" rather than "ok".',
        },
      },
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', description: 'True only if every pinned entry verified cleanly.' },
        total: { type: 'number', description: 'Number of entries in the lock.' },
        failed: { type: 'number', description: 'Number of entries that did not verify.' },
        results: {
          type: 'array',
          description: 'Per-entry verification result.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The pinned name.' },
              status: { type: 'string', description: 'ok | drifted | poisoned | untrusted | unsigned | missing' },
            },
            required: ['name', 'status'],
          },
        },
      },
      required: ['ok', 'total', 'failed', 'results'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'truecopy-status',
    title: 'Describe what this lock pins',
    description:
      'List what this truecopy lock pins, without re-verifying it. Returns each entry with the kind of artifact (skill, mcp, or file), ' +
      'the scan verdict recorded at pin time, and whether it carries a signature. ' +
      'Use this to see the vetted set at a glance — what an agent is permitted to run — or to confirm the gate is reading the lock you expect. ' +
      'For whether those bytes are still unchanged, call truecopy-verify instead. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' },
    outputSchema: {
      type: 'object',
      properties: {
        lockPath: { type: 'string', description: 'Path of the lock this gate was configured with.' },
        total: { type: 'number', description: 'Number of pinned entries.' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string', description: 'skill | mcp | file' },
              verdict: { type: 'string', description: 'Scan verdict recorded when this entry was pinned.' },
              signed: { type: 'boolean' },
            },
            required: ['name', 'kind'],
          },
        },
      },
      required: ['lockPath', 'total', 'entries'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const structured = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj });

/** Execute one of our own tools. Pure: no path input, no writes, no network. */
export function callTool(name, args = {}, { lockPath }) {
  if (name === 'truecopy-verify') {
    const v = verify({ lockPath, requireSigned: !!args.requireSigned });
    if (v.error) return { content: [{ type: 'text', text: `truecopy: ${v.error}` }], isError: true };
    const results = v.results.map((r) => ({ name: r.name, status: r.status }));
    return structured({ ok: v.ok, total: results.length, failed: results.filter((r) => r.status !== 'ok').length, results });
  }
  if (name === 'truecopy-status') {
    let lock;
    try { lock = readLock(lockPath, { mustExist: true }); }
    catch (e) { return { content: [{ type: 'text', text: `truecopy: ${e.message}` }], isError: true }; }
    const entries = Object.entries(lock.skills).map(([name, e]) => ({
      name, kind: e.kind || 'skill', verdict: e.verdict || 'unknown', signed: !!e.signed,
    }));
    return structured({ lockPath, total: entries.length, entries });
  }
  return { content: [{ type: 'text', text: `truecopy: unknown tool ${name}` }], isError: true };
}

/** Handle one JSON-RPC message. → reply object, or null when none is due. */
export function handle(msg, ctx) {
  if (!msg || msg.jsonrpc !== '2.0') return null;
  const { id, method } = msg;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'truecopy', title: 'truecopy — supply-chain gate', version: ctx.version || '0.0.0' },
    } };
  }
  if (method === 'notifications/initialized') return null; // notification: no reply
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = msg.params?.name;
    if (!TOOLS.some((t) => t.name === name)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } };
    }
    return { jsonrpc: '2.0', id, result: callTool(name, msg.params?.arguments || {}, ctx) };
  }
  if (id == null) return null;                       // any other notification
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}

export function runStandalone({ lockPath = resolveLock(), version } = {}) {
  const ctx = { lockPath, version };
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); return; }
    // Batching was removed from MCP (2025-06-18); reject rather than half-handle.
    if (Array.isArray(msg)) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC batching is not supported' } }) + '\n');
      return;
    }
    const reply = handle(msg, ctx);
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  });
}
