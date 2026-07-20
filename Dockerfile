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
FROM node:22-slim

# @askalf/truecopy pulls @askalf/redstamp from GitHub, so git (+ CA certs for
# HTTPS) must be present when npm resolves the dependency tree.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Pin both versions so the image — and the lock generated from it — are
# reproducible. Bump these together with a rebuild.
ARG TRUECOPY_VERSION=0.9.0
ARG EVERYTHING_VERSION=2026.7.4
RUN npm i -g @askalf/truecopy@${TRUECOPY_VERSION} \
              @modelcontextprotocol/server-everything@${EVERYTHING_VERSION}

WORKDIR /app
COPY docker/pin-everything.mjs ./pin-everything.mjs

# Capture exactly the tools the downstream advertises and pin them into
# truecopy.lock. At runtime the same server advertises byte-identical tools, so
# the gate classifies them `vetted` and serves them; anything drifted or
# poisoned would be dropped before it reached the client.
RUN node pin-everything.mjs everything -- mcp-server-everything stdio > everything.json \
 && truecopy add everything.json --lock /app/truecopy.lock \
 && rm everything.json

# Enforce the pinned lock in front of the live server, over stdio.
ENTRYPOINT ["truecopy-mcp", "--lock", "/app/truecopy.lock", "--name", "everything", \
            "--", "mcp-server-everything", "stdio"]
