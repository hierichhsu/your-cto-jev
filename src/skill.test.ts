import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { FLOW_SKILL_PATH, SKILL_MARK, syncFlowSkill } from './skill.js';

test('syncFlowSkill writes the marked cto-flow skill when enabled and removes it when not', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-flow-skill-'));
  const path = join(root, FLOW_SKILL_PATH);

  assert.deepEqual(syncFlowSkill(root, true), { written: [FLOW_SKILL_PATH], removed: [] });
  const text = readFileSync(path, 'utf8');
  assert.ok(text.startsWith('---\nname: cto-flow\n'));
  assert.ok(text.includes(SKILL_MARK));
  assert.deepEqual(syncFlowSkill(root, true), { written: [], removed: [] }); // idempotent

  assert.deepEqual(syncFlowSkill(root, false), { written: [], removed: [FLOW_SKILL_PATH] });
  assert.ok(!existsSync(path));
  assert.ok(!existsSync(dirname(path)));
  assert.deepEqual(syncFlowSkill(root, false), { written: [], removed: [] });
});
