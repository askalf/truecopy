# truecopy-mcp as a container — for Glama and any host that launches an MCP
# server from an image.
#
# truecopy-mcp is normally a GATE: given a downstream command it filters that
# server's tools/list down to the pinned, unmodified, unpoisoned set. Run bare
# (no downstream command) it serves STANDALONE instead — its own two read-only
# tools, truecopy-verify and truecopy-status (src/mcp-serve.mjs). That's what
# this image runs: no wrapped reference server, so a directory that introspects
# this image grades truecopy's own tools, not a demo server's.
#
# The image ships pre-loaded with the repo's own self-dogfood lock
# (truecopy.lock + demo/clean-mcp.json, the same fixture the test suite pins)
# so truecopy-verify/truecopy-status have something real to report on out of
# the box, rather than an empty lock.
#
# Every dependency of this image is pinned by HASH, not by tag: the base image by
# digest below, the npm tree by integrity hash in docker/package-lock.json. A tool
# that exists to make agents pin their supply chain has to pin its own. Dependabot
# watches both (`docker` + `/docker` npm in .github/dependabot.yml), so the pins
# get bumped deliberately instead of drifting silently.
FROM node:26-slim@sha256:715e55e4b84e4bb0ff48e49b398a848f08e55daed8eb6a0ea1839ae53bc57583

# CA certs for HTTPS while npm resolves the tree. git is deliberately NOT
# installed: as of truecopy 0.10.1 the redstamp dependency is a signed release
# tarball fetched over HTTPS, not a git pin, so there is no git-sourced package
# left in docker/package-lock.json (grep it for `git+` — zero hits) and nothing
# in this build shells out to git. A container whose whole job is gating a
# supply chain should not carry a fetch tool it never uses.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install from a LOCKFILE, not `npm i <pkg>@<version>`. A version tag is a
# mutable label; docker/package-lock.json records the integrity hash of every
# tarball in the transitive tree — including redstamp's release tarball, which
# a git pin could not provide one for — so the image is byte-reproducible and a
# compromised republish cannot slip in. Bump docker/package.json and regenerate
# the lock together — never hand-edit it.
COPY docker/package.json docker/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# truecopy-mcp is now local to /app rather than globally installed, so put the
# local bin dir on PATH for the ENTRYPOINT.
ENV PATH=/app/node_modules/.bin:$PATH

# The self-dogfood lock this repo already uses in its own test suite — see
# truecopy.lock / demo/clean-mcp.json at the repo root. Ships a real, non-empty
# pinned entry so truecopy-verify/truecopy-status report something meaningful.
COPY truecopy.lock ./truecopy.lock
COPY demo/clean-mcp.json ./demo/clean-mcp.json

# Drop root. A supply-chain gate has no business running its own container as
# uid 0: the process only reads the lock and the pinned demo fixture, never
# writes at runtime. node:26-slim ships an unprivileged `node` user (uid 1000).
# Everything the runtime touches is world-readable and built above as root, so
# nothing needs chown'ing.
# The docker workflow asserts `id -u != 0` on every build so this cannot regress.
USER node

# Standalone: no downstream command, so truecopy-mcp serves its own tools.
ENTRYPOINT ["truecopy-mcp", "--lock", "/app/truecopy.lock"]
