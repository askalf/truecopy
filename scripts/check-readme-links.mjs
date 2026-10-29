#!/usr/bin/env node
// Every relative link, image and anchor in the README and docs/ must resolve.
//
// Checks, with no network access:
//   - relative file targets exist (links, <a href>, <img src>, and every
//     candidate URL in a <source srcset> or <img srcset>, without its descriptor);
//     a ?query is not part of the file name
//   - #fragments, percent-decoded, resolve to a heading (GitHub's slug rules)
//     or an explicit <a id="…"> / <a name="…"> in the target file, README included
//   - mailto: / http(s): / data: targets are left alone (external reachability
//     is not a property of this repo)
//
// Only rendered text counts: a link or <a id> inside fenced code or an inline
// code span is an example, not a link or an anchor, and link syntax or
// backticks inside a raw HTML tag are attribute text. It reads markdown line by
// line, not with a parser, so indented code blocks, HTML comments and code
// spans that cross a line break are read as rendered text, and only # headings
// are headings: a link to an underlined (=== or ---) heading fails. So does a
// link to a heading holding a named character reference outside the short
// NAMED table: write the character itself.
//
// Usage: node scripts/check-readme-links.mjs [file.md ...]   (default: README.md + docs/*.md)
// test/readme-links.test.mjs drives the exported functions against fixtures.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The backtick run at i and the inline code span it opens, found the CommonMark
 * way: a whole run of N backticks opens a span that the next run of exactly N
 * closes. run is where the opening run ends; span is { start, end, code }, or
 * null when no closer follows and the run is literal text. The code is the text
 * between the runs, one space trimmed from each end when both ends have one and
 * it is not all spaces.
 */
function codeSpanAt(line, i) {
  let j = i;
  while (line[j] === '`') j++;
  const n = j - i;
  for (let k = j; k < line.length; ) {
    if (line[k] !== '`') { k++; continue; }
    let e = k;
    while (line[e] === '`') e++;
    if (e - k === n) {
      let code = line.slice(j, k);
      if (code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) code = code.slice(1, -1);
      return { run: j, span: { start: i, end: e, code } };
    }
    k = e;
  }
  return { run: j, span: null };
}

/**
 * The inline code spans in one line. Outside code a backslash escapes the
 * character after it; inside code it does not.
 */
function codeSpans(line) {
  const spans = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\\') { i += 2; continue; }
    if (line[i] !== '`') { i++; continue; }
    const { run, span } = codeSpanAt(line, i);
    if (!span) { i = run; continue; }
    spans.push(span);
    i = span.end;
  }
  return spans;
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

/** The named character references this checker decodes, as code points. HTML has over two thousand. */
const NAMED = {
  amp: 0x26, lt: 0x3C, gt: 0x3E, quot: 0x22, apos: 0x27, nbsp: 0xA0, copy: 0xA9, reg: 0xAE,
  trade: 0x2122, hellip: 0x2026, mdash: 0x2014, ndash: 0x2013, lsquo: 0x2018, rsquo: 0x2019,
  ldquo: 0x201C, rdquo: 0x201D, laquo: 0xAB, raquo: 0xBB, middot: 0xB7, bull: 0x2022,
  times: 0xD7, deg: 0xB0, larr: 0x2190, rarr: 0x2192, check: 0x2713,
};

/**
 * Text with its character references decoded (&amp; &#233; &#xE9;). A named one
 * outside NAMED, whose meaning this checker cannot know, stays as written and
 * sets unknown. A numeric reference to no character (0, a surrogate, past
 * U+10FFFF) is U+FFFD.
 */
function decodeReferences(text) {
  let unknown = false;
  const out = text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/g, (ref, dec, hex, name) => {
    if (name) {
      if (Object.hasOwn(NAMED, name)) return String.fromCodePoint(NAMED[name]);
      unknown = true;
      return ref;
    }
    const n = dec ? Number(dec) : parseInt(hex, 16);
    return String.fromCodePoint(n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF) ? 0xFFFD : n);
  });
  return { text: out, unknown };
}

/** An HTML attribute value as the browser reads it: character references decoded. */
function attributeValue(raw) {
  return decodeReferences(raw).text;
}

/**
 * An HTML start tag up to, not including, its closing >. A quoted value may hold
 * > and line breaks; a match that runs to the end of its input is a tag still
 * open there.
 */
const START_TAG = /<([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)((?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^"'>])*)/y;

/**
 * A START_TAG match as { name, attrs }: the tag name lowercased and attrs its
 * [name, value] pairs, names lowercased and values decoded. HTML allows
 * whitespace around an attribute's = and a value that is double-quoted,
 * single-quoted or unquoted (running to whitespace or >), so <a id = "x">,
 * <a href=guide.md> and <img src='a.png'> all count.
 */
function tagOf(t) {
  const attrs = [];
  for (const a of t[2].matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs.push([a[1].toLowerCase(), attributeValue(a[2] ?? a[3] ?? a[4] ?? '')]);
  }
  return { name: t[1].toLowerCase(), attrs };
}

/** The label and destination of a reference definition, [label]: target. */
const REFERENCE_DEFINITION = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*(?:<[^<>]*>|\S+)/;

/**
 * One line read left to right the way GitHub's inline parser reads it: a code
 * span or a raw HTML tag, whichever starts first, takes its whole text. So
 * backticks and link syntax inside a quoted attribute are attribute text, and a
 * tag inside a code span is code. A link destination, inline or in a reference
 * definition, is a destination, so [a](<b c.md>) holds no tag. A < after an odd
 * number of backslashes is escaped text, so \<img src="x.png"> is no tag, while
 * after \\ the tag is real.
 *
 * Returns text, the line with each code span and tag replaced by one U+FFFC,
 * which is no markup, so the text on either side stays apart ([a]`x`(b.md) is
 * not a link); tags, the start tags that close on this line; and open, the text
 * so far of a tag still open at the end of the line. Passing open back with the
 * next line reads the two as one, so a tag is returned with the line it closes
 * on and the text it covers on that line is no markdown. rest gives the lines
 * after this one in its paragraph: a tag that does not close before the
 * paragraph ends is no tag, so its < is text and the lines after it are markdown.
 */
function inlineParts(line, open = null, rest = () => []) {
  const tags = [];
  const tagAt = (src, at) => { START_TAG.lastIndex = at; return START_TAG.exec(src); };
  let text = '';
  let last = 0;
  let i = 0;
  if (open) {
    const src = `${open}\n${line}`;
    const t = tagAt(src, 0);
    if (t[0].length === src.length) return { text, tags, open: src };
    tags.push(tagOf(t));
    text = '\uFFFC';
    i = last = t[0].length - open.length;
  } else {
    i = line.match(REFERENCE_DEFINITION)?.[0].length ?? 0;
  }
  let brackets = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      const { run, span } = codeSpanAt(line, i);
      if (span) { text += line.slice(last, i) + '\uFFFC'; i = last = span.end; } else i = run;
      continue;
    }
    if (c === '<') {
      const t = tagAt(line, i);
      if (t && i + t[0].length === line.length) {
        const src = [line.slice(i), ...rest()].join('\n');
        if (tagAt(src, 0)[0].length < src.length) return { text: text + line.slice(last, i), tags, open: line.slice(i) };
      } else if (t) { tags.push(tagOf(t)); text += line.slice(last, i) + '\uFFFC'; i = last = i + t[0].length + 1; continue; }
    }
    if (c === '[') brackets++;
    else if (c === ']' && brackets > 0) {
      brackets--;
      const link = line[i + 1] === '(' && inlineDestination(line, i + 2);
      if (link) { i = link.end; continue; }
    }
    i++;
  }
  return { text: text + line.slice(last), tags, open: null };
}

/**
 * The lines after lines[n] in its paragraph: they run until a blank line, or a
 * gap where proseLines dropped fenced code.
 */
function paragraphRest(lines, n) {
  const out = [];
  for (let m = n + 1; m < lines.length && lines[m].i === lines[m - 1].i + 1 && /\S/.test(lines[m].line); m++) out.push(lines[m].line);
  return out;
}

/**
 * A markdown link destination as GitHub serves it. Its renderer decodes character
 * references first and undoes backslash escapes after, so a\&amp;b.md links to
 * a&b.md and c&#92;&amp;d.md to c&d.md; GitHub's markdown API renders both so.
 * Heading text differs: there an escaped & is literal (see slugify).
 */
function markdownTarget(raw) {
  return decodeReferences(raw).text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * The inline link whose "](" ends just before index i, as { dest, end } with end
 * just past its closing ), or null when none parses there. Whitespace may lead
 * the destination. <...> runs to the first >; a bare destination runs to
 * whitespace or to the ) that leaves its own parentheses unbalanced, so
 * guide(v2).md is one file name. An optional quoted or (...) title and a ) follow.
 */
function inlineDestination(text, i) {
  while (text[i] === ' ' || text[i] === '\t') i++;
  let j = i;
  let dest;
  if (text[i] === '<') {
    for (j = i + 1; j < text.length && text[j] !== '>' && text[j] !== '<'; j += text[j] === '\\' ? 2 : 1);
    if (text[j] !== '>') return null;
    dest = text.slice(i + 1, j++);
  } else {
    let depth = 0;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '\\') { j++; continue; }
      if (c <= ' ') break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
    }
    if (depth !== 0) return null;
    dest = text.slice(i, j);
  }
  const tail = text.slice(j).match(/^(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*\)/);
  return tail ? { dest, end: j + tail[0].length } : null;
}

/**
 * Text with its inline images dropped (images: true) or its inline links turned
 * into their text (images: false), destinations parsed as inlineDestination
 * parses them, so [Guide](docs/guide(v2).md) renders as Guide.
 */
function withoutInlineLinks(text, images) {
  let out = '';
  let last = 0;
  for (let k = text.indexOf(']('); k >= 0; k = text.indexOf('](', k + 1)) {
    const open = text.lastIndexOf('[', k);
    if (open < last || text.slice(open + 1, k).includes(']')) continue;
    const isImage = open > 0 && text[open - 1] === '!';
    if (isImage !== images) continue;
    const link = inlineDestination(text, k + 2);
    if (!link) continue;
    out += images ? text.slice(last, open - 1) : text.slice(last, open) + text.slice(open + 1, k);
    last = link.end;
    k = link.end - 1;
  }
  return out + text.slice(last);
}

/**
 * GitHub's heading slug, or null when the heading holds a character reference
 * this checker cannot decode. The text first goes the way GitHub renders it:
 * code spans found first and kept as their literal content, then each backslash
 * escaped character kept literal (so \&amp; is the text &amp; and \<b> is no
 * tag); around them, tags and images dropped (an image has no text), links to
 * their text, underscore emphasis dropped, character references decoded. Then
 * GitHub's slugger:
 * lowercase, every character but a letter, mark, number, space, hyphen or
 * underscore removed, each space to a hyphen, no trim after (so "🚀 Launch" is
 * "-launch"). anchorsOf gives duplicates their suffixes.
 */
export function slugify(text) {
  // Each code span and each escaped character is parked as one private-use
  // character while the text around it is rendered, and goes back after the
  // references are decoded, so nothing in it is read as markup. The slugger drops
  // private-use characters, so removing any already in the text changes no slug.
  const s = text.trim().replace(/\p{Co}/gu, '');
  const parked = [];
  const park = (literal) => String.fromCharCode(0xE000 + parked.push(literal) - 1);
  let r = '';
  let last = 0;
  for (const span of codeSpans(s)) {
    r += s.slice(last, span.start) + park(span.code);
    last = span.end;
  }
  r = (r + s.slice(last)).replace(/\\([!-/:-@[-`{-~])/g, (escape, c) => park(c));
  // Looping until nothing changes handles nested/split tags; this is slug
  // derivation for comparison, not sanitization of anything rendered.
  for (let prev = null; prev !== r; ) { prev = r; r = r.replace(HTML_TAG, ''); }
  r = withoutUnderscoreEmphasis(withoutInlineLinks(withoutInlineLinks(r, true), false));
  const { text: rendered, unknown } = decodeReferences(r);
  if (unknown) return null;
  return rendered.replace(/\p{Co}/gu, (c) => parked[c.charCodeAt(0) - 0xE000])
    .toLowerCase().replace(/[^\p{L}\p{M}\p{N} _-]/gu, '').replace(/ /g, '-');
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
 * A # line inside a tag still open from an earlier line is attribute text, read
 * with the same state targetsOf uses, so it gives no slug.
 * A repeated slug takes the next -1, -2 … suffix not already taken, so headings
 * "Setup", "Setup", "Setup-1" give setup, setup-1, setup-1-1 (github-slugger's rule).
 */
export function anchorsOf(path) {
  const taken = new Map(); const out = new Set();
  let open = null;
  const lines = proseLines(readFileSync(path, 'utf8'));
  lines.forEach(({ line }, n) => {
    const m = open ? null : line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    const base = m && slugify(m[1]);
    if (base != null) {
      let slug = base;
      while (taken.has(slug)) { taken.set(base, taken.get(base) + 1); slug = `${base}-${taken.get(base)}`; }
      taken.set(slug, 0);
      out.add(slug);
    }
    const html = inlineParts(line, open, () => paragraphRest(lines, n));
    open = html.open;
    for (const tag of html.tags) {
      if (tag.name !== 'a') continue;
      for (const [name, value] of tag.attrs) if (name === 'id' || name === 'name') out.add(value);
    }
  });
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
  let open = null;
  const lines = proseLines(src);
  lines.forEach(({ line, i }, n) => {
    const parts = inlineParts(line, open, () => paragraphRest(lines, n));
    open = parts.open;
    const text = parts.text;
    const add = (t) => { if (t) targets.push({ t, line: i + 1 }); };
    // inline links and images: [text](target "title"), ![alt](<target>). A link
    // needs a ] that closes an unescaped [ before it, so \[a](b.md) and a lone
    // ](b.md) are text; a backslash escapes the character after it, so after \\
    // a bracket counts. A link cannot hold a link, so one closes every [ before
    // it; an image can sit inside a link, so [![alt](a.png)](b.md) gives both.
    const opens = [];
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (c === '\\') { k++; continue; }
      if (c === '[') { opens.push({ image: text[k - 1] === '!' }); continue; }
      if (c !== ']' || !opens.length) continue;
      const { image } = opens.pop();
      if (text[k + 1] !== '(') continue;
      const link = inlineDestination(text, k + 2);
      if (!link) continue;
      add(markdownTarget(link.dest));
      if (!image) opens.length = 0;
      k = link.end - 1;
    }
    // reference definitions: [label]: target "title": the target for every
    // [text][label] / ![alt][label] use, so checking the definition covers them.
    // A footnote definition ([^label]: prose) is not a link.
    for (const m of text.matchAll(/^\s{0,3}\[(?!\^)[^\]]+\]:\s*(?:<([^<>]*)>|(\S+))/g)) add(markdownTarget(m[1] ?? m[2]));
    // raw html: <a href>, <img src> hold one URL each; <source srcset>, <img
    // srcset> hold a list of "URL descriptor" candidates. A tag may span lines,
    // and its targets carry the line it closes on.
    for (const tag of parts.tags) {
      for (const [name, value] of tag.attrs) {
        if (name === 'href' || name === 'src') add(value);
        else if (name === 'srcset') for (const t of srcsetUrls(value)) add(t);
      }
    }
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
    // path?query#fragment: a query (?plain=1, ?raw=true) is not part of the file name.
    const hash = t.indexOf('#');
    const beforeHash = hash < 0 ? t : t.slice(0, hash);
    const query = beforeHash.indexOf('?');
    const pathPart = query < 0 ? beforeHash : beforeHash.slice(0, query);
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
