# The lockfile, publisher signatures and CI

## The lockfile

`truecopy.lock` is your vetted set — **commit it**, like `package-lock.json`. One entry per trusted skill: where it came from, the content hash you trusted, the scan verdict at pin time, a per-part hash map (so a drift names the changed tools/files), and an optional Ed25519 signature.

`--sign` stamps an entry with an Ed25519 signature over its content hash. Editing a hash in `truecopy.lock` without the signing key is caught on `verify`.

## Publisher signatures — trust *who* signed, not just *that* it changed

A hash catches a change; a signature says **who vetted it**. `truecopy verify` checks every signed entry against your **trust set** — and a cryptographically valid signature from a key you *don't* trust fails closed (`untrusted`), it doesn't quietly pass. A signer is matched on the **whole public key**; the short `key id` is a handle for reading and addressing keys, never the thing that decides trust:

```bash
# publisher — vet, sign, and publish your key
truecopy add ./mcp-server.json --sign         # signs with your key in ~/.truecopy
truecopy key                                  # prints your public key + id to hand out

# consumer — trust the publisher once; every future version is then provenance-checked
truecopy trust add publisher.pub --name acme  # add --repo to commit it to ./truecopy.trust
truecopy verify                               # ✓ filesystem  ok · signed by acme
#                                          # a signature from any other key → ⚠ untrusted, exit 1
```

Trust comes from three sources, unioned: your own machine's key (implicit, so a local `--sign` round-trips with no extra step), a user-global `~/.truecopy/trust.json`, and a repo-committed **`truecopy.trust`**. Commit `truecopy.trust` and a teammate's checkout — or your CI — verifies the publisher's signature with zero setup. Still deterministic and offline: no transparency log, no network.

## In CI

**One line, from the [GitHub Marketplace](https://github.com/marketplace/actions/truecopy-gate-your-agent-skills)** — verify the committed lock, or poison-scan sources without one:

```yaml
- uses: askalf/truecopy-action@v1             # verify truecopy.lock — fails the build on drift / poisoning
- uses: askalf/truecopy-action@v1             # …or scan-mode: vet a marketplace / manifest with no lock needed
  with:
    command: scan
    marketplace: ./the-repo-you-cloned
```

This repo runs exactly that gate on itself — see [`truecopy-gate.yml`](../.github/workflows/truecopy-gate.yml).

> On npm as `@askalf/truecopy` — the snippets below use the GitHub form, but `npx -y @askalf/truecopy verify` works the same.

**Verify everywhere** — the gate. Public key only, no secret:

```yaml
- run: npx -y github:askalf/truecopy verify   # fails the build if any pinned skill drifted or turned poisonous
- run: npx -y github:askalf/truecopy verify --json > truecopy-report.json   # same gate, machine-readable — feed a dashboard / PR comment (scan, list, diff take --json too)
```

**Require signatures where trust matters.** By default `verify` accepts an unsigned entry whose bytes match — signing only helps if you also *look* at the lock diff. Add **`--require-signed`** (to `verify` or `guard`) and any entry without a valid signature from a **trusted key** fails closed, so a lock substitution that strips the signature and swaps in other clean-scanning bytes can't pass. Pair it with a committed `truecopy.trust`:

```yaml
- run: npx -y github:askalf/truecopy verify --require-signed   # every pinned skill must be signed by a trusted publisher
```

**Sign in CI, not on laptops.** Hold the private signing key as a single CI secret instead of scattering it across developer machines. Set **`CANON_SIGNING_KEY`** to the private key (a raw ed25519 PEM, or base64-encoded) — truecopy derives the public key from it, so signing needs no `~/.truecopy` file and no keychain, and the key keeps the same `keyId`:

```yaml
- run: npx -y github:askalf/truecopy add ./mcp-server.json --sign
  env:
    CANON_SIGNING_KEY: ${{ secrets.CANON_SIGNING_KEY }}
```

Mint the identity once (`openssl genpkey -algorithm ed25519`), store the private key as the `CANON_SIGNING_KEY` secret, and commit its public key to **`truecopy.trust`** (`truecopy trust add <pub.pem> --repo`). Everyone else — laptops, the fleet, the verify job above — carries only the public key, so they `verify` but never sign: one signing identity in one secret, not a private key on every box.

> The `CANON_SIGNING_KEY` env key **signs only** — it is *not* auto-trusted at verify time (otherwise anyone who could set that env var on a verify runner would become a trusted signer). So committing its public key to `truecopy.trust` is required, not optional: that is what a `verify` step checks the signature against.
