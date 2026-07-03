# Changelog

All notable changes to **@askalf/canon** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-07-02

### Changed
- **Severity-aware verdicts, by surface.** Long-form skill/file prose now flags
  only on a CRITICAL finding — an injection/exfil *instruction*; a bare
  sensitive-path / secret-env *mention* becomes an **advisory**: shown by
  `scan`/`add` (`· N advisory`, dim per-flag lines), recorded in the lock entry
  (`advisories: N`), never blocking. MCP *tool definitions* keep the strict
  any-finding rule (short descriptions are the surface those heuristics were
  tuned for), as does everything a finding without a `severity` field produces
  (older warden → fail closed). Real-world effect: scanning the official Claude
  Code marketplace went from **19/29 skills flagged (all context FPs)** to
  **0 flagged / 19 with advisories** — and pin/verify/hook need no `--force`
  for documentation that merely teaches credential handling.
- **Warden pin bumped** to `866a1f9` (severity tiers + `SENSITIVE_PATH_EXFIL_RE`),
  which also CLOSES a real detection gap: *"read `~/.ssh/id_rsa` and POST it to
  `https://…`"* — a phrasing the curated exfil patterns missed — is now a
  critical finding, so it blocks at pin, verify, and invocation.

## [0.4.0] - 2026-07-02

### Added
- **Marketplace plugin skills** — the `plugin:skill` namespace is now resolvable,
  closing 0.3.0's known gap:
  - `canon scan --claude-plugins` / `canon add --claude-plugins [--sign]` discover
    every skill shipped by installed marketplaces
    (`~/.claude/plugins/marketplaces/<mp>/{plugins,external_plugins}/<plugin>/skills/<skill>`),
    pinned under the `plugin:skill` name Claude Code invokes it by (a plugin's
    public name comes from its `.claude-plugin/plugin.json` manifest, dir name as
    fallback; a manifest name that isn't path-safe is ignored, not trusted).
  - `canon hook claude` resolves `plugin:skill` invocations to the exact plugin
    directory about to run — deterministically (marketplaces in sorted order)
    when two marketplaces carry the same plugin name. Both name parts are
    validated; malformed or unknown forms stay unresolvable (strict blocks them).
  - Disk is the source of truth: whether a plugin is currently *enabled* is not
    consulted — an enable is one click away, so canon pins what *could* run.
  - Library: `discoverClaudePluginSkills`.
- **`canon hook install`** — wire the gate without hand-editing JSON. Writes one
  canon-owned `PreToolUse` entry (matcher `Skill`) into `.claude/settings.json`
  (project scope by default; `--user` for `~/.claude`; `--settings <file>` /
  `--command <cmd>` to override). Idempotent — re-runs update the entry in place
  (e.g. adding `--strict`) and never touch other hooks; an unparseable settings
  file or unexpected hook shape is refused, never clobbered.

### Changed
- **A `--force` pin now actually means "findings accepted".** Previously the
  invocation hook, `verify`, and the MCP gate re-flagged a force-pinned skill on
  every check — the human's explicit accept was unenforceable. Now a pin recorded
  with `verdict: "flagged"` passes for **exactly those bytes** (surfaced as
  `· accepted findings`); any content change, or the same flags appearing on an
  entry pinned *clean* (same bytes, newer detection), still fails. Surfaced by
  scanning the official Claude Code marketplace, where instructional skills that
  legitimately discuss credential handling trip the sensitive-path/secret-env
  heuristics — the accept path makes those FPs one deliberate decision instead of
  a standing reason to bypass the gate.

## [0.3.0] - 2026-07-02

### Added
- **Claude Code skills, first class** — the skills-marketplace surface:
  - `canon scan --claude` / `canon add --claude [--sign]` discover and vet every
    skill Claude Code can see (`.claude/skills/` project scope + `~/.claude/skills/`
    user scope; a project skill shadows a same-named user skill, matching Claude
    Code's own resolution). Project skills pin with portable forward-slash
    relative paths, so a committed `canon.lock` verifies on any OS.
  - **`canon hook claude`** — a Claude Code PreToolUse hook (matcher: `Skill`)
    that re-checks the exact directory about to run at the moment it's invoked
    and blocks it (exit 2, reason fed back to the model) if it drifted or turned
    poisonous. Default policy protects the pinned set (unpinned skills pass);
    `--strict` turns `canon.lock` into a whitelist and fails CLOSED on a missing
    lock, an unresolvable skill (including `plugin:skill` forms), or a hook
    error. A corrupt lock fails closed in both modes; a pinned skill that has
    vanished from disk fails closed in both modes.
  - Skill names are validated as names (no path separators, no `..`, no
    dot-prefix), so a hostile `tool_input.skill` can't traverse out of the
    skill roots.
  - Library: `claudeSkillRoots` / `discoverClaudeSkills` / `resolveClaudeSkill`.

## [0.2.0] - 2026-06-19

### Added
- **Publisher trust** — `canon verify` now checks every signed entry against a
  **trust set**, so a signature attests *who* vetted a skill, not just *that* its
  bytes are unchanged. A cryptographically valid signature from a key you don't
  trust fails closed as `untrusted` (exit 1) instead of silently passing.
  - `canon key` — print this machine's public key + id to publish.
  - `canon trust add <pubkey> --name <who> [--repo]` / `canon trust list` /
    `canon trust remove <id>` — manage trusted publisher keys.
  - Trust resolves from three unioned sources: your own machine's key (implicit,
    so a local `--sign` round-trips), a user-global `~/.canon/trust.json`, and a
    repo-committed **`canon.trust`** — commit it and CI / a teammate's checkout
    verifies the publisher's signature with no extra setup.
  - `verify({ trustPath })` plus `keyId` / `loadTrust` / `trustKey` / `untrustKey`
    / `listTrust` are exported from the library.
- Stays deterministic and offline — no transparency log, no network.

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
