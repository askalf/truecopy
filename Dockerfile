# truecopy-mcp as a container — for Glama and any host that launches an MCP
# server from an image.
#
# truecopy-mcp is a GATE, not a server: it sits in front of a downstream MCP
# server and filters its tools/list down to the pinned, unmodified, unpoisoned
# set. So a bare gate has nothing to introspect — every unpinned tool is dropped
# and tools/list comes back empty. This image therefore wraps the MCP reference
# server (@modelcontextprotocol/server-everything) and pins its tools at build
# time, so at runtime tools/list returns a real, *vetted* tool set — a live
# demonstration of the gate passing a clean server through untouched.
#
# Every dependency of this image is pinned by HASH, not by tag: the base image by
# digest below, the npm tree by integrity hash in docker/package-lock.json. A tool
# that exists to make agents pin their supply chain has to pin its own. Dependabot
# watches both (`docker` + `/docker` npm in .github/dependabot.yml), so the pins
# get bumped deliberately instead of drifting silently.
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

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

# The two CLIs (truecopy, mcp-server-everything) are now local to /app rather
# than globally installed, so put the local bin dir on PATH for the build steps,
# the ENTRYPOINT, and the downstream server this gate spawns.
ENV PATH=/app/node_modules/.bin:$PATH

COPY docker/pin-everything.mjs ./pin-everything.mjs

# Capture exactly the tools the downstream advertises and pin them into
# truecopy.lock. At runtime the same server advertises byte-identical tools, so
# the gate classifies them `vetted` and serves them; anything drifted or
# poisoned would be dropped before it reached the client.
RUN node pin-everything.mjs everything -- mcp-server-everything stdio > everything.json \
 && truecopy add everything.json --lock /app/truecopy.lock \
 && rm everything.json

# Drop root. A supply-chain gate has no business running its own container as
# uid 0: the process only needs to READ the lock and exec the downstream server,
# so a container escape or a compromised downstream should not land on root.
# node:22-slim ships an unprivileged `node` user (uid 1000). Everything the
# runtime touches is world-readable and built above as root -- /app/node_modules
# and the lock at /app/truecopy.lock -- so nothing needs chown'ing, and the gate
# never writes at runtime.
# The docker workflow asserts `id -u != 0` on every build so this cannot regress.
USER node

# Enforce the pinned lock in front of the live server, over stdio.
ENTRYPOINT ["truecopy-mcp", "--lock", "/app/truecopy.lock", "--name", "everything", \
            "--", "mcp-server-everything", "stdio"]
