import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS, handle, callTool } from '../src/mcp-serve.mjs';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-mcpserve-'));
const lockPath = path.join(baseDir, 'truecopy.lock');
fs.writeFileSync(lockPath, JSON.stringify({
  version: 1,
  skills: { demo: { source: path.join(baseDir, 'gone'), kind: 'skill', hash: 'deadbeef', verdict: 'clean' } },
}, null, 2));
const ctx = { lockPath, version: '9.9.9' };

// ── protocol ──

test('initialize advertises tools capability and server identity', () => {
  const r = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ctx);
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.serverInfo.name, 'truecopy');
});

test('initialized notification draws no reply', () => {
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
});

test('tools/list returns exactly the two read-only tools', () => {
  const names = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx).result.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['truecopy-status', 'truecopy-verify']);
});

test('unknown method is a proper JSON-RPC error, not a crash', () => {
  const r = handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, ctx);
  assert.equal(r.error.code, -32601);
});

// ── the security shape ──

test('no tool accepts a caller-supplied path', () => {
  // Findings carry `evidence` (matched source TEXT). A scan tool taking a caller
  // path would therefore be an arbitrary file-content disclosure primitive.
  for (const t of TOOLS) {
    const props = Object.keys(t.inputSchema.properties || {});
    for (const k of props) {
      assert.ok(!/path|file|dir|source|target|url/i.test(k),
        `${t.name} must not take a path-like input (${k})`);
    }
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} must not accept arbitrary extra input`);
  }
});

test('a scan tool is deliberately NOT exposed', () => {
  assert.equal(TOOLS.some((t) => /scan/i.test(t.name)), false);
  const r = handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'truecopy-scan', arguments: { path: '/etc/passwd' } } }, ctx);
  assert.equal(r.error.code, -32602);
});

test('every exposed tool declares itself read-only and non-destructive', () => {
  for (const t of TOOLS) {
    assert.equal(t.annotations.readOnlyHint, true, `${t.name}`);
    assert.equal(t.annotations.destructiveHint, false, `${t.name}`);
  }
});

test('an unknown tool name is rejected rather than dispatched', () => {
  const r = handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: '../../etc/passwd' } }, ctx);
  assert.equal(r.error.code, -32602);
});

// ── behaviour ──

test('truecopy-status reports the configured lock without verifying it', () => {
  const out = callTool('truecopy-status', {}, ctx).structuredContent;
  assert.equal(out.lockPath, lockPath);
  assert.equal(out.total, 1);
  assert.equal(out.entries[0].name, 'demo');
  assert.equal(out.entries[0].verdict, 'clean');
});

test('truecopy-verify surfaces a missing pinned source as a failure', () => {
  const out = callTool('truecopy-verify', {}, ctx).structuredContent;
  assert.equal(out.ok, false, 'a pinned source that is gone must not verify');
  assert.equal(out.total, 1);
  assert.equal(out.failed, 1);
});

test('a missing lock is an isError result, not a thrown exception', () => {
  const r = callTool('truecopy-status', {}, { lockPath: path.join(baseDir, 'nope.lock') });
  assert.equal(r.isError, true);
});

// ── definition quality (these are the public surface) ──

test('every tool carries a title, a substantive description and an output schema', () => {
  for (const t of TOOLS) {
    assert.ok(t.title && t.title.length > 8, `${t.name} needs a title`);
    assert.ok(t.description.length > 180, `${t.name} description is too thin to be useful`);
    assert.ok(t.outputSchema, `${t.name} should declare an output schema`);
    assert.equal(t.inputSchema.type, 'object');
  }
});
