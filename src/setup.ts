import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { PHASES, agentNames, agents, hookCommand, promptOutput, type AgentName, type HookOutput } from './agents.js';
import { t, type Lang } from './i18n.js';
import { loadConfig, modelsPrefs, type ModelsPrefs } from './brain.js';
import { MODEL_KEYS, MSG, advisorOf, agentsDir, applyModels, clearScope, driftCheck, fableReminder, isOurs, targetPath, userSettingsPath, writeJsonIfUnchanged, type DriftResult, type ModelsOpts } from './models.js';
import { AGENT_FILES, FLOW_COMMAND_PATH, FLOW_SKILL_PATH, SKILL_MARK, guidancePaths, syncFlowSkill, syncGuidance } from './skill.js';
import { findConflicts } from './conflicts.js';
import { FLOW_DIR } from './flow.js';

const START = '# >>> YOUR CTO JEV START >>>';
const END = '# <<< YOUR CTO JEV END <<<';
// Keep the block minimal: all logic (including the git diff call) lives in the package, so npm update upgrades every repo.
// A hook's result is its last command's. pre-push's block is appended, so a failing line above it would decide the result:
// KEEP_FAIL passes that status on. pre-commit's block goes first, and a failing setup line above it (nvm's `[ -s … ] && …`)
// must not decide the commit, so it has no KEEP_FAIL.
const KEEP_FAIL = 's=$?; [ $s -eq 0 ] || exit $s\n';
const HOOK_BODY = 'if command -v cto >/dev/null 2>&1; then\n  cto --hook git-commit || exit 1\nfi\n';
// pre-push gets git's ref lines on stdin; they are passed straight through.
const PUSH_BODY = KEEP_FAIL + 'if command -v cto >/dev/null 2>&1; then\n  cto --hook git-push || exit 1\nfi\n';
export const GIT_HOOKS: [string, string][] = [['pre-commit', HOOK_BODY], ['pre-push', PUSH_BODY]];
// settings.local.json is Claude Code's per-machine file; often only the global gitignore covers it, which linters like biome never read.
const IGNORE_BODY = '.cto-brain.json\n.cto-brain.json.*tmp\n.cto-brain.json.lock*\ndebug_stdin.json\n.claude/settings.local.json\n';
const OURS = (cmd?: unknown) => typeof cmd === 'string' && cmd.startsWith('cto --hook ');

const block = (body: string) => `${START}\n${body}${END}\n`;
// \r?\n: an editor or core.autocrlf may have turned the file CRLF; the block must still be found, or setup appends a second one.
const blockRe = /(\r?\n)?# >>> YOUR CTO JEV START >>>\r?\n[\s\S]*?# <<< YOUR CTO JEV END <<<(\r?\n)?/;

// The bytes alone cannot tell our newline from the user's, so a block that had to end their last line says so.
const ADDED_EOL = '# cto ended the line above';

export function removeBlock(content: string): string {
  // The newline before the block is the user's unless an appended block (ADDED_EOL, at the end of the file) added it: keep it,
  // in their line ending, even when an editor stripped the newline after END.
  return content.replace(blockRe, (m, lead: string | undefined, _trail: string | undefined, offset: number, whole: string) =>
    m.includes(ADDED_EOL) && offset + m.length === whole.length ? '' : lead ?? '');
}

export function appendBlock(content: string, body: string): string {
  const base = removeBlock(content);
  return base && !base.endsWith('\n') ? `${base}\n${block(`${ADDED_EOL}\n${body}`)}` : base + block(body);
}

/**
 * A hook file: cto's block goes first (after a shebang), before the user's commands, so a formatter or linter already in
 * the file cannot run ahead of the gate. The user's content is kept as it is.
 */
/** Places the block with `body` in `base`: after a shebang and the leading setup lines, before the rest. */
function placeText(base: string, body: string): string {
  const shebang = /^#![^\n]*\n/.exec(base)?.[0] ?? '';
  let rest = base.slice(shebang.length);
  // Leading lines that only set variables, export, source, or change PATH stay above the block: the block runs after them.
  let head = '';
  for (let m = /^[^\n]*(?:\n|$)/.exec(rest); m && m[0] && SETUP_LINE.test(m[0]); m = /^[^\n]*(?:\n|$)/.exec(rest)) {
    head += m[0];
    rest = rest.slice(m[0].length);
  }
  // A last setup line with no newline gets one from cto: the block marks it, so uninstall takes it back.
  const eol = head !== '' && !head.endsWith('\n');
  if (eol) head += '\n';
  return shebang + head + block(eol ? `${ADDED_EOL}\n${body}` : body) + rest;
}
export function placeBlock(content: string, body: string): string {
  return placeText(removeBlock(content), body);
}
/** A line that only sets a variable (bare, or quoted value), exports one, or is a blank or comment line. A command after it is not setup. */
const ASSIGN = '[A-Za-z_]\\w*=(?:"[^"]*"|\'[^\']*\'|\\S*)';
// eval "$(direnv hook …)" and nvm's `[ -s … ] && \. …` are one-line environment setup too.
const SETUP_LINE = new RegExp(`^\\s*(?:export\\s+[A-Za-z_]\\w*\\s*$|(?:export\\s+)?${ASSIGN}\\s*$|source\\s|\\.\\s|eval\\s+["']?\\$\\(|\\[[^\\]]*\\]\\s*&&\\s*(?:\\\\?\\.|source)\\s|#|$)`);
/** True when a line above the block (after the shebang) is not setup: moving the block would move those lines too. */
export function userLinesAbove(content: string): boolean {
  const at = content.indexOf(START);
  if (at < 0) return false;
  return content.slice(0, at).replace(/^#![^\n]*\n/, '').split('\n').some((l) => !SETUP_LINE.test(l + '\n'));
}
/** An exit 0 outside our block means an appended block never runs (pre-push, where the block is appended). */
export function hasEarlyExit(content: string): boolean {
  return /^\s*exit\s+0\b/m.test(removeBlock(content));
}
/**
 * The block for a git hook: pre-commit gets cto's block first, so a formatter or linter the user wrote runs after the
 * gate. pre-push keeps cto last: git-lfs and others read the ref lines on stdin, and cto's block must not run before them.
 */
export function placeFor(name: string, content: string, body: string): string {
  return name === 'pre-commit' ? placeBlock(content, body) : appendBlock(content, body);
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * IGNORE_BODY entries the repo's own .gitignore does not already cover outside our block: an exact line, or any rule there
 * git says matches (`.claude/` covers `.claude/settings.local.json`). Global excludesFile and .git/info/exclude do not
 * count; linters like biome never read them. shortcut: a rule in a nested .gitignore does not count either.
 */
export function missingIgnores(text: string): string[] {
  const outside = removeBlock(text);
  const have = new Set(outside.split(/\r?\n/).map((l) => l.trim()));
  const entries = IGNORE_BODY.split('\n').filter(Boolean);
  // Ask about a real file name: brain.ts writes `.cto-brain.json.<pid>.tmp`, which a user's `*.tmp` covers; a long odd pid
  // so a rule like `*.1.tmp`, which matches one pid only, does not pass for covering them all.
  const sample = (e: string) => e.replace('*', '9876543210.');
  let out: string | undefined;
  // check-ignore names only the last matching rule, which would be our block's own line, so ask a scratch repo whose
  // .gitignore is the user's lines alone; it also honours a later `!` rule. Exit 1 means nothing matched.
  let tmp: string | undefined; // an unwritable tmp dir falls back below instead of crashing setup
  try {
    tmp = mkdtempSync(join(tmpdir(), 'cto-ignore-'));
    git(tmp, 'init', '-q');
    writeFileSync(join(tmp, '.gitignore'), outside);
    out = git(tmp, 'check-ignore', '--no-index', '-v', ...entries.map(sample));
  } catch (e) { if ((e as { status?: number }).status === 1) out = ''; } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
  // git failed: fall back to exact lines.
  if (out === undefined) return entries.filter((l) => !have.has(l));
  const covered = out.split('\n').map((l) => /^\.gitignore:\d+:([^\t]*)\t(.*)$/.exec(l))
    .filter((m) => m && !m[1].startsWith('!')).map((m) => m![2]);
  return entries.filter((e) => !covered.includes(sample(e)));
}

/** Hooks dir honoring core.hooksPath (via --git-path). Husky's generated .husky/_ is replaced on install, so use .husky. */
export function hooksDir(root: string): string {
  const dir = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks');
  if (basename(dir) === '_' && basename(dirname(dir)) === '.husky') return dirname(dir);
  // Fresh husky clone: core.hooksPath is set only once husky's prepare runs, but the committed .husky/ hooks already carry the block.
  let hooksPath = true;
  try { git(root, 'config', '--get', 'core.hooksPath'); } catch { hooksPath = false; }
  const husky = join(root, '.husky');
  const huskyHasBlock = GIT_HOOKS.some(([name]) => existsSync(join(husky, name)) && blockRe.test(readFileSync(join(husky, name), 'utf8')));
  return !hooksPath && huskyHasBlock ? husky : dir;
}

/** Agents whose home config dir exists. */
export function detectAgents(home = homedir()): AgentName[] {
  return agentNames.filter((n) => existsSync(join(home, agents[n].homeDir)));
}

export function readSettings(path: string): any | null {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
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
    if (!spec || spec.user) continue;
    const command = hookCommand(name, phase);
    const arr: any[] = (settings.hooks[spec.event] ??= []);
    if (a.style === 'cursor') {
      if (!arr.some((h) => h?.command === command)) arr.push({ command });
    } else {
      const mine = arr.find((m) => m?.hooks?.some((h: any) => h?.command === command));
      if (!mine) arr.push({ ...(spec.matcher && { matcher: spec.matcher }), hooks: [{ type: 'command', command }] });
      else if (phase === 'guard' && spec.matcher) catchUpGuard(arr, spec.matcher, command);
    }
  }
}

/** An older install's guard matcher (before AskUserQuestion, before Agent) catches up. Returns whether it changed. */
function catchUpGuard(arr: any[], matcher: string, command: string): boolean {
  const mine = arr.find((m) => m?.hooks?.some((h: any) => h?.command === command));
  if (!mine || mine.matcher === matcher) return false;
  if (mine.hooks.length === 1) mine.matcher = matcher;
  else { // shared with the user's own hooks: leave theirs on the old matcher, move ours to its own entry
    mine.hooks = mine.hooks.filter((h: any) => h?.command !== command);
    arr.push({ matcher, hooks: [{ type: 'command', command }] });
  }
  return true;
}

/**
 * SessionStart: what the review gate needs from a wired Claude Code project's settings, nothing more. The guard
 * entry's matcher catches up (it must see Agent) and the SubagentStop hook is added when absent. Other cto hooks the
 * user took out stay out; `setup --refresh` re-adds everything. Git hooks, .gitignore and the user's entries are not touched.
 * Returns the settings path when it changed (dryRun: would change); undefined when current, unwired or not valid JSON.
 */
export function refreshClaudeHooks(root: string, dryRun: boolean): string | undefined {
  if (!wiredAgents(root).includes('claude')) return undefined;
  const a = agents.claude, rel = a.settings;
  const text = readFileSync(join(root, rel), 'utf8');
  let json: any;
  try { json = JSON.parse(text); } catch { return undefined; }
  if (!validShape(json, 'claude')) return undefined;
  json.hooks ??= {};
  const guardArr = json.hooks[a.guard!.event];
  let changed = Array.isArray(guardArr) && catchUpGuard(guardArr, a.guard!.matcher!, hookCommand('claude', 'guard'));
  const agentCmd = hookCommand('claude', 'agent');
  if (!JSON.stringify(json.hooks).includes(agentCmd)) {
    (json.hooks[a.agent!.event] ??= []).push({ hooks: [{ type: 'command', command: agentCmd }] });
    changed = true;
  }
  if (!changed) return undefined;
  return dryRun || writeJsonIfUnchanged(join(root, rel), text, json) ? rel : undefined;
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
  /** Write (or on uninstall clear) the Claude Code model split and the user-level hook. Unset: ~/.claude is never touched. */
  models?: ModelsOpts;
  /** The menu moves the split to another scope right after setup (applyModelsChange): do not write the old scope first. */
  modelsWriteLater?: boolean;
}

// docs/cto_jev/ skeleton, created only for files that do not exist. Headings are the fixed field names the flow checks
// read (FLOW_SKILL_TEXT in skill.ts); `unknown` is what the agent's first run fills in.
const fields = (names: string[]) => names.map((n) => `## ${n}\n\nunknown\n`).join('\n');
export const FLOW_SKELETON: Record<string, string> = {
  'docs/cto_jev/PRODUCT.md': `# PRODUCT\n\nStatus: draft\n\n${fields(['一句話', '使用者角色', '怎麼賺錢', '方案與限制', '不做的事', '設計約束'])}`,
  'docs/cto_jev/ARCHITECTURE.md': `# ARCHITECTURE\n\nStatus: draft\n\n${fields(['技術棧', '目錄地圖', '外部服務與資料', '驗證指令', '不變的原則'])}`,
  'docs/cto_jev/features/platform/CONCEPT.md': '# platform\n\nStatus: approved\n\n## 目的\n\nInfrastructure: CI, build, deploy, dependencies\n\n## 動機\n\n## 商業規則\n\n## 不做的事\n',
  'docs/cto_jev/features/platform/SPEC.md': '# platform SPEC\n\n## Interface\n\n## Constraints\n\n## Internals\n',
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
export function planSetup(root: string, chosenAgents: AgentName[], flow: boolean, goal: string, models?: ModelsPlan): FileChange[] {
  const out: FileChange[] = [];
  const at = (p: string, change: 'write' | 'remove', abs = join(root, p)) => {
    if (!out.some((f) => f.path === p)) out.push({ path: p, change: change === 'remove' ? 'remove' : existsSync(abs) ? 'update' : 'new' });
  };
  const chosen = new Set(chosenAgents);
  // git reports the hooks dir with long names; a Windows temp root may be 8.3 (C:\Users\JOHNDO~1). Compare real paths.
  const real = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };
  const dir = hooksDir(root);
  for (const [name, body] of GIT_HOOKS) {
    const p = join(dir, name);
    const c = existsSync(p) ? readFileSync(p, 'utf8') : '';
    if (!c || placeFor(name, c, body) !== c) at(join(relative(real(root), real(dir)), name).replace(/\\/g, '/'), 'write', p);
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
  const missing = missingIgnores(ignoreText);
  if (missing.length && appendBlock(ignoreText, missing.join('\n') + '\n') !== ignoreText) at('.gitignore', 'write');
  const cfg = loadConfig(root);
  if (!existsSync(join(root, '.cto.json')) || cfg.flow !== flow || cfg.sprint_goal !== goal) at('.cto.json', 'write');
  if (models) planModels(root, chosen.has('claude'), wiredAgents(root).includes('claude'), models, at);
  return out;
}

/** What the model split adds to a setup plan; `write` is false when setup would leave it alone (auto-fix off, no change). */
/** `before`: the profile saved now; when the menu moves the split to another scope, the old one is cleared by its values. */
export interface ModelsPlan { prefs: ModelsPrefs; write: boolean; home?: string; before?: ModelsPrefs }

function planModels(root: string, claude: boolean, wasWired: boolean, m: ModelsPlan, at: (p: string, c: 'write' | 'remove', abs: string) => void) {
  const home = m.home ?? homedir();
  const p = m.prefs;
  const shownIn = (scope: ModelsPrefs['scope']) => (abs: string) => (scope === 'global' ? `~/${relative(home, abs).replace(/\\/g, '/')}` : relative(root, abs).replace(/\\/g, '/'));
  // What clearScope takes out of one scope (same isOurs rule): cto's key values, cto's agent files, the user hook.
  const planClear = (scope: ModelsPrefs['scope']) => {
    const shown = shownIn(scope), target = targetPath(root, scope, home), s = readSettings(target);
    const hook = scope === 'global' && Array.isArray(s?.hooks?.SessionStart) && s.hooks.SessionStart.some(hasModelsHook);
    if (isObj(s) && (hook || MODEL_KEYS.some((k) => isOurs(k, valueAt(s, k.path))))) at(shown(target), 'write', target);
    for (const n of Object.keys(AGENT_FILES)) {
      const f = join(agentsDir(root, scope, home), n);
      if (existsSync(f) && readFileSync(f, 'utf8').includes(SKILL_MARK)) at(shown(f), 'remove', f);
    }
  };
  // Unticked: only a scope-local split goes with the project; a global one stays for the other projects.
  // Unticked: a menu change to the split is not applied, so the saved scope decides.
  if (!claude) { if (wasWired && (m.before ?? p).scope === 'local') planClear('local'); return; }
  if (m.before && m.before.scope !== p.scope) planClear(m.before.scope);
  const target = targetPath(root, p.scope, home);
  const shown = shownIn(p.scope);
  const agentFile = (n: string) => join(agentsDir(root, p.scope, home), n);
  const s = readSettings(target);
  if (!m.write) return;
  const keysOff = !isObj(s) || MODEL_KEYS.some((k) => !k.ok(valueAt(s, k.path), p));
  const hookOff = p.scope === 'global' && !(Array.isArray(s?.hooks?.SessionStart) && s.hooks.SessionStart.some(hasModelsHook));
  if (keysOff || hookOff) at(shown(target), 'write', target);
  for (const [n, text] of Object.entries(AGENT_FILES)) {
    const cur = existsSync(agentFile(n)) ? readFileSync(agentFile(n), 'utf8') : undefined;
    if (cur !== text) at(shown(agentFile(n)), 'write', agentFile(n));
  }
}
const valueAt = (o: unknown, path: string[]): unknown => path.reduce<any>((x, k) => (isObj(x) ? x[k] : undefined), o);

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
    if (opts.models && removing.includes('claude')) {
      lines.push(...modelsLines(clearScope(root, modelsPrefs().scope, opts.models)));
      const h = userModelsHook(opts.models.home ?? homedir(), false);
      if (h) lines.push(`[cto] ${h}`);
    }
    lines.push(t(lang, 'uninstall_done'));
    return { code: 0, lines };
  }

  // 1. git hooks: cover every agent and humans alike. Our marked block goes before the user's commands; their content is kept.
  for (const [name, body] of GIT_HOOKS) {
    const hookPath = join(dir, name);
    if (existsSync(hookPath)) {
      const c = readFileSync(hookPath, 'utf8');
      writeFileSync(hookPath, placeFor(name, c, body));
      if (name !== 'pre-commit' && hasEarlyExit(c)) lines.push(t(lang, 'setup_hook_exit', { path: rel(hookPath) }));
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
  if (opts.models && claude && !opts.modelsWriteLater) lines.push(...writeModels(root, opts.models));
  // Claude unticked in one project: a scope-local split goes with it. A global one (keys, agent files, user hook) is
  // shared by every project and is cleared only by a full --uninstall.
  if (opts.models && removing.includes('claude') && modelsPrefs().scope === 'local') lines.push(...modelsLines(clearScope(root, modelsPrefs().scope, opts.models)));
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
  const missing = missingIgnores(ignoreText);
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
      const spec = agents[n][phase];
      if (spec && !spec.user && !text.includes(hookCommand(n, phase))) missing.push(hookCommand(n, phase));
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
  const dir = hooksDir(root);
  return GIT_HOOKS.some(([name]) => existsSync(join(dir, name)) && blockRe.test(readFileSync(join(dir, name), 'utf8')));
}

/** Repo root, or undefined outside a git repo. */
export function gitRoot(cwd: string): string | undefined {
  try { return git(cwd, 'rev-parse', '--show-toplevel'); } catch { return undefined; }
}

/**
 * Merge keys into .cto.json, keeping everything else in the file.
 * Refuses (returns false) when the file exists but is not a JSON object: never overwrite someone's thresholds.
 */
export function patchConfig(root: string, patch: Record<string, unknown>): boolean {
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

// ---------- the Claude Code model split (docs/cto_jev/features/models/SPEC.md) ----------

const MODELS_HOOK = hookCommand('claude', 'models');
const USER_SETTINGS_SHOWN = '~/.claude/settings.json';
const modelsLines = (r: DriftResult) => [...r.fixed, ...r.reported].map((l) => `[cto] ${l}`);
const hasModelsHook = (m: any) => Array.isArray(m?.hooks) && m.hooks.some((h: any) => h?.command === MODELS_HOOK);

/**
 * Add or remove the user-level `claude-models` SessionStart hook in ~/.claude/settings.json, keeping every other key.
 * Returns a line to show, or undefined when nothing changed.
 */
export function userModelsHook(home: string, on: boolean): string | undefined {
  const path = userSettingsPath(home);
  let before: string | undefined, json: any = {};
  try {
    if (existsSync(path)) { before = readFileSync(path, 'utf8'); json = JSON.parse(before); }
  } catch { json = null; }
  const arr = json?.hooks?.SessionStart;
  if (!isObj(json) || (json.hooks !== undefined && !isObj(json.hooks)) || (arr !== undefined && !Array.isArray(arr))) return MSG.badJson(USER_SETTINGS_SHOWN);
  const has = (arr ?? []).some(hasModelsHook);
  if (on === has) return undefined;
  if (on) {
    json.hooks ??= {};
    (json.hooks.SessionStart ??= []).push({ hooks: [{ type: 'command', command: MODELS_HOOK }] });
  } else {
    const kept = arr.flatMap((m: any) => {
      if (!hasModelsHook(m)) return [m];
      const hooks = m.hooks.filter((h: any) => h?.command !== MODELS_HOOK);
      return hooks.length ? [{ ...m, hooks }] : [];
    });
    if (kept.length) json.hooks.SessionStart = kept;
    else delete json.hooks.SessionStart;
    if (!Object.keys(json.hooks).length) delete json.hooks;
  }
  if (!writeJsonIfUnchanged(path, before, json)) return MSG.notWritten(USER_SETTINGS_SHOWN);
  return on ? MSG.wrote(USER_SETTINGS_SHOWN) : MSG.removed(MODELS_HOOK, USER_SETTINGS_SHOWN);
}

/**
 * `cto setup` with Claude Code: write the split for the profile's scope, and the user hook only for scope global.
 * Follows the profile's auto-fix: after `cto models autofix off` no setup or refresh (also run by `cto update`) touches
 * ~/.claude, in any project. With no saved profile yet the default (auto-fix on) applies, so a first install writes.
 */
function writeModels(root: string, o: ModelsOpts): string[] {
  if (!(o.autoFix ?? modelsPrefs().autoFix)) return [];
  const lines = modelsLines(driftCheck(root, { ...o, autoFix: true, files: false }));
  const h = userModelsHook(o.home ?? homedir(), modelsPrefs().scope === 'global');
  return h ? [...lines, `[cto] ${h}`] : lines;
}

/** The drift line for SessionStart, or an error line when the check threw; undefined when there is nothing to say. */
function driftLine(lang: Lang, check: () => DriftResult): string | undefined {
  try {
    const r = check();
    const items = [...r.fixed, ...r.reported];
    return items.length ? t(lang, 'models_line', { items: items.join('; ') }) : undefined;
  } catch (e) {
    return t(lang, 'models_error', { msg: (e as Error)?.message ?? String(e) });
  }
}

/**
 * Claude Code's project SessionStart: the brief goes to Claude, the drift line to both Claude and the user. Scope global
 * leaves the model settings to the user-level `claude-models` hook, so they are not checked twice.
 */
export function claudeStart(root: string, brief: string[], lang: Lang, opts: ModelsOpts = {}): HookOutput {
  const line = driftLine(lang, () => driftCheck(root, { ...opts, models: modelsPrefs().scope === 'local' }));
  return promptOutput([...brief, ...(line ? [line] : [])].join('\n'), line, 'SessionStart');
}

/** The user-level SessionStart (`claude-models`): model settings only, in any directory; silent in scope local. */
export function claudeModels(root: string, lang: Lang, opts: ModelsOpts = {}): HookOutput {
  const line = modelsPrefs().scope === 'global' ? driftLine(lang, () => driftCheck(root, { ...opts, files: false })) : undefined;
  return promptOutput(line, line, 'SessionStart');
}

/** The one save error explained in a line: brain.ts refusing to overwrite an unparsable credentials file. Others rethrow. */
export function prefsSaveError(e: unknown, lang: Lang, path: string): string {
  if (e instanceof Error && e.message.includes('is not valid JSON')) return t(lang, 'prefs_broken', { path });
  throw e;
}

/** Apply a model split chosen in the setup menu: only what changed, through the same function as `cto models`. */
export function applyModelsChange(root: string, before: ModelsPrefs, after: ModelsPrefs, opts: ModelsOpts = {}): string[] {
  const change: Partial<ModelsPrefs> = {};
  if (after.advisor !== before.advisor) change.advisor = after.advisor;
  if (after.autoFix !== before.autoFix) change.autoFix = after.autoFix;
  if (after.scope !== before.scope) change.scope = after.scope;
  return Object.keys(change).length ? applyAndHook(root, change, opts) : [];
}

function applyAndHook(root: string, change: Partial<ModelsPrefs>, opts: ModelsOpts): string[] {
  const lines = modelsLines(applyModels(root, change, opts));
  if (change.scope) { const h = userModelsHook(opts.home ?? homedir(), modelsPrefs().scope === 'global'); if (h) lines.push(`[cto] ${h}`); }
  return lines;
}

/** `cto models [advisor fable|opus | autofix on|off | scope global|local | review on|off]`. */
export function modelsCommand(root: string, args: string[], lang: Lang, opts: ModelsOpts = {}): { code: number; lines: string[] } {
  const [what, value] = args;
  const onoff = (b: boolean) => t(lang, b ? 'ui_on' : 'ui_off');
  if (!what) {
    // A dry run: nothing is written, not even the profile. An /advisor switch is shown as the next session would follow it.
    const r = driftCheck(root, { ...opts, autoFix: false, dryRun: true });
    const saved = modelsPrefs();
    const home = opts.home ?? homedir();
    // Same rule as driftCheck: /advisor writes the user settings; in scope local only a value changed since last seen counts.
    const fromUser = advisorOf(readSettings(userSettingsPath(home))?.advisorModel);
    const advisor = saved.scope === 'global' ? fromUser ?? saved.advisor
      : fromUser && fromUser !== saved.seenUserAdvisor ? fromUser : saved.advisor;
    const p = { ...saved, advisor };
    const items = [...r.fixed, ...r.reported];
    const fable = fableReminder(p);
    return {
      code: 0,
      lines: [
        t(lang, 'models_split', { advisor: p.advisor }),
        t(lang, 'models_scope', { scope: t(lang, `models_scope_${p.scope}`), file: p.scope === 'global' ? USER_SETTINGS_SHOWN : '.claude/settings.local.json' }),
        t(lang, 'models_autofix', { state: onoff(p.autoFix) }),
        t(lang, 'models_review', { state: onoff(loadConfig(root).review_gate) }),
        ...(items.length ? [t(lang, 'models_drift_head'), ...items.map((i) => `  ${i}`)] : [t(lang, 'models_no_drift')]),
        ...(fable ? [fable] : []),
      ],
    };
  }
  if (what === 'review' && (value === 'on' || value === 'off')) {
    if (!existsSync(join(root, '.cto.json'))) return { code: 1, lines: [t(lang, 'models_no_config')] };
    if (!patchConfig(root, { review_gate: value === 'on' })) return { code: 1, lines: [t(lang, 'models_bad_json', { file: '.cto.json' })] };
    return { code: 0, lines: [t(lang, 'models_set', { what: 'review_gate', value })] };
  }
  const change: Partial<ModelsPrefs> | undefined =
    what === 'advisor' && (value === 'fable' || value === 'opus') ? { advisor: value }
    : what === 'autofix' && (value === 'on' || value === 'off') ? { autoFix: value === 'on' }
    : what === 'scope' && (value === 'global' || value === 'local') ? { scope: value }
    : undefined;
  if (!change) return { code: 1, lines: [t(lang, 'models_usage')] };
  const lines = applyAndHook(root, change, opts);
  const p = modelsPrefs();
  // The profile did not take the change (the prefs file is broken): the lines already say why.
  if (!Object.entries(change).every(([k, v]) => p[k as keyof ModelsPrefs] === v)) return { code: 1, lines };
  lines.push(t(lang, 'models_set', { what, value }));
  if (change.advisor === 'fable') lines.push(MSG.fable);
  return { code: 0, lines };
}
