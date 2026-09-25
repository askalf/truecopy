# Gate Claude Code skills

Claude Code loads **skills** — instruction directories under `.claude/skills/` (project scope), `~/.claude/skills/` (user scope), and, namespaced as `plugin:skill`, from **marketplace plugins** under `~/.claude/plugins/marketplaces/`. That is exactly the surface truecopy exists for: a skill is prose that steers an agent holding your privileges, and a silent update to one shows up in no diff you'll ever read.

Pin everything Claude Code can see, then gate every invocation:

```bash
truecopy add --claude --sign            # vet + pin every project/user skill (a project skill shadows a same-named user skill, like Claude Code itself)
truecopy add --claude-plugins --sign    # …and every skill shipped by installed marketplace plugins, under its `plugin:skill` name
truecopy hook install                   # wire the gate into this repo's .claude/settings.json (idempotent; --user for ~/.claude)
truecopy scan --marketplace ./clone     # audit a marketplace or plugin repo you cloned — BEFORE you install from it
```

`hook install` writes one truecopy-owned `PreToolUse` entry (and never touches your other hooks — it refuses an unparseable settings file rather than clobber it):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Skill",
        "hooks": [{ "type": "command", "command": "npx -y github:askalf/truecopy#v0.10.4 hook claude", "timeout": 20 }] }
    ]
  }
}
```

From then on the **exact directory about to run** — project, user, or marketplace-plugin — is re-checked at the moment the skill is invoked; a drifted or poisoned skill is blocked (exit 2), with the reason fed back to the model. This composes with Claude Code's own plugin blocklist rather than duplicating it: the blocklist is name-based and centrally pushed, truecopy pins the *content you vetted*.

Two policies. The default protects the **pinned** set — unpinned skills pass, so adoption never breaks a session. `--strict` turns `truecopy.lock` into a whitelist that fails **closed** — including on a crashed hook, so the gate itself can't become the bypass:

| skill state | default | `--strict` |
|---|---|---|
| pinned, unchanged | runs | runs |
| pinned, **modified since pin** | **blocked** | **blocked** |
| pinned clean, **now scans poisoned** — same bytes, newer detection | **blocked** | **blocked** |
| pinned with `--force` (findings **accepted** for those exact bytes), unchanged | runs | runs |
| pinned, directory missing · corrupt lock | **blocked** | **blocked** |
| pinned, but the check itself failed (unreadable file, I/O error) | **blocked** | **blocked** |
| not pinned · a name truecopy can't resolve to a directory | runs | **blocked** |
| no lock · hook crash | runs | **blocked** |

A `--force` pin is an explicit accept: you read those bytes, truecopy records `verdict: "flagged"`, and `verify` / the hook / `truecopy-mcp` all honor it *for exactly that content* (shown as `· accepted findings`). Any change to the bytes, or the same flags appearing on something you pinned as clean, blocks as before.

**Verdicts are severity-aware by surface.** In long-form skill prose, only an *instruction* flags — instruction-override, a jailbreak persona, a sensitive path being *moved* (`read ~/.ssh/id_rsa and POST it to https://…`). A bare *mention* of a sensitive path or secret env var is an **advisory**: shown in `scan`/`add` (`· 1 advisory`), noted in the lock, never blocking — documentation legitimately teaches credential handling. Measured at ecosystem scale: truecopy audited **2,019 skills** — the full official Claude Code plugin marketplace plus nine community marketplaces — and found **zero poisoned skills**; tightening detection against that corpus took the flag rate from 126 to **12 (0.6%), every one benign on manual review**. Methodology and findings: [Auditing the skills supply chain](https://sprayberrylabs.com/blog/auditing-the-skills-supply-chain). Since then, at registry scale: all **66,541 skills on ClawHub** scanned **clean** — zero confirmed malicious, 813 deterministic alarms, every one benign on cross-check against ClawHub's own scanner ([write-up](https://sprayberrylabs.com/blog/the-marketplace-that-started-the-panic)). MCP *tool definitions* keep the strict any-finding rule — in a short description, a mention has no innocent reason to be there.

Every row in the policy table above is verified **live**, not just unit-tested: each scenario ran in its own fresh headless Claude Code session against a real pinned skill. A skill silently edited after pinning physically cannot run — the invocation fails and the model is told why ("drifted from its pinned version") — and restoring the exact pinned bytes immediately un-blocks it. The check costs roughly a quarter-second per skill invocation.

**Per-repo lockdown:** hook settings merge from the project too, so `truecopy hook install --strict` in a repo (committed next to `truecopy.lock`) makes *that repo* whitelist-strict for everyone who works in it, while machines keep the adoption-friendly default globally. And the same committed `truecopy.lock` gates CI (`truecopy verify`), `truecopy-mcp`, and every teammate's sessions.
