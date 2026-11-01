import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './brain.js';
import { FLOW_DIR, writeIndex } from './flow.js';
import { t } from './i18n.js';
import { localCommitChecks } from './local.js';

test('flow_signoff: a touched feature with tasks but no approved SPEC blocks; unrelated, approved or task-less features do not', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-'));
  const dir = join(root, FLOW_DIR, 'features', 'perm');
  mkdirSync(dir, { recursive: true });
  const spec = (status: string) => writeFileSync(join(dir, 'SPEC.md'), `# perm SPEC\n\nStatus: ${status}\n`);
  writeFileSync(join(dir, 'TASKS.md'), '# perm TASKS\n\n- [ ] PERM-1 roles (files: src/x/)\n');
  spec('draft');
  writeIndex(root); // the index must be fresh, or flow_index_stale joins the findings
  const sec = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n+x\n`;
  const kinds = (d: string) => localCommitChecks(d, loadConfig(root), root, 'feature').map((f) => `${f.kind}${f.block ? '!' : ''}:${f.detail}`);

  assert.deepEqual(kinds(sec('src/x/a.ts')), ['flow_signoff!:perm'], 'a task file scope');
  assert.deepEqual(kinds(sec(`${FLOW_DIR}/features/perm/TASKS.md`)), ['flow_signoff!:perm'], 'the feature folder itself');
  assert.deepEqual(kinds(sec('src/y/b.ts')), [], 'an unrelated commit');
  spec('approved');
  assert.deepEqual(kinds(sec('src/x/a.ts')), []);
  rmSync(join(dir, 'SPEC.md'));
  assert.deepEqual(kinds(sec('src/x/a.ts')), ['flow_signoff!:perm'], 'missing SPEC');
  writeFileSync(join(dir, 'TASKS.md'), '# perm TASKS\n');
  writeIndex(root);
  assert.deepEqual(kinds(sec('src/x/a.ts') + sec(`${FLOW_DIR}/features/perm/TASKS.md`)), [], 'no task ids, nothing to sign off');
});

test('flow_index_stale / flow_dangling_after: warn only on commits that touch the index inputs or the TASKS.md with the bad id', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-'));
  const dir = join(root, FLOW_DIR, 'features', 'perm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SPEC.md'), '# perm SPEC\n\nStatus: approved\n');
  const tasksMd = `${FLOW_DIR}/features/perm/TASKS.md`;
  writeFileSync(join(root, tasksMd), '# perm TASKS\n\n- [ ] PERM-1 roles (files: src/x/)\n- [ ] PERM-2 scopes (after: NOPE-1)\n');
  const sec = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n+x\n`;
  const kinds = (d: string) => localCommitChecks(d, loadConfig(root), root, 'feature').map((f) => `${f.kind}${f.block ? '!' : ''}:${f.detail}`);

  assert.deepEqual(kinds(sec(tasksMd)), [`flow_index_stale:${FLOW_DIR}/INDEX.md`, 'flow_dangling_after:PERM-2 → NOPE-1'], 'INDEX missing, TASKS.md touched');
  assert.deepEqual(kinds(sec('src/x/a.ts')), [], 'stale index, but the commit changes none of its inputs');
  writeIndex(root);
  assert.deepEqual(kinds(sec(tasksMd) + sec(`${FLOW_DIR}/INDEX.md`)), ['flow_dangling_after:PERM-2 → NOPE-1'], 'index regenerated and committed along');
  assert.deepEqual(kinds(sec(`${FLOW_DIR}/features/other/TASKS.md`)), [], 'dangling id lives in a TASKS.md this diff does not touch');
});

test('flow_interface: warn when a SPEC diff touches the ## Interface section, naming the features that depend on it', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-'));
  const feat = (slug: string, tasks: string) => {
    const dir = join(root, FLOW_DIR, 'features', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SPEC.md'), `# ${slug} SPEC\n\nStatus: approved\n\n## Interface\n\n- a\n\n## Constraints\n\n- b\n\n## Internals\n\n- c\n`);
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
