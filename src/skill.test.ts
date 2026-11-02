import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { FLOW_COMMAND_PATH, FLOW_COMMAND_TEXT, FLOW_SKILL_PATH, FLOW_SKILL_TEXT, SKILL_MARK, SKILL_TEXT, syncFlowSkill } from './skill.js';

test('the cto skill lists every user-facing command, including the flow ones', () => {
  for (const cmd of ['cto brief', 'cto check', 'cto doctor', 'cto index', 'cto docs']) assert.ok(SKILL_TEXT.includes(`\`${cmd}\``), cmd);
});

test('the flow skill routes every review (docs, wave, release) through the shared findings rules', () => {
  const rules = FLOW_SKILL_TEXT.indexOf('## Review findings');
  assert.ok(rules > 0);
  assert.equal(FLOW_SKILL_TEXT.match(/as under "Review findings"/g)?.length, 3, 'feature, work and release all point there');
  assert.ok(FLOW_SKILL_TEXT.includes('self-review'));
});

test('syncFlowSkill writes /cto-jev for Claude Code only, and removes the 0.9.x cto-flow skill', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-jev-cmd-'));
  const legacy = join(root, '.agents/skills/cto-flow/SKILL.md');
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, `---\nname: cto-flow\n---\n${SKILL_MARK}\n`);

  assert.deepEqual(syncFlowSkill(root, true, true, true), { written: [FLOW_SKILL_PATH, FLOW_COMMAND_PATH], removed: ['.agents/skills/cto-flow/SKILL.md'] });
  assert.ok(existsSync(legacy), 'dry run writes nothing');
  assert.deepEqual(syncFlowSkill(root, true, false, true).removed, ['.agents/skills/cto-flow/SKILL.md']);
  assert.ok(!existsSync(dirname(legacy)));
  assert.equal(readFileSync(join(root, FLOW_COMMAND_PATH), 'utf8'), FLOW_COMMAND_TEXT);
  assert.ok(FLOW_COMMAND_TEXT.includes(FLOW_SKILL_PATH) && FLOW_COMMAND_TEXT.includes('$ARGUMENTS'));

  assert.deepEqual(syncFlowSkill(root, true, false, false), { written: [], removed: [FLOW_COMMAND_PATH] }); // Claude unpicked
  assert.deepEqual(syncFlowSkill(root, false, false, true), { written: [], removed: [FLOW_SKILL_PATH] });

  const mine = join(root, FLOW_COMMAND_PATH); // a user's own command of the same name is never touched
  mkdirSync(dirname(mine), { recursive: true });
  writeFileSync(mine, 'my own\n');
  assert.deepEqual(syncFlowSkill(root, true, false, true), { written: [FLOW_SKILL_PATH], removed: [] }, 'not overwritten');
  assert.deepEqual(syncFlowSkill(root, false), { written: [], removed: [FLOW_SKILL_PATH] }, 'not removed');
  assert.equal(readFileSync(mine, 'utf8'), 'my own\n');
});

test('syncFlowSkill writes the marked cto-jev skill when enabled and removes it when not', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-flow-skill-'));
  const path = join(root, FLOW_SKILL_PATH);

  assert.deepEqual(syncFlowSkill(root, true), { written: [FLOW_SKILL_PATH], removed: [] });
  const text = readFileSync(path, 'utf8');
  assert.ok(text.startsWith('---\nname: cto-jev\n'));
  assert.ok(text.includes(SKILL_MARK));
  assert.deepEqual(syncFlowSkill(root, true), { written: [], removed: [] }); // idempotent

  assert.deepEqual(syncFlowSkill(root, false), { written: [], removed: [FLOW_SKILL_PATH] });
  assert.ok(!existsSync(path));
  assert.ok(!existsSync(dirname(path)));
  assert.deepEqual(syncFlowSkill(root, false), { written: [], removed: [] });
});
