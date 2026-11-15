import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_MODELS, loadConfig, loadPrefs, modelsPrefs, savePrefs, type ModelsPrefs } from './brain.js';
import { appendBlock, isObj, missingIgnores, readSettings, refreshClaudeHooks, wiredAgents } from './setup.js';
import { AGENT_FILES, FLOW_COMMAND_PATH, FLOW_SKILL_PATH, SKILL_MARK, SKILL_PATH, fileVersion, syncFlowSkill, syncGuidance, tooNew } from './skill.js';
import { currentVersion } from './update.js';
import { t, type Lang } from './i18n.js';

// The model split for Claude Code (docs/cto_jev/features/models/SPEC.md): Sonnet does the work, Fable or Opus advises,
// Haiku runs sub-agents, an Opus agent reviews. cto keeps the settings in line and says what it fixed.

// Every user-visible item in one place; the text is in i18n.ts. English unless the CLI sets the language (tests stay English).
let lang: Lang = 'en';
export const setModelsLang = (l: Lang) => { lang = l; };
const unset = (v: string | undefined) => v ?? t(lang, 'models_unset');
// An unfixed item is reported in two cases: auto-fix is off, or `cto models` only looked. The hint follows the profile.
const hint = () => t(lang, modelsPrefs().autoFix ? 'models_hint_on' : 'models_hint_off');
export const MSG = {
  fixed: (key: string, from: string | undefined, to: string) => t(lang, 'models_fixed', { key, from: unset(from), to }),
  drift: (key: string, from: string | undefined, to: string) => t(lang, 'models_drift', { key, from: unset(from), to, hint: hint() }),
  removed: (key: string, file: string) => t(lang, 'models_removed', { key, file }),
  localOverride: (key: string, file: string) => t(lang, 'models_local_override', { key, file, hint: hint() }),
  shared: (key: string, file: string) => t(lang, 'models_shared', { key, file }),
  badJson: (file: string) => t(lang, 'models_bad_json', { file }),
  unreadable: (file: string) => t(lang, 'models_unreadable', { file }),
  badShape: (file: string) => t(lang, 'models_bad_shape', { file }),
  prefsBroken: (msg: string) => t(lang, 'models_prefs_broken', { msg }),
  managed: (key: string, want: string) => t(lang, 'models_managed', { key, want }),
  envSet: (value: string, where: 'the shell environment' | 'managed settings') =>
    t(lang, 'models_env_set', { value, where: t(lang, where === 'managed settings' ? 'models_where_managed' : 'models_where_shell') }),
  conflict: (file: string) => t(lang, 'models_conflict', { file }),
  tooOld: (file: string, fileVer: string) => t(lang, 'models_too_old', { current: currentVersion(), file, fileVer }),
  wrote: (file: string) => t(lang, 'models_wrote', { file }),
  deleted: (file: string) => t(lang, 'models_deleted', { file }),
  stale: (file: string) => t(lang, 'models_stale', { file, hint: hint() }),
  hooksRestart: (file: string) => t(lang, 'models_hooks_restart', { file }),
  hooksPending: (file: string) => t(lang, 'models_hooks_pending', { file }),
  notWritten: (file: string) => t(lang, 'models_not_written', { file }),
  get fable() { return t(lang, 'models_fable'); },
};

/** Shown by `cto models` and the setup menu when the advisor is Fable; never at SessionStart (noise). */
export const fableReminder = (p: ModelsPrefs = modelsPrefs()): string | undefined => (p.advisor === 'fable' ? MSG.fable : undefined);

// ---------- model matchers (case-insensitive) ----------

export const isMainModel = (v: unknown): boolean => typeof v === 'string' && /^(sonnet|claude-sonnet-[\w.-]+)(\[1m\])?$/i.test(v);
export const isSubagentModel = (v: unknown): boolean => typeof v === 'string' && (/^haiku$/i.test(v) || /^claude-haiku-[\w.-]+$/i.test(v));
/** fable or opus (Opus 5 and up; the bare alias counts), anything else undefined. */
export function advisorOf(v: unknown): 'fable' | 'opus' | undefined {
  if (typeof v !== 'string') return undefined;
  if (/^(fable|claude-fable-[\w.-]+)$/i.test(v)) return 'fable';
  const m = /^(opus|claude-opus-(\d+)[\w.-]*)$/i.exec(v);
  return m && (m[2] === undefined || Number(m[2]) >= 5) ? 'opus' : undefined;
}

// ---------- the three keys and where they go ----------

type Key = { label: string; path: string[]; ok: (v: unknown, p: ModelsPrefs) => boolean; want: (p: ModelsPrefs) => string };
export const MODEL_KEYS: Key[] = [
  { label: 'model', path: ['model'], ok: isMainModel, want: () => 'sonnet' },
  { label: 'advisorModel', path: ['advisorModel'], ok: (v, p) => advisorOf(v) === p.advisor, want: (p) => p.advisor },
  // Never CLAUDE_CODE_SUBAGENT_MODEL_FORCE: with it Claude Code ignores cto-reviewer's own `model: opus`.
  { label: 'CLAUDE_CODE_SUBAGENT_MODEL', path: ['env', 'CLAUDE_CODE_SUBAGENT_MODEL'], ok: isSubagentModel, want: () => 'haiku' },
];

export const userSettingsPath = (home: string) => join(home, '.claude', 'settings.json');
export const targetPath = (root: string, scope: ModelsPrefs['scope'], home: string) =>
  scope === 'global' ? userSettingsPath(home) : join(root, '.claude', 'settings.local.json');
export const agentsDir = (root: string, scope: ModelsPrefs['scope'], home: string) =>
  scope === 'global' ? join(home, '.claude', 'agents') : join(root, '.claude', 'agents');

export function managedSettingsPath(platform: string = process.platform): string {
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

// ---------- settings files ----------

const getAt = (o: unknown, path: string[]): unknown => path.reduce<any>((x, k) => (isObj(x) ? x[k] : undefined), o);
/** Callers check badShape first, so every parent on the path is an object or missing. */
function setAt(o: Record<string, any>, path: string[], v: string) {
  let x = o;
  for (const k of path.slice(0, -1)) x = x[k] ??= {};
  x[path[path.length - 1]] = v;
}
/** A parent of a key that is not an object (e.g. `"env": "x"`): cto would have to replace the user's value, so it does not write. */
const badShape = (o: Record<string, any>) => MODEL_KEYS.some((k) => k.path.length > 1 && o[k.path[0]] !== undefined && !isObj(o[k.path[0]]));
function delAt(o: Record<string, any>, path: string[]) {
  const parent = path.length > 1 ? getAt(o, path.slice(0, -1)) : o;
  if (!isObj(parent)) return;
  delete parent[path[path.length - 1]];
  if (path.length > 1 && !Object.keys(parent).length) delete o[path[0]];
}
const shown = (v: unknown) => (v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v));

/**
 * A file cto may edit, with its text for the unchanged-before-write check (readSettings in setup.ts has no text).
 * `text` undefined = missing. `json` null = not a JSON object, or unreadable (`unreadable` set); never written then.
 */
function readSettingsFile(path: string): { text?: string; json: Record<string, any> | null; unreadable?: boolean } {
  if (!existsSync(path)) return { json: {} };
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return { json: null, unreadable: true }; } // EACCES, EISDIR
  try { const j = JSON.parse(text); return { text, json: isObj(j) ? j : null }; } catch { return { text, json: null }; }
}
const fileProblem = (f: { unreadable?: boolean }, file: string) => (f.unreadable ? MSG.unreadable(file) : MSG.badJson(file));

/**
 * Write `json` only if the file still holds `before` (undefined = still missing): another program that wrote in
 * between wins, and the next session fixes it. tmp + rename like saveBrain, so a reader never sees half a file.
 * A symlinked settings file (dotfiles repo) stays a symlink: the link's target is replaced, keeping its mode.
 */
export function writeJsonIfUnchanged(path: string, before: string | undefined, json: object): boolean {
  let real = path, tmp = '';
  try {
    const now = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (now !== before) return false;
    let mode: number | undefined;
    if (now !== undefined) { real = realpathSync(path); mode = statSync(real).mode & 0o777; }
    tmp = `${real}.${process.pid}.tmp`;
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n');
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, real);
    return true;
  } catch {
    if (tmp) try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    return false;
  }
}

// ---------- the drift check ----------

export interface ModelsOpts {
  home?: string; // default os.homedir()
  env?: NodeJS.ProcessEnv; // default process.env
  autoFix?: boolean; // default the profile's autoFix
  managedPath?: string; // default managedSettingsPath()
  models?: boolean; // check the model settings and agent files (default true)
  files?: boolean; // check cto's skill/command files in `root` (default true)
  adopt?: boolean; // an advisor switched with /advisor updates the profile (default true; off when cto itself just set it)
  dryRun?: boolean; // `cto models`: follow an /advisor switch in memory only, never save the profile (pair with autoFix false)
}
export interface DriftResult { fixed: string[]; reported: string[] }

const empty = (): DriftResult => ({ fixed: [], reported: [] });
// Windows paths are case-insensitive: C:\Users\Me and c:\users\me are one home.
const samePath = (a: string, b: string) => {
  const n = (x: string) => (process.platform === 'win32' ? resolve(x).toLowerCase() : resolve(x));
  return n(a) === n(b);
};
const display = (root: string, home: string) => (path: string) => {
  const inside = (base: string) => { const r = relative(base, path); return r && !r.startsWith('..') && !isAbsolute(r) ? r.replace(/\\/g, '/') : undefined; };
  const h = inside(home);
  if (!samePath(root, home)) { const r = inside(root); if (r) return r; }
  return h ? `~/${h}` : path;
};

/** The prefs file also holds API keys and is never overwritten when broken (savePrefs throws): say so, write nothing. */
function saveModels(p: ModelsPrefs, out: DriftResult): boolean {
  try { savePrefs({ ...loadPrefs(), models: p }); return true; } catch (e) { out.reported.push(MSG.prefsBroken((e as Error).message)); return false; }
}
const SUB_PATH = ['env', 'CLAUDE_CODE_SUBAGENT_MODEL'];

export function driftCheck(root: string, opts: ModelsOpts = {}): DriftResult {
  const out = empty();
  const p = modelsPrefs();
  const autoFix = opts.autoFix ?? p.autoFix;
  if (opts.models !== false) checkModels(root, opts, p, autoFix, out);
  if (opts.files !== false) checkFiles(root, autoFix, out);
  return out;
}

function checkModels(root: string, opts: ModelsOpts, profile: ModelsPrefs, autoFix: boolean, out: DriftResult) {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const show = display(root, home);
  let p = profile;
  const target = targetPath(root, p.scope, home);
  const t = readSettingsFile(target);
  const m = readSettings(opts.managedPath ?? managedSettingsPath());
  const managed: Record<string, any> = isObj(m) ? m : {}; // unreadable or broken (e.g. server-managed) = no limits
  const targetSub = getAt(t.json, SUB_PATH);

  // An advisor that is fable or opus but not the profile's was switched on purpose (/advisor): follow it. /advisor writes
  // the user settings only, so in scope local the project's own value is stale, not a switch: it is drift, fixed below.
  if (opts.adopt !== false && p.scope === 'global') {
    const a = advisorOf(getAt(t.json, ['advisorModel']));
    if (a && a !== p.advisor) p = { ...p, advisor: a };
  }
  // /advisor writes the user settings, which the local target overrides, so scope local reads them too. Only a value
  // that changed since last seen is a switch: one left behind would otherwise undo `cto models advisor` every session.
  if (p.scope === 'local') {
    const u = advisorOf(getAt(readSettings(userSettingsPath(home)), ['advisorModel']));
    if (u && u !== p.seenUserAdvisor) p = { ...p, ...(opts.adopt !== false && { advisor: u }), seenUserAdvisor: u };
  }
  if (p !== profile && !opts.dryRun && !saveModels(p, out)) return;

  const list = Array.isArray(managed.availableModels) ? managed.availableModels.filter((m: unknown) => typeof m === 'string').map((m: string) => m.toLowerCase()) : undefined;
  const allowed = (k: Key, want: string) => !list || list.includes(want) || list.some((m: string) => k.ok(m, p));

  if (t.json === null) out.reported.push(fileProblem(t, show(target)));
  else if (badShape(t.json)) out.reported.push(MSG.badShape(show(target)));
  else {
    const fixes: string[] = [];
    for (const k of MODEL_KEYS) {
      const v = getAt(t.json, k.path), want = k.want(p);
      if (k.ok(v, p)) continue;
      if (!allowed(k, want)) out.reported.push(MSG.managed(k.label, want));
      else if (!autoFix) out.reported.push(MSG.drift(k.label, shown(v), want));
      else { setAt(t.json, k.path, want); fixes.push(MSG.fixed(k.label, shown(v), want)); }
    }
    if (fixes.length && writeJsonIfUnchanged(target, t.text, t.json)) out.fixed.push(...fixes);
  }

  // Scope global: the project's own files override the user settings. The personal one is cleaned, the shared one only reported.
  if (p.scope === 'global' && !samePath(root, home)) {
    const local = join(root, '.claude', 'settings.local.json');
    const l = readSettingsFile(local);
    const set = l.json ? MODEL_KEYS.filter((k) => getAt(l.json, k.path) !== undefined) : [];
    if (l.json === null) out.reported.push(fileProblem(l, show(local)));
    else if (set.length && !autoFix) for (const k of set) out.reported.push(MSG.localOverride(k.label, show(local)));
    else if (set.length) {
      for (const k of set) delAt(l.json, k.path);
      if (writeJsonIfUnchanged(local, l.text, l.json)) for (const k of set) out.fixed.push(MSG.removed(k.label, show(local)));
    }
    const shared = join(root, '.claude', 'settings.json');
    const s = readSettings(shared);
    for (const k of MODEL_KEYS) {
      const v = getAt(s, k.path);
      if (v !== undefined && !k.ok(v, p)) out.reported.push(MSG.shared(k.label, show(shared)));
    }
  }

  // Claude Code passes the settings' own env to hooks: a value equal to the target's is that, already handled above.
  // Otherwise only a value that breaks the split is worth a word.
  const shellSub = env.CLAUDE_CODE_SUBAGENT_MODEL;
  if (shellSub && !isSubagentModel(shellSub) && shellSub !== targetSub) out.reported.push(MSG.envSet(shellSub, 'the shell environment'));
  const managedSub = getAt(managed, SUB_PATH);
  if (managedSub !== undefined && !isSubagentModel(managedSub)) out.reported.push(MSG.envSet(String(shown(managedSub)), 'managed settings'));

  syncAgentFiles(agentsDir(root, p.scope, home), autoFix, show, out);
}

function syncAgentFiles(dir: string, write: boolean, show: (p: string) => string, out: DriftResult) {
  for (const [name, text] of Object.entries(AGENT_FILES)) {
    const path = join(dir, name);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (current === text) continue;
    // Same rule as syncFlowSkill: a same-named file without the marker is the user's own.
    if (current !== undefined && !current.includes(SKILL_MARK)) out.reported.push(MSG.conflict(show(path)));
    else if (tooNew(current)) out.reported.push(MSG.tooOld(show(path), fileVersion(current!)!));
    else if (!write) out.reported.push(MSG.stale(show(path)));
    else { mkdirSync(dir, { recursive: true }); writeFileSync(path, text); out.fixed.push(MSG.wrote(show(path))); }
  }
}

const LOCK_IGNORE = '.cto-brain.json.lock*';

/** Writes `next` only if the file still reads as `was` (a missing file reads as ''): a write from another hook since then is left alone. */
export function writeTextIfUnchanged(path: string, was: string, next: string): boolean {
  const now = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (now !== was) return false;
  writeFileSync(path, next);
  return true;
}

function checkFiles(root: string, autoFix: boolean, out: DriftResult) {
  const wired = wiredAgents(root);
  if (!wired.length) return;
  // The lock file is the brain's own: a repo set up before it existed gets the entry on the next session.
  const ignore = join(root, '.gitignore');
  const ignoreText = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  // A plain text check first: missingIgnores asks git, and a lock line already in the file settles it.
  const missing = ignoreText.includes('.cto-brain.json.lock') ? [] : missingIgnores(ignoreText);
  // Only the lock line is added, never the rest of the block: into the cto block when there is one, else as a block of its own.
  const start = ignoreText.indexOf('# >>> YOUR CTO JEV START >>>');
  const end = ignoreText.indexOf('# <<< YOUR CTO JEV END <<<');
  const eol = ignoreText.includes('\r\n') ? '\r\n' : '\n';
  const next = !missing.includes(LOCK_IGNORE) ? ignoreText
    : start >= 0 && end > start ? ignoreText.slice(0, end) + LOCK_IGNORE + eol + ignoreText.slice(end)
    : appendBlock(ignoreText, LOCK_IGNORE + '\n');
  if (next !== ignoreText) {
    if (!autoFix) out.reported.push(MSG.stale('.gitignore'));
    else if (writeTextIfUnchanged(ignore, ignoreText, next)) out.fixed.push(MSG.wrote('.gitignore'));
  }
  const flow = loadConfig(root).flow;
  const g = syncGuidance(root, new Set(wired), false, flow, !autoFix);
  const f = syncFlowSkill(root, flow, !autoFix, wired.includes('claude'));
  const hooks = refreshClaudeHooks(root, !autoFix);
  for (const rel of [...g.written, ...f.written]) (autoFix ? out.fixed.push(MSG.wrote(rel)) : out.reported.push(MSG.stale(rel)));
  // Claude Code loads its hooks at session start: the entries just added take effect only after a restart.
  // Dry run (autofix off): nothing was written, so the line says what to do instead of that it was.
  if (hooks) (autoFix ? out.fixed.push(MSG.hooksRestart(hooks)) : out.reported.push(MSG.hooksPending(hooks)));
  for (const rel of [SKILL_PATH, FLOW_SKILL_PATH, FLOW_COMMAND_PATH]) {
    const path = join(root, rel);
    const text = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (tooNew(text)) out.reported.push(MSG.tooOld(rel, fileVersion(text!)!));
  }
}

// ---------- changing the split ----------

/**
 * A value cto wrote, so clearing a scope may remove it: model sonnet, sub-agents haiku, and any fable or opus advisor
 * (whichever one the profile holds now, or one switched with /advisor; the same rule switchScope carries over).
 */
export const isOurs = (k: Key, v: unknown): boolean =>
  k.label === 'advisorModel' ? advisorOf(v) !== undefined : v === k.want(DEFAULT_MODELS);

/**
 * Take the split out of one scope: the three keys (only where they still hold the profile's values) and cto's agent
 * files there. Used when switching scope and when cto is removed.
 */
export function clearScope(root: string, scope: ModelsPrefs['scope'], opts: ModelsOpts = {}): DriftResult {
  const out = empty();
  const home = opts.home ?? homedir();
  const show = display(root, home);
  const path = targetPath(root, scope, home);
  const t = readSettingsFile(path);
  if (t.json === null) out.reported.push(fileProblem(t, show(path)));
  else {
    const mine = MODEL_KEYS.filter((k) => isOurs(k, getAt(t.json, k.path)));
    for (const k of mine) delAt(t.json, k.path);
    if (mine.length && writeJsonIfUnchanged(path, t.text, t.json)) for (const k of mine) out.fixed.push(MSG.removed(k.label, show(path)));
  }
  for (const name of Object.keys(AGENT_FILES)) {
    const file = join(agentsDir(root, scope, home), name);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (text === undefined || !text.includes(SKILL_MARK)) continue;
    if (tooNew(text)) { out.reported.push(MSG.tooOld(show(file), fileVersion(text)!)); continue; }
    unlinkSync(file);
    out.fixed.push(MSG.deleted(show(file)));
  }
  return out;
}

/**
 * Move the split to `to`: clear the old scope (for local, only this project), then write the new one. `also` carries
 * other changes made in the same step (a new advisor); clearScope removes any fable or opus advisor the old scope holds.
 */
export function switchScope(root: string, to: ModelsPrefs['scope'], opts: ModelsOpts = {}, also: Partial<ModelsPrefs> = {}): DriftResult {
  const p = modelsPrefs();
  const out = empty();
  if (p.scope === to) return out;
  // An /advisor switch in the old user settings since the last session would be lost once that scope is cleared: carry it
  // over. A scope-local file is never a switch (/advisor writes the user settings), so nothing is carried from it.
  const a = p.scope === 'global' ? advisorOf(getAt(readSettings(targetPath(root, p.scope, opts.home ?? homedir())), ['advisorModel'])) : undefined;
  if (!saveModels({ ...p, ...(a && { advisor: a }), ...also, scope: to }, out)) return out; // prefs first: a failed save changes no file
  const cleared = clearScope(root, p.scope, opts);
  const written = driftCheck(root, { ...opts, autoFix: true, files: false, adopt: false });
  return { fixed: [...cleared.fixed, ...written.fixed], reported: [...cleared.reported, ...written.reported] };
}

/** `cto models advisor|autofix|scope`: save the change, then write it at once (turning autofix off writes nothing). */
export function applyModels(root: string, change: Partial<ModelsPrefs>, opts: ModelsOpts = {}): DriftResult {
  const p = modelsPrefs();
  const out = empty();
  if (change.scope && change.scope !== p.scope) { const { scope, ...also } = change; return switchScope(root, scope, opts, also); }
  if (!saveModels({ ...p, ...change, scope: p.scope }, out)) return out;
  if (change.advisor !== undefined || change.autoFix === true) return driftCheck(root, { ...opts, autoFix: true, files: false, adopt: false });
  return out;
}
