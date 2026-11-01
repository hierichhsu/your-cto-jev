import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLOW_DIR } from './flow.js';
import { driftContext, gitCommit } from './hooks.js';

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
  return root;
}

test('driftContext: feature by code scope, SPEC constraints and PRODUCT non-goals', () => {
  const root = flowRepo();
  assert.deepEqual(driftContext(root, ['src/pay/a.ts']), { feature: 'pay', constraints: '- never store card numbers', nonGoals: '- no crypto' });
  assert.equal(driftContext(root, ['src/other.ts']), undefined);
  assert.equal(driftContext(flowRepo(''), ['src/pay/a.ts']), undefined, 'empty Constraints -> nothing to judge against');
  assert.equal(driftContext(mkdtempSync(join(tmpdir(), 'cto-')), ['src/pay/a.ts']), undefined, 'no flow folder');
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
