# Changelog

All notable changes to **@askalf/canon** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-06-16

First public release — own your agent skills: the supply-chain gate for AI agents.

### Added
- **Scan** — inspect skills and MCP servers for poisoned descriptions and
  injection before they run (reuses `@askalf/warden`'s `scanMcpTools`).
- **Pin + verify** — `canon.lock` records a content hash for every approved
  skill / MCP server; `canon verify` fails (non-zero exit, CI-ready) on any
  drift from the locked state.
- **Sign** — optional Ed25519 signing/verification of the lockfile so an
  approved set can't be swapped underneath you.
- **Runtime gate** — `canon-mcp` proxies an MCP server and drops tools that
  aren't vetted/pinned; `canon guard` classifies each tool as
  vetted / drifted / unvetted / unpinned / poisoned.

[0.1.0]: https://github.com/askalf/canon/releases/tag/v0.1.0
