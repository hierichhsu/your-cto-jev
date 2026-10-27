import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskSensitiveState } from './masker.js';
import type { TurnAction } from './types.js';

// Lessons: every failed agent command, fingerprinted, with the edit that made the same command pass afterwards.
// Kept per repo in .cto-lessons.jsonl (meant to be committed, so every teammate's agent learns from it). One line
// per lesson, append-style, so two people adding lessons never conflict in git. No Jev call anywhere in here.

export const LESSONS_FILE = '.cto-lessons.jsonl';
const MAX_LESSONS = 200;

export interface Lesson {
  id: string;
  fingerprint: string;
  command: string;
  error: string[]; // first lines of the failure that matter, masked, paths relative
  env: { os: string; node: string; pm: string; agent: string };
  seen: number;
  first_at: string;
  last_at: string;
  /** Set when the same command passed after code edits. Absent while unresolved. */
  fix?: { files: string[]; verified_by: string; at: string };
  note?: string;
}

/** The first two words of a command: the tool and its verb ("npm test", "npx tsc", "git push"). Flags are not a verb. */
export function commandHead(command: string): string {
  const words = command.trim().replace(/^(?:\w+=\S*\s+)+/, '').split(/\s+/);
  return words.slice(0, words[1] && !words[1].startsWith('-') ? 2 : 1).join(' ');
}

// Numbers, hashes, quoted names and absolute paths vary between runs of the same mistake.
const normalise = (s: string) =>
  s.replace(/(['"`])[^'"`]*\1/g, "'*'").replace(/\b[0-9a-f]{6,}\b/gi, '*').replace(/\d+/g, '*')
    .replace(/(?:[A-Za-z]:)?[\\/](?:[\w.-]+[\\/])+[\w.-]*/g, '*').replace(/\s+/g, ' ').trim();

const TELLING = /\b(error|err|exception|fail|failed|cannot|not found|denied|invalid|unexpected|missing|ENOENT|TS\d{4}|panic|traceback)\b/i;

/** The lines of a failure worth keeping: the first telling line and the two after it. */
export function errorLines(output: string, root?: string): string[] {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const at = Math.max(0, lines.findIndex((l) => TELLING.test(l)));
  return lines.slice(at, at + 3).map((l) => relativise(maskSensitiveState(l), root).slice(0, 200));
}

// Absolute paths under the repo become ./..., with forward slashes, so the same lesson reads the same on every machine.
const relativise = (s: string, root?: string) =>
  root ? s.split(root).join('.').split(root.replace(/\\/g, '/')).join('.').replace(/\\/g, '/') : s;

export const fingerprint = (command: string, error: string[]) => `${commandHead(command)} | ${normalise(error[0] ?? '')}`;

const idOf = (fp: string) => {
  let h = 0;
  for (const c of fp) h = (h * 31 + c.charCodeAt(0)) | 0;
  return 'l_' + (h >>> 0).toString(16).padStart(8, '0');
};

export function loadLessons(root: string): Lesson[] {
  try {
    return readFileSync(join(root, LESSONS_FILE), 'utf8').split('\n').flatMap((l) => {
      try { const j = l && JSON.parse(l); return j && typeof j.fingerprint === 'string' ? [j as Lesson] : []; } catch { return []; }
    });
  } catch { return []; }
}

/** Same tmp + rename as saveBrain; never throws, so bookkeeping can never turn into a fail-open pass. */
export function saveLessons(root: string, lessons: Lesson[]): void {
  const path = join(root, LESSONS_FILE);
  const kept = lessons.length > MAX_LESSONS ? [...lessons].sort((a, b) => b.last_at.localeCompare(a.last_at)).slice(0, MAX_LESSONS) : lessons;
  if (!kept.length && !existsSync(path)) return;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, kept.map((l) => JSON.stringify(l)).join('\n') + (kept.length ? '\n' : ''));
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
}

export function packageManager(root: string): string {
  return existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn'
    : existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock')) ? 'bun' : 'npm';
}

/** A command failed: count it, and forget any earlier fix since it evidently did not hold. Called once per failure. */
export function recordFailure(lessons: Lesson[], command: string, error: string, root: string, agent: string, now = new Date()): Lesson {
  const lines = errorLines(error, root);
  const fp = fingerprint(command, lines);
  const at = now.toISOString();
  let l = lessons.find((x) => x.fingerprint === fp);
  if (l) {
    l.seen++;
    l.last_at = at;
    l.error = lines;
    delete l.fix;
  } else {
    l = {
      id: idOf(fp), fingerprint: fp, command: relativise(maskSensitiveState(command), root).slice(0, 200), error: lines,
      env: { os: process.platform, node: process.version, pm: packageManager(root), agent }, seen: 1, first_at: at, last_at: at,
    };
    lessons.push(l);
  }
  return l;
}

/**
 * Resolve lessons from a turn: a failed run, then code edits, then the same command (by head) passing marks the fix.
 * Idempotent, so a turn that is read again at a second stop sets the same fix twice. Failures are not counted here.
 */
export function resolveFromTurn(lessons: Lesson[], actions: TurnAction[], root: string, now = new Date()): Lesson[] {
  const pending = new Map<string, { lesson: Lesson; files: Set<string> }>();
  const fixed: Lesson[] = [];
  for (const a of actions) {
    if (a.kind === 'edit') { for (const p of pending.values()) p.files.add(a.file); continue; }
    const head = commandHead(a.command);
    if (!a.ok) {
      const fp = fingerprint(a.command, errorLines(a.tail, root));
      const lesson = lessons.find((l) => l.fingerprint === fp) ?? lessons.find((l) => commandHead(l.command) === head && !l.fix);
      if (lesson) pending.set(head, { lesson, files: new Set() });
      continue;
    }
    const p = pending.get(head);
    if (!p || !p.files.size) continue;
    p.lesson.fix = { files: [...p.files], verified_by: maskSensitiveState(a.command).slice(0, 200), at: now.toISOString() };
    fixed.push(p.lesson);
    pending.delete(head);
  }
  return fixed;
}

/** Unresolved first, then the most often seen, then the most recent. */
export const rankLessons = (lessons: Lesson[]) =>
  [...lessons].sort((a, b) => Number(!!a.fix) - Number(!!b.fix) || b.seen - a.seen || b.last_at.localeCompare(a.last_at));
