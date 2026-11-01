import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { loadBrain } from './brain.js';
import { docCandidates, judgeDocs, renderDocs, type DocCandidate } from './docs.js';

process.env.APPDATA = mkdtempSync(join(tmpdir(), 'cto-home-')); // never read the user's real keys and prefs
process.env.OPENROUTER_API_KEY = 'k';
const ctx = () => ({ brain: loadBrain(mkdtempSync(join(tmpdir(), 'cto-brain-'))), lang: 'en' as const, timeoutMs: 1000, notices: new Set<string>() });
const noul = (v: number) => ({ type: 'noul', noul: v });
const ask = (file: string, open = 0): DocCandidate => ({ file, verdict: 'ask', reason: 'r', open, done: 1, lastModifiedDays: 1 });

test('cto docs: rules classify stale planning markdown and leave the rest alone', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cto-docs-'));
  const g = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });
  const put = (file: string, text: string) => { mkdirSync(dirname(join(repo, file)), { recursive: true }); writeFileSync(join(repo, file), text); };
  g(['init', '-q']);
  g(['config', 'user.email', 't@example.com']);
  g(['config', 'user.name', 't']);
  g(['config', 'core.autocrlf', 'false']); // keep Windows CRLF warnings out of the test output

  // Fully ticked and committed long ago: the 30-day rule.
  put('old.md', '# Done\n- [x] shipped\n- [x] tested\n');
  g(['add', '.']);
  const old = '2020-01-01T00:00:00Z';
  g(['commit', '-q', '-m', 'old'], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });

  put('README.md', '- [ ] excluded by name\n');
  put('docs/guide.md', '# Guide\nNo boxes here.\n');
  put('docs/howto.md', 'Example plan:\n```md\n- [ ] not a real item\n- [x] nor this\n```\n');
  put('TODO.md', '- [x] a\n- [X] b\n');
  put('.planning/x.md', '- [x] done\n- [ ] still open\n- [ ] and this\n');
  put('notes/ideas.md', '- [ ] think about it\n```\n- [x] fenced, must not count as done\n```\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'now']);

  const got = docCandidates(repo);
  const by = Object.fromEntries(got.map((c) => [c.file, c]));
  assert.deepEqual(Object.keys(by).sort(), ['.planning/x.md', 'TODO.md', 'notes/ideas.md', 'old.md']);

  assert.equal(by['TODO.md'].verdict, 'delete');
  assert.match(by['TODO.md'].reason, /every item ticked/);
  assert.deepEqual([by['TODO.md'].open, by['TODO.md'].done], [0, 2]);

  assert.equal(by['old.md'].verdict, 'delete');
  assert.match(by['old.md'].reason, /untouched for \d+ days/);
  assert.ok((by['old.md'].lastModifiedDays ?? 0) > 2000, 'commit date came from GIT_COMMITTER_DATE');

  assert.equal(by['.planning/x.md'].verdict, 'merge');
  assert.match(by['.planning/x.md'].reason, /2 open items/);

  assert.equal(by['notes/ideas.md'].verdict, 'ask');
  assert.deepEqual([by['notes/ideas.md'].open, by['notes/ideas.md'].done], [1, 0], 'fenced box does not count');
  assert.ok(by['notes/ideas.md'].lastModifiedDays !== null && by['notes/ideas.md'].lastModifiedDays <= 1);

  const out = renderDocs(got);
  const idx = (s: string) => out.findIndex((l) => l.startsWith(s));
  assert.ok(idx('Delete') < idx('Merge into a feature') && idx('Merge into a feature') < idx('Needs a look'));
  assert.ok(idx('  TODO.md  0 open · 2 done · ') > idx('Delete') && idx('  TODO.md  0 open · 2 done · ') < idx('Merge into a feature'));
  assert.ok(idx('  .planning/x.md  2 open · 1 done · ') > idx('Merge into a feature'));
  assert.ok(idx('  notes/ideas.md  1 open · 0 done · 0d old  — ') > idx('Needs a look'));
  assert.match(out.at(-1)!, /only suggests/);

  assert.deepEqual(renderDocs([]), ['No stale planning documents outside docs/cto_jev/.']);
});

test('cto docs: Jev turns ask candidates into delete / merge / archive, leaves user docs alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-docs-jev-'));
  const put = (file: string, text: string) => writeFileSync(join(root, file), text);
  put('done.md', '- [x] shipped\nAPI_TOKEN=supersecretvalue\n');
  put('todo.md', '- [ ] next\n');
  put('half.md', '- [x] a\n- [ ] b\n');
  put('old-spec.md', 'Old design\n');
  put('guide.md', '# How to use\n');
  const answers: Record<string, [number, number, number]> = {
    'done.md': [0.9, 0.8, 0.1], 'todo.md': [0.9, 0.2, 0.1], 'half.md': [0.9, 0.8, 0.1], 'old-spec.md': [0.9, 0.2, 0.9], 'guide.md': [0.2, 0.5, 0.5],
  };
  const sent: Record<string, any> = {};
  globalThis.fetch = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body);
    const file = Object.keys(answers).find((f) => body.state.includes(`Document ${f}:`))!;
    sent[file] = body;
    const [planning, finished, conflicts] = answers[file];
    return new Response(JSON.stringify({ model: 'jev', answers: { planning: noul(planning), finished: noul(finished), conflicts: noul(conflicts) }, usage: { input_tokens: 1, output_tokens: 1 } }));
  }) as any;

  const rule: DocCandidate = { file: 'TODO.md', verdict: 'delete', reason: 'rule', open: 0, done: 2, lastModifiedDays: 1 };
  const got = await judgeDocs(root, [rule, ask('done.md'), ask('todo.md', 1), ask('half.md', 1), ask('old-spec.md'), ask('guide.md')], ctx());
  const by = Object.fromEntries(got.map((c) => [c.file, c]));
  assert.deepEqual(by['TODO.md'], rule, 'rule verdicts pass through untouched');
  assert.equal(by['done.md'].verdict, 'delete');
  assert.match(by['done.md'].reason, /planning 0\.90 · finished 0\.80 · conflicts 0\.10/);
  assert.equal(by['todo.md'].verdict, 'merge');
  assert.equal(by['half.md'].verdict, 'archive');
  assert.equal(by['old-spec.md'].verdict, 'archive');
  assert.match(by['old-spec.md'].reason, /contradicts current features/);
  assert.equal(by['guide.md'].verdict, 'ask');
  assert.match(by['guide.md'].reason, /looks like user documentation; not touched/);

  assert.equal(Object.keys(sent).length, 5, 'one request per ask candidate, none for rule verdicts');
  assert.deepEqual(Object.keys(sent['done.md'].questions), ['planning', 'finished', 'conflicts']);
  assert.ok(sent['done.md'].state.includes('# INDEX'), 'INDEX is part of the state');
  assert.ok(!sent['done.md'].state.includes('supersecretvalue') && sent['done.md'].state.includes('[REDACTED'), 'file content is masked');

  const out = renderDocs(got);
  const idx = (s: string) => out.findIndex((l) => l.startsWith(s));
  assert.ok(idx('Merge into a feature') < idx('Archive to docs/cto_jev/archive/') && idx('Archive to docs/cto_jev/archive/') < idx('Needs a look'));
  assert.ok(idx('  half.md  ') > idx('Archive to docs/cto_jev/archive/') && idx('  half.md  ') < idx('Needs a look'));
  assert.match(out.at(-1)!, /only suggests/);
});

test('cto docs: Jev failure or a malformed answer fails open; nothing to ask means no network call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-docs-jev-'));
  writeFileSync(join(root, 'a.md'), '- [ ] x\n');
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('offline'); }) as any;
  let got = await judgeDocs(root, [ask('a.md', 1)], ctx());
  assert.equal(got[0].verdict, 'ask');
  assert.equal(got[0].reason, 'Jev unavailable; decide by hand');
  assert.equal(calls, 1);

  globalThis.fetch = (async () => new Response(JSON.stringify({ answers: { planning: noul(0.9), finished: { type: 'choice', choice: 'yes' } } }))) as any;
  got = await judgeDocs(root, [ask('a.md', 1)], ctx());
  assert.deepEqual([got[0].verdict, got[0].reason], ['ask', 'Jev unavailable; decide by hand']);

  delete process.env.OPENROUTER_API_KEY;
  got = await judgeDocs(root, [ask('a.md', 1)], ctx());
  assert.deepEqual([got[0].verdict, got[0].reason], ['ask', 'Jev unavailable; decide by hand'], 'no key');
  process.env.OPENROUTER_API_KEY = 'k';

  calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('must not be called'); }) as any;
  const rules: DocCandidate[] = [{ file: 'TODO.md', verdict: 'delete', reason: 'rule', open: 0, done: 2, lastModifiedDays: 1 }];
  assert.deepEqual(await judgeDocs(root, rules, ctx()), rules);
  assert.equal(calls, 0);
});
