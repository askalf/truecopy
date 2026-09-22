# Runtime gate — enforce the lock

Scanning and pinning are *checks*. truecopy also **enforces** the lock at runtime, so an unvetted or drifted tool never reaches the agent:

**`truecopy-mcp`** — a drop-in MCP proxy. Point your MCP client at it instead of the server; only tools that are pinned, unmodified, and unpoisoned pass through `tools/list`, and calls to anything it dropped are blocked:

```bash
truecopy-mcp --lock truecopy.lock --name filesystem -- npx -y @modelcontextprotocol/server-filesystem /workspace
```

A silently-added, drifted, or poisoned tool is stripped from `tools/list` (the agent never sees it); a call to one comes back as a normal tool error. `--strict` blocks the *entire* server if anything is off, instead of stripping the bad tools.

> **Windows / Git Bash:** MSYS auto-rewrites an argument that looks like a Unix absolute path before `truecopy` (a native node process) sees it — a bare `--lock /etc/truecopy.lock`, a scan source like `/srv/skill.json`, or the wrapped server's `/workspace` path can arrive mangled (e.g. prefixed with `C:/Program Files/Git/…`), so the lock isn't found or the wrong path is scanned. Prefix the run with `MSYS_NO_PATHCONV=1` and use drive-letter paths (`C:/…`), or run truecopy from PowerShell/cmd. Not a truecopy bug — the arg is rewritten before truecopy reads it.

**As a container** — the repo ships a [`Dockerfile`](../Dockerfile) that runs `truecopy-mcp` **standalone**: with no downstream server to gate, it serves its own two read-only tools instead (`truecopy-verify`, `truecopy-status` — see [Standalone tools](#standalone-tools) below), pre-loaded with the repo's own self-dogfood lock so there's something real to report on. Useful for MCP hosts that launch servers from an image (e.g. [Glama](https://glama.ai/mcp/servers)):

```bash
docker build -t truecopy-mcp . && docker run --rm -i truecopy-mcp
```

[![truecopy on Glama](https://glama.ai/mcp/servers/askalf/truecopy/badges/card.svg)](https://glama.ai/mcp/servers/askalf/truecopy)

To gate a real downstream server from the image instead, override the `ENTRYPOINT` with your own `--lock`/`--name -- <server cmd>`.

#### Standalone tools

Run `truecopy-mcp` with no downstream command (`truecopy-mcp [--lock truecopy.lock]`) and it serves two read-only tools of its own instead of gating a server:

| tool | what it answers |
|---|---|
| `truecopy-verify` | re-derives every pinned hash → `ok` / `drifted` / `poisoned` / `untrusted` / `unsigned` / `missing` per entry |
| `truecopy-status` | what this lock pins — kind, pin-time verdict, signed — without re-verifying |

Neither accepts a caller-supplied path — both operate only on the lock the process was configured with. `truecopy-scan` is deliberately **not** exposed here: findings carry the matched source text as evidence, so a scan tool taking a caller path would be an arbitrary file-content disclosure primitive.

**`truecopy guard`** — a launch gate. Verify the lock, then run a command only if it's clean:

```bash
truecopy guard -- npm start        # refuses to launch (exit 1) if any pinned skill drifted or turned poisonous
```

So truecopy spans the whole lifecycle: **scan → pin → verify (CI) → enforce (runtime).** Where [redstamp](https://github.com/askalf/redstamp) firewalls what a tool *does*, truecopy-mcp gates which tools *exist*.
