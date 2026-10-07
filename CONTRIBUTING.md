# Contributing to truecopy

Thanks for your interest in improving **truecopy** — the supply-chain gate that
vets, signs, and pins agent skills and MCP servers before they run. Part of
[Own Your Agent Security](https://sprayberrylabs.com).

## Ground rules

- Be respectful. This project follows our [Code of Conduct](CODE_OF_CONDUCT.md).
- Found a security issue? **Do not open a public issue** — follow
  [SECURITY.md](SECURITY.md) to report it privately.

## Development setup

truecopy is a Node.js package. You need Node.js **20 or 22** (the versions CI
tests against).

```bash
git clone https://github.com/askalf/truecopy.git
cd truecopy
npm ci        # install from the frozen lockfile
npm test      # run the full test suite
```

## Making a change

1. Branch off `master`.
2. Keep the change focused — one concern per PR.
3. Add or update tests for any behavior change. truecopy guards a trust
   boundary, so changes to the parsers, the MCP gate, or the scanner verdict
   must be covered by tests.
4. Run `npm test` locally before pushing.
5. Open a pull request against `master`.

## What CI requires

Every PR must pass these checks to merge:

- `test` on **ubuntu** × Node **20** and **22**
- **CodeQL** static analysis (`analyze (javascript-typescript)`)

`test` also runs on ubuntu with Node 24 and on **windows** with Node 22. Those two are not
required: Windows runs on GitHub's runners, and a hosted outage should not hold a merge. A red
Windows run still needs fixing before a release.

OpenSSF Scorecard and ClusterFuzzLite fuzzing also run on the repo; a discovered
crash or a new high-severity finding will block the change.

## Conventions

- GitHub Actions are **pinned to a commit SHA**, never a mutable tag. New or
  updated workflow steps must keep this.
- Commit messages: short imperative subject, with a wrapped body explaining the
  *why* when it isn't obvious.
- We squash-merge, so your PR title becomes the commit subject on `master`.

## Releases

Releases are automated: bump `version` in `package.json` on `master` and
`auto-release.yml` tags it, cuts a GitHub release from `CHANGELOG.md`, and
publishes to npm via OIDC trusted publishing (no tokens). A normal PR needs no
release steps.
