// Claude Code skills — the skills-marketplace surface, first class. A skill is a
// directory (SKILL.md + files) that Claude Code loads BY NAME from, most-specific
// scope first:
//   <project>/.claude/skills/<name>/   (project scope)
//   ~/.claude/skills/<name>/           (user scope)
// and, namespaced as `plugin:skill`, from marketplace plugins:
//   ~/.claude/plugins/marketplaces/<mp>/{plugins,external_plugins}/<plugin>/skills/<skill>/
// canon pins each one like any skill dir; `canon hook claude` gates the Skill
// tool call itself (PreToolUse), so a drifted or poisoned skill is blocked at the
// moment it's invoked — not only at CI time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CANON_CLAUDE_HOME overrides where `~/.claude` lives (tests; unusual installs).
const userClaudeDir = () => path.join(process.env.CANON_CLAUDE_HOME || os.homedir(), '.claude');

/** The skill roots visible from projectDir, project scope first — on a name
 *  collision Claude Code runs the more specific scope, so canon must resolve
 *  (and gate) the same directory that will actually run. */
export function claudeSkillRoots({ projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd() } = {}) {
  const roots = [
    { scope: 'project', dir: path.join(projectDir, '.claude', 'skills') },
    { scope: 'user', dir: path.join(userClaudeDir(), 'skills') },
  ];
  return roots.filter((r) => { try { return fs.statSync(r.dir).isDirectory(); } catch { return false; } });
}

const hasSkillMd = (dir) => { try { return fs.statSync(path.join(dir, 'SKILL.md')).isFile(); } catch { return false; } };

const statIsDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// A Dirent's isDirectory() is LSTAT-based, so a symlinked directory — or a
// Windows junction, which needs no special privilege to create — answers false.
// Every discovery filter here used it, so those entries were skipped silently.
//
// Claude Code does not skip them: hasSkillMd() and resolveClaudeSkill() stat
// THROUGH the link. So a symlinked skill directory was one that RUNS but that
// truecopy could neither inventory nor pin — `add --claude` never saw it, which
// left the default-mode hook treating it as unpinned and allowing it, forever
// and invisibly, while `scan --claude` reported the machine clean by omission.
// A gate that cannot see a skill is worse than one that reports it.
const isDirEntry = (e, full) => e.isDirectory() || (e.isSymbolicLink() && statIsDir(full));

// Does `full` still land inside `realRoot` once symlinks are resolved?
// `realRoot` must already be realpath'd, or a symlinked root compares unequal to
// its own contents.
function insideRoot(full, realRoot) {
  try {
    const real = fs.realpathSync(full);
    return real === realRoot || real.startsWith(realRoot + path.sep);
  } catch { return false; }
}

/** Every Claude Code skill visible from projectDir. → [{ name, dir, scope }]
 *  (a project skill shadows a user skill of the same name, like Claude Code itself) */
export function discoverClaudeSkills(opts = {}) {
  const seen = new Map();
  for (const { scope, dir } of claudeSkillRoots(opts)) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (seen.has(e.name)) continue;
      const skillDir = path.join(dir, e.name);
      // Followed wherever it points, including out of the skills root. This is
      // the machine's OWN skill directory, and the content is going to be loaded
      // into the model either way — the only question is whether the gate knows
      // about it. Confining discovery here would recreate the invisible-but-
      // runnable skill this fixes. (An untrusted CLONE is a different matter —
      // see discoverMarketplaceSkills.)
      if (!isDirEntry(e, skillDir)) continue;
      if (hasSkillMd(skillDir)) seen.set(e.name, { name: e.name, dir: skillDir, scope });
    }
  }
  return [...seen.values()];
}

// A skill NAME, not a path: alphanumeric start (rejects dotdirs and `..`), then
// word / dot / dash. A `plugin:skill` invocation is exactly two of these joined
// by one `:`; anything else (separators, `..`, extra colons) → unresolvable, and
// the hook's policy decides what that means (strict blocks it).
const SKILL_NAME = /^[A-Za-z0-9][\w.-]*$/;

// ---- marketplace plugins ------------------------------------------------------

const marketplacesDir = () => path.join(userClaudeDir(), 'plugins', 'marketplaces');

// A plugin's public name comes from its .claude-plugin/plugin.json manifest (the
// dir name is only a fallback) — that's the namespace Claude Code invokes it by.
// A manifest name that isn't a plain NAME is ignored rather than trusted: the
// name is used to match hostile-controllable input, so it must stay path-safe.
function pluginName(pluginDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (j && typeof j.name === 'string' && SKILL_NAME.test(j.name)) return j.name;
  } catch {}
  const base = path.basename(pluginDir);
  return SKILL_NAME.test(base) ? base : null;
}

function* pluginDirs() {
  let mps = [];
  try { mps = fs.readdirSync(marketplacesDir(), { withFileTypes: true }); } catch { return; }
  // sorted → deterministic resolution when two marketplaces carry the same plugin name
  const sorted = (list) => list.sort((a, b) => a.name.localeCompare(b.name));
  for (const mp of sorted(mps)) {
    if (!isDirEntry(mp, path.join(marketplacesDir(), mp.name))) continue;
    for (const kind of ['plugins', 'external_plugins']) {
      const root = path.join(marketplacesDir(), mp.name, kind);
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of sorted(entries)) {
        const dir = path.join(root, e.name);
        if (!isDirEntry(e, dir)) continue;   // installed plugins are local: follow the link
        yield { marketplace: mp.name, dir };
      }
    }
  }
}

// `confine` (a realpath'd root) restricts discovery to skills that stay inside
// it, and every entry refused that way is pushed onto `skipped` rather than
// dropped. Used when walking an UNTRUSTED clone: without it, a vendor repo
// shipping `skills/x -> /somewhere/else` would have the watch read, hash and
// publish evidence from a directory outside the corpus. Local discovery passes
// no confine — see discoverClaudeSkills.
function collectPluginSkills(pluginDir, marketplace, seen, { confine = null, skipped = null } = {}) {
  const plugin = pluginName(pluginDir);
  if (!plugin) return;
  let skills = [];
  try { skills = fs.readdirSync(path.join(pluginDir, 'skills'), { withFileTypes: true }); } catch { return; }
  for (const s of skills) {
    const skillDir = path.join(pluginDir, 'skills', s.name);
    if (!isDirEntry(s, skillDir)) continue;
    if (!SKILL_NAME.test(s.name)) continue;
    if (confine && !insideRoot(skillDir, confine)) {
      skipped?.push({ path: skillDir, name: `${plugin}:${s.name}`, reason: 'symlink leaves the scanned tree' });
      continue;
    }
    const name = `${plugin}:${s.name}`;
    if (hasSkillMd(skillDir) && !seen.has(name)) seen.set(name, { name, dir: skillDir, scope: 'plugin', marketplace });
  }
}

/** Every skill shipped by installed marketplace plugins, keyed the way Claude
 *  Code invokes them. → [{ name: 'plugin:skill', dir, scope: 'plugin', marketplace }]
 *  Disk is the source of truth — whether the plugin is currently ENABLED isn't
 *  consulted (an enable is one click away; pin what could run). */
export function discoverClaudePluginSkills() {
  const seen = new Map();
  for (const { marketplace, dir } of pluginDirs()) collectPluginSkills(dir, marketplace, seen);
  return [...seen.values()];
}

/** Discover plugin skills under an EXPLICIT root — a cloned marketplace repo
 *  (`plugins/` + `external_plugins/` trees) or a single-plugin repo (`skills/`
 *  at the top, usually with `.claude-plugin/plugin.json`). Same `plugin:skill`
 *  naming as the live-marketplace discovery, so a study scan, a pin, and the
 *  hook all agree on identity. Offline by design: point it at a clone you made.
 *
 *  This root is UNTRUSTED — it is how the watch walks 250+ vendor repos — so
 *  symlinked directories are followed only while they stay inside it. One that
 *  points out of the tree is refused and recorded on `opts.skipped` (pass an
 *  array to collect them), never silently dropped: a scanner that quietly
 *  ignores part of what it was pointed at reports a coverage number it did not
 *  earn, and this one publishes that number. */
export function discoverMarketplaceSkills(root, { skipped = null } = {}) {
  const seen = new Map();
  const resolved = path.resolve(String(root || '.'));
  let realRoot; try { realRoot = fs.realpathSync(resolved); } catch { realRoot = resolved; }
  const label = path.basename(resolved);
  for (const kind of ['plugins', 'external_plugins']) {
    const base = path.join(resolved, kind);
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = path.join(base, e.name);
      if (!isDirEntry(e, dir)) continue;
      if (!insideRoot(dir, realRoot)) {
        skipped?.push({ path: dir, name: `${label}/${e.name}`, reason: 'symlink leaves the scanned tree' });
        continue;
      }
      collectPluginSkills(dir, label, seen, { confine: realRoot, skipped });
    }
  }
  if (!seen.size) collectPluginSkills(resolved, label, seen, { confine: realRoot, skipped }); // a single-plugin repo
  return [...seen.values()];
}

/** The directory that will run when Claude Code invokes skill `name`, or null.
 *  Bare names resolve from the project/user skill roots; `plugin:skill` names
 *  resolve from installed marketplace plugins. */
export function resolveClaudeSkill(name, opts = {}) {
  const raw = String(name || '');
  const colon = raw.indexOf(':');
  if (colon >= 0) {
    const plugin = raw.slice(0, colon), skill = raw.slice(colon + 1);
    if (!SKILL_NAME.test(plugin) || !SKILL_NAME.test(skill)) return null;
    for (const { dir } of pluginDirs()) {
      if (pluginName(dir) !== plugin) continue;
      const skillDir = path.join(dir, 'skills', skill);
      if (hasSkillMd(skillDir)) return skillDir;
    }
    return null;
  }
  if (!SKILL_NAME.test(raw)) return null;
  for (const { dir } of claudeSkillRoots(opts)) {
    const skillDir = path.join(dir, raw);
    if (hasSkillMd(skillDir)) return skillDir;
  }
  return null;
}
