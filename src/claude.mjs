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

/** Every Claude Code skill visible from projectDir. → [{ name, dir, scope }]
 *  (a project skill shadows a user skill of the same name, like Claude Code itself) */
export function discoverClaudeSkills(opts = {}) {
  const seen = new Map();
  for (const { scope, dir } of claudeSkillRoots(opts)) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      const skillDir = path.join(dir, e.name);
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
  for (const mp of mps.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    for (const kind of ['plugins', 'external_plugins']) {
      const root = path.join(marketplacesDir(), mp.name, kind);
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        yield { marketplace: mp.name, dir: path.join(root, e.name) };
      }
    }
  }
}

/** Every skill shipped by installed marketplace plugins, keyed the way Claude
 *  Code invokes them. → [{ name: 'plugin:skill', dir, scope: 'plugin', marketplace }]
 *  Disk is the source of truth — whether the plugin is currently ENABLED isn't
 *  consulted (an enable is one click away; pin what could run). */
export function discoverClaudePluginSkills() {
  const seen = new Map();
  for (const { marketplace, dir } of pluginDirs()) {
    const plugin = pluginName(dir);
    if (!plugin) continue;
    let skills = [];
    try { skills = fs.readdirSync(path.join(dir, 'skills'), { withFileTypes: true }); } catch { continue; }
    for (const s of skills.filter((e) => e.isDirectory())) {
      if (!SKILL_NAME.test(s.name)) continue;
      const skillDir = path.join(dir, 'skills', s.name);
      const name = `${plugin}:${s.name}`;
      if (hasSkillMd(skillDir) && !seen.has(name)) seen.set(name, { name, dir: skillDir, scope: 'plugin', marketplace });
    }
  }
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
