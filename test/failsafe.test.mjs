// Fail-safe contract: canon's runtime gate + parse layer must never throw on a
// hostile/malformed input — a poisoned MCP server can advertise a non-array tool
// list, null entries, or a circular schema, and a corrupt canon.lock can carry a
// non-object `skills`. A supply-chain gate that crashes is a gate that's off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateTools } from '../src/gate.mjs';
import { scanSkill } from '../src/scan.mjs';
import { canonicalJson, sha256 } from '../src/hash.mjs';
import { inspectServer } from '../src/mcp.mjs';
import { readLock } from '../src/lock.mjs';
import { verify } from '../src/index.mjs';

const circular = {}; circular.self = circular;

test('gateTools never throws on a hostile tool list', () => {
  const hostile = [null, undefined, 'x', 123, {}, [null], [5, 's'], [{ name: 'x', inputSchema: circular }], [circular]];
  hostile.forEach((t, i) => assert.doesNotThrow(() => gateTools(t), `gateTools threw on case ${i}`));
  // a non-array gates to nothing; malformed entries are dropped (never "vetted")
  assert.deepEqual(gateTools(null), { report: [], allowed: new Set() });
  const r = gateTools([null, { name: 'ok' }], { parts: { ok: sha256(canonicalJson({ name: 'ok' })) } });
  assert.equal(r.report.length, 1);
  // `allowed` is keyed by content hash now, not by name
  assert.ok(r.allowed.has(sha256(canonicalJson({ name: 'ok' }))));
});

test('scanSkill never throws on malformed scan targets', () => {
  for (const s of [null, undefined, {}, { scanTargets: null }, { scanTargets: 'x' }, { scanTargets: [null, 5] }, { scanTargets: [{ name: 'x', inputSchema: circular }] }]) {
    assert.doesNotThrow(() => scanSkill(s), 'scanSkill threw');
  }
});

test('canonicalJson + sha256 never throw on circular / BigInt / undefined', () => {
  for (const v of [circular, 10n, undefined, null, { a: circular }, [1n, circular]]) {
    assert.doesNotThrow(() => sha256(canonicalJson(v)), 'hash threw');
  }
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}'); // still deterministic
});

test('inspectServer drops null/malformed tools from a tools/list without throwing', () => {
  const state = { pending: { 1: 'tools/list' }, blocked: new Set() };
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [null, 5, { name: 'ok' }] } });
  let out;
  assert.doesNotThrow(() => { out = inspectServer(line, state, {}); });
  const tools = JSON.parse(out.forward).result.tools;
  assert.ok(tools.every((t) => t && typeof t === 'object'), 'no null entries survive');
});

test('readLock coerces a hostile-but-parseable lock; verify never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-fs-'));
  // A lock that parses to an OBJECT but carries a hostile `skills` shape is
  // coerced to a safe empty object — that's the fail-SAFE half of the contract.
  for (const body of ['{"skills":null}', '{"skills":"evil"}', '{"skills":[1,2]}']) {
    const p = path.join(dir, 'canon.lock');
    fs.writeFileSync(p, body);
    const lock = readLock(p);
    assert.equal(typeof lock.skills, 'object');
    assert.ok(lock.skills && !Array.isArray(lock.skills), 'skills is a plain object');
    assert.doesNotThrow(() => verify({ lockPath: p }), `verify threw for ${body}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readLock fails CLOSED on a corrupt/non-object lock; verify reports error without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-fs2-'));
  // An unparseable lock or a parseable-but-not-an-object lock must NOT degrade to
  // "nothing pinned, all clear" — readLock throws ELOCKCORRUPT and verify surfaces it.
  for (const body of ['not json', '[]', '', '<<<<<<< HEAD\n{"skills":{}}']) {
    const p = path.join(dir, 'canon.lock');
    fs.writeFileSync(p, body);
    assert.throws(() => readLock(p, { mustExist: true }), /unparseable|not a lock object/, `readLock should throw for ${JSON.stringify(body)}`);
    let r;
    assert.doesNotThrow(() => { r = verify({ lockPath: p }); }, `verify threw for ${JSON.stringify(body)}`);
    assert.equal(r.ok, false, `verify must fail closed for ${JSON.stringify(body)}`);
    assert.ok(r.error, 'verify surfaces the lock error');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
