import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { FLOW_COMMAND_PATH, FLOW_COMMAND_TEXT, FLOW_SKILL_PATH, FLOW_SKILL_TEXT, SKILL_MARK, SKILL_TEXT, syncFlowSkill, syncGuidance } from './skill.js';

test('the cto skill lists every user-facing command, including the flow ones', () => {
  for (const cmd of ['cto brief', 'cto check', 'cto doctor', 'cto index', 'cto docs']) assert.ok(SKILL_TEXT.includes(`\`${cmd}\``), cmd);
});

test('the flow skill routes every review (docs, wave, release) through the shared findings rules', () => {
  const rules = FLOW_SKILL_TEXT.indexOf('## Review findings');
  assert.ok(rules > 0);
  assert.equal(FLOW_SKILL_TEXT.match(/as under "Review findings"/g)?.length, 4, 'feature, work, work all and release all point there');
  assert.ok(FLOW_SKILL_TEXT.includes('self-review'));
});

test('work runs every wave with a review each; work all reviews once on a branch; both park instead of stopping and never release', () => {
  const all = FLOW_SKILL_TEXT.slice(FLOW_SKILL_TEXT.indexOf('### cto-jev work all'), FLOW_SKILL_TEXT.indexOf('## Review findings'));
  const work = FLOW_SKILL_TEXT.slice(FLOW_SKILL_TEXT.indexOf('## cto-jev work'), FLOW_SKILL_TEXT.indexOf('### cto-jev work all'));
  for (const s of ['Do not ask before a wave and do not stop between waves', '**Stop:** when no task is left to run', 'Never release', '**Review before you commit.**', 'would this test fail']) assert.ok(work.includes(s), s);
  for (const s of ['park the task instead', 'never dispatched again', 'Status: approved', 'git diff <start>..HEAD', 'never before the review', 'Never release', 'Assumed:']) assert.ok(all.includes(s), s);
  assert.ok(FLOW_COMMAND_TEXT.includes('work all'));
  for (const s of ['never drop a task to get past a block', 'never drop in this run', 'names no end-to-end command', 'never how you accept', '\`manual\` only for a \`(look)\` line', 'written from them first and seen failing', 'the CONCEPT decides', 'screenshots at each width', 'Never change a test to match the code']) assert.ok(FLOW_SKILL_TEXT.includes(s), s);
  assert.ok(FLOW_SKILL_TEXT.includes('(dropped: <reason>)') && FLOW_SKILL_TEXT.includes('"<id> dropped"'), 'how to close a task without doing it');
});

test('the flow skill hands docs over with a Review: line, signs via hook or the user, caps reviews at three rounds', () => {
  const t = FLOW_SKILL_TEXT;
  assert.match(t, /^Review: docs\/cto_jev\/features\/<slug>\/CONCEPT\.md$/m, 'a standalone Review: line naming only the CONCEPT');
  assert.ok(t.includes('Review: docs/cto_jev/PRODUCT.md, docs/cto_jev/ARCHITECTURE.md'), 'init lists two, comma-separated');
  for (const s of ['Key points:', 'Might be missing:', 'Data:', 'Assumed: ...', 'Partial agreement signs nothing', "cto's hook sets", 'the user edits the line', 'first set \`Status: draft\` with the Edit tool', 'Shell commands may not write', 'before the CONCEPT is approved', "! sed -i 's/^Status: draft/Status: approved/'", 'never run it yourself', 'reply "ok" to sign', 'Only with another agent', 'whose CONCEPT is not']) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('they set \`Status: approved\`'), 'the user no longer hand-sets approved in Claude Code');
  assert.equal(t.match(/complete: send a review handoff/g)?.length, 2, 'init and feature both stop with a handoff');
  assert.ok(t.includes('which business rules, error cases, roles/permissions or data cases are missing'), 'docs review third question');
  for (const s of ['\`## Constraints\`, \`## Acceptance\`, \`## Internals\`', 'expected result a script can check', '(look)', 'not your guess', 'end-to-end test command']) assert.ok(t.includes(s), s);
  assert.ok(t.includes('At most three rounds per review') && t.includes('If P1s remain after round three') && !t.includes('Do not loop'));
});

test('the flow skill stops for the user only at the CONCEPT sign-off and the release; SPEC and manual tasks wait on nobody', () => {
  const t = FLOW_SKILL_TEXT;
  const between = (a: string, b: string) => t.slice(t.indexOf(a), t.indexOf(b));
  for (const s of ['in exactly two places', 'SPEC.md is yours', 'What the CONCEPT does not decide, you decide', 'Never ask "shall I start?"', 'Park, do not stop,']) assert.ok(between('## Where you stop', '## Sign-off').includes(s), s);
  const signoff = between('## Sign-off', '## cto-jev init');
  assert.ok(!signoff.includes('SPEC.md\`') && !signoff.includes('## Interface'), 'the sign-off rules name no SPEC file or section');
  assert.ok(signoff.includes('SPEC.md carries no Status line'));
  const feature = between('## cto-jev feature', '## cto-jev tasks');
  for (const s of ['Talk before you write, about the CONCEPT only', 'what the user sees when it works', 'Do not walk them through the SPEC', 'No sign-off.', 'SPEC.md: no \`Status:\` line']) assert.ok(feature.includes(s), s);
  for (const s of ['manual: <what to look at> @ <url, command or screenshot path>', '\`manual\` does not wait for the user', 'does not stop a run', 'This is the one place the user reads them']) assert.ok(t.includes(s), s);
  assert.ok(between('## cto-jev tasks', '## cto-jev work').includes('names no end-to-end command, do not ask'), 'a missing e2e command is planned, not asked about');
  for (const s of ['wait for the user to say go', 'Wait for the user to say go', 'accepted manually', 'stops the job there', 'and nothing else', 'command, ask the user', 'ask before adding one']) assert.ok(!t.includes(s), `gone: ${s}`);
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

test('syncGuidance: a CLAUDE.md turned CRLF keeps one rules block, and removal leaves the user text', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-crlf-'));
  const path = join(root, 'CLAUDE.md');
  writeFileSync(path, '# Mine\r\n');
  syncGuidance(root, new Set(['claude']), false);
  writeFileSync(path, readFileSync(path, 'utf8').replace(/\r?\n/g, '\r\n'));
  syncGuidance(root, new Set(['claude']), false);
  assert.equal(readFileSync(path, 'utf8').split('YOUR CTO JEV START').length, 2, 'exactly one block');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/\r?\n/g, '\r\n'));
  syncGuidance(root, new Set(), true);
  assert.equal(readFileSync(path, 'utf8'), '# Mine\r\n');
});
