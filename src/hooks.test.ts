import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLOW_DIR } from './flow.js';
import { adrQuestion, driftContext, gitCommit } from './hooks.js';

process.env.CTO_NO_UPDATE_CHECK = '1';
process.env.APPDATA = mkdtempSync(join(tmpdir(), 'cto-home-')); // never read or write the user's real keys and prefs

const answers = (a: Record<string, unknown>) => ({ model: 'jev', answers: a, usage: { input_tokens: 1, output_tokens: 1 } });
const noul = (v: number) => ({ type: 'noul', noul: v });

/** A flow repo with one feature `pay` owning src/pay/ and a product with one non-goal. */
function flowRepo(constraints = '- never store card numbers') {
  const root = mkdtempSync(join(tmpdir(), 'cto-'));
  const dir = join(root, FLOW_DIR, 'features', 'pay');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SPEC.md'), `Status: approved\n\n## Interface\n\n- pay()\n\n## Constraints\n${constraints}\n\n## Internals\n\n- x\n`);
  writeFileSync(join(dir, 'TASKS.md'), '- [ ] PAY-1 charge cards (files: src/pay/)\n');
  writeFileSync(join(root, FLOW_DIR, 'PRODUCT.md'), 'Status: approved\n\n## 目標\n\n- take money\n\n## 不做的事\n\n- no crypto\n');
  writeFileSync(join(root, FLOW_DIR, 'ARCHITECTURE.md'), 'Status: approved\n\n## 技術棧\n\n- node\n\n## 不變的原則\n\n- one database, no queues\n');
  return root;
}

test('driftContext: feature by code scope, SPEC constraints and PRODUCT non-goals', () => {
  const root = flowRepo();
  assert.deepEqual(driftContext(root, ['src/pay/a.ts']), { feature: 'pay', constraints: '- never store card numbers', nonGoals: '- no crypto' });
  assert.equal(driftContext(root, ['src/other.ts']), undefined);
  assert.equal(driftContext(flowRepo(''), ['src/pay/a.ts']), undefined, 'empty Constraints -> nothing to judge against');
  assert.equal(driftContext(flowRepo('unknown'), ['src/pay/a.ts']), undefined, 'skeleton Constraints -> sprint_goal fallback');
  writeFileSync(join(root, FLOW_DIR, 'PRODUCT.md'), 'Status: draft\n\n## 不做的事\n\nunknown\n');
  assert.equal(driftContext(root, ['src/pay/a.ts'])?.nonGoals, '', 'a skeleton "unknown" is not a non-goal');
  assert.equal(driftContext(mkdtempSync(join(tmpdir(), 'cto-')), ['src/pay/a.ts']), undefined, 'no flow folder');
});

test('adrQuestion: without src/, only source files outside dot-directories count; a decisions/*.md record (not .gitkeep) silences it', () => {
  const root = flowRepo(); // no src/ directory on disk
  assert.equal(adrQuestion(root, ['package-lock.json', '.cto.json', '.github/workflows/ci.yml', 'logo.png', 'README.md']), undefined);
  assert.ok(adrQuestion(root, ['cmd/server/main.go']));
  assert.ok(adrQuestion(root, ['cmd/server/main.go', `${FLOW_DIR}/decisions/.gitkeep`]), '.gitkeep is not a record');
  assert.equal(adrQuestion(root, ['cmd/server/main.go', `${FLOW_DIR}/decisions/0001-queue.md`]), undefined);
  writeFileSync(join(root, FLOW_DIR, 'ARCHITECTURE.md'), 'Status: draft\n\n## 不變的原則\n\nunknown\n');
  assert.ok(!adrQuestion(root, ['cmd/server/main.go'])!.instructions.includes('unknown'), 'skeleton principles stay out of the prompt');
});

test('git-commit: architecture question quotes the feature constraints when the diff hits a feature, else the sprint goal', async () => {
  process.env.OPENROUTER_API_KEY = 'k';
  process.env.CTO_PROVIDER = 'openrouter';
  const root = flowRepo();
  writeFileSync(join(root, '.cto.json'), JSON.stringify({ sprint_goal: 'ship billing' }));
  let sent: any;
  globalThis.fetch = (async (_u: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify(answers({ credential_leak: noul(0.1), code_complexity: { type: 'score', score: 0.5 }, architecture_violation: noul(0.1) })));
  }) as any;
  const diff = (p: string) => `diff --git a/${p} b/${p}\n+++ b/${p}\n+const x = 1\n`;

  let out = await gitCommit(diff('src/pay/a.ts'), { root, lang: 'en' });
  assert.equal(out.code, 0);
  let q = sent.questions.architecture_violation.instructions as string;
  assert.ok(q.includes('"pay"') && q.includes('never store card numbers') && q.includes('no crypto'), q);
  assert.ok(!q.includes('ship billing'), 'feature match replaces the sprint goal');
  assert.ok(sent.state.includes('src/pay/a.ts'), 'state is still the diff');

  out = await gitCommit(diff('src/other.ts'), { root, lang: 'en' });
  assert.equal(out.code, 0);
  q = sent.questions.architecture_violation.instructions;
  assert.ok(q.includes('ship billing') && !q.includes('card numbers'), q);
});

test('git-commit: architecture_undocumented asked for code changes in a flow repo with no new decision record', async () => {
  process.env.OPENROUTER_API_KEY = 'k';
  process.env.CTO_PROVIDER = 'openrouter';
  const root = flowRepo();
  let sent: any;
  let adr = noul(0.1);
  globalThis.fetch = (async (_u: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify(answers({ credential_leak: noul(0.1), code_complexity: { type: 'score', score: 0.5 }, architecture_undocumented: adr })));
  }) as any;
  const diff = (...ps: string[]) => ps.map((p) => `diff --git a/${p} b/${p}\n+++ b/${p}\n+const x = 1\n`).join('');

  await gitCommit(diff('src/a.ts'), { root, lang: 'en' });
  const q = sent.questions.architecture_undocumented;
  assert.ok(q && q.instructions.includes('one database, no queues'), 'quotes a principle from ARCHITECTURE.md');
  assert.ok(sent.state.includes('src/a.ts'), 'state is still the diff');

  await gitCommit(diff('src/a.ts', `${FLOW_DIR}/decisions/0001-x.md`), { root, lang: 'en' });
  assert.equal(sent.questions.architecture_undocumented, undefined, 'a decision record in the same commit');

  await gitCommit(diff('README.md'), { root, lang: 'en' });
  assert.equal(sent.questions.architecture_undocumented, undefined, 'markdown only');

  await gitCommit(diff('src/a.ts'), { root: mkdtempSync(join(tmpdir(), 'cto-')), lang: 'en' });
  assert.equal(sent.questions.architecture_undocumented, undefined, 'no flow folder');

  adr = noul(0.95);
  const out = await gitCommit(diff('src/a.ts'), { root, lang: 'en' });
  assert.equal(out.code, 0, 'warning only');
  assert.ok(out.stderr.some((l) => l.includes('architecture change with no decision record') && l.includes('docs/cto_jev/decisions/NNNN-<slug>.md')), out.stderr.join('\n'));
});
