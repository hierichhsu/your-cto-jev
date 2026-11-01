import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './brain.js';
import { FLOW_DIR } from './flow.js';
import { localCommitChecks } from './local.js';

test('flow_signoff: a touched feature with tasks but no approved SPEC blocks; unrelated, approved or task-less features do not', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-'));
  const dir = join(root, FLOW_DIR, 'features', 'perm');
  mkdirSync(dir, { recursive: true });
  const spec = (status: string) => writeFileSync(join(dir, 'SPEC.md'), `# perm SPEC\n\nStatus: ${status}\n`);
  writeFileSync(join(dir, 'TASKS.md'), '# perm TASKS\n\n- [ ] PERM-1 roles (files: src/x/)\n');
  spec('draft');
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
  assert.deepEqual(kinds(sec('src/x/a.ts') + sec(`${FLOW_DIR}/features/perm/TASKS.md`)), [], 'no task ids, nothing to sign off');
});
