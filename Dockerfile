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

# @askalf/truecopy pulls @askalf/redstamp from GitHub, so git (+ CA certs for
# HTTPS) must be present when npm resolves the dependency tree.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# npm writes hosted-git `resolved` URLs as git+ssh:// whenever the lock is
# generated on a machine with a GitHub SSH remote. There is no SSH key in this
# build, so force the HTTPS transport for github.com — the commit SHA in the lock
# is what pins the dependency; the transport that fetches it is not a security
# property. Without this the build breaks on whoever regenerates the lock next.
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/

WORKDIR /app

# Install from a LOCKFILE, not `npm i <pkg>@<version>`. A version tag is a
# mutable label; docker/package-lock.json records the integrity hash of every
# registry tarball in the transitive tree (and the exact commit for the
# git-sourced redstamp dependency), so the image is byte-reproducible and a
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
