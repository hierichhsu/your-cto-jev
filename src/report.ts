import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { credentialsPath, loadBrain } from './brain.js';
import { t, type Lang } from './i18n.js';

// `cto log`: the last answered questions with their scores. `cto report [n]`: "that call was wrong", which writes
// the exact masked state as a calibration case to a per-user file, ready to paste into calibration/candidates/.

const stamp = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export function showLog(root: string, lang: Lang): { code: number; lines: string[] } {
  const d = loadBrain(root).decisions ?? [];
  if (!d.length) return { code: 0, lines: [t(lang, 'log_empty')] };
  const lines = [t(lang, 'log_head')];
  d.forEach((x, i) => {
    const crossed = x.value > x.threshold;
    lines.push(`  ${String(i + 1).padStart(2)}  ${stamp(x.at)}  ${x.hook.padEnd(7)}  ${x.signal.padEnd(22)}  ${String(x.value).padEnd(5)}  ${crossed ? '>' : '<'} ${x.threshold}  ${crossed ? t(lang, 'log_crossed') : 'ok'}`);
  });
  lines.push(t(lang, 'log_hint'));
  return { code: 0, lines };
}

export const reportsPath = (signal: string) => join(dirname(credentialsPath()), 'reports', `${signal}.jsonl`);

/** A reported decision becomes a case whose expected answer is the opposite of what Jev said. */
export function report(root: string, lang: Lang, which?: string): { code: number; lines: string[] } {
  const d = loadBrain(root).decisions ?? [];
  if (!d.length) return { code: 1, lines: [t(lang, 'log_empty')] };
  const n = which ? Number(which) : d.length;
  const x = d[n - 1];
  if (!x) return { code: 1, lines: [t(lang, 'report_bad_n', { max: d.length })] };
  const crossed = x.value > x.threshold;
  const entry = { id: `report-${x.at.replace(/\D/g, '').slice(0, 14)}`, set: 'holdout', expect: !crossed, source: `cto report ${stamp(x.at)} ${x.hook} value ${x.value}`, state: x.state };
  const path = reportsPath(x.signal);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  return { code: 0, lines: [t(lang, crossed ? 'report_wrong' : 'report_missed', { signal: x.signal, value: x.value }), t(lang, 'report_written', { path, signal: x.signal })] };
}
