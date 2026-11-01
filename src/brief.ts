import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshErrors, loadBrain, loadConfig } from './brain.js';
import { FLOW_DIR, featureIndex, loadTasks, openTasks, parallelTasks, writeIndex, type Task } from './flow.js';
import { loadLessons, packageManager, rankLessons, type Lesson } from './lessons.js';
import { displayWidth } from './setupui.js';
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

/** Unchecked "- [ ]" items in tracked markdown files, by file. The flow's own docs are listed by flowLines instead. */
export function openPlanItems(root: string): { file: string; items: string[] }[] {
  const files = git(root, 'ls-files', '-z', '--', '*.md', '*.mdx').split('\0').filter((f) => f && !f.startsWith(`${FLOW_DIR}/`));
  const out: { file: string; items: string[] }[] = [];
  for (const file of files) {
    let text = '';
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    if (text.length > 200_000) continue;
    // Boxes inside ``` fences are examples (a README showing a plan), not plan items.
    let fenced = false;
    const items = text.split(/\r?\n/).flatMap((l) => {
      if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return []; }
      const m = fenced ? null : BOX.exec(l);
      return m && m[2] === ' ' ? [m[3].trim()] : [];
    });
    if (items.length) out.push({ file, items });
  }
  return out;
}

const overlaps = (a: string[], b: string[]) => a.some((x) => b.some((y) => x.startsWith(y) || y.startsWith(x)));
/** A fixed-width column in terminal cells (CJK task text takes two per character), truncated with an ellipsis. */
const col = (s: string, w: number) => {
  if (displayWidth(s) > w) { let cut = ''; for (const ch of s) { if (displayWidth(cut + ch) > w - 1) break; cut += ch; } s = `${cut}…`; }
  return s + ' '.repeat(Math.max(0, w - displayWidth(s)));
};
const unknownCount = (path: string) => {
  try { return readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => /\(unknown\)|unknown\s*$/.test(l)).length; } catch { return 0; }
};

/** The development flow (docs/cto_jev/features): Ready and Blocked tasks, pending sign-offs, unknown fields. Empty when the repo does not use it. */
export function flowLines(root: string): string[] {
  if (!existsSync(join(root, FLOW_DIR, 'features'))) return [];
  writeIndex(root);
  const rows = featureIndex(root);
  const tasks = loadTasks(root);
  const ids = new Set(tasks.map((t) => t.id));
  const { ready, blocked } = openTasks(tasks);
  const together = parallelTasks(ready);
  const idW = Math.max(8, ...tasks.map((t) => t.id.length));
  const line = (t: Task, rest: string) => `  ${t.id.padEnd(idW)}  ${col(t.text, 24)}  ${rest}`;

  const counts = (['active', 'planned', 'done'] as const).filter((s) => rows.some((r) => r.status === s)).map((s) => `${rows.filter((r) => r.status === s).length} ${s}`);
  const pending = rows.filter((r) => r.signoff.concept !== 'approved' || r.signoff.spec !== 'approved')
    .map((r) => `${r.slug} (${(['concept', 'spec'] as const).filter((k) => r.signoff[k] !== 'approved').map((k) => `${k} ${r.signoff[k]}`).join(', ')})`);
  const L = ['', ['Features', String(rows.length), ...counts, ...(pending.length ? [`sign-off pending: ${pending.join(', ')}`] : [])].join(' · ')];

  L.push('', ready.length
    ? `Ready · ${ready.length} (run together: ${together.map((t) => t.id).join(', ')})`
    : `Ready · none${tasks.length ? '' : ` · add tasks to ${FLOW_DIR}/features/<slug>/TASKS.md`}`);
  for (const t of ready) {
    const first = together.includes(t) ? undefined : together.find((o) => overlaps(o.files, t.files));
    L.push(line(t, `files ${col(t.files.join(', ') || '-', 22)}  accept: ${(t.accept ?? '-').slice(0, 16)}${first ? `  (overlaps ${first.id}: run after)` : ''}`));
  }
  if (blocked.length) {
    L.push('', `Blocked · ${blocked.length}`);
    for (const b of blocked.slice(0, 8)) L.push(line(b.task, `waiting on ${b.waitingOn.map((id) => (ids.has(id) ? id : `${id} (missing)`)).join(', ')}`));
    if (blocked.length > 8) L.push(`  … ${blocked.length - 8} more`);
  }
  const unknown = ['PRODUCT.md', 'ARCHITECTURE.md'].map((f) => [f, unknownCount(join(root, FLOW_DIR, f))] as const).filter(([, n]) => n > 0);
  if (unknown.length) L.push('', `Unknown fields · ${unknown.map(([f, n]) => `${f} ${n}`).join(' · ')}`);
  return L;
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

  L.push(...flowLines(root));
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
