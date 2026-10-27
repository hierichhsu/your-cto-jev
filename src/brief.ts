import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshErrors, loadBrain, loadConfig } from './brain.js';
import { loadLessons, packageManager, rankLessons, type Lesson } from './lessons.js';
import { BOX } from './turn.js';

// `cto brief`: what an agent should know before it starts working in this repo. Read by agents (Claude Code gets it
// at SessionStart), so it is English only and fits on one screen.

const git = (cwd: string, ...args: string[]) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

/** The command that verifies this repo, from .cto.json or the project files. Empty when unknown. */
export function detectTestCommand(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const script = pkg?.scripts?.test;
    if (typeof script === 'string' && !/no test specified/.test(script)) return `${packageManager(root)} test`;
  } catch { /* not a node project */ }
  const has = (f: string) => existsSync(join(root, f));
  if (has('Makefile') && /^test:/m.test(readFileSync(join(root, 'Makefile'), 'utf8'))) return 'make test';
  if (has('pytest.ini') || has('conftest.py') || (has('pyproject.toml') && /pytest/.test(readFileSync(join(root, 'pyproject.toml'), 'utf8')))) return 'pytest';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  return '';
}

/** Unchecked "- [ ]" items in tracked markdown files, by file. */
export function openPlanItems(root: string): { file: string; items: string[] }[] {
  const files = git(root, 'ls-files', '-z', '--', '*.md', '*.mdx').split('\0').filter(Boolean);
  const out: { file: string; items: string[] }[] = [];
  for (const file of files) {
    let text = '';
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    if (text.length > 200_000) continue;
    const items = text.split(/\r?\n/).flatMap((l) => { const m = BOX.exec(l); return m && m[2] === ' ' ? [m[3].trim()] : []; });
    if (items.length) out.push({ file, items });
  }
  return out;
}

const ago = (iso: string, now: number) => {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
};

export function lessonLines(l: Lesson, now: number): string[] {
  const mark = !l.fix ? '!!' : l.seen > 1 ? '! ' : '- ';
  const how = l.fix ? `fixed by editing ${l.fix.files.join(', ')} · verified by ${l.fix.verified_by}` : 'UNRESOLVED';
  return [
    `  ${mark} ${l.command.padEnd(16).slice(0, 16)} ${l.error[0] ?? ''}`,
    `                    seen ${l.seen}x · last ${ago(l.last_at, now)} · ${how}${l.note ? ` · note: ${l.note}` : ''}`,
  ];
}

export function brief(root: string, now = Date.now()): string[] {
  const cfg = loadConfig(root);
  const brain = loadBrain(root);
  const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  const dirty = git(root, 'status', '--porcelain').split('\n').filter(Boolean).length;
  const L = [`[cto] brief · ${name}${branch ? ` · ${branch}` : ''} · ${dirty} files uncommitted`, ''];

  L.push(`Sprint goal   ${cfg.sprint_goal.trim() || '(none set in .cto.json)'}`);
  const test = cfg.test_command.trim() || detectTestCommand(root);
  L.push(`Verify with   ${test || '(unknown: set test_command in .cto.json)'}${test && !cfg.test_command.trim() ? '   (detected; pin it as test_command in .cto.json)' : ''}`);

  const plans = openPlanItems(root);
  if (plans.length) {
    const total = plans.reduce((n, p) => n + p.items.length, 0);
    L.push('', `Open plan items · ${plans.map((p) => `${p.file} ${p.items.length}`).join(' · ')} · ${total} unchecked`);
    for (const it of plans.flatMap((p) => p.items).slice(0, 5)) L.push(`  - [ ] ${it.slice(0, 100)}`);
    if (total > 5) L.push(`  … ${total - 5} more`);
  }

  const lessons = rankLessons(loadLessons(root));
  if (lessons.length) {
    L.push('', `Lessons from this repo · ${Math.min(5, lessons.length)} of ${lessons.length} · unresolved and frequent first`);
    for (const l of lessons.slice(0, 5)) L.push(...lessonLines(l, now));
  }

  const recent = freshErrors(brain, now);
  L.push('', `Failures in the last 15 min   ${recent.length ? recent.map((e) => e.command.slice(0, 60)).join('; ') : 'none'}`);
  L.push('Guards   secrets · test tampering · destructive commands · loops · unverified done');
  L.push('         Run cto check before committing. Same error twice: change approach.');
  return L;
}
