import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Signal, TurnAction } from './types.js';

export interface CtoConfig {
  sprint_goal: string;
  test_command: string; // what `cto brief` tells the agent to verify with; detected from the project when empty
  protected_branches: string[]; // commits on these branches and pushes that delete or rewrite them are blocked locally
  flow: boolean; // the cto development flow (docs/cto_jev/ + cto-flow skill) was chosen in `cto setup`
  thresholds: Record<Signal, number>;
  review_gate: boolean; // commits wait for a cto-reviewer review (MOD-4); `cto models review on|off`
  turn_limits: TurnLimits; // a turn past any of these gets one reminder to stop and report; 0 turns a limit off
}

export interface TurnLimits { minutes: number; tool_calls: number; agents: number }
const turnLimits = (raw: any): TurnLimits => {
  const n = (k: keyof TurnLimits) => (typeof raw?.[k] === 'number' && raw[k] >= 0 ? raw[k] : DEFAULT_CONFIG.turn_limits[k]);
  return { minutes: n('minutes'), tool_calls: n('tool_calls'), agents: n('agents') };
};

export interface RecentError { command: string; error: string; at: string; edited_after?: boolean; warned?: boolean }
/** One answered yes/no question, with the masked state Jev saw, so `cto report` can turn a wrong call into a calibration case. */
export interface Decision { at: string; hook: 'commit' | 'check' | 'command' | 'stop' | 'prompt'; signal: Signal; value: number; threshold: number; state: string }
export const DECISIONS_KEPT = 30;
export const DECISION_STATE_CHARS = 12_000;
export interface Cooldown { until: number; status: string }

export interface Brain {
  recent_errors: RecentError[];
  blocked_attempts: number;
  skipped_attempts: number;
  failover_count: number;
  provider_cooldown: Record<string, Cooldown>;
  notified_sessions: string[];
  checks?: number; // checks Jev answered (any hook)
  /** cto's own per-session turn log, for agents whose transcript format is not public (Cursor, Gemini CLI, Codex). */
  turns?: Record<string, { at: string; actions: TurnAction[]; reply?: string }>;
  last_check_at?: string;
  /** Checklist items the done check already judged ("file:text"), so an uncommitted tick is judged once, not every turn. */
  judged_items?: string[];
  /** Per session: HEAD just before the agent's first `git commit` of the turn, so the done check sees ticks it committed. */
  turn_base?: Record<string, { head: string; at: number }>;
  /**
   * Per session: sign-off docs approved when the user's last prompt was handled, each with a hash of its text without
   * the Status line. At stop, a doc approved beyond it, or approved with that text changed, is reverted. A pre-0.12
   * brain holds a plain list of paths: no hashes, so only the first rule applies.
   */
  signoff_baseline?: Record<string, Record<string, string> | string[]>;
  decisions?: Decision[];
  /** Per session: when the user's last message arrived, and whether this turn was already told it runs long. */
  turn_start?: Record<string, { at: number; warned?: boolean }>;
  /** cto-reviewer's last reviews (SubagentStop), each with a hash of the code it saw; the commit gate looks for a match. */
  reviews?: Review[];
  /** Per session: the code hash at each cto-reviewer start not yet used by a finished review (each is used once). */
  review_start?: Record<string, { hash: string; at: number; prompt: string; promptHash?: string }[]>;
}

export interface Review { at: number; sessionId?: string; diffHash: string; text: string; prompt?: string }

/** Sign-off writes approved for the user, so an agent editing .cto.json may raise this bar but never lower it. */
export const SIGNOFF_FLOOR = 0.8;
/** review_unresolved and review_prompt default and ceiling: .cto.json can only lower them. */
export const REVIEW_CEIL = 0.7;
export const signoffThreshold = (override: unknown) => Math.max(typeof override === 'number' && Number.isFinite(override) ? override : 0, SIGNOFF_FLOOR);

export const DEFAULT_CONFIG: CtoConfig = {
  sprint_goal: '',
  test_command: '',
  protected_branches: [],
  flow: false,
  thresholds: {
    credential_leak: 0.5,
    destructive_command: 0.7,
    infinite_loop: 0.6,
    architecture_violation: 0.85,
    architecture_undocumented: 0.85,
    manual_measurable: 0.85, // not calibrated yet; warns only
    test_tampering: 0.8,
    done_unverified: 0.6,
    signoff_approved: SIGNOFF_FLOOR,
    review_unresolved: REVIEW_CEIL, // not calibrated yet; blocks the commit
    review_prompt: REVIEW_CEIL, // not calibrated yet; blocks the commit
    code_complexity: 2,
  },
  review_gate: true,
  turn_limits: { minutes: 20, tool_calls: 150, agents: 4 },
};

const emptyBrain = (): Brain => ({
  recent_errors: [],
  blocked_attempts: 0,
  skipped_attempts: 0,
  failover_count: 0,
  provider_cooldown: {},
  notified_sessions: [],
});

/** Nearest ancestor holding .cto.json or .git; falls back to start. No git spawn. */
export function findRoot(start = process.cwd()): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.cto.json')) || existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

export function loadConfig(root: string): CtoConfig {
  const raw = readJson(join(root, '.cto.json')) ?? {};
  const thresholds = { ...DEFAULT_CONFIG.thresholds, ...(raw.thresholds ?? {}) };
  thresholds.signoff_approved = signoffThreshold(thresholds.signoff_approved);
  // An agent editing .cto.json may make the review gate stricter, never looser.
  for (const k of ['review_unresolved', 'review_prompt'] as const) {
    const v = thresholds[k];
    thresholds[k] = Math.min(typeof v === 'number' && Number.isFinite(v) ? v : REVIEW_CEIL, REVIEW_CEIL);
  }
  return {
    sprint_goal: typeof raw.sprint_goal === 'string' ? raw.sprint_goal : '',
    test_command: typeof raw.test_command === 'string' ? raw.test_command : '',
    protected_branches: Array.isArray(raw.protected_branches) ? raw.protected_branches.filter((b: unknown) => typeof b === 'string') : [],
    flow: raw.flow === true,
    thresholds,
    review_gate: raw.review_gate !== false,
    turn_limits: turnLimits(raw.turn_limits),
  };
}

/** Corrupt or missing state rebuilds as empty: the gate must never crash on its own bookkeeping. */
export function loadBrain(root: string): Brain {
  const raw = readJson(join(root, '.cto-brain.json'));
  return raw && typeof raw === 'object' ? { ...emptyBrain(), ...raw } : emptyBrain();
}

// ---------- user-level credentials ----------
// GUI-launched agents and git clients often do not inherit shell env vars, so keys set in .zshrc
// never reach the hook. A per-user file outside every repo fixes that without touching rc files.

export const CREDENTIAL_KEYS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'OPENROUTER_API_KEY', 'TYPESAFE_API_KEY'] as const;
export type Credentials = Partial<Record<(typeof CREDENTIAL_KEYS)[number], string>>;

export function credentialsPath(env = process.env): string {
  const base = env.APPDATA ?? env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'your-cto-jev', 'credentials.json');
}

export function loadCredentials(): Credentials {
  const raw = readJson(credentialsPath()) ?? {};
  return Object.fromEntries(CREDENTIAL_KEYS.filter((k) => typeof raw[k] === 'string' && raw[k]).map((k) => [k, raw[k]]));
}

/** Env vars win; the file only fills what is missing. */
export function applyCredentials(env = process.env): void {
  for (const [k, v] of Object.entries(loadCredentials())) if (!env[k]) env[k] = v;
}

/** Replace the stored keys with exactly `c`; personal prefs in the same file are kept. */
export function saveCredentials(c: Credentials): string {
  const raw = readUserFile();
  for (const k of CREDENTIAL_KEYS) delete raw[k];
  return writeUserFile({ ...raw, ...c });
}

// Personal preferences live next to the keys: they are per person, not per repo.
export interface Prefs {
  provider_order?: string[]; // providers to use, in failover order; absent = every provider with a key, default order
  lang?: 'zh-TW' | 'en'; // absent = auto-detect
  models?: ModelsPrefs; // absent = DEFAULT_MODELS
}

/** Which model does which job in Claude Code, and where cto writes it (docs/cto_jev/features/models). */
export interface ModelsPrefs {
  scope: 'global' | 'local';
  advisor: 'fable' | 'opus';
  autoFix: boolean;
  seenUserAdvisor?: 'fable' | 'opus'; // scope local: the user-level advisorModel last seen, so only a new /advisor switch is followed
}
export const DEFAULT_MODELS: ModelsPrefs = { scope: 'global', advisor: 'fable', autoFix: true };
export const modelsPrefs = (p: Prefs = loadPrefs()): ModelsPrefs => ({ ...DEFAULT_MODELS, ...p.models });

export function loadPrefs(): Prefs {
  const raw = readJson(credentialsPath()) ?? {};
  const m = raw.models;
  const models = m && typeof m === 'object' && !Array.isArray(m) && {
    ...((m.scope === 'global' || m.scope === 'local') && { scope: m.scope }),
    ...((m.advisor === 'fable' || m.advisor === 'opus') && { advisor: m.advisor }),
    ...(typeof m.autoFix === 'boolean' && { autoFix: m.autoFix }),
    ...((m.seenUserAdvisor === 'fable' || m.seenUserAdvisor === 'opus') && { seenUserAdvisor: m.seenUserAdvisor }),
  };
  return {
    ...(Array.isArray(raw.provider_order) && { provider_order: raw.provider_order.filter((p: unknown) => typeof p === 'string') }),
    ...((raw.lang === 'zh-TW' || raw.lang === 'en') && { lang: raw.lang }),
    ...(models && { models: { ...DEFAULT_MODELS, ...models } }),
  };
}

/** provider_order and lang are replaced by `p` (absent = cleared); models is kept unless `p` sets it. */
export function savePrefs(p: Prefs): string {
  const raw = readUserFile();
  delete raw.provider_order;
  delete raw.lang;
  return writeUserFile({ ...raw, ...p });
}

/**
 * The file holds API keys: a file that exists but does not parse is never overwritten (its keys would be lost).
 * Throws then; callers that run unattended (SessionStart) catch it and report.
 */
function readUserFile(): Record<string, any> {
  const path = credentialsPath();
  if (!existsSync(path)) return {};
  const raw = readJson(path);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} is not valid JSON; fix or delete it, cto will not overwrite it`);
  return raw;
}

function writeUserFile(data: object): string {
  const path = credentialsPath();
  const tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path); // a crash mid-write never leaves half a key file
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
  return path;
}

/**
 * Atomic write via per-process tmp + rename. No file lock (spec section 7): parallel hooks race, last write wins.
 * Never throws: losing bookkeeping is fine, but an exception here would turn a block into a fail-open pass.
 */
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** rename, retried for EPERM (Windows: an antivirus or indexer holds the file for a moment); other errors throw at once. */
export function renameWithRetry(rename: (from: string, to: string) => void, from: string, to: string, attempts = 50): void {
  for (let i = 1; ; i++) {
    try { rename(from, to); return; } catch (e: any) {
      if (e?.code !== 'EPERM' || i >= attempts) throw e;
      sleepMs(20);
    }
  }
}

export function saveBrain(root: string, brain: Brain): void {
  const path = join(root, '.cto-brain.json');
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(brain, null, 2) + '\n');
    renameWithRetry(renameSync, tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    // Losing bookkeeping does not block a hook, but the loss is said, not dropped silently.
    process.stderr.write(`[cto] could not save ${path}: ${(e as Error).message}\n`);
  }
}

/**
 * Runs fn holding .cto-brain.json.lock: an O_EXCL create, retried for about 2 s. A lock older than 10 s is a crashed
 * writer's and is taken over. When the lock cannot be had in time, fn runs unlocked and the lock is left alone.
 */
export function withBrainLock<T>(root: string, fn: () => T, afterRename?: (aside: string) => void): T {
  const lock = join(root, '.cto-brain.json.lock');
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`; // the lock is ours only while it holds this
  const until = Date.now() + 2000;
  let held = false;
  for (;;) {
    try { writeFileSync(lock, token, { flag: 'wx' }); held = true; break; } catch (e: any) {
      if (e?.code !== 'EEXIST') break;
      let stale = false;
      try { stale = Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS; } catch { /* vanished: try again */ }
      if (stale) takeOver(lock, afterRename);
      if (Date.now() > until) break;
      sleepMs(20);
    }
  }
  try { return fn(); } finally {
    if (held) try { if (readFileSync(lock, 'utf8') === token) unlinkSync(lock); } catch { /* already gone */ }
  }
}
const STALE_LOCK_MS = 10_000;
/** Moved-aside stale locks left behind by a takeover that did not put the file back: removed once they are stale too. */
function sweepAsides(lock: string): void {
  const dir = dirname(lock);
  const prefix = `${basename(lock)}.stale-`;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const p = join(dir, name);
      try { if (Date.now() - statSync(p).mtimeMs > STALE_LOCK_MS) unlinkSync(p); } catch { /* gone, or held by another hook */ }
    }
  } catch { /* brain dir unreadable: the takeover itself reports nothing */ }
}
/**
 * Takes over a lock that looked stale: it is renamed to a unique name first, so of the hooks racing for it only one rename
 * succeeds. The moved file is checked again: a holder that refreshed it meanwhile gets its lock back and nothing is removed.
 */
function takeOver(lock: string, afterRename?: (aside: string) => void): void {
  sweepAsides(lock);
  const aside =`${lock}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try { renameSync(lock, aside); } catch { return; } // another hook renamed it first
  afterRename?.(aside);
  let still = false;
  try { still = Date.now() - statSync(aside).mtimeMs > STALE_LOCK_MS; } catch { return; }
  if (still) { try { unlinkSync(aside); } catch { /* gone */ } return; }
  // Put back with a link, which fails when the lock path was taken meanwhile: then the moved file stays where it is and the
  // holder's new lock is left alone.
  try { linkSync(aside, lock); } catch { return; }
  try { unlinkSync(aside); } catch { /* gone */ }
}

/**
 * Saves a brain read before a long wait (a Jev call): the fields other hooks write while it waits (reviews, review_start)
 * come from a fresh read, under the brain lock, so a record another hook wrote in the meantime is kept.
 * shortcut: the other fields are still this hook's snapshot; a counter another hook bumps in the same window is lost.
 */
export function saveKeeping(root: string, brain: Brain): void {
  withBrainLock(root, () => {
    const fresh = loadBrain(root);
    saveBrain(root, { ...brain, reviews: fresh.reviews, review_start: fresh.review_start });
  });
}

/** Failures older than this are history, not a loop. */
export const RECENT_ERROR_WINDOW_MS = 15 * 60_000;
export function freshErrors(brain: Brain, now = Date.now()): RecentError[] {
  return brain.recent_errors.filter((e) => now - Date.parse(e.at) < RECENT_ERROR_WINDOW_MS);
}
