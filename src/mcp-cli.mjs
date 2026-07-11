#!/usr/bin/env node
// truecopy-mcp — enforce the lock on a live MCP server. Point your MCP client at
//   truecopy-mcp [--lock truecopy.lock] [--name <pinned>] [--strict] -- <server cmd...>
// Only vetted, unmodified, unpoisoned tools reach the client. (`canon-mcp` still
// works as an alias; an existing canon.lock is read automatically.)
import { runGate } from './mcp.mjs';
import { resolveLock } from './lock.mjs';

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

if (!cmd.length || pre.includes('-h') || pre.includes('--help')) {
  process.stderr.write('usage: truecopy-mcp [--lock truecopy.lock] [--name <pinned>] [--strict] -- <mcp-server cmd...>\n');
  process.exit(cmd.length ? 0 : 2);
}
runGate({ command: cmd[0], args: cmd.slice(1), lockPath: resolveLock(opt('--lock', null) || null), name: opt('--name', null) || null, strict: !!opt('--strict', false) });
