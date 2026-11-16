import { execFileSync } from 'node:child_process';
import { loadBrain, loadConfig, saveKeeping } from './brain.js';
import { BLOCKING_COMMIT, DIFF_ARGS, WARNING_COMMIT, countCheck, localLines, reviewDiff, reviewGate } from './hooks.js';
import { personaDict, t, type Lang } from './i18n.js';
import { localCommitChecks } from './local.js';
import type { Signal } from './types.js';

const PINNED = DIFF_ARGS.filter((a) => a !== 'diff' && a !== '--cached');
const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * What a commit would contain: the staged changes if anything is staged, otherwise every working-tree change,
 * including new files git does not track yet (agents create those often). Read-only: the index is never touched.
 */
export function pendingDiff(root: string, base?: string): { diff: string; source: 'staged' | 'working' | 'base' } {
  // CI: everything the branch adds on top of base (three-dot: since the merge base), nothing else.
  if (base) return { diff: git(root, ['diff', `${base}...HEAD`, ...PINNED]), source: 'base' };
  const staged = git(root, DIFF_ARGS);
  if (staged.trim()) return { diff: staged, source: 'staged' };
  let diff = git(root, ['diff', ...PINNED]);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const f of untracked) {
    try {
      diff += git(root, ['diff', '--no-index', ...PINNED, '--', '/dev/null', f]);
    } catch (e: any) {
      diff += String(e?.stdout ?? ''); // --no-index exits 1 when the files differ, which is always here
    }
  }
  return { diff, source: 'working' };
}

/** `cto check`: the commit checks, run now, with every score shown. Exit 1 when a commit would be blocked. */
export async function runCheck(root: string, lang: Lang, base?: string): Promise<{ code: number; lines: string[] }> {
  const cfg = loadConfig(root);
  const brain = loadBrain(root);
  const { diff, source } = pendingDiff(root, base);
  const local = localCommitChecks(diff, cfg, root);
  // The review records are local to this machine, so a branch diff for CI (--base) has none to match.
  const [gate, review] = await Promise.all([
    base ? { block: false, lines: [] as string[], answered: false } : reviewGate(diff, cfg, brain, root, lang, undefined, 'check', source === 'staged'),
    reviewDiff(diff, cfg, brain, lang, undefined, 'check', root, !!base),
  ]);
  if (gate.answered) countCheck(brain); // the gate's Jev calls count as one check, like a commit's
  saveKeeping(root, brain); // provider cooldowns and the decision log; check runs are not counted as blocks
  // The gate decides even when no commit check has anything to judge (every section filtered out): its block stands.
  if (!review) return gate.block ? { code: 1, lines: gate.lines } : { code: 0, lines: [t(lang, 'check_nothing'), ...gate.lines] };

  const head = source === 'staged' ? 'check_head_staged' : source === 'working' ? 'check_head_working' : 'check_head_base';
  const lines = [t(lang, head, { files: review.files, base: base ?? '' }), ...review.notices];
  let code = local.some((f) => f.block) || gate.block ? 1 : 0;
  const verdicts: string[] = [...localLines(lang, local), ...gate.lines];
  if (!Object.keys(review.scores).length) {
    lines.push(t(lang, 'check_unchecked'), ...verdicts);
    return { code, lines };
  }
  const width = Math.max(...[...BLOCKING_COMMIT, ...WARNING_COMMIT].map((s) => s.length));
  for (const s of [...BLOCKING_COMMIT, ...WARNING_COMMIT] as Signal[]) {
    const blocking = BLOCKING_COMMIT.includes(s);
    const v = review.scores[s];
    const name = s.padEnd(width);
    if (v === undefined) {
      // Asked but unanswered means the request failed, not that the question did not apply.
      const why = review.asked.has(s) ? 'check_why_failed' : s === 'test_tampering' ? 'check_why_tests' : s === 'architecture_violation' ? 'check_why_goal' : s === 'architecture_undocumented' ? 'check_why_adr' : s === 'manual_measurable' ? 'check_why_manual' : s === 'code_complexity' && base ? 'check_why_release' : 'check_why_failed';
      lines.push(`  ${name}  ${t(lang, why)}`);
      continue;
    }
    const limit = cfg.thresholds[s];
    const bad = v > limit;
    const status = bad ? t(lang, blocking ? 'check_block' : 'check_warn') : 'ok';
    lines.push(`  ${name}  ${String(v).padEnd(5)}  ${t(lang, blocking ? 'check_limit_block' : 'check_limit_warn', { limit })}  ${status}`);
    if (bad) {
      verdicts.push(`[cto] ${personaDict[lang][s]}`);
      if (blocking) code = 1;
    }
  }
  if (review.failed) lines.push(t(lang, 'check_partial'));
  lines.push(...verdicts, code ? t(lang, 'check_result_block') : t(lang, 'check_result_ok'));
  return { code, lines };
}
