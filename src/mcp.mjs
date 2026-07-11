// canon-mcp — a stdio MCP proxy that ENFORCES canon.lock at runtime. It sits
// between an MCP client and a downstream MCP server, filters `tools/list` down to
// the vetted set, and blocks `tools/call` to anything it dropped. Un-vetted,
// drifted, or poisoned tools never reach the agent. JSON-RPC over newline stdio.
//
// Where warden-mcp firewalls what a tool DOES, canon-mcp gates what tools EXIST.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { gateTools, toolHash } from './gate.mjs';
import { readLock, resolveLock } from './lock.mjs';

const blockReply = (id, name) =>
  JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `⛔ canon blocked an un-vetted / drifted tool: ${name}` }], isError: true } });

const batchError = (msg) => {
  // JSON-RPC batching was removed from MCP (2025-06-18) and would let a tools/call
  // to a dropped tool ride past the single-message gate — so reject a client batch
  // rather than forward it raw. id null per JSON-RPC for a batch-level error.
  const id = Array.isArray(msg) ? (msg.find((m) => m && m.id != null)?.id ?? null) : null;
  return { reply: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message: '⛔ canon: JSON-RPC batching is not supported through the gate — send individual requests' } }) };
};

/** client → server. { forward } to pass on, or { reply } to short-circuit a blocked call. */
export function inspectClient(line, state) {
  let msg;
  try { msg = JSON.parse(line); } catch { return { forward: line }; }
  if (Array.isArray(msg)) return batchError(msg); // a batch could smuggle a blocked tools/call — fail closed
  if (msg && msg.method && msg.id != null) state.pending[msg.id] = msg.method;
  // Fail CLOSED on calls: a tool is callable only once we've SEEN and vetted a
  // tools/list AND its name survived that gating. Before any gated list (`listed`
  // is false), block everything — a tool known to the agent out-of-band, or
  // smuggled past tools/list, must not be forwarded and executed.
  if (msg && msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (!state.listed || !state.allowedNames?.has(name) || state.blocked.has(name)) return { reply: blockReply(msg.id, name) };
  }
  return { forward: line };
}

// Gate ONE server→client message in place: strip any tools array down to the
// vetted set and record vetted/blocked names. Non-tools messages pass through
// (their pending id is cleared). Extracted so a JSON-RPC batch can gate each
// element instead of forwarding the array raw.
function gateServerMsg(msg, state, opts) {
  const isToolsResult = msg && msg.result && Array.isArray(msg.result.tools);
  if (!isToolsResult) { if (msg && msg.id != null) delete state.pending[msg.id]; return msg; }
  if (msg.id != null) delete state.pending[msg.id];
  const { allowed, report } = gateTools(msg.result.tools, opts.entry);
  const blockAll = opts.strict && report.some((r) => r.status !== 'vetted'); // strict: any problem → block the whole server
  for (const r of report) if (r.status !== 'vetted') { state.blocked.add(r.tool); opts.onWarn?.(`${blockAll ? 'strict — blocking all (' : 'dropped '}${r.tool} (${r.status})${blockAll ? ')' : ''}`); }
  const keep = blockAll ? new Set() : allowed;   // allowed is now a Set of hashes
  const kept = msg.result.tools.filter((t) => t && typeof t === 'object' && keep.has(toolHash(t)));
  msg.result.tools = kept;
  // Remember the vetted names so a later tools/call can be allow-listed (fail
  // closed). `listed` flips the call gate from blocklist to allowlist.
  state.listed = true;
  state.allowedNames = state.allowedNames || new Set();
  for (const t of kept) state.allowedNames.add(t.name);
  return msg;
}

/** server → client. Rewrites ANY result carrying a tools array down to the vetted
 *  set — not only one correlated to a tracked tools/list id. A hostile server can
 *  push an UNSOLICITED tools result, answer tools/list TWICE (the 2nd after the id
 *  is cleared), bury tools in another reply, or hide a tools/list inside a
 *  JSON-RPC BATCH array; all must be gated, never forwarded raw. */
export function inspectServer(line, state, opts = {}) {
  let msg;
  try { msg = JSON.parse(line); } catch { return { forward: line }; }
  if (Array.isArray(msg)) return { forward: JSON.stringify(msg.map((m) => gateServerMsg(m, state, opts))) };
  return { forward: JSON.stringify(gateServerMsg(msg, state, opts)) };
}

/** Which lock entry governs this server: explicit --name, else the sole MCP entry. */
export function pickEntry(lock, name) {
  if (name) return (lock.skills && lock.skills[name]) || null;
  const mcp = Object.entries(lock.skills || {}).filter(([, e]) => e.kind === 'mcp');
  return mcp.length === 1 ? mcp[0][1] : null;
}

/** Spawn the downstream server and wire the two gated streams together. */
export function runGate({ command, args = [], lockPath = resolveLock(), name = null, strict = false, onWarn } = {}) {
  const warn = onWarn || ((m) => process.stderr.write('[truecopy] ' + m + '\n'));
  const entry = pickEntry(readLock(lockPath), name);
  if (!entry) warn(`no pinned ${name ? '"' + name + '" ' : ''}MCP entry in ${lockPath} — every tool will be treated as unvetted (canon add it first)`);
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const state = { pending: {}, blocked: new Set(), allowedNames: new Set(), listed: false };
  const opts = { entry, strict, onWarn: warn };

  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    const r = inspectClient(line, state);
    if (r.reply) process.stdout.write(r.reply + '\n');
    if (r.forward) child.stdin.write(r.forward + '\n');
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    process.stdout.write(inspectServer(line, state, opts).forward + '\n');
  });
  process.stdin.on('end', () => { try { child.stdin.end(); } catch {} });
  child.on('exit', (code) => process.exit(code ?? 0));
}
