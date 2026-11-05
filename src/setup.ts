import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { PHASES, agentNames, agents, hookCommand, type AgentName } from './agents.js';
import { t, type Lang } from './i18n.js';
import { loadConfig } from './brain.js';
import { FLOW_COMMAND_PATH, FLOW_SKILL_PATH, guidancePaths, syncFlowSkill, syncGuidance } from './skill.js';
import { findConflicts } from './conflicts.js';
import { FLOW_DIR } from './flow.js';

const START = '# >>> YOUR CTO JEV START >>>';
const END = '# <<< YOUR CTO JEV END <<<';
// Keep the block minimal: all logic (including the git diff call) lives in the package, so npm update upgrades every repo.
// A hook's result is its last command's; once our block is last, a failing line above it (biome, lint) would be ignored.
const KEEP_FAIL = 's=$?; [ $s -eq 0 ] || exit $s\n';
const HOOK_BODY = KEEP_FAIL + 'if command -v cto >/dev/null 2>&1; then\n  cto --hook git-commit || exit 1\nfi\n';
// pre-push gets git's ref lines on stdin; they are passed straight through.
const PUSH_BODY = KEEP_FAIL + 'if command -v cto >/dev/null 2>&1; then\n  cto --hook git-push || exit 1\nfi\n';
export const GIT_HOOKS: [string, string][] = [['pre-commit', HOOK_BODY], ['pre-push', PUSH_BODY]];
// settings.local.json is Claude Code's per-machine file; often only the global gitignore covers it, which linters like biome never read.
const IGNORE_BODY = '.cto-brain.json\n.cto-brain.json.*tmp\ndebug_stdin.json\n.claude/settings.local.json\n';
const OURS = (cmd?: unknown) => typeof cmd === 'string' && cmd.startsWith('cto --hook ');

const block = (body: string) => `${START}\n${body}${END}\n`;
// \r?\n: an editor or core.autocrlf may have turned the file CRLF; the block must still be found, or setup appends a second one.
const blockRe = /(\r?\n)?# >>> YOUR CTO JEV START >>>\r?\n[\s\S]*?# <<< YOUR CTO JEV END <<<(\r?\n)?/;

export function removeBlock(content: string): string {
  // The newline before the block is the user's (appendBlock ends their last line first): keep it, in their line ending,
  // even when an editor stripped the newline after END.
  return content.replace(blockRe, (_m, lead?: string) => lead ?? '');
}

export function appendBlock(content: string, body: string): string {
  const base = removeBlock(content);
  return (base && !base.endsWith('\n') ? base + '\n' : base) + block(body);
}

/** An exit 0 outside our block means the appended block never runs. */
export function hasEarlyExit(content: string): boolean {
  return /^\s*exit\s+0\b/m.test(removeBlock(content));
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * IGNORE_BODY entries the repo's own .gitignore does not already cover outside our block: an exact line, or any rule there
 * git says matches (`.claude/` covers `.claude/settings.local.json`). Global excludesFile and .git/info/exclude do not
 * count; linters like biome never read them. shortcut: a rule in a nested .gitignore does not count either.
 */
function missingIgnores(root: string, text: string): string[] {
  const have = new Set(removeBlock(text).split(/\r?\n/).map((l) => l.trim()));
  const entries = IGNORE_BODY.split('\n').filter((l) => l && !have.has(l));
  // Ask about a real file name: brain.ts writes `.cto-brain.json.<pid>.tmp`, which a user's `*.tmp` covers.
  const sample = (e: string) => e.replace('*', '1.');
  let out = '';
  // Exit 1 means nothing matched; a git failure leaves the exact-line answer.
  try { if (entries.length) out = git(root, 'check-ignore', '--no-index', '-v', ...entries.map(sample)); } catch { /* none covered */ }
  // A rule reported from inside our block counts only if the same line also sits outside it.
  const covered = out.split('\n').map((l) => /^\.gitignore:\d+:([^\t]*)\t(.*)$/.exec(l))
    .filter((m) => m && !m[1].startsWith('!') && have.has(m[1].trim())).map((m) => m![2]);
  return entries.filter((e) => !covered.includes(sample(e)));
}

/** Hooks dir honoring core.hooksPath (via --git-path). Husky's generated .husky/_ is replaced on install, so use .husky. */
export function hooksDir(root: string): string {
  const dir = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks');
  return basename(dir) === '_' && basename(dirname(dir)) === '.husky' ? dirname(dir) : dir;
}

/** Agents whose home config dir exists. */
export function detectAgents(home = homedir()): AgentName[] {
  return agentNames.filter((n) => existsSync(join(home, agents[n].homeDir)));
}

function readSettings(path: string): any | null {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

const isObj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Settings must be an object; the hook events cto writes must be arrays if present. Checked before anything is written. */
function validShape(json: any, name: AgentName): boolean {
  if (!isObj(json)) return false;
  if (json.hooks === undefined) return true;
  if (!isObj(json.hooks)) return false;
  const a = agents[name];
  return PHASES.map((p) => a[p]).every((spec) => !spec || json.hooks[spec.event] === undefined || Array.isArray(json.hooks[spec.event]));
}

function writeOrRemove(path: string, settings: any) {
  const meaningful = Object.keys(settings).filter((k) => k !== 'version');
  if (meaningful.length) return writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  unlinkSync(path);
  try { if (!readdirSync(dirname(path)).length) rmdirSync(dirname(path)); } catch { /* keep dir */ }
}

function installAgent(settings: any, name: AgentName) {
  const a = agents[name];
  settings.hooks ??= {};
  if (a.style === 'cursor') settings.version ??= 1;
  for (const phase of PHASES) {
    const spec = a[phase];
    if (!spec) continue;
    const command = hookCommand(name, phase);
    const arr: any[] = (settings.hooks[spec.event] ??= []);
    if (a.style === 'cursor') {
      if (!arr.some((h) => h?.command === command)) arr.push({ command });
    } else if (!arr.some((m) => m?.hooks?.some((h: any) => h?.command === command))) {
      arr.push({ ...(spec.matcher && { matcher: spec.matcher }), hooks: [{ type: 'command', command }] });
    }
  }
}

/** Remove every cto hook from a settings object (both styles). Returns whether anything changed. */
function uninstallHooks(settings: any): boolean {
  if (!settings.hooks || typeof settings.hooks !== 'object') return false;
  let touched = false;
  for (const [event, arr] of Object.entries<any>(settings.hooks)) {
    if (!Array.isArray(arr)) continue;
    const kept = arr.flatMap((m: any) => {
      if (OURS(m?.command)) { touched = true; return []; } // cursor style
      if (!Array.isArray(m?.hooks) || !m.hooks.some((h: any) => OURS(h?.command))) return [m];
      touched = true;
      const hooks = m.hooks.filter((h: any) => !OURS(h?.command));
      return hooks.length ? [{ ...m, hooks }] : [];
    });
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (touched && !Object.keys(settings.hooks).length) delete settings.hooks;
  return touched;
}

export interface SetupOptions {
  uninstall?: boolean;
  agents?: AgentName[];
  /** The agent list is the full desired set (interactive setup): unpicked agents lose their cto hooks. Default: add only. */
  exact?: boolean;
  /** Use the cto development flow (cto-flow skill + docs/cto_jev/ skeleton). Undefined keeps the value saved in .cto.json. */
  flow?: boolean;
}

// docs/cto_jev/ skeleton, created only for files that do not exist. Headings are the fixed field names the flow checks
// read (FLOW_SKILL_TEXT in skill.ts); `unknown` is what the agent's first run fills in.
const fields = (names: string[]) => names.map((n) => `## ${n}\n\nunknown\n`).join('\n');
export const FLOW_SKELETON: Record<string, string> = {
  'docs/cto_jev/PRODUCT.md': `# PRODUCT\n\nStatus: draft\n\n${fields(['一句話', '使用者角色', '怎麼賺錢', '方案與限制', '不做的事', '設計約束'])}`,
  'docs/cto_jev/ARCHITECTURE.md': `# ARCHITECTURE\n\nStatus: draft\n\n${fields(['技術棧', '目錄地圖', '外部服務與資料', '驗證指令', '不變的原則'])}`,
  'docs/cto_jev/features/platform/CONCEPT.md': '# platform\n\nStatus: approved\n\n## 目的\n\nInfrastructure: CI, build, deploy, dependencies\n\n## 動機\n\n## 商業規則\n\n## 不做的事\n',
  'docs/cto_jev/features/platform/SPEC.md': '# platform SPEC\n\nStatus: approved\n\n## Interface\n\n## Constraints\n\n## Internals\n',
  'docs/cto_jev/features/platform/TASKS.md': '# platform TASKS\n',
  'docs/cto_jev/features/platform/REVIEW.md': '# platform REVIEW\n\nNot reviewed yet.\n',
  'docs/cto_jev/decisions/.gitkeep': '',
};

export interface FileChange { path: string; change: 'new' | 'update' | 'remove' }

/**
 * What an interactive (exact) setup with these choices would write, without writing: the summary shown before "Proceed?".
 * Same decisions as `setup`: files already current are left out. A settings file setup would refuse (bad JSON) is listed
 * as an update; setup itself then stops before writing anything.
 */
export function planSetup(root: string, chosenAgents: AgentName[], flow: boolean, goal: string): FileChange[] {
  const out: FileChange[] = [];
  const at = (p: string, change: 'write' | 'remove', abs = join(root, p)) => out.push({ path: p, change: change === 'remove' ? 'remove' : existsSync(abs) ? 'update' : 'new' });
  const chosen = new Set(chosenAgents);
  // git reports the hooks dir with long names; a Windows temp root may be 8.3 (C:\Users\JOHNDO~1). Compare real paths.
  const real = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };
  const dir = hooksDir(root);
  for (const [name, body] of GIT_HOOKS) {
    const p = join(dir, name);
    const c = existsSync(p) ? readFileSync(p, 'utf8') : '';
    if (!c || appendBlock(c, body) !== c) at(join(relative(real(root), real(dir)), name).replace(/\\/g, '/'), 'write', p);
  }
  for (const name of agentNames) {
    const p = agents[name].settings;
    const json = readSettings(join(root, p));
    // A file setup would refuse (bad JSON or shape) is listed so the user sees it; setup then stops before writing anything.
    const bad = json === null || !validShape(json, name);
    if (chosen.has(name)) {
      if (bad) { at(p, 'write'); continue; }
      const before = JSON.stringify(json);
      installAgent(json, name);
      if (JSON.stringify(json) !== before || !existsSync(join(root, p))) at(p, 'write');
    } else if (bad) {
      if (readFileSync(join(root, p), 'utf8').includes('cto --hook ')) at(p, 'remove');
    } else if (uninstallHooks(json)) at(p, 'remove');
  }
  const g = syncGuidance(root, chosen, true, flow, true);
  const f = syncFlowSkill(root, flow, true, chosen.has('claude'));
  for (const p of [...g.written, ...f.written]) at(p, 'write');
  for (const p of [...g.removed, ...f.removed]) at(p, 'remove');
  if (flow) for (const p of Object.keys(FLOW_SKELETON)) if (!existsSync(join(root, p))) at(p, 'write');
  const ignore = join(root, '.gitignore');
  const ignoreText = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const missing = missingIgnores(root, ignoreText);
  if (missing.length && appendBlock(ignoreText, missing.join('\n') + '\n') !== ignoreText) at('.gitignore', 'write');
  const cfg = loadConfig(root);
  if (!existsSync(join(root, '.cto.json')) || cfg.flow !== flow || cfg.sprint_goal !== goal) at('.cto.json', 'write');
  return out;
}

export function setup(cwd: string, lang: Lang, opts: SetupOptions = {}): { code: number; lines: string[] } {
  const lines: string[] = [];
  let root: string;
  try { root = git(cwd, 'rev-parse', '--show-toplevel'); } catch { return { code: 1, lines: [t(lang, 'setup_not_git')] }; }
  const rel = (p: string) => relative(root, p) || p;

  // Files we will touch: chosen agents get hooks; in exact mode (and on uninstall) agents that currently have cto hooks
  // lose them. Any other agent's config is never read, so a broken unrelated file cannot block the install.
  const chosen = new Set(opts.uninstall ? [] : (opts.agents ?? []));
  const removing = opts.uninstall || opts.exact ? wiredAgents(root).filter((n) => !chosen.has(n)) : [];
  const targets = [...chosen, ...removing];
  // Validate every config file we may touch before writing anything.
  const settings = new Map<AgentName, { path: string; json: any }>();
  for (const name of targets) {
    const path = join(root, agents[name].settings);
    const json = readSettings(path);
    if (json === null || !validShape(json, name)) return { code: 1, lines: [t(lang, 'setup_bad_json', { path: rel(path) })] };
    settings.set(name, { path, json });
  }

  const dir = hooksDir(root);
  const ignorePath = join(root, '.gitignore');

  if (opts.uninstall) {
    for (const [name] of GIT_HOOKS) {
      const hookPath = join(dir, name);
      if (!existsSync(hookPath)) continue;
      const c = readFileSync(hookPath, 'utf8');
      if (!blockRe.test(c)) continue;
      const rest = removeBlock(c);
      if (!rest.trim() || rest.trim() === '#!/bin/sh') unlinkSync(hookPath);
      else writeFileSync(hookPath, rest);
      lines.push(t(lang, 'uninstall_hook', { path: rel(hookPath) }));
    }
    for (const [name, { path, json }] of settings) {
      if (!existsSync(path) || !uninstallHooks(json)) continue;
      writeOrRemove(path, json);
      lines.push(t(lang, 'uninstall_agent', { label: agents[name].label, path: rel(path) }));
    }
    if (existsSync(ignorePath)) {
      const c = readFileSync(ignorePath, 'utf8');
      if (blockRe.test(c)) {
        const rest = removeBlock(c);
        if (rest.trim()) writeFileSync(ignorePath, rest);
        else unlinkSync(ignorePath);
        lines.push(t(lang, 'uninstall_gitignore'));
      }
    }
    for (const p of [...syncGuidance(root, new Set(), true).removed, ...syncFlowSkill(root, false).removed]) lines.push(t(lang, 'uninstall_skill', { path: p }));
    lines.push(t(lang, 'uninstall_done'));
    return { code: 0, lines };
  }

  // 1. git pre-commit and pre-push: cover every agent and humans alike. Append a marked block, never overwrite.
  for (const [name, body] of GIT_HOOKS) {
    const hookPath = join(dir, name);
    if (existsSync(hookPath)) {
      const c = readFileSync(hookPath, 'utf8');
      writeFileSync(hookPath, appendBlock(c, body));
      if (hasEarlyExit(c)) lines.push(t(lang, 'setup_hook_exit', { path: rel(hookPath) }));
    } else {
      mkdirSync(dirname(hookPath), { recursive: true });
      writeFileSync(hookPath, '#!/bin/sh\n' + block(body));
    }
    chmodSync(hookPath, 0o755);
    lines.push(t(lang, 'setup_hook', { name, path: rel(hookPath) }));
  }

  // 2. Agent hooks: merge, keep everything else. Agents not chosen lose their cto hooks only.
  for (const [name, { path, json }] of settings) {
    if (!chosen.has(name)) {
      if (existsSync(path) && uninstallHooks(json)) {
        writeOrRemove(path, json);
        lines.push(t(lang, 'uninstall_agent', { label: agents[name].label, path: rel(path) }));
      }
      continue;
    }
    installAgent(json, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
    lines.push(t(lang, 'setup_agent', { label: agents[name].label, path: rel(path) }));
    const note = agents[name].note;
    if (note) lines.push(t(lang, note));
  }

  // 2b. The cto skill (rules for the agent), for the chosen agents; the flow skill and docs skeleton when the flow is on.
  const savedFlow = loadConfig(root).flow;
  const flow = opts.flow ?? savedFlow;
  const skills = syncGuidance(root, chosen, !!opts.exact, flow);
  // Not exact: an agent left unpicked keeps its cto wiring, so Claude Code keeps /cto-jev too.
  const claude = chosen.has('claude') || (!opts.exact && wiredAgents(root).includes('claude'));
  const flowSkill = syncFlowSkill(root, flow, false, claude);
  for (const p of [...skills.written, ...flowSkill.written]) lines.push(t(lang, 'setup_skill', { path: p }));
  const hidden = ignoredByGit(root, [...guidancePaths(chosen), ...(flow ? [FLOW_SKILL_PATH] : []), ...(flow && claude ? [FLOW_COMMAND_PATH] : [])]);
  // Advise git add -f: a .gitignore negation cannot re-include a file whose parent folder is excluded (git rule).
  if (hidden.length) lines.push(t(lang, 'setup_ignored', { list: hidden.join(', '), cmd: `git add -f ${hidden.join(' ')}` }));
  for (const p of [...skills.removed, ...flowSkill.removed]) lines.push(t(lang, 'uninstall_skill', { path: p }));
  if (flow) {
    // Docs are the user's: never overwritten here, never deleted when the flow is turned off.
    const created = Object.entries(FLOW_SKELETON).filter(([p]) => !existsSync(join(root, p)));
    for (const [p, body] of created) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
    if (created.length) lines.push(t(lang, 'setup_flow_docs', { list: created.map(([p]) => p).join(', ') }));
  }

  // 3. .gitignore block.
  // Only the entries the file lacks outside our block; a repo that already ignores them all gets no block.
  const ignoreText = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const missing = missingIgnores(root, ignoreText);
  if (missing.length) {
    writeFileSync(ignorePath, appendBlock(ignoreText, missing.join('\n') + '\n'));
    lines.push(t(lang, 'setup_gitignore'));
  }

  // 4. Shared config, created once and never removed.
  const cfgPath = join(root, '.cto.json');
  let goal = '';
  if (!existsSync(cfgPath)) {
    // Thresholds are left out on purpose: the package defaults apply and improve with each release. Add only overrides.
    writeFileSync(cfgPath, JSON.stringify({ sprint_goal: '', thresholds: {} }, null, 2) + '\n');
    lines.push(t(lang, 'setup_config'));
  } else {
    try { goal = JSON.parse(readFileSync(cfgPath, 'utf8')).sprint_goal ?? ''; } catch { /* keep empty */ }
  }
  if (flow !== savedFlow && !patchConfig(root, { flow })) lines.push(t(lang, 'setup_flow_bad_json'));
  if (!String(goal).trim() && !flow) lines.push(t(lang, 'setup_sprint')); // with the flow on, drift is judged against SPEC Constraints
  lines.push(...conflictLines(root, [...chosen], lang));
  lines.push(t(lang, 'setup_done'));
  // The first-run interview is still owed only while a top-level doc is missing or holds an unknown field.
  const owed = ['PRODUCT.md', 'ARCHITECTURE.md'].some((f) => { try { return /\bunknown\b/.test(readFileSync(join(root, FLOW_DIR, f), 'utf8')); } catch { return true; } });
  if (flow && !savedFlow && owed) lines.push(t(lang, 'setup_flow_next', { claude: claude ? 1 : 0 }));
  // PRODUCT.md holds pricing and business rules: a docs site must not publish docs/cto_jev/. Warn only; config is the user's.
  const publisher = flow ? docsPublisher(root) : undefined;
  if (publisher) lines.push(t(lang, 'setup_flow_publish', { file: publisher }));
  return { code: 0, lines };
}

const PUBLISHER_FILES = ['mkdocs.yml', 'mkdocs.yaml', 'docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs', 'docusaurus.config.cjs', '_config.yml', 'book.toml'];

/** Config file of a documentation site generator at the repo root (relative path), or undefined. */
export function docsPublisher(root: string): string | undefined {
  const file = PUBLISHER_FILES.find((f) => existsSync(join(root, f)));
  if (file) return file;
  const vp = join(root, 'docs/.vitepress');
  const cfg = existsSync(vp) ? readdirSync(vp).find((f) => /^config\.\w+$/.test(f)) : undefined;
  return cfg && `docs/.vitepress/${cfg}`;
}

/** Notes about other hooks, contrary guidance and duplicate skills; empty when there is nothing to say. */
export function conflictLines(root: string, wired: AgentName[], lang: Lang, home?: string): string[] {
  const found = findConflicts(root, wired, home);
  if (!found.length) return [];
  return [t(lang, 'conflicts_head'), ...found.map((c) => `  -- ${t(lang, `conflict_${c.kind}`, { where: c.where, detail: c.detail })}`)];
}

/** Hook phases a wired agent should have but its config lacks (installed by an older version). */
export function missingHooks(root: string): string[] {
  const missing: string[] = [];
  for (const n of wiredAgents(root)) {
    const text = readFileSync(join(root, agents[n].settings), 'utf8');
    for (const phase of PHASES) {
      if (agents[n][phase] && !text.includes(hookCommand(n, phase))) missing.push(hookCommand(n, phase));
    }
  }
  return missing;
}

/**
 * Paths git would ignore. cto's rules are meant to be committed so every teammate's agent follows them; a repo
 * .gitignore that excludes them (often a broad rule like .agents/skills/) silently keeps them on one machine.
 */
export function ignoredByGit(root: string, paths: string[]): string[] {
  return paths.filter((p) => {
    try { execFileSync('git', ['check-ignore', '-q', p], { cwd: root, stdio: 'ignore' }); return true; } catch { return false; }
  });
}

/** Agents whose config in this repo currently calls cto. */
export function wiredAgents(root: string): AgentName[] {
  return agentNames.filter((n) => {
    const p = join(root, agents[n].settings);
    return existsSync(p) && readFileSync(p, 'utf8').includes('cto --hook ');
  });
}

/** cto was set up here: an agent is wired, or only the git hooks are (setup with no agents). */
export function isSetUp(root: string): boolean {
  if (wiredAgents(root).length) return true;
  // A global core.hooksPath is shared by every repo; .cto.json (always written by setup) says it was this one.
  if (!existsSync(join(root, '.cto.json'))) return false;
  // .husky too: in a fresh clone the committed .husky/ hooks carry the block before husky has set core.hooksPath.
  return [hooksDir(root), join(root, '.husky')].some((dir) =>
    GIT_HOOKS.some(([name]) => existsSync(join(dir, name)) && blockRe.test(readFileSync(join(dir, name), 'utf8'))));
}

/** Repo root, or undefined outside a git repo. */
export function gitRoot(cwd: string): string | undefined {
  try { return git(cwd, 'rev-parse', '--show-toplevel'); } catch { return undefined; }
}

/**
 * Merge keys into .cto.json, keeping everything else in the file.
 * Refuses (returns false) when the file exists but is not a JSON object: never overwrite someone's thresholds.
 */
function patchConfig(root: string, patch: Record<string, unknown>): boolean {
  const path = join(root, '.cto.json');
  let cfg: any = { sprint_goal: '', thresholds: {} };
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  }
  writeFileSync(path, JSON.stringify({ ...cfg, ...patch }, null, 2) + '\n');
  return true;
}

/** Set sprint_goal in .cto.json, keeping everything else in the file. */
export function setSprintGoal(root: string, goal: string): boolean {
  return patchConfig(root, { sprint_goal: goal });
}
