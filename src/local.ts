import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitFiles } from './diff.js';
import { danglingAfter, docStatus, duplicateIds, featureIndex, FLOW_DIR, indexStale, loadTasks } from './flow.js';
import type { CtoConfig } from './brain.js';

// Checks that need no model: they run first, work without any API key, and cost nothing.
// Blocking ones end the commit before Jev is asked; warnings are printed next to Jev's.

export type LocalKind = 'protected_branch' | 'conflict_marker' | 'env_file' | 'big_file' | 'lock_drift' | 'flow_signoff' | 'flow_index_stale' | 'flow_dangling_after' | 'flow_duplicate_id' | 'flow_manual_bare' | 'flow_interface';
export interface LocalFinding { kind: LocalKind; block: boolean; detail: string }

const BIG_BYTES = 5 * 1024 * 1024;
const ENV_FILE = /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/;
const LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
// A dependency line's value is a version range or a spec prefix; author, url and script lines are not.
const DEP_LINE = /^[+-]\s*"[^"]+":\s*"(?:[\d~^>=<*][^"]*|latest|(?:workspace|npm|file|link):[^"]*)"\s*,?$/m;

const git = (cwd: string, ...args: string[]) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

export const currentBranch = (root: string) => git(root, 'rev-parse', '--abbrev-ref', 'HEAD');

/** A path is in a `(files:)` scope when it is that file or lies under that directory; `src/auth` must not claim `src/authz/`. */
const inScope = (file: string, raw: string) => {
  const scope = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  return file === scope || file.startsWith(scope.endsWith('/') ? scope : `${scope}/`);
};

/**
 * Features whose TASKS.md has tasks but whose CONCEPT.md is not `Status: approved`: no work without sign-off.
 * SPEC.md is the CTO's own document and is not looked at.
 * Only the features this diff touches (their docs folder or a task's `(files:)` scope); any read error means no finding.
 */
function flowSignoff(root: string, touched: Set<string>): LocalFinding[] {
  try {
    const tasks = loadTasks(root);
    const out: LocalFinding[] = [];
    for (const slug of new Set(tasks.map((t) => t.feature))) {
      const dir = `${FLOW_DIR}/features/${slug}/`;
      const scopes = [dir, ...tasks.filter((t) => t.feature === slug).flatMap((t) => t.files)];
      if (![...touched].some((f) => scopes.some((s) => inScope(f, s)))) continue;
      const read = (f: string) => { try { return readFileSync(join(root, dir, f), 'utf8'); } catch { return ''; } };
      // CONCEPT.md is the one signed doc of a feature, so the message names it and detail is just the slug.
      if (docStatus(read('CONCEPT.md')) !== 'approved') out.push({ kind: 'flow_signoff', block: true, detail: slug });
    }
    return out;
  } catch { return []; }
}

// The files INDEX.md is computed from: a commit that changes none of them is not nagged about an index that drifted earlier.
const INDEX_INPUT = new RegExp(`^${FLOW_DIR}/features/[^/]+/(TASKS|CONCEPT|SPEC)\\.md$`);

/**
 * Warnings: INDEX.md not regenerated after its inputs changed, and `(after:)` ids nobody defines in a TASKS.md this
 * diff touches (at most 5). Any read error means no finding.
 */
function flowIndex(root: string, touched: Set<string>): LocalFinding[] {
  try {
    const out: LocalFinding[] = [];
    if ([...touched].some((f) => INDEX_INPUT.test(f)) && indexStale(root)) out.push({ kind: 'flow_index_stale', block: false, detail: `${FLOW_DIR}/INDEX.md` });
    const tasks = loadTasks(root);
    const inTouched = (id: string) => touched.has(tasks.find((t) => t.id === id)?.file ?? '');
    for (const d of danglingAfter(tasks).filter((d) => inTouched(d.task)).slice(0, 5)) out.push({ kind: 'flow_dangling_after', block: false, detail: `${d.task} → ${d.missing}` });
    const dupIn = (id: string) => tasks.some((t) => t.id === id && touched.has(t.file));
    for (const id of duplicateIds(tasks).filter(dupIn).slice(0, 5)) out.push({ kind: 'flow_duplicate_id', block: false, detail: id });
    // The stop reminder prints what follows "manual:"; without it the user gets a task id and has to go look it up.
    const bare = tasks.filter((t) => !t.done && touched.has(t.file) && /^manual\s*[:：]?\s*$/i.test(t.accept ?? ''));
    for (const t of bare.slice(0, 5)) out.push({ kind: 'flow_manual_bare', block: false, detail: t.id });
    return out;
  } catch { return []; }
}

const SPEC_FILE = new RegExp(`^${FLOW_DIR}/features/([^/]+)/SPEC\\.md$`);

/**
 * Whether a SPEC.md diff section adds or removes a line inside `## Interface`. The section a changed line belongs to is
 * read off the new file (`## ` headings by line number), walking each hunk from its `+c` start: git's hunk header never
 * names a markdown heading, and a one-line edit further than three lines below `## Interface` shows no heading in the hunk.
 * A removed line sits just before the next new line, so it takes the section of the line above.
 */
function changesInterface(section: string, newText: string): boolean {
  const headings = newText.split(/\r?\n/).map((l, i) => ({ line: i + 1, name: /^##\s+(.*?)\s*$/.exec(l)?.[1] })).filter((h) => h.name);
  const sectionAt = (n: number) => headings.filter((h) => h.line <= n).pop()?.name;
  let n = 0;
  for (const line of section.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { n = Number(hunk[1]); continue; }
    if (!n) continue;
    if (line.startsWith('+')) { if (sectionAt(n) === 'Interface') return true; n++; }
    else if (line.startsWith('-')) { if (sectionAt(n - 1) === 'Interface') return true; }
    else if (line.startsWith(' ') || line === '') n++;
  }
  return false;
}

/**
 * Warning: a feature's Interface moved, so the features whose `(after:)` points into it must re-check their tasks.
 * A new SPEC and a feature nobody depends on have no one to warn. Any read error means no finding.
 */
function flowInterface(root: string, rawDiff: string): LocalFinding[] {
  try {
    const out: LocalFinding[] = [];
    for (const section of splitFiles(rawDiff)) {
      const path = /^diff --git a\/.+? b\/(.+)$/m.exec(section)?.[1] ?? '';
      const slug = SPEC_FILE.exec(path)?.[1];
      if (!slug || /^--- \/dev\/null$/m.test(section)) continue;
      const deps = featureIndex(root).filter((r) => r.dependsOn.includes(slug)).map((r) => r.slug);
      if (!deps.length || !changesInterface(section, readFileSync(join(root, path), 'utf8'))) continue;
      out.push({ kind: 'flow_interface', block: false, detail: `${slug} → ${deps.join(', ')}` });
    }
    return out;
  } catch { return []; }
}

/** Local findings for a diff about to be committed on `branch`. The raw diff: lock files are part of the question here. */
export function localCommitChecks(rawDiff: string, cfg: CtoConfig, root: string, branch = currentBranch(root)): LocalFinding[] {
  const out: LocalFinding[] = [];
  if (branch && cfg.protected_branches.includes(branch)) out.push({ kind: 'protected_branch', block: true, detail: branch });

  const touched = new Set<string>();
  for (const section of splitFiles(rawDiff)) {
    const file = /^diff --git a\/.+? b\/(.+)$/m.exec(section)?.[1];
    if (!file) continue;
    touched.add(file);
    if (/^\+(<{7} |={7}$|>{7} )/m.test(section)) out.push({ kind: 'conflict_marker', block: true, detail: file });
    if (ENV_FILE.test(file) && /^\+\s*(?:export\s+)?[A-Za-z_][\w.]*\s*=\s*\S/m.test(section)) out.push({ kind: 'env_file', block: true, detail: file });
    if (section.length > BIG_BYTES) out.push({ kind: 'big_file', block: false, detail: `${file} (${Math.round(section.length / 1024 / 1024)} MB)` });
  }
  const pkgs = [...touched].filter((f) => /(^|\/)package\.json$/.test(f));
  const lockInRepo = LOCKS.find((l) => existsSync(join(root, l)));
  if (pkgs.length && lockInRepo && ![...touched].some((f) => LOCKS.some((l) => f.endsWith(l)))) {
    const depChange = splitFiles(rawDiff).some((s) => pkgs.some((p) => s.includes(` b/${p}\n`)) && DEP_LINE.test(s));
    if (depChange) out.push({ kind: 'lock_drift', block: false, detail: lockInRepo });
  }
  out.push(...flowSignoff(root, touched), ...flowIndex(root, touched), ...flowInterface(root, rawDiff));
  return out;
}

/**
 * pre-push: stdin lines "<local ref> <local sha> <remote ref> <remote sha>". A protected branch is blocked when the
 * push deletes it or rewrites its history (the remote commit is not an ancestor of what is pushed).
 */
export function localPushChecks(stdin: string, cfg: CtoConfig, root: string): LocalFinding[] {
  const out: LocalFinding[] = [];
  for (const line of stdin.split('\n')) {
    const [, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    const branch = remoteRef?.replace(/^refs\/heads\//, '');
    if (!branch || !cfg.protected_branches.includes(branch) || !remoteSha || /^0+$/.test(remoteSha)) continue;
    if (/^0+$/.test(localSha)) { out.push({ kind: 'protected_branch', block: true, detail: `${branch} (delete)` }); continue; }
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', remoteSha, localSha], { cwd: root, stdio: 'ignore' });
    } catch {
      out.push({ kind: 'protected_branch', block: true, detail: `${branch} (force push)` });
    }
  }
  return out;
}
