#!/usr/bin/env node
// truecopy-mcp — enforce the lock on a live MCP server. Point your MCP client at
//   truecopy-mcp [--lock truecopy.lock] [--name <pinned>] [--strict] -- <server cmd...>
// Only vetted, unmodified, unpoisoned tools reach the client. (`canon-mcp` still
// works as an alias; an existing canon.lock is read automatically.)
import { runGate } from './mcp.mjs';
import { runStandalone } from './mcp-serve.mjs';
import { createRequire } from 'node:module';
import { resolveLock } from './lock.mjs';

const VERSION = (() => {
  try { return createRequire(import.meta.url)('../package.json').version; } catch { return '0.0.0'; }
})();

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const pre = sep >= 0 ? argv.slice(0, sep) : argv;
const cmd = sep >= 0 ? argv.slice(sep + 1) : [];
const opt = (n, d) => {
  const i = pre.indexOf(n);
  if (i >= 0) { const nx = pre[i + 1]; return nx !== undefined && !nx.startsWith('--') ? nx : true; } // `--n value` or bare `--n`
  const eq = pre.find((x) => x.startsWith(n + '='));
  return eq ? eq.slice(n.length + 1) : d;
};

if (pre.includes('-h') || pre.includes('--help')) {
  process.stderr.write(
    'usage: truecopy-mcp [--lock truecopy.lock] [--name <pinned>] [--strict] -- <mcp-server cmd...>\n' +
    '       truecopy-mcp [--lock truecopy.lock]            (standalone: serve truecopy own tools)\n');
  process.exit(0);
}

const lockPath = resolveLock(opt('--lock', null) || null);

// No downstream command => STANDALONE. This previously exited 2. A bare gate has
// nothing of its own to advertise, which is why the container image had to wrap a
// reference server just to expose a tool surface at all; standalone serves
// truecopy's own read-only tools instead. The proxy path below is UNCHANGED --
// the fail-closed gating that protects a live downstream is not touched.
if (!cmd.length) {
  runStandalone({ lockPath, version: VERSION });
} else {
  runGate({ command: cmd[0], args: cmd.slice(1), lockPath, name: opt('--name', null) || null, strict: !!opt('--strict', false) });
}
