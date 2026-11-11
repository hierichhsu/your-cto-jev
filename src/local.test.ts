import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './brain.js';
import { FLOW_DIR, writeIndex } from './flow.js';
import { t } from './i18n.js';
import { localCommitChecks } from './local.js';

test('flow_signoff: a touched feature with tasks but no approved CONCEPT blocks; unrelated, approved or task-less features do not', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-'));
  const dir = join(root, FLOW_DIR, 'features', 'perm');
  mkdirSync(dir, { recursive: true });
  const concept = (status: string) => writeFileSync(join(dir, 'CONCEPT.md'), `# perm CONCEPT\n\nStatus: ${status}\n`);
  writeFileSync(join(dir, 'TASKS.md'), '# perm TASKS\n\n- [ ] PERM-1 roles (files: src/x/)\n');
  concept('draft'); // no SPEC.md at all: the commit check never reads it
  writeIndex(root); // the index must be fresh, or flow_index_stale joins the findings
  const sec = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n+x\n`;
  const kinds = (d: string) => localCommitChecks(d, loadConfig(root), root, 'feature').map((f) => `${f.kind}${f.block ? '!' : ''}:${f.detail}`);

  assert.deepEqual(kinds(sec('src/x/a.ts')), ['flow_signoff!:perm: CONCEPT.md'], 'a task file scope');
  assert.deepEqual(kinds(sec(`${FLOW_DIR}/features/perm/TASKS.md`)), ['flow_signoff!:perm: CONCEPT.md'], 'the feature folder itself');
  assert.deepEqual(kinds(sec('src/y/b.ts')), [], 'an unrelated commit');
  writeFileSync(join(dir, 'TASKS.md'), '# perm TASKS\n\n- [ ] PERM-1 roles (files: src/x, src/one.ts)\n');
  assert.deepEqual(kinds(sec('src/xy/a.ts')), [], 'a scope without trailing slash does not claim a sibling directory');
  assert.deepEqual(kinds(sec('src/x/a.ts') + sec('src/one.ts')), ['flow_signoff!:perm: CONCEPT.md'], 'the directory itself and a single-file scope');
  writeFileSync(join(dir, 'TASKS.md'), '# perm TASKS\n\n- [ ] PERM-1 roles (files: src\\x, ./src/z/)\n');
  assert.deepEqual(kinds(sec('src/x/a.ts')), ['flow_signoff!:perm: CONCEPT.md'], 'backslash scope');
  assert.deepEqual(kinds(sec('src/z/a.ts')), ['flow_signoff!:perm: CONCEPT.md'], './ scope');
  concept('Approved');
  assert.deepEqual(kinds(sec('src/x/a.ts')), [], 'status is case-insensitive');
  concept('approved');
  assert.deepEqual(kinds(sec('src/x/a.ts')), []);
  rmSync(join(dir, 'CONCEPT.md'));
  assert.deepEqual(kinds(sec('src/x/a.ts')), ['flow_signoff!:perm: CONCEPT.md'], 'missing CONCEPT');
  writeFileSync(join(dir, 'TASKS.md'), '# perm TASKS\n');
  writeIndex(root);
  assert.deepEqual(kinds(sec('src/x/a.ts') + sec(`${FLOW_DIR}/features/perm/TASKS.md`)), [], 'no task ids, nothing to sign off');
});

test('flow_signoff: only CONCEPT.md is signed; a SPEC in any state never blocks', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-'));
  const dir = join(root, FLOW_DIR, 'features', 'perm');
  mkdirSync(dir, { recursive: true });
  const doc = (name: string, status: string) => writeFileSync(join(dir, name), `# perm\n\nStatus: ${status}\n`);
  writeFileSync(join(dir, 'TASKS.md'), '# perm TASKS\n\n- [ ] PERM-1 roles (files: src/x/)\n');
  doc('SPEC.md', 'approved');
  doc('CONCEPT.md', 'draft');
  writeIndex(root);
  const diff = 'diff --git a/src/x/a.ts b/src/x/a.ts\n--- a/src/x/a.ts\n+++ b/src/x/a.ts\n+x\n';
  const kinds = () => localCommitChecks(diff, loadConfig(root), root, 'feature').map((f) => `${f.kind}${f.block ? '!' : ''}:${f.detail}`);

  assert.deepEqual(kinds(), ['flow_signoff!:perm: CONCEPT.md'], 'SPEC approved, CONCEPT draft');
  doc('CONCEPT.md', 'approved');
  assert.deepEqual(kinds(), [], 'both approved');
  doc('SPEC.md', 'draft');
  assert.deepEqual(kinds(), [], 'a pre-0.12 SPEC left at draft');
  rmSync(join(dir, 'SPEC.md'));
  assert.deepEqual(kinds(), [], 'no SPEC yet');
  rmSync(join(dir, 'CONCEPT.md'));
  assert.deepEqual(kinds(), ['flow_signoff!:perm: CONCEPT.md'], 'CONCEPT missing');

  assert.equal(t('en', 'local_flow_signoff', { detail: 'perm: CONCEPT.md' }),
    '[cto] perm has a TASKS.md but CONCEPT.md is not Status: approved. No sign-off, no work: send the user a Review handoff, or remove TASKS.md.');
  assert.match(t('zh-TW', 'local_flow_signoff', { detail: 'perm: CONCEPT.md' }), /^\[cto\] perm 已經有 TASKS\.md，但 CONCEPT\.md 還不是 Status: approved/);
});

test('flow_index_stale / flow_dangling_after: warn only on commits that touch the index inputs or the TASKS.md with the bad id', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-'));
  const dir = join(root, FLOW_DIR, 'features', 'perm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SPEC.md'), '# perm SPEC\n\nStatus: approved\n');
  writeFileSync(join(dir, 'CONCEPT.md'), '# perm CONCEPT\n\nStatus: approved\n');
  const tasksMd = `${FLOW_DIR}/features/perm/TASKS.md`;
  writeFileSync(join(root, tasksMd), '# perm TASKS\n\n- [ ] PERM-1 roles (files: src/x/)\n- [ ] PERM-2 scopes (after: NOPE-1)\n');
  const sec = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n+x\n`;
  const kinds = (d: string) => localCommitChecks(d, loadConfig(root), root, 'feature').map((f) => `${f.kind}${f.block ? '!' : ''}:${f.detail}`);

  assert.deepEqual(kinds(sec(tasksMd)), [`flow_index_stale:${FLOW_DIR}/INDEX.md`, 'flow_dangling_after:PERM-2 → NOPE-1'], 'INDEX missing, TASKS.md touched');
  assert.deepEqual(kinds(sec('src/x/a.ts')), [], 'stale index, but the commit changes none of its inputs');
  writeIndex(root);
  assert.deepEqual(kinds(sec(tasksMd) + sec(`${FLOW_DIR}/INDEX.md`)), ['flow_dangling_after:PERM-2 → NOPE-1'], 'index regenerated and committed along');
  assert.deepEqual(kinds(sec(`${FLOW_DIR}/features/other/TASKS.md`)), [], 'dangling id lives in a TASKS.md this diff does not touch');
  writeFileSync(join(root, tasksMd), '# perm TASKS\n\n- [ ] PERM-1 roles (files: src/x/)\n- [ ] PERM-1 again\n');
  writeIndex(root);
  assert.deepEqual(kinds(sec(tasksMd) + sec(`${FLOW_DIR}/INDEX.md`)), ['flow_duplicate_id:PERM-1'], 'duplicate id in a touched TASKS.md');
  writeFileSync(join(root, tasksMd), '# perm TASKS\n\n- [ ] PERM-1 badge\n      驗收: manual\n- [ ] PERM-2 list\n      驗收: manual: 375px 不橫向捲動 @ http://localhost:3000/list\n- [x] PERM-3 old\n      accept: manual\n- [ ] PERM-4 api\n      accept: `npm test`\n- [ ] PERM-5 logo\n      accept: `manual`\n');
  writeIndex(root);
  assert.deepEqual(kinds(sec(tasksMd) + sec(`${FLOW_DIR}/INDEX.md`)), ['flow_manual_bare:PERM-1', 'flow_manual_bare:PERM-5'], 'open manual tasks that do not say what to look at, in backticks too');
  assert.deepEqual(kinds(sec('src/x/a.ts')), [], 'only when the commit touches that TASKS.md');
  assert.match(t('zh-TW', 'local_flow_manual_bare', { detail: 'PERM-1' }), /^\[cto\] PERM-1：驗收行只寫 manual/);
});

test('flow_interface: warn when a SPEC diff touches the ## Interface section, naming the features that depend on it', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-'));
  const feat = (slug: string, tasks: string) => {
    const dir = join(root, FLOW_DIR, 'features', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SPEC.md'), `# ${slug} SPEC\n\nStatus: approved\n\n## Interface\n\n- a\n\n## Constraints\n\n- b\n\n## Internals\n\n- c\n`);
    writeFileSync(join(dir, 'CONCEPT.md'), `# ${slug} CONCEPT\n\nStatus: approved\n`);
    writeFileSync(join(dir, 'TASKS.md'), `# ${slug} TASKS\n\n${tasks}`);
  };
  feat('perm', '- [ ] PERM-1 roles (files: src/x/)\n');
  feat('cust', '- [ ] CUST-1 list (after: PERM-1)\n');
  writeIndex(root);
  const diff = (slug: string, hunk: string) => {
    const p = `${FLOW_DIR}/features/${slug}/SPEC.md`;
    return `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${hunk}`;
  };
  const kinds = (d: string) => localCommitChecks(d, loadConfig(root), root, 'feature').map((f) => `${f.kind}${f.block ? '!' : ''}:${f.detail}`);

  assert.deepEqual(kinds(diff('perm', '@@ -5,3 +5,4 @@\n ## Interface\n \n+- new export\n - a\n')), ['flow_interface:perm → cust'], 'heading as context line');
  assert.deepEqual(kinds(diff('perm', '@@ -13,3 +13,4 @@\n ## Internals\n \n+- new export\n - c\n')), [], 'same change under Internals');
  assert.deepEqual(kinds(diff('perm', '@@ -5,3 +5,4 @@\n ## Interface\n \n-- a\n ## Constraints\n+- new rule\n')), ['flow_interface:perm → cust'], 'removal counts; later section does not reset the finding');
  // Line 7 is `- a` under Interface; no heading in the hunk and git's header names none for markdown.
  assert.deepEqual(kinds(diff('perm', '@@ -7,1 +7,2 @@ Status: approved\n - a\n+- new export\n')), ['flow_interface:perm → cust'], 'edit below the heading, heading not in the hunk');
  assert.deepEqual(kinds(diff('perm', '@@ -11,1 +11,2 @@ Status: approved\n - b\n+- new rule\n')), [], 'same shape under Constraints');
  assert.deepEqual(kinds(diff('cust', '@@ -5,3 +5,4 @@\n ## Interface\n \n+- new export\n - a\n')), [], 'no feature depends on cust: nobody to warn');
  const p = `${FLOW_DIR}/features/perm/SPEC.md`;
  assert.deepEqual(kinds(`diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,3 @@\n+## Interface\n+\n+- a\n`), [], 'a new SPEC has no previous Interface');
  assert.match(t('en', 'local_flow_interface', { detail: 'a → b' }), /^\[cto\] a → b: the SPEC's Interface changed/);
});
