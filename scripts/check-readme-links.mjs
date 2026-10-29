#!/usr/bin/env node
// Every relative link, image and anchor in the README and docs/ must resolve.
//
// Checks, with no network access:
//   - relative file targets exist (links, <a href>, <img src>, and every
//     candidate URL in a <source srcset> or <img srcset>, without its descriptor)
//   - #fragments, percent-decoded, resolve to a heading (GitHub's slug rules)
//     or an explicit <a id="…"> / <a name="…"> in the target file, README included
//   - mailto: / http(s): / data: targets are left alone (external reachability
//     is not a property of this repo)
//
// Only rendered text counts: a link or <a id> inside fenced code or an inline
// code span is an example, not a link or an anchor. It reads markdown line by
// line, not with a parser, so indented code blocks, HTML comments and code
// spans that cross a line break are read as rendered text, and only # headings
// are headings: a link to an underlined (=== or ---) heading fails.
//
// Usage: node scripts/check-readme-links.mjs [file.md ...]   (default: README.md + docs/*.md)
// test/readme-links.test.mjs drives the exported functions against fixtures.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The inline code spans in one line, found the CommonMark way: a whole run of N
 * backticks opens a span that the next run of exactly N closes, and a run with
 * no closer is literal text. Outside code a backslash escapes the character
 * after it; inside code it does not. The code is the text between the runs, one
 * space trimmed from each end when both ends have one and it is not all spaces.
 */
function codeSpans(line) {
  const spans = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\\') { i += 2; continue; }
    if (line[i] !== '`') { i++; continue; }
    let j = i;
    while (line[j] === '`') j++;
    const n = j - i;
    let close = -1;
    for (let k = j; k < line.length; ) {
      if (line[k] !== '`') { k++; continue; }
      let e = k;
      while (line[e] === '`') e++;
      if (e - k === n) { close = k; break; }
      k = e;
    }
    if (close < 0) { i = j; continue; }
    let code = line.slice(j, close);
    if (code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) code = code.slice(1, -1);
    spans.push({ start: i, end: close + n, code });
    i = close + n;
  }
  return spans;
}

/** The line with its inline code spans removed. */
function withoutCodeSpans(line) {
  let out = '';
  let last = 0;
  for (const s of codeSpans(line)) { out += line.slice(last, s.start); last = s.end; }
  return out + line.slice(last);
}

/**
 * An HTML tag or comment. A tag name is followed by whitespace, / or >, so an
 * autolink such as <https://example.com> is not a tag: GitHub shows its text.
 */
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])[^<>]*>|<!--[\s\S]*?-->/g;

/**
 * Text with underscore emphasis dropped: _a_ and __a__ open after a non-word
 * character and close before one, so foo_bar, _private and more_ stay literal.
 */
function withoutUnderscoreEmphasis(text) {
  let s = text;
  for (let prev = null; prev !== s; ) {
    prev = s;
    s = s.replace(/(^|[^\p{L}\p{N}_])(_+)(?=\S)(.*?\S)\2(?![\p{L}\p{N}_])/gu, '$1$3');
  }
  return s;
}

/**
 * GitHub's heading slug. The text first goes the way GitHub renders it: code
 * spans found first and kept as their literal content, then, outside code, tags
 * dropped, links and images to their text, underscore emphasis dropped. Then
 * GitHub's slugger: lowercase, every character but a letter, mark, number,
 * space, hyphen or underscore removed, each space to a hyphen, no trim after
 * (so "🚀 Launch" is "-launch"). anchorsOf gives duplicates their suffixes.
 */
export function slugify(text) {
  // Each code span is parked as one private-use character while the text around
  // it is rendered, then put back. The slugger drops private-use characters, so
  // removing any already in the text changes no slug.
  const s = text.trim().replace(/[-]/g, '');
  const code = [];
  let r = '';
  let last = 0;
  for (const span of codeSpans(s)) {
    r += s.slice(last, span.start) + String.fromCharCode(0xE000 + code.length);
    code.push(span.code);
    last = span.end;
  }
  r += s.slice(last);
  // Looping until nothing changes handles nested/split tags; this is slug
  // derivation for comparison, not sanitization of anything rendered.
  for (let prev = null; prev !== r; ) { prev = r; r = r.replace(HTML_TAG, ''); }
  r = withoutUnderscoreEmphasis(r.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'));
  r = r.replace(/[-]/g, (c) => code[c.charCodeAt(0) - 0xE000]);
  return r.toLowerCase().replace(/[^\p{L}\p{M}\p{N} _-]/gu, '').replace(/ /g, '-');
}

/** Percent-decoded text, or null when an escape is malformed. */
function decoded(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

/**
 * The lines outside fenced code, each with its 0-based index. A fence opens on a
 * run of 3 or more backticks or tildes (a backtick fence's info string holds no
 * backtick) and closes only on a run of the same character, at least as long,
 * with nothing after it. Unclosed, it runs to the end. Any indent is accepted, so
 * a fence nested in a list item counts.
 */
export function proseLines(src) {
  const out = [];
  let fence = null;
  src.split('\n').forEach((line, i) => {
    if (fence) {
      const close = line.match(/^\s*(`+|~+)\s*$/);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      return;
    }
    const open = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) { fence = { ch: open[1][0], len: open[1].length }; return; }
    out.push({ line, i });
  });
  return out;
}

/**
 * Every heading slug and explicit <a id|name> in a markdown file's rendered text.
 * A repeated slug takes the next -1, -2 … suffix not already taken, so headings
 * "Setup", "Setup", "Setup-1" give setup, setup-1, setup-1-1 (github-slugger's rule).
 */
export function anchorsOf(path) {
  const taken = new Map(); const out = new Set();
  for (const { line } of proseLines(readFileSync(path, 'utf8'))) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) {
      const base = slugify(m[1]);
      let slug = base;
      while (taken.has(slug)) { taken.set(base, taken.get(base) + 1); slug = `${base}-${taken.get(base)}`; }
      taken.set(slug, 0);
      out.add(slug);
    }
    for (const m of withoutCodeSpans(line).matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]);
  }
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
  for (const { line, i } of proseLines(src)) {
    const text = withoutCodeSpans(line);
    // inline links and images: [text](target "title"), ![alt](target)
    for (const m of text.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) targets.push({ t: m[1], line: i + 1 });
    // reference definitions: [label]: target "title": the target for every
    // [text][label] / ![alt][label] use, so checking the definition covers them.
    // A footnote definition ([^label]: prose) is not a link.
    for (const m of text.matchAll(/^\s{0,3}\[(?!\^)[^\]]+\]:\s*<?([^\s>]+)>?(?:\s+.*)?$/g)) targets.push({ t: m[1], line: i + 1 });
    // raw html: <a href>, <img src> hold one URL each
    for (const m of text.matchAll(/\b(?:href|src)="([^"]+)"/g)) targets.push({ t: m[1], line: i + 1 });
    // <source srcset>, <img srcset> hold a list of "URL descriptor" candidates
    for (const m of text.matchAll(/\bsrcset="([^"]+)"/g)) for (const t of srcsetUrls(m[1])) targets.push({ t, line: i + 1 });
  }
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
    const hash = t.indexOf('#');
    const pathPart = hash < 0 ? t : t.slice(0, hash);
    const path = decoded(pathPart);
    const frag = hash < 0 ? undefined : decoded(t.slice(hash + 1));
    if (path === null || frag === null) { failures.push(`${file}:${line} → ${t} (malformed percent-escape)`); continue; }
    let target = file;
    if (path) {
      const p = resolve(base, path);
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
