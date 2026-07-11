import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectClient, inspectServer } from '../src/mcp.mjs';
import { toolHash } from '../src/gate.mjs';

// A pinned entry that vets exactly read_file (its content hash).
const READ = { name: 'read_file', description: 'Read a file.' };
const EXEC = { name: 'exec', description: 'Run a shell command.' };
const entry = { kind: 'mcp', verdict: 'clean', parts: { read_file: toolHash(READ) } };
const freshState = () => ({ pending: {}, blocked: new Set(), allowedNames: new Set(), listed: false });
const listMsg = (tools, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, result: { tools } });
const callMsg = (name, id = 2) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

test('inspectClient: a tools/call before any gated tools/list is BLOCKED (fail closed)', () => {
  const s = freshState();
  const r = inspectClient(callMsg('read_file'), s); // even a would-be-vetted name
  assert.ok(r.reply && !r.forward, 'no list seen yet → blocked, not forwarded');
  assert.match(JSON.parse(r.reply).result.text ?? JSON.parse(r.reply).result.content[0].text, /blocked/);
});

test('inspectClient: after a gated list, a vetted call passes and a dropped call is blocked', () => {
  const s = freshState();
  inspectServer(listMsg([READ, EXEC]), s, { entry }); // gates: read_file vetted, exec dropped
  assert.equal(s.listed, true);
  assert.ok(inspectClient(callMsg('read_file'), s).forward, 'vetted tool forwards');
  assert.ok(inspectClient(callMsg('exec'), s).reply, 'dropped tool blocked');
  assert.ok(inspectClient(callMsg('never_listed'), s).reply, 'a name that was never vetted is blocked');
});

test('inspectClient: a JSON-RPC BATCH request is rejected, never forwarded', () => {
  const s = freshState();
  inspectServer(listMsg([READ]), s, { entry }); // read_file is vetted by name now
  // a batch that hides a tools/call to a dropped tool alongside a vetted one
  const batch = JSON.stringify([
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'read_file', arguments: {} } },
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'exec', arguments: {} } },
  ]);
  const r = inspectClient(batch, s);
  assert.ok(r.reply && !r.forward, 'batch is rejected, not forwarded');
  const err = JSON.parse(r.reply);
  assert.equal(err.error.code, -32600);
  assert.match(err.error.message, /batch/i);
});

test('inspectServer: a tools/list hidden inside a BATCH is gated, not forwarded raw', () => {
  const s = freshState();
  const batch = JSON.stringify([
    { jsonrpc: '2.0', id: 1, result: { tools: [READ, EXEC] } }, // exec must be stripped
    { jsonrpc: '2.0', id: 2, result: { ok: true } },            // unrelated reply passes through
  ]);
  const out = JSON.parse(inspectServer(batch, s, { entry }).forward);
  assert.ok(Array.isArray(out), 'still a batch');
  assert.deepEqual(out[0].result.tools.map((t) => t.name), ['read_file'], 'exec stripped from the batched list');
  assert.equal(out[1].result.ok, true, 'unrelated batched reply preserved');
  assert.ok(s.blocked.has('exec'), 'exec recorded as blocked');
  assert.equal(s.listed, true, 'a batched list still arms the call gate');
  // and a follow-up call to the stripped tool is now blocked
  assert.ok(inspectClient(callMsg('exec'), s).reply);
});

test('inspectServer: an ordinary (non-batch) tools result is still gated as before', () => {
  const s = freshState();
  const out = JSON.parse(inspectServer(listMsg([READ, EXEC]), s, { entry }).forward);
  assert.deepEqual(out.result.tools.map((t) => t.name), ['read_file']);
});
