#!/usr/bin/env node
// Build-time helper: launch the downstream MCP server, capture the exact tool
// set it advertises, and emit a truecopy manifest ({ name, tools }) on stdout.
// Piped into `truecopy add` so the image ships a truecopy.lock that pins those
// tools — at runtime the same server advertises byte-identical tools, so the
// gate serves them as `vetted` instead of dropping every unpinned tool.
//
//   node docker/pin-everything.mjs "<name>" -- <server cmd...>  > manifest.json
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const name = (sep > 0 ? argv[0] : 'downstream');
const cmd = sep >= 0 ? argv.slice(sep + 1) : argv;
if (!cmd.length) { process.stderr.write('usage: pin-everything.mjs <name> -- <server cmd...>\n'); process.exit(2); }

const srv = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: srv.stdout });
const send = (m) => srv.stdin.write(JSON.stringify(m) + '\n');
const fail = (msg) => { process.stderr.write(`pin-everything: ${msg}\n`); srv.kill(); process.exit(1); };
const timer = setTimeout(() => fail('timed out waiting for tools/list'), 60000);

rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; } // ignore non-JSON banner lines
  if (msg.id === 1) { // initialize acked → announce initialized, then ask for tools
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  } else if (msg.id === 2) {
    clearTimeout(timer);
    const tools = msg.result?.tools;
    if (!Array.isArray(tools) || !tools.length) fail('downstream advertised no tools');
    process.stdout.write(JSON.stringify({ name, tools }, null, 2) + '\n');
    srv.kill();
    process.exit(0);
  }
});
srv.on('error', (e) => fail(`could not launch downstream: ${e.message}`));
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'truecopy-pin', version: '1' } } });
