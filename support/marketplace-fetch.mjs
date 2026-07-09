#!/usr/bin/env node
// Materialize the official plugin directory into a scannable corpus. Reads the
// catalog (`.claude-plugin/marketplace.json`) from a clone of
// anthropics/claude-plugins-official, resolves the in-repo plugins, and fetches
// every EXTERNAL vendor plugin at its catalog-pinned sha. Network lives here;
// the scan (marketplace-watch.mjs) stays offline and reads only this corpus.
//
//   node support/marketplace-fetch.mjs <directory-clone> <corpus-dir> [concurrency]
//
// Writes <corpus-dir>/canon-corpus.json — one row per catalog plugin:
//   { name, kind: 'local'|'external', dir, url?, sha?, ref?,
//     status: 'ok'|'ref-fallback'|'failed'|'invalid', actualSha?, error? }
// 'ref-fallback' = the pinned sha was unfetchable but the catalog ref resolved —
// the scan proceeds on ref@actualSha and the watch reports the pin drift.
// Individual fetch failures are rows, not fatal; exit 2 only when the catalog
// is unreadable/empty or every external fetch failed (the watch itself broke).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEX40 = /^[0-9a-f]{40}$/i;

const posix = (p) => String(p).replace(/\\/g, '/');
const safeSubPath = (p) => {
  if (!p) return true;
  const n = path.posix.normalize(posix(p));
  return !n.startsWith('..') && !path.posix.isAbsolute(n) && !n.includes('\0') && !/^[A-Za-z]:/.test(n);
};

/** Normalize the catalog's plugin list into fetchable entries. Handles every
 *  source shape the official directory uses: a local string path into the
 *  directory repo, `git-subdir`/`url` objects ({ url, sha, ref?, path? }), and
 *  `github` objects ({ repo, commit, sha }). Unusable rows come back with
 *  `invalid` set instead of being silently dropped. */
export function normalizeCatalog(catalog) {
  const plugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
  const entries = [];
  for (const p of plugins) {
    if (!p || typeof p !== 'object') { entries.push({ name: '', invalid: 'not an object' }); continue; }
    const name = String(p.name || '');
    if (!SAFE_NAME.test(name)) { entries.push({ name, invalid: 'unsafe plugin name' }); continue; }
    const src = p.source;
    if (typeof src === 'string') {
      const rel = posix(src).replace(/^\.\//, '');
      if (!safeSubPath(rel)) { entries.push({ name, invalid: `unsafe local source path: ${src}` }); continue; }
      entries.push({ name, kind: 'local', rel });
    } else if (src && typeof src === 'object') {
      const url = String(src.url || (src.repo ? `https://github.com/${src.repo}.git` : ''));
      const sha = String(src.commit || src.sha || ''); // the github shape pins `commit`; url/git-subdir pin `sha`
      const ref = src.ref ? String(src.ref) : '';
      const sub = src.path ? posix(String(src.path)) : '';
      if (!url.startsWith('https://')) { entries.push({ name, invalid: `non-https source url: ${url || '(none)'}` }); continue; }
      if (!HEX40.test(sha) && !ref) { entries.push({ name, invalid: 'no pinned sha and no ref' }); continue; }
      if (!safeSubPath(sub)) { entries.push({ name, invalid: `unsafe source path: ${src.path}` }); continue; }
      entries.push({ name, kind: 'external', url, sha: HEX40.test(sha) ? sha.toLowerCase() : '', ref, sub });
    } else {
      entries.push({ name, invalid: 'unrecognized source shape' });
    }
  }
  return entries;
}

// autocrlf=false is load-bearing: the corpus must carry the repos' TRUE bytes
// on every platform — a Windows fetch with the installer-default autocrlf=true
// checks out CRLF, and every skill hash (watch-accepted.json) diverges from CI.
const GIT_FLAGS = ['-c', 'core.longpaths=true', '-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false'];
const git = (args, cwd) => new Promise((resolve) => {
  execFile('git', [...GIT_FLAGS, ...args], { cwd, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
  });
});
const gitError = (r) => (r.stderr.trim().split('\n').pop() || 'git failed').slice(0, 300);

/** Shallow-fetch `want` (a sha or ref) from `url` into `dir`, detached. */
async function fetchAt(url, want, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', url], ['fetch', '-q', '--depth', '1', '--no-tags', 'origin', want], ['checkout', '-q', 'FETCH_HEAD']]) {
    const r = await git(args, dir);
    if (!r.ok) return { ok: false, error: `${args[0]}: ${gitError(r)}` };
  }
  const head = await git(['rev-parse', 'HEAD'], dir);
  return head.ok ? { ok: true, actualSha: head.stdout.trim() } : { ok: false, error: gitError(head) };
}

/** Fetch one unique (url, sha, ref) into its cache dir: pinned sha first, the
 *  catalog ref as fallback. Reuses a dir already sitting at the pinned sha. */
async function fetchRepo(job) {
  const { url, sha, ref, dir } = job;
  if (sha && fs.existsSync(path.join(dir, '.git'))) {
    const head = await git(['rev-parse', 'HEAD'], dir);
    if (head.ok && head.stdout.trim() === sha) return { status: 'ok', actualSha: sha, cached: true };
  }
  if (sha) {
    const r = await fetchAt(url, sha, dir);
    if (r.ok) return { status: 'ok', actualSha: r.actualSha };
    if (!ref) return { status: 'failed', error: r.error };
    const f = await fetchAt(url, ref, dir);
    if (f.ok) return { status: 'ref-fallback', actualSha: f.actualSha, error: `pinned sha unfetchable (${r.error}); scanned ${ref}@${f.actualSha.slice(0, 12)}` };
    return { status: 'failed', error: `sha: ${r.error}; ref ${ref}: ${f.error}` };
  }
  const f = await fetchAt(url, ref, dir);
  return f.ok ? { status: 'ok', actualSha: f.actualSha } : { status: 'failed', error: f.error };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function main() {
  const [cloneArg, corpusArg, concurrencyArg] = process.argv.slice(2);
  if (!cloneArg || !corpusArg) {
    console.error('usage: marketplace-fetch.mjs <directory-clone> <corpus-dir> [concurrency]');
    process.exit(2);
  }
  const clone = path.resolve(cloneArg);
  const corpus = path.resolve(corpusArg);
  const concurrency = Math.max(1, Number(concurrencyArg) || 8);

  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(path.join(clone, '.claude-plugin', 'marketplace.json'), 'utf8')); }
  catch (e) { console.error(`cannot read catalog under ${clone}: ${e.message}`); process.exit(2); }
  const entries = normalizeCatalog(catalog);
  if (!entries.some((e) => !e.invalid)) { console.error('catalog yielded no usable plugins — layout changed?'); process.exit(2); }

  // One fetch per unique (url, sha, ref); catalog entries share vendor repos.
  const repoJobs = new Map();
  for (const e of entries) {
    if (e.invalid || e.kind !== 'external') continue;
    const key = `${e.url}#${e.sha}#${e.ref}`;
    if (!repoJobs.has(key)) {
      const slug = posix(e.url).replace(/\.git$/, '').split('/').filter(Boolean).slice(-2).join('-').replace(/[^A-Za-z0-9._-]/g, '_');
      repoJobs.set(key, { url: e.url, sha: e.sha, ref: e.ref, dir: path.join(corpus, 'repos', `${repoJobs.size}-${slug}`.slice(0, 80)) });
    }
    e.repoKey = key;
  }
  fs.mkdirSync(path.join(corpus, 'repos'), { recursive: true });
  const jobs = [...repoJobs.values()];
  let done = 0;
  const results = new Map();
  await pool(jobs, concurrency, async (job) => {
    const r = await fetchRepo(job);
    results.set(`${job.url}#${job.sha}#${job.ref}`, { ...r, dir: job.dir });
    done += 1;
    if (done % 25 === 0 || done === jobs.length) console.error(`fetched ${done}/${jobs.length} vendor repos`);
  });

  const rows = [];
  for (const e of entries) {
    if (e.invalid) { rows.push({ name: e.name, status: 'invalid', error: e.invalid }); continue; }
    if (e.kind === 'local') {
      const dir = path.resolve(clone, e.rel);
      if (!dir.startsWith(clone + path.sep) || !fs.existsSync(dir)) rows.push({ name: e.name, kind: 'local', status: 'failed', error: `local source missing: ${e.rel}` });
      else rows.push({ name: e.name, kind: 'local', dir, status: 'ok' });
      continue;
    }
    const r = results.get(e.repoKey);
    if (r.status === 'failed') { rows.push({ name: e.name, kind: 'external', url: e.url, sha: e.sha, ref: e.ref, status: 'failed', error: r.error }); continue; }
    const dir = e.sub ? path.resolve(r.dir, e.sub) : r.dir;
    if (e.sub && (!dir.startsWith(r.dir + path.sep) || !fs.existsSync(dir))) {
      rows.push({ name: e.name, kind: 'external', url: e.url, sha: e.sha, ref: e.ref, status: 'failed', error: `source path missing in repo: ${e.sub}` });
      continue;
    }
    rows.push({ name: e.name, kind: 'external', url: e.url, sha: e.sha, ref: e.ref, dir, status: r.status, actualSha: r.actualSha, ...(r.error ? { error: r.error } : {}) });
  }

  const count = (s) => rows.filter((r) => r.status === s).length;
  const external = rows.filter((r) => r.kind === 'external').length;
  const summary = {
    plugins: rows.length,
    local: rows.filter((r) => r.kind === 'local').length,
    external,
    uniqueRepos: jobs.length,
    ok: count('ok'),
    refFallback: count('ref-fallback'),
    failed: count('failed'),
    invalid: count('invalid'),
  };
  fs.writeFileSync(path.join(corpus, 'canon-corpus.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), directoryClone: clone, summary, entries: rows }, null, 2) + '\n');
  console.log(JSON.stringify(summary));
  if (external > 0 && summary.failed >= external) { console.error('every external fetch failed — network or auth broke'); process.exit(2); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
