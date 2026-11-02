import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, type EvalCtx } from './api.js';
import { estimateTokens } from './diff.js';
import { featureIndex, renderIndex } from './flow.js';
import { t, type Lang } from './i18n.js';
import { maskSensitiveState } from './masker.js';
import { BOX } from './turn.js';
import type { JevQuestion } from './types.js';

// `cto docs`: tracked markdown outside docs/cto_jev/ that looks like a stale planning document. Rules
// first, Jev only for what the rules leave as `ask`.
// Suggest only: nothing here moves or deletes.

export type DocVerdict = 'delete' | 'merge' | 'archive' | 'ask';

const PLANNING_MIN = 0.6;
const FINISHED_MIN = 0.6;
const CONFLICTS_MIN = 0.6;
const STATE_TOKENS = 6000;
const UNAVAILABLE = 'Jev unavailable; decide by hand';

export interface DocCandidate { file: string; verdict: DocVerdict; reason: string; open: number; done: number; lastModifiedDays: number | null }

const git = (cwd: string, ...args: string[]) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

const EXCLUDED = /^(README|CONTRIBUTING|CHANGELOG|SECURITY)\.md$|^LICENSE/i;
const TOOL_DIR = /(^|\/)(\.planning|specs|\.kiro)\//;
const TOOL_FILE = /^(PLAN|TODO|NOTES)\.md$|-plan\.md$/i;
const STALE_DAYS = 30;

/** Checkbox counts, ignoring boxes inside ``` fences exactly like openPlanItems. */
function countBoxes(text: string): { open: number; done: number } {
  let fenced = false, open = 0, done = 0;
  for (const l of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; continue; }
    const m = fenced ? null : BOX.exec(l);
    if (m) m[2] === ' ' ? open++ : done++;
  }
  return { open, done };
}

export function docCandidates(root: string, now = Date.now()): DocCandidate[] {
  const files = git(root, 'ls-files', '-z', '--', '*.md', '*.mdx').split('\0').filter(Boolean);
  const out: DocCandidate[] = [];
  for (const file of files) {
    const base = file.split('/').pop()!;
    if (EXCLUDED.test(base) || file.startsWith('docs/cto_jev/')) continue;
    let text = '';
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    if (text.length > 200_000) continue;
    const { open, done } = countBoxes(text);
    const tool = TOOL_DIR.test(file) || TOOL_FILE.test(base);
    const boxed = open + done > 0;
    if (!boxed && !tool) continue; // plain docs are never candidates, under docs/ or anywhere else
    const ct = Number(git(root, 'log', '-1', '--format=%ct', '--', file));
    const lastModifiedDays = ct > 0 ? Math.floor((now / 1000 - ct) / 86_400) : null;
    const ticked = boxed && open === 0;
    const [verdict, reason]: [DocVerdict, string] =
      tool && ticked ? ['delete', 'planning file, every item ticked'] :
      ticked && lastModifiedDays !== null && lastModifiedDays > STALE_DAYS ? ['delete', `every item ticked, untouched for ${lastModifiedDays} days`] :
      tool && open > 0 ? ['merge', `planning file with ${open} open item${open === 1 ? '' : 's'}`] :
      ['ask', tool ? 'planning file without a checklist' : 'has a checklist outside a planning path'];
    out.push({ file, verdict, reason, open, done, lastModifiedDays });
  }
  return out;
}

const QUESTIONS: Record<'planning' | 'finished' | 'conflicts', JevQuestion> = {
  planning: { type: 'noul', instructions: 'Is this document a plan, spec, checklist or working notes rather than documentation written for users of the software?' },
  finished: { type: 'noul', instructions: 'Is the work this document describes already done, or already covered by the features listed in the INDEX?' },
  conflicts: { type: 'noul', instructions: 'Does this document contradict the current INDEX or the features it lists?' },
};

function clip(s: string): string {
  let n = s.length;
  while (n > 0 && estimateTokens(s.slice(0, n)) > STATE_TOKENS) n = Math.floor(n * 0.8);
  return s.slice(0, n);
}

/** Ask Jev about every `ask` candidate, one request per file, sequentially. Any failure leaves the candidate as `ask` (fail open). */
export async function judgeDocs(root: string, candidates: DocCandidate[], ctx: EvalCtx): Promise<DocCandidate[]> {
  if (!candidates.some((c) => c.verdict === 'ask')) return candidates;
  const index = renderIndex(featureIndex(root));
  const out: DocCandidate[] = [];
  for (const c of candidates) {
    if (c.verdict !== 'ask') { out.push(c); continue; }
    let text = '';
    try { text = readFileSync(join(root, c.file), 'utf8'); } catch { out.push({ ...c, reason: UNAVAILABLE }); continue; }
    const state = maskSensitiveState(`INDEX (docs/cto_jev/INDEX.md):\n${index}\n\nDocument ${c.file}:\n${clip(text)}`);
    const r = await evaluate({ state, questions: QUESTIONS }, ctx).catch(() => null);
    const p = (k: keyof typeof QUESTIONS) => { const a = r?.ok ? r.answers[k] : undefined; return a?.type === 'noul' && typeof a.noul === 'number' ? a.noul : NaN; };
    const [planning, finished, conflicts] = [p('planning'), p('finished'), p('conflicts')];
    if ([planning, finished, conflicts].some(Number.isNaN)) { out.push({ ...c, reason: UNAVAILABLE }); continue; }
    const probs = `planning ${planning.toFixed(2)} · finished ${finished.toFixed(2)} · conflicts ${conflicts.toFixed(2)}`;
    const [verdict, why]: [DocVerdict, string] =
      planning < PLANNING_MIN ? ['ask', 'looks like user documentation; not touched'] :
      finished >= FINISHED_MIN ? (c.open === 0 ? ['delete', 'work already done'] : ['archive', 'work already done, open items left']) :
      conflicts >= CONFLICTS_MIN ? ['archive', 'contradicts current features; keep for humans, agents should not read it'] :
      ['merge', 'open work not yet in docs/cto_jev/'];
    out.push({ ...c, verdict, reason: `${why} (${probs})` });
  }
  return out;
}

/** The whole `cto docs` report: rules, then Jev on what the rules left open. No network call when nothing is `ask`. */
export async function docsReport(root: string, ctx: EvalCtx): Promise<string[]> {
  return renderDocs(await judgeDocs(root, docCandidates(root), ctx), ctx.lang);
}

const GROUPS: DocVerdict[] = ['delete', 'merge', 'archive', 'ask'];

export function renderDocs(c: DocCandidate[], lang: Lang = 'en'): string[] {
  if (!c.length) return [t(lang, 'docs_none')];
  const L: string[] = [];
  for (const verdict of GROUPS) {
    const rows = c.filter((d) => d.verdict === verdict);
    if (!rows.length) continue;
    if (L.length) L.push('');
    L.push(t(lang, `docs_group_${verdict}`));
    for (const d of rows) {
      const age = d.lastModifiedDays === null ? 'age unknown' : `${d.lastModifiedDays}d old`;
      L.push(`  ${d.file}  ${d.open} open · ${d.done} done · ${age}  — ${d.reason}`);
    }
  }
  L.push('', t(lang, 'docs_footer'));
  return L;
}
