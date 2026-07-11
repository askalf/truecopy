#!/bin/bash -eu
# Build the Jazzer.js fuzz targets for ClusterFuzzLite / OSS-Fuzz.
# Each target is an ESM module exporting `fuzz(data)`; the invariants are the
# security-critical fail-safe contracts at canon's trust boundary — the content
# hasher and its canonical JSON never throw on hostile input, the MCP tool gate
# never throws and never lets a prototype-named or duplicate twin ride in as
# `vetted`, and the poison scanner always returns a well-formed verdict on any
# malformed skill.
cd "$SRC/truecopy"
# npm ci verifies every integrity hash in the committed lockfile
# (Scorecard Pinned-Dependencies); Jazzer comes in as the locked devDependency.
npm ci --no-audit --no-fund

for target in canonical_json gate_tools scan_skill; do
  compile_javascript_fuzzer truecopy "fuzz/${target}.fuzz.js" --sync
done
