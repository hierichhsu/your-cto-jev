import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { PHASES, agentNames, agents, hookCommand, type AgentName } from './agents.js';
import { t, type Lang } from './i18n.js';
import { loadConfig } from './brain.js';
import { FLOW_SKILL_PATH, guidancePaths, syncFlowSkill, syncGuidance } from './skill.js';
import { findConflicts } from './conflicts.js';

const START = '# >>> YOUR CTO JEV START >>>';
const END = '# <<< YOUR CTO JEV END <<<';
// Keep the block minimal: all logic (including the git diff call) lives in the package, so npm update upgrades every repo.
const HOOK_BODY = 'if command -v cto >/dev/null 2>&1; then\n  cto --hook git-commit || exit 1\nfi\n';
// pre-push gets git's ref lines on stdin; they are passed straight through.
const PUSH_BODY = 'if command -v cto >/dev/null 2>&1; then\n  cto --hook git-push || exit 1\nfi\n';
export const GIT_HOOKS: [string, string][] = [['pre-commit', HOOK_BODY], ['pre-push', PUSH_BODY]];
const IGNORE_BODY = '.cto-brain.json\n.cto-brain.json.*tmp\ndebug_stdin.json\n';
const OURS = (cmd?: unknown) => typeof cmd === 'string' && cmd.startsWith('cto --hook ');

const block = (body: string) => `${START}\n${body}${END}\n`;
const blockRe = /\n?# >>> YOUR CTO JEV START >>>\n[\s\S]*?# <<< YOUR CTO JEV END <<<\n?/;

export function removeBlock(content: string): string {
  return content.replace(blockRe, (m) => (m.startsWith('\n') && m.endsWith('\n') ? '\n' : ''));
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
// read (docs/cto_jev/features/cto-flow/SPEC.md); `unknown` is what the agent's first run fills in.
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
  const flowSkill = syncFlowSkill(root, flow);
  for (const p of [...skills.written, ...flowSkill.written]) lines.push(t(lang, 'setup_skill', { path: p }));
  const hidden = ignoredByGit(root, [...guidancePaths(chosen), ...(flow ? [FLOW_SKILL_PATH] : [])]);
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
  const have = new Set(removeBlock(ignoreText).split(/\r?\n/).map((l) => l.trim()));
  const missing = IGNORE_BODY.split('\n').filter((l) => l && !have.has(l));
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
  if (!String(goal).trim()) lines.push(t(lang, 'setup_sprint'));
  lines.push(...conflictLines(root, [...chosen], lang));
  lines.push(t(lang, 'setup_done'));
  if (flow && !savedFlow) lines.push(t(lang, 'setup_flow_next'));
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
