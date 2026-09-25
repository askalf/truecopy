# Commands, sources and the library

## Install

```bash
npm i -g @askalf/truecopy                # latest, from npm
npm i -g @askalf/truecopy@0.10.4         # pinned release
```

> Also installable straight from GitHub: `npm i -g github:askalf/truecopy`. Every command below runs one-shot with `npx -y @askalf/truecopy` (or `npx -y github:askalf/truecopy`).

## Commands

```bash
truecopy scan ./mcp-server.json          # poison-scan a skill / MCP manifest / directory
truecopy add  ./mcp-server.json --sign   # vet + pin into truecopy.lock (refuses a poisoned skill)
truecopy verify                          # re-check every pinned skill for drift / poisoning  (CI: exit 1 on any fail)
truecopy diff ./mcp-server.json          # what changed since you pinned it
truecopy list                            # the pinned set
truecopy remove old-skill                # un-pin a deprecated skill — drops its lock entry, no hand-editing (a signed lock would flag that as tampering)
truecopy guard -- npm start              # verify the lock, then launch only if it's clean
truecopy add --claude --claude-plugins --sign   # pin every Claude Code skill — project, user, and marketplace-plugin scope
truecopy hook install                    # …and wire the invocation-time gate into .claude/settings.json
```

Run the whole story: `npm run demo`.

## What you can pin

| Source | Identity (what's hashed) | What's scanned |
|---|---|---|
| an **MCP manifest** (`.json` with a `tools` array) | the canonical tool set | every tool's name + description + schema |
| a **skill directory** (`SKILL.md` + files) | a manifest of per-file hashes | the instruction/text files |
| a single **file** | its bytes | its text |

## Library

```js
import { scan, pin, verify, diff } from '@askalf/truecopy';

const r = scan('./mcp-server.json');     // { verdict: 'clean' | 'flagged', findings }
if (r.verdict === 'flagged') throw new Error('poisoned skill');

verify();                                 // { ok, results: [{ name, status: 'ok'|'drifted'|'poisoned'|... }] }
```
