// Hardening sweep over the last fail-open paths and two footguns.
//
//   1. the MCP proxy forwarded any line it could not parse, on BOTH legs — the
//      one way past a gate whose whole promise is that it looked at everything;
//   2. `trust remove ""` emptied the entire trust store, silently;
//   3. the lock was written by truncate-then-write, so an interrupted write left
//      a corrupt lock (which fails closed — every pinned skill blocked);
//   4. on Windows the DPAPI key blob was spliced into a PowerShell command string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-hardening-'));
process.env.CANON_HOME = path.join(baseDir, 'home');
const { inspectClient, inspectServer } = await import('../src/mcp.mjs');
const { untrustKey, trustKey } = await import('../src/trust.mjs');
const { keyId } = await import('../src/sign.mjs');
const { readLock, writeLock } = await import('../src/lock.mjs');

const freshState = () => ({ blocked: new Set(), allowedNames: new Set(), listed: false });

test('the client leg refuses to forward a line it cannot parse', () => {
  const state = freshState();
  // Valid-looking, but not valid JSON — a trailing comma.
  const r = inspectClient('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"exec"},}', state);
  assert.ok(!r.forward, 'not forwarded to the server');
  const err = JSON.parse(r.reply);
  assert.equal(err.error.code, -32700);
  assert.equal(err.id, null, 'id is null — reading it is exactly what failed');
});

test('the server leg drops a line it cannot parse instead of relaying it', () => {
  const state = freshState();
  const warnings = [];
  const r = inspectServer('{"result":{"tools":[{"name":"exec"}]},}', state, { entry: null, onWarn: (m) => warnings.push(m) });
  assert.ok(!r.forward, 'nothing is written to the client');
  assert.equal(r.drop, true);
  assert.match(warnings.join(' '), /unparseable/);
  assert.equal(state.listed, false, 'and it certainly did not count as a gated tools/list');
});

test('blank lines are not treated as parse errors', () => {
  assert.deepEqual(inspectClient('   ', freshState()), {});
  assert.deepEqual(inspectServer('', freshState(), { entry: null }), {});
});

test('a parseable message still flows through both legs', () => {
  const state = freshState();
  const list = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'read_file', description: 'read a file' }] } });
  const out = inspectServer(list, state, { entry: null });
  assert.ok(out.forward, 'a good line is still forwarded');
  assert.equal(JSON.parse(out.forward).result.tools.length, 0, 'nothing pinned → still gated to empty');
  assert.ok(inspectClient(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' }), state).forward);
});

// ---- trust store -------------------------------------------------------------

const kp = () => crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

test('trust remove refuses an empty or too-short prefix', () => {
  const a = kp(), b = kp();
  trustKey(a.publicKey, 'acme');
  trustKey(b.publicKey, 'globex');
  // The whole point: '' used to match every key and empty the store.
  assert.throws(() => untrustKey(''), /at least 8 characters/);
  assert.throws(() => untrustKey('a'), /at least 8 characters/);
  assert.equal(untrustKey(keyId(a.publicKey)), 1, 'a full id still works');
  assert.equal(untrustKey(keyId(b.publicKey)), 1);
});

test('trust remove refuses an ambiguous prefix unless --all', () => {
  // Two keys sharing a prefix, staged directly so the case is deterministic.
  const store = path.join(process.env.CANON_HOME, '.canon', 'trust.json');
  fs.mkdirSync(path.dirname(store), { recursive: true });
  const keys = [
    { id: 'abcdef0011223344', name: 'one', publicKey: 'A' },
    { id: 'abcdef0099887766', name: 'two', publicKey: 'B' },
    { id: 'ffffffff00000000', name: 'other', publicKey: 'C' },
  ];
  const reset = () => fs.writeFileSync(store, JSON.stringify({ version: 1, keys }));

  reset();
  assert.throws(() => untrustKey('abcdef00'), /matches 2 trusted keys/);
  assert.equal(readStoreNames(store).length, 3, 'nothing was removed by the refused call');

  reset();
  assert.equal(untrustKey('abcdef00', { all: true }), 2);
  assert.deepEqual(readStoreNames(store), ['other']);

  reset();
  assert.equal(untrustKey('ffffffff00000000'), 1);
  assert.deepEqual(readStoreNames(store).sort(), ['one', 'two']);

  reset();
  assert.equal(untrustKey('00000000deadbeef'), 0, 'no match is 0, not an error');
});

const readStoreNames = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).keys.map((k) => k.name);

// ---- lock write --------------------------------------------------------------

// These two pass on the old implementation as well, and are characterization
// rather than regression tests: the failure they guard against needs a write
// interrupted part-way (crash, full disk, Ctrl-C), which cannot be staged
// in-process without a flaky SIGKILL race. They pin the invariants the new
// implementation must keep — replace cleanly, leave no residue, never destroy a
// good lock on a failed write.
test('writeLock replaces atomically and leaves no temp file behind', () => {
  const dir = fs.mkdtempSync(path.join(baseDir, 'lock-'));
  const p = path.join(dir, 'truecopy.lock');
  writeLock({ version: 1, skills: { a: { hash: 'x' } } }, p);
  writeLock({ version: 1, skills: { b: { hash: 'y' } } }, p);
  assert.deepEqual(Object.keys(readLock(p).skills), ['b'], 'the second write replaced the first');
  assert.deepEqual(fs.readdirSync(dir), ['truecopy.lock'], 'no .tmp-* residue');
});

test('a failed write does not destroy the existing lock', () => {
  const dir = fs.mkdtempSync(path.join(baseDir, 'lock-fail-'));
  const p = path.join(dir, 'truecopy.lock');
  writeLock({ version: 1, skills: { keep: { hash: 'x' } } }, p);
  // A value JSON.stringify refuses: the throw must happen before anything on
  // disk is touched.
  const circular = { version: 1, skills: {} }; circular.self = circular;
  assert.throws(() => writeLock(circular, p));
  assert.deepEqual(Object.keys(readLock(p).skills), ['keep'], 'the good lock survived');
  assert.deepEqual(fs.readdirSync(dir), ['truecopy.lock']);
});

// ---- Windows key blob --------------------------------------------------------

test('the DPAPI blob is never spliced into a PowerShell command', { skip: process.platform !== 'win32' && 'DPAPI is Windows-only' }, async () => {
  const { keychainSet, keychainGet } = await import('../src/keychain.mjs');
  delete process.env.CANON_KEYCHAIN_FAKE;
  delete process.env.CANON_NO_KEYCHAIN;
  fs.mkdirSync(path.join(process.env.CANON_HOME, '.canon'), { recursive: true });

  const secret = 'a-signing-key-value-' + 'x'.repeat(40);
  keychainSet(secret);
  assert.equal(keychainGet(), secret, 'round trip still works');

  // A blob carrying a quote used to close the single-quoted PowerShell literal
  // and run the remainder as code. The payload has to leave the SCRIPT valid to
  // prove anything — PowerShell parses the whole -Command string before running
  // any of it, so a payload that merely breaks the syntax proves only that
  // broken syntax does not run. This one closes the literal, runs a command, and
  // reopens a literal for the tail; on the old code the canary appears.
  const blob = path.join(process.env.CANON_HOME, '.canon', 'signing-key.dpapi');
  const canary = path.join(baseDir, 'canary.txt');
  fs.writeFileSync(blob, `QQ=='); Set-Content -Path '${canary}' -Value pwned; $z=@('`);
  assert.equal(keychainGet(), null, 'a non-base64 blob is refused, not executed');
  assert.equal(fs.existsSync(canary), false, 'the injected command did not run');
});
