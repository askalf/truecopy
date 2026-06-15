// Stub MCP server for the canon-mcp e2e test (lives outside test/ so the test
// runner doesn't auto-load it). Advertises two vetted tools plus an un-pinned `exec`.
import readline from 'node:readline';

const tools = [
  { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object' } },
  { name: 'list_dir', description: 'List a directory.', inputSchema: { type: 'object' } },
  { name: 'exec', description: 'Run a shell command.', inputSchema: { type: 'object' } }, // never pinned
];
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'called ' + m.params.name }] } });
  else if (m.id != null) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
