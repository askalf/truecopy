# The marketplace watch

A **standing watch** re-scans the full official Claude Code plugin directory **every day** — every catalog plugin, including external vendor plugins fetched at their catalog-pinned SHAs — and publishes each snapshot to [`WATCH.md` on the `watch` branch](https://github.com/askalf/truecopy/blob/watch/WATCH.md) and the **[live observatory → truecopy.sprayberrylabs.com](https://truecopy.sprayberrylabs.com)**. The badge at the top of the README carries the always-current numbers; a poisoned skill would turn it red and the scheduled run with it.

**The watch is consumable, not just a badge.** Each run also publishes [`directory-manifest.json`](https://github.com/askalf/truecopy/blob/watch/directory-manifest.json) — name → content hash for every skill it scanned, plus the currently-flagged names. Point `check-manifest` at it and every marketplace plugin skill **installed on your machine** is compared against exactly the bytes the watch vetted:

```bash
curl -fsSLo directory-manifest.json https://raw.githubusercontent.com/askalf/truecopy/watch/directory-manifest.json
truecopy check-manifest directory-manifest.json
```

An installed skill whose bytes differ from what the watch scanned is `drifted`, a watch-flagged skill fails even byte-identical (a hash match is not an endorsement), and skills from other marketplaces — or your own — are `unlisted`, reported but never fatal. Exit 1 on any failure, `--json` for machines, and offline like everything else: you fetch the manifest, truecopy only reads it.

And the gate eats its own cooking: this repo pins its own demo manifest in [`truecopy.lock`](../truecopy.lock) and verifies it on every PR with [truecopy-action](https://github.com/marketplace/actions/truecopy-gate-your-agent-skills).
