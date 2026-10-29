#!/usr/bin/env node
// Every relative link, image and anchor in the README and docs/ must resolve.
//
// Checks, with no network access:
//   - relative file targets exist (links, <a href>, <img src>, and every
//     candidate URL in a <source srcset> or <img srcset>, without its descriptor)
//   - #fragments resolve to a heading (GitHub's slug rules) or an explicit
//     <a id="…"> / <a name="…"> in the target file, README included
//   - mailto: / http(s): / data: targets are left alone (external reachability
//     is not a property of this repo)
//
// Usage: node scripts/check-readme-links.mjs [file.md ...]   (default: README.md + docs/*.md)
// test/readme-links.test.mjs drives the exported functions against fixtures.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** GitHub-style heading slug: lowercase, drop punctuation, spaces → hyphens; duplicates get -1, -2 … */
export function slugify(text) {
  // Inline HTML in a heading (<kbd>, <code>…) does not reach the slug, so drop
  // the tags. Looping until nothing changes handles nested/split tags; this is
  // slug derivation for comparison, not sanitization of anything rendered.
  let s = text.toLowerCase();
  for (let prev = null; prev !== s; ) { prev = s; s = s.replace(/<[^>]*>/g, ''); }
  return s
    .replace(/[`*_~]/g, '')             // markdown emphasis / code
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
    .replace(/[^\p{L}\p{N}\s-]/gu, '')  // punctuation and emoji
    .trim()
    .replace(/\s/g, '-');
}

/** Every heading slug and explicit <a id|name> in a markdown file. */
export function anchorsOf(path) {
  const src = readFileSync(path, 'utf8');
  const seen = new Map(); const out = new Set();
  let inFence = false;
  for (const line of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) {
      const base = slugify(m[1]);
      const n = seen.get(base) ?? 0; seen.set(base, n + 1);
      out.add(n === 0 ? base : `${base}-${n}`);
    }
  }
  for (const m of src.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]);
  return out;
}

/**
 * The candidate URLs of a srcset value, descriptors dropped: "a.png 1x, b.png 2x"
 * gives [a.png, b.png]. Follows the HTML parsing rule: a URL runs to the next
 * whitespace and loses any trailing commas, and its descriptors run to the next
 * comma. So a comma inside a URL ("a,b.png 1x") stays part of it.
 */
export function srcsetUrls(value) {
  const out = [];
  let rest = value;
  for (;;) {
    rest = rest.replace(/^[\s,]+/, '');
    if (!rest) return out;
    const url = rest.match(/^\S+/)[0];
    rest = rest.slice(url.length);
    if (url.endsWith(',')) { out.push(url.replace(/,+$/, '')); continue; }
    out.push(url);
    const comma = rest.indexOf(',');
    rest = comma < 0 ? '' : rest.slice(comma + 1);
  }
}

/** Every link target in markdown text, with its 1-based line. Fenced code is skipped. */
export function targetsOf(src) {
  const targets = [];
  let inFence = false;
  src.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    // inline links and images: [text](target "title"), ![alt](target)
    for (const m of line.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) targets.push({ t: m[1], line: i + 1 });
    // reference definitions: [label]: target "title": the target for every
    // [text][label] / ![alt][label] use, so checking the definition covers them.
    // A footnote definition ([^label]: prose) is not a link.
    for (const m of line.matchAll(/^\s{0,3}\[(?!\^)[^\]]+\]:\s*<?([^\s>]+)>?(?:\s+.*)?$/g)) targets.push({ t: m[1], line: i + 1 });
    // raw html: <a href>, <img src> hold one URL each
    for (const m of line.matchAll(/\b(?:href|src)="([^"]+)"/g)) targets.push({ t: m[1], line: i + 1 });
    // <source srcset>, <img srcset> hold a list of "URL descriptor" candidates
    for (const m of line.matchAll(/\bsrcset="([^"]+)"/g)) for (const t of srcsetUrls(m[1])) targets.push({ t, line: i + 1 });
  });
  return targets;
}

/** Check one markdown file. Returns how many relative targets it checked and a message per broken one. */
export function checkFile(file, anchors = anchorsOf) {
  const base = dirname(resolve(file));
  const failures = [];
  let checked = 0;
  for (const { t, line } of targetsOf(readFileSync(file, 'utf8'))) {
    if (/^(https?:|mailto:|data:)/i.test(t)) continue;
    checked++;
    const [pathPart, frag] = t.split('#');
    let target = file;
    if (pathPart) {
      const p = resolve(base, decodeURIComponent(pathPart));
      if (!existsSync(p)) { failures.push(`${file}:${line} → ${t} (file not found)`); continue; }
      if (statSync(p).isDirectory()) { if (frag) failures.push(`${file}:${line} → ${t} (fragment on a directory)`); continue; }
      target = p;
    }
    if (frag !== undefined) {
      if (!/\.md$/i.test(target)) { failures.push(`${file}:${line} → ${t} (fragment on a non-markdown file)`); continue; }
      if (!anchors(target).has(frag)) failures.push(`${file}:${line} → ${t} (no heading or anchor "#${frag}" in ${target === file ? 'this file' : pathPart})`);
    }
  }
  return { checked, failures };
}

// Run as a script, not imported. realpath on both sides: argv[1] keeps a symlinked or
// short (8.3) path as typed, import.meta.url is the resolved one.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['README.md', ...readdirSync('docs').filter((f) => f.endsWith('.md')).sort().map((f) => join('docs', f))];
  const cache = new Map();
  const anchors = (p) => { if (!cache.has(p)) cache.set(p, anchorsOf(p)); return cache.get(p); };
  let failures = 0;
  for (const file of files) {
    const r = checkFile(file, anchors);
    for (const msg of r.failures) console.error(`FAIL: ${msg}`);
    failures += r.failures.length;
    console.log(`${failures ? 'checked' : 'ok '} ${file}: ${r.checked} relative link${r.checked === 1 ? '' : 's'}/anchors checked`);
  }
  process.exit(failures ? 1 : 0);
}
