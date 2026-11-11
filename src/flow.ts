import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCEPT, BOX } from './turn.js';

// docs/cto_jev/features/<slug>/TASKS.md: the one place the development flow keeps state. Everything else (INDEX,
// ready list, feature dependencies, code ownership) is computed from it. Format: FLOW_SKILL_TEXT in skill.ts.

export const FLOW_DIR = 'docs/cto_jev';
export const FEATURE_FILES = ['CONCEPT.md', 'SPEC.md', 'TASKS.md', 'REVIEW.md'] as const;

export interface Task {
  id: string;
  text: string; // without the id and the (after:)/(files:) tags
  done: boolean;
  feature: string;
  file: string;
  line: number; // 1-based
  parent?: string;
  children: string[];
  after: string[];
  files: string[];
  accept?: string; // "驗收: <cmd>" / "accept: <cmd>" on the next line; "manual: <what> @ <where>" is for the user to look at and blocks nothing
  priority?: 'P1' | 'P2' | 'P3'; // P1 first and before any release, P2 (the default when absent) normal, P3 when nothing else is left
  seq?: boolean; // (seq): never run alongside another task, whatever its (files:) say
}

const ID = /^([A-Z][A-Z0-9]*-\d+(?:\.\d+)*)\b\s*/;
const TAG = /\s*\((after|files):\s*([^)]*)\)/g;
const PRIORITY = /\s*\((P[123])\)/;
const SEQ = /\s*\(seq\)/;
const list = (s: string) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);

/** Parses one TASKS.md. Items without an id are skipped (they are not tasks the flow can track). */
export function parseTasks(text: string, feature: string, file: string): Task[] {
  const tasks: Task[] = [];
  const stack: { indent: number; id: string }[] = [];
  let fenced = false;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    const m = BOX.exec(raw);
    if (!m) {
      const a = ACCEPT.exec(raw);
      const last = tasks[tasks.length - 1];
      if (a && last && !last.accept) last.accept = a[1];
      return;
    }
    const indent = m[1].length;
    const idm = ID.exec(m[3]);
    if (!idm) return;
    const after: string[] = [];
    const files: string[] = [];
    let priority: Task['priority'];
    let seq = false;
    const text = m[3].slice(idm[0].length)
      .replace(TAG, (_, k, v) => { (k === 'after' ? after : files).push(...list(v)); return ''; })
      .replace(PRIORITY, (_, p) => { priority = p; return ''; })
      .replace(SEQ, () => { seq = true; return ''; })
      .trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.id;
    const t: Task = { id: idm[1], text, done: m[2] !== ' ', feature, file, line: i + 1, parent, children: [], after, files, ...(priority ? { priority } : {}), ...(seq ? { seq } : {}) };
    if (parent) tasks.find((p) => p.id === parent)?.children.push(t.id);
    tasks.push(t);
    stack.push({ indent, id: t.id });
  });
  return tasks;
}

/** Feature slugs: the directories under docs/cto_jev/features, from the file system (a new feature is not yet in git). */
export function listFeatures(root: string): string[] {
  const dir = join(root, FLOW_DIR, 'features');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export function loadTasks(root: string): Task[] {
  return listFeatures(root).flatMap((slug) => {
    const rel = `${FLOW_DIR}/features/${slug}/TASKS.md`;
    try { return parseTasks(readFileSync(join(root, rel), 'utf8'), slug, rel); } catch { return []; }
  });
}

const isLeaf = (t: Task) => t.children.length === 0;
/** Two file scopes collide when one is a prefix of the other ("src/a/" vs "src/a/b.ts"). */
const overlaps = (a: string[], b: string[]) => a.some((x) => b.some((y) => x.startsWith(y) || y.startsWith(x)));

/** Open leaf tasks whose `after` tasks are all done. `blocked` says what each of the others is waiting for. */
export function openTasks(tasks: Task[]): { ready: Task[]; blocked: { task: Task; waitingOn: string[] }[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // A parent is done when every child is, whether or not anyone ticked its own box.
  const done = (id: string): boolean => {
    const t = byId.get(id);
    return !t ? false : isLeaf(t) ? t.done : t.children.every(done);
  };
  const ready: Task[] = [];
  const blocked: { task: Task; waitingOn: string[] }[] = [];
  for (const t of tasks) {
    if (t.done || !isLeaf(t)) continue;
    const waitingOn = t.after.filter((id) => !done(id));
    if (waitingOn.length) blocked.push({ task: t, waitingOn });
    else ready.push(t);
  }
  return { ready, blocked };
}

/**
 * Ready tasks that can run at the same time: taken in the given order, skipping any whose files overlap one already
 * taken and any that runs alone: marked (seq), or with no (files:), whose reach is unknown.
 */
export const runsAlone = (t: Task) => !!t.seq || !t.files.length;
export function parallelTasks(ready: Task[]): Task[] {
  const out: Task[] = [];
  for (const t of ready) if (!runsAlone(t) && !out.some((o) => overlaps(o.files, t.files))) out.push(t);
  return out;
}

/** Ids defined by more than one task, across all TASKS.md files. */
export const duplicateIds = (tasks: Task[]) => {
  const seen = new Set<string>();
  return [...new Set(tasks.filter((t) => seen.has(t.id) || !seen.add(t.id)).map((t) => t.id))];
};

/** `after` ids that no task defines. */
export const danglingAfter = (tasks: Task[]) => {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.flatMap((t) => t.after.filter((id) => !ids.has(id)).map((id) => ({ task: t.id, missing: id })));
};

// INDEX.md: one row per feature, computed from CONCEPT.md, SPEC.md and TASKS.md. Regenerated, never edited.

export type Signoff = 'draft' | 'approved' | 'missing';
export interface FeatureRow {
  slug: string;
  purpose: string; // first line under "## 目的" in CONCEPT.md
  status: 'planned' | 'active' | 'done';
  code: string[]; // union of (files:), without entries another entry already covers
  dependsOn: string[]; // other features that an (after:) points into
  signoff: Signoff; // CONCEPT.md's Status; SPEC.md is not signed
}

const readOr = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };
/** A sign-off doc's state: the first `Status: draft|approved` line (any case); no such line is 'missing'. */
// Blanks on a Status line: space, tab, or the no-break space some editors and IMEs type; never a line break.
const SP = '[ \\t\\u00a0]';
export const docStatus = (text: string): Signoff =>
  (new RegExp(`^Status:${SP}*(draft|approved)${SP}*\\r?$`, 'im').exec(text)?.[1]?.toLowerCase() as Signoff | undefined) ?? 'missing';
/** `text` with its first `Status: <from>` line set to `to`, keeping the blanks and line ending. */
export const setStatus = (text: string, from: Signoff, to: Signoff) =>
  text.replace(new RegExp(`^(Status:${SP}*)${from}(?=${SP}*\\r?$)`, 'im'), `$1${to}`);
const signoff = (path: string): Signoff => docStatus(readOr(path) ?? '');

function purpose(concept: string): string {
  const lines = concept.split(/\r?\n/);
  const i = lines.findIndex((l) => /^##\s*目的\s*$/.test(l));
  const next = i < 0 ? undefined : lines.slice(i + 1).find((l) => l.trim());
  return next && !next.startsWith('#') ? next.trim() : '';
}

const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();

export function featureIndex(root: string): FeatureRow[] {
  const tasks = loadTasks(root);
  const featureOf = new Map(tasks.map((t) => [t.id, t.feature]));
  return listFeatures(root).map((slug) => {
    const dir = join(root, FLOW_DIR, 'features', slug);
    const mine = tasks.filter((t) => t.feature === slug);
    const leaves = mine.filter(isLeaf);
    const files = uniqSorted(mine.flatMap((t) => t.files));
    return {
      slug,
      purpose: purpose(readOr(join(dir, 'CONCEPT.md')) ?? ''),
      status: !mine.length ? 'planned' : leaves.every((t) => t.done) ? 'done' : 'active',
      code: files.filter((f) => !files.some((o) => o !== f && f.startsWith(o))),
      dependsOn: uniqSorted(mine.flatMap((t) => t.after).map((id) => featureOf.get(id)).filter((f): f is string => !!f && f !== slug)),
      signoff: signoff(join(dir, 'CONCEPT.md')),
    };
  });
}

export function renderIndex(rows: FeatureRow[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const line = (r: FeatureRow) =>
    `| ${r.slug} | ${r.status} | ${cell(r.purpose)} | ${r.code.join(', ')} | ${r.dependsOn.join(', ')} | ${r.signoff} |`;
  return [
    '# INDEX',
    '',
    '<!-- Generated by cto. Do not edit: run cto index. -->',
    '',
    'Read the row of the feature you work on, then its SPEC.md; for each feature in "Depends on", read only the `## Interface` section of its SPEC.md.',
    '',
    '| Feature | Status | Purpose | Code | Depends on | Sign-off |',
    '|---|---|---|---|---|---|',
    ...[...rows].sort((a, b) => a.slug.localeCompare(b.slug)).map(line),
    '',
  ].join('\n');
}

const INDEX = `${FLOW_DIR}/INDEX.md`;
// CRLF-normalized so a checkout with autocrlf does not look stale forever.
const onDisk = (root: string) => readOr(join(root, INDEX))?.replace(/\r\n/g, '\n');
const hasFeatures = (root: string) => existsSync(join(root, FLOW_DIR, 'features'));

/** Rewrites INDEX.md only when its content changed; no features directory means nothing to do. */
export function writeIndex(root: string): { path: string; changed: boolean } {
  if (!hasFeatures(root)) return { path: INDEX, changed: false };
  const next = renderIndex(featureIndex(root));
  if (onDisk(root) === next) return { path: INDEX, changed: false };
  writeFileSync(join(root, INDEX), next);
  return { path: INDEX, changed: true };
}

/** True when INDEX.md is missing or no longer matches the feature folders. */
export const indexStale = (root: string) => hasFeatures(root) && onDisk(root) !== renderIndex(featureIndex(root));
