import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { AGENT_FILES, FLOW_COMMAND_PATH, FLOW_COMMAND_TEXT, FLOW_SKILL_PATH, FLOW_SKILL_TEXT, SKILL_MARK, SKILL_TEXT, syncFlowSkill, syncGuidance } from './skill.js';

test('the cto skill lists every user-facing command, including the flow ones', () => {
  for (const cmd of ['cto brief', 'cto check', 'cto doctor', 'cto index', 'cto docs']) assert.ok(SKILL_TEXT.includes(`\`${cmd}\``), cmd);
});

test('the flow skill routes every review (docs, wave, release) through the shared findings rules', () => {
  const rules = FLOW_SKILL_TEXT.indexOf('## Review findings');
  assert.ok(rules > 0);
  assert.equal(FLOW_SKILL_TEXT.match(/as under "Review findings"/g)?.length, 4, 'feature, work, work all and release all point there');
  assert.ok(FLOW_SKILL_TEXT.includes('self-review'));
});

test('work runs every wave with a review each; work all reviews every wave on a branch; both park instead of stopping and never release', () => {
  const all = FLOW_SKILL_TEXT.slice(FLOW_SKILL_TEXT.indexOf('### cto-jev work all'), FLOW_SKILL_TEXT.indexOf('## Review findings'));
  const work = FLOW_SKILL_TEXT.slice(FLOW_SKILL_TEXT.indexOf('## cto-jev work'), FLOW_SKILL_TEXT.indexOf('### cto-jev work all'));
  for (const s of ['Do not ask before a wave and do not stop between waves', '**Stop:** when no task is left to run', 'Never release', '**Review before you commit.**', 'would this test fail']) assert.ok(work.includes(s), s);
  for (const s of ['park the task instead', 'never dispatched again', 'Status: approved', 'git diff <start>..HEAD', "never before the last wave's review", 'Never release', 'Assumed:']) assert.ok(all.includes(s), s);
  assert.ok(FLOW_COMMAND_TEXT.includes('work all'));
  for (const s of ['never drop a task to get past a block', 'never drop in this run', 'names no end-to-end command', 'never how you accept', '\`manual\` only for a \`(look)\` line', 'written from them first and seen failing', 'the CONCEPT decides', 'screenshots at each width', 'Never change a test to match the code']) assert.ok(FLOW_SKILL_TEXT.includes(s), s);
  assert.ok(FLOW_SKILL_TEXT.includes('(dropped: <reason>)') && FLOW_SKILL_TEXT.includes('"<id> dropped"'), 'how to close a task without doing it');
});

test('a wave runs only its own acceptance and its features e2e; full suites at cleanup and release; no menu mid-run; e2e only for Acceptance scenarios', () => {
  const t = FLOW_SKILL_TEXT;
  const work = t.slice(t.indexOf('## cto-jev work'), t.indexOf('### cto-jev work all'));
  assert.ok(work.includes("plus the end-to-end tests of the features it touches (\`e2e/<slug>/\`)") && work.includes('run the whole end-to-end suite instead'), 'scoped e2e, full on shared files');
  assert.ok(work.includes('once in a feature\'s cleanup wave and once in the release, never in every wave'), 'full suites not per wave');
  assert.ok(t.slice(t.indexOf('## cto-jev release')).includes('The whole unit and end-to-end suites and \`cto check --base'), 'release runs everything');
  assert.ok(t.includes('Never open the question menu (AskUserQuestion) or ask a question in the middle of') && t.includes("You stop at a sign-off, a run's final report and the release, never mid-run."), 'no menu mid-run');
  for (const s of ['End-to-end tests live in \`e2e/<feature slug>/\`', 'Only Acceptance scenarios get an end-to-end test', 'one shared check per page', "A finding task's test is a unit or database test"]) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('customers.spec.ts'), 'the example uses the per-feature folder');
  assert.ok(!/e2e\/[\w-]+\.(spec|test)\.[jt]s/.test(t), 'no example test file sits in the e2e/ root');
  assert.ok(work.includes('add a \`platform\` task for the split whose text starts exactly \`Split the end-to-end tests into feature folders\`, in English whatever language') && work.includes('tagged \`(seq)\`, whose \`(files:)\` hold \`e2e/\` plus each file') && work.includes("that holds the test runner's file pattern"), 'brief knows the split task by its text, and its runner config is in scope');
  assert.ok(work.includes("never in every wave. Like a wave that changes a \`platform\` or shared file, a wave that touches a feature whose end-to-end tests are not yet in \`e2e/<slug>/\` runs the whole end-to-end suite"), 'an old flat layout is never skipped, and it reads as an exception like platform files');
  assert.ok(work.includes('When \`cto brief\` lists test files outside every feature folder (in the \`e2e/\` root or a flat folder such as \`e2e/tests/\`), do not move them on your own: put "split the end-to-end tests into feature folders?" in the run\'s final report menu'), 'the split is asked, at the end of a run');
  for (const s of ['The split goes test by test, not file by file', 'goes to the feature whose SPEC holds its scenario', 'goes to \`e2e/platform/\`', 'with as many tests as before', 'set \`"e2e_folders": false\` in \`.cto.json\`']) assert.ok(work.includes(s), s);
});

test('findings below P1 wait for a per-feature cleanup wave, and what its review finds is parked, so findings never chain wave after wave', () => {
  const work = FLOW_SKILL_TEXT.slice(FLOW_SKILL_TEXT.indexOf('## cto-jev work'), FLOW_SKILL_TEXT.indexOf('### cto-jev work all'));
  const rules = FLOW_SKILL_TEXT.slice(FLOW_SKILL_TEXT.indexOf('## Review findings'), FLOW_SKILL_TEXT.indexOf('## cto-jev release'));
  assert.ok(work.includes('wait while their feature has any other Ready task you would dispatch') && work.includes('Review finding (wave <ids>):'), 'work defers and marks finding tasks');
  for (const s of ['batched, not chained', 'one review over the whole cleanup and one commit', 'does not become a task', 'Left for the user:', 'parked tasks, finding tasks and tasks blocked on a finding task do not count', 'in any wording']) assert.ok(rules.includes(s), s);
  assert.ok(!rules.includes('no other open task'), 'a parked task or a second finding task never holds the cleanup back');
  assert.ok(work.includes('in English whatever language'), 'one fixed marker to recognise finding tasks by');
  assert.ok(work.includes("A cleanup wave's review is the exception: its P2s become no task"), 'step 5 does not file cleanup findings as tasks');
  assert.ok(work.includes('A cleanup wave runs alone'), 'one review never mixes a cleanup with a normal wave');
  const reviewer = AGENT_FILES['cto-reviewer.md'];
  assert.ok(reviewer.includes('names the input or state that produces the wrong result') && reviewer.includes('is not reported'), 'the reviewer drops behaviour findings without a failure case');
  assert.ok(reviewer.includes('skipped, deleted or loosened, a broken Constraint or Interface') && reviewer.includes('report them as they are'), 'findings that have no failing input are still reported');
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
  for (const s of ['waits for the user in one place only: before the merge', 'SPEC.md is yours', 'What the CONCEPT does not decide, you decide', 'Never ask "shall I start?"', 'Park, do not stop,']) assert.ok(between('## Where you stop', '## Sign-off').includes(s), s);
  const signoff = between('## Sign-off', '## cto-jev init');
  assert.ok(!signoff.includes('SPEC.md\`') && !signoff.includes('## Interface'), 'the sign-off rules name no SPEC file or section');
  assert.ok(signoff.includes('SPEC.md carries no Status line'));
  const feature = between('## cto-jev feature', '## cto-jev tasks');
  for (const s of ['Talk before you write, about the CONCEPT only', 'what the user sees when it works', 'Do not walk them through the SPEC', 'No sign-off.', 'SPEC.md: no \`Status:\` line']) assert.ok(feature.includes(s), s);
  for (const s of ['manual: <what to look at> @ <url, command or screenshot path>', '\`manual\` does not wait for the user', 'does not stop a run', 'This is the one place the user reads them']) assert.ok(t.includes(s), s);
  assert.ok(t.includes('never dropped by you'), 'only the user drops a task');
  assert.ok(between('## cto-jev tasks', '## cto-jev work').includes('names no end-to-end command, do not ask'), 'a missing e2e command is planned, not asked about');
  for (const s of ['wait for the user to say go', 'Wait for the user to say go', 'accepted manually', 'stops the job there', 'and nothing else', 'command, ask the user', 'ask before adding one', 'or what it checks is gone', 'in exactly two places']) assert.ok(!t.includes(s), `gone: ${s}`);
});

test('cto-jev decide: one menu for everything waiting on the user; Sign-off sends Claude Code there at every stop', () => {
  const t = FLOW_SKILL_TEXT;
  const decide = t.slice(t.indexOf('## cto-jev decide'), t.indexOf('## Never'));
  assert.ok(decide.length > 20, 'the job exists before ## Never');
  for (const s of ['(Recommended)', '之後再選', 'Assumed:', 'at most 4 questions', 'one doc per question', 'Approve', 'only the user drops', 'write the decision back', 'becomes a new task', 'other agents list them as text', 'Review: <repo-relative path>', 'multiSelect', 'prefill', '"Other"', 'never point to "listed above"', 'one question each, quoting the line', 'equals an offered label exactly']) assert.ok(decide.includes(s), s);
  const signoff = t.slice(t.indexOf('## Sign-off'), t.indexOf('## cto-jev init'));
  assert.ok(signoff.includes('whenever you stop for the user, put what waits on them in a menu as under "cto-jev decide"'));
  assert.ok(FLOW_COMMAND_TEXT.includes('decide') && t.includes('Eight jobs'));
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

// ---------- MOD-5: the skill's review, wave and escalation text ----------

test('MOD-5: every code review is dispatched as cto-reviewer with no model parameter, on the whole change', () => {
  const work = FLOW_SKILL_TEXT.slice(FLOW_SKILL_TEXT.indexOf('## cto-jev work'), FLOW_SKILL_TEXT.indexOf('### cto-jev work all'));
  assert.ok(work.includes('`subagent_type: "cto-reviewer"` with no model parameter'), 'the wave review');
  assert.ok(work.includes('the whole uncommitted change of the wave'), 'the whole change, not a part');
  assert.ok(FLOW_SKILL_TEXT.includes('`subagent_type: "cto-reviewer"` with no model parameter and none of your context'), 'the release review');
});

test('MOD-5: after fixing P1s the reviewer runs again on the whole change, never on the fix alone', () => {
  const work = FLOW_SKILL_TEXT.slice(FLOW_SKILL_TEXT.indexOf('## cto-jev work'), FLOW_SKILL_TEXT.indexOf('### cto-jev work all'));
  assert.ok(work.includes('dispatch again on the whole change, never on the fix alone'));
  assert.ok(FLOW_SKILL_TEXT.includes('re-reviews the whole current change, never the fix alone'));
});

test('MOD-5: work all reviews every wave before its commit; no per-wave or end-of-run review wording is left', () => {
  const all = FLOW_SKILL_TEXT.slice(FLOW_SKILL_TEXT.indexOf('### cto-jev work all'), FLOW_SKILL_TEXT.indexOf('## Review findings'));
  assert.ok(all.includes('Every wave is reviewed before its commit'), 'each wave reviewed');
  for (const s of ['There is no per-wave review', 'reviewed at the end', 'one review at the end', 'one zero-context review']) {
    assert.ok(!FLOW_SKILL_TEXT.includes(s), `no leftover: ${s}`);
  }
  const row = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8').split('\n').find((l) => l.includes('`cto-jev work all`')) ?? '';
  assert.ok(row.includes('every wave reviewed'), 'the README job table row');
  assert.ok(!row.includes('at the end'), 'the README row has no end-of-run review');
});

test('MOD-5: a P1 still open after three rounds is written into REVIEW.md as escalated to the user, which the gate accepts', () => {
  assert.ok(FLOW_SKILL_TEXT.includes('If P1s remain after round three, stop fixing: write each one into the REVIEW.md entry marked as escalated to the user (the commit gate accepts that)'));
});

test('MOD-5: a dispatch prompt names what to review and the verify command; it never dictates the verdict or drops changed paths', () => {
  const work = FLOW_SKILL_TEXT.slice(FLOW_SKILL_TEXT.indexOf('## cto-jev work'), FLOW_SKILL_TEXT.indexOf('### cto-jev work all'));
  assert.ok(work.includes('the verify command from `cto brief`'), 'names the verify command');
  assert.ok(work.includes('never dictates the verdict and never drops a changed path'), 'no verdict, no dropped paths');
});

test('without sub-agents, a self-review cannot pass the commit gate where Claude Code is wired: the wave is parked or handed to Claude Code', () => {
  assert.ok((FLOW_SKILL_TEXT.match(/a self-review cannot pass the commit gate/g) ?? []).length >= 2, 'the work step and the work all step');
  assert.ok(FLOW_SKILL_TEXT.includes("keep the wave's tasks ticked, leave the tree uncommitted, stop the run, and say in the final report that the wave is waiting for a cto-reviewer review in a Claude Code session"));
  assert.ok(FLOW_SKILL_TEXT.includes('if the tree holds uncommitted code from ticked tasks'), 'the first step in work');
  assert.ok(FLOW_SKILL_TEXT.includes('first, if the tree holds uncommitted code from ticked tasks, a Claude Code session reviews it with `cto-reviewer` and commits it before dispatching anything new; any other agent stops there'), 'the first step in work all');
  assert.ok(FLOW_SKILL_TEXT.includes('Any other agent stops here, reports that the wave is still waiting for a Claude Code session, and dispatches nothing new'), 'the first step in work: other agents stop');
  assert.ok(FLOW_SKILL_TEXT.includes("run the project's formatter, if any, so the review sees the final tree"), 'the formatter before the reviewer');
  assert.ok(FLOW_SKILL_TEXT.includes('only a Claude Code session can satisfy the gate, so other agents (with or without sub-agents) hand the wave over'), 'step 5 says who can pass the gate');
  assert.ok(FLOW_SKILL_TEXT.includes('that self-review cannot pass the commit gate: keep its tasks ticked, leave the tree uncommitted, stop the run, and say in the final report that it is waiting for a cto-reviewer review in a Claude Code session'), 'the review findings rule');
  assert.ok(!FLOW_SKILL_TEXT.includes("untick the wave's tasks") && !FLOW_SKILL_TEXT.includes('untick its tasks'), 'no untick in the handover');
  assert.ok(FLOW_SKILL_TEXT.includes('In the `main`-only row without a `work-all` branch the wave review'), 'the main-only row is named');
  assert.ok(!FLOW_SKILL_TEXT.includes('park the wave') && !FLOW_SKILL_TEXT.includes('park it, or hand it'), 'no park-the-wave wording');
});

test('a work-all branch in a main-only repo is released by reviewing git diff main...work-all, the user merges, the branch is deleted', () => {
  assert.ok(FLOW_SKILL_TEXT.includes('`git diff main...work-all`, the user merges it into `main`, then the branch is deleted'));
  assert.ok(FLOW_SKILL_TEXT.includes('| `main` only, after `work all` |') && FLOW_SKILL_TEXT.includes('| `git diff main...work-all` |'), 'the release table row');
  assert.ok(FLOW_SKILL_TEXT.includes('| `main` only, no `work-all` branch |'), 'the first row names no work-all branch');
});

test('README rows: cto-jev work reviews the whole change again with cto-reviewer; work all hands over to release and never merges', () => {
  const rows = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8').split('\n');
  const work = rows.find((l) => l.startsWith('| `cto-jev work` |')) ?? '';
  const all = rows.find((l) => l.startsWith('| `cto-jev work all` |')) ?? '';
  assert.ok(work.includes('the whole change reviewed again by `cto-reviewer`'));
  assert.ok(all.includes('then hands over to `cto-jev release`, never merges'));
});
