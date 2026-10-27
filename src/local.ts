import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitFiles } from './diff.js';
import type { CtoConfig } from './brain.js';

// Checks that need no model: they run first, work without any API key, and cost nothing.
// Blocking ones end the commit before Jev is asked; warnings are printed next to Jev's.

export type LocalKind = 'protected_branch' | 'conflict_marker' | 'env_file' | 'big_file' | 'lock_drift';
export interface LocalFinding { kind: LocalKind; block: boolean; detail: string }

const BIG_BYTES = 5 * 1024 * 1024;
const ENV_FILE = /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/;
const LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
const DEP_LINE = /^[+-]\s*"[^"]+":\s*"[^"]*"\s*,?$/m;

const git = (cwd: string, ...args: string[]) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

export const currentBranch = (root: string) => git(root, 'rev-parse', '--abbrev-ref', 'HEAD');

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
