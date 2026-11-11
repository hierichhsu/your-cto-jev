import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agents, promptOutput } from './agents.js';
import { FLOW_DIR } from './flow.js';
import { agentGuard, agentPre, agentPrompt, agentStop } from './hooks.js';

process.env.CTO_NO_UPDATE_CHECK = '1';
process.env.APPDATA = mkdtempSync(join(tmpdir(), 'cto-home-')); // never read or write the user's real keys and prefs
process.env.OPENROUTER_API_KEY = 'k';
process.env.CTO_PROVIDER = 'openrouter';

const answers = (a: Record<string, unknown>) => ({ model: 'jev', answers: a, usage: { input_tokens: 1, output_tokens: 1 } });
const noul = (v: number) => ({ type: 'noul', noul: v });
let calls = 0;
/** Jev stub: a number answers signoff_approved and destructive_command with it; 'down' makes the call fail. */
function jev(v: number | 'down') {
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (v === 'down') throw new Error('offline');
    return new Response(JSON.stringify(answers({ signoff_approved: noul(v), destructive_command: noul(0.1) })));
  }) as any;
}

const X = `${FLOW_DIR}/features/x`;
const P = `${FLOW_DIR}/PRODUCT.md`;
const CONCEPT_APPROVED = '# x\n\nStatus: approved\n\n## 商業規則\n\n- never store cards\n';
const OLD_SPEC = 'Status: Draft\r\n\r\n## Interface\r\n\r\n- run()\r\n'; // a pre-0.12 SPEC still carries a Status line; nothing reads it

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'cto-signoff-'));
  mkdirSync(join(root, X), { recursive: true });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, X, 'CONCEPT.md'), '# x\n\nStatus: draft\n\nwhy\n');
  writeFileSync(join(root, X, 'SPEC.md'), OLD_SPEC);
  writeFileSync(join(root, P), 'Status: Draft\r\n\r\n## 一句話\r\n\r\n- x\r\n'); // CRLF must survive
  writeFileSync(join(root, 'src', 'a.ts'), 'Status: draft\n');
  return root;
}
const read = (root: string, p: string) => readFileSync(join(root, p), 'utf8');

const L = JSON.stringify;
const human = (text: string) => L({ type: 'user', message: { role: 'user', content: text } });
const said = (text: string) => L({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const REVIEW = `請你看\n**Review:** ${X}/CONCEPT.md, ${X}/SPEC.md, ${P}, src/a.ts\n\n重點：\n- 做 x`;

function prompt(root: string, lines: string[], text = '好') {
  const transcriptPath = join(root, 't.jsonl');
  writeFileSync(transcriptPath, [...lines, human(text)].join('\n') + '\n');
  return agentPrompt({ transcriptPath, cwd: root, prompt: text }, { root, lang: 'zh-TW' });
}

test('promptOutput: both fields, one field, nothing', () => {
  assert.deepEqual(JSON.parse(promptOutput('c', 'u').stdout!), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'c' }, systemMessage: 'u' });
  assert.deepEqual(JSON.parse(promptOutput(undefined, 'u').stdout!), { systemMessage: 'u' });
  assert.deepEqual(promptOutput(), { code: 0, stderr: [] });
});

test('prompt: no Review line or no flow folder -> silent, Jev never called', async () => {
  jev(0.95);
  const root = repo();
  assert.deepEqual(await prompt(root, [human('hi'), said('done, no review here')]), { code: 0, stderr: [] });
  const bare = mkdtempSync(join(tmpdir(), 'cto-signoff-'));
  assert.deepEqual(await prompt(bare, [human('hi'), said(REVIEW)]), { code: 0, stderr: [] });
  assert.equal(calls, 0);
});

test('prompt: a task notification never signs; a prompt not yet in the transcript still finds the Review', async () => {
  jev(0.95);
  const root = repo();
  const transcriptPath = join(root, 't.jsonl');
  writeFileSync(transcriptPath, [human('write x'), said(REVIEW)].join('\n') + '\n');
  assert.deepEqual(await agentPrompt({ transcriptPath, cwd: root, prompt: '<task-notification>\nok\n</task-notification>' }, { root, lang: 'zh-TW' }), { code: 0, stderr: [] });
  assert.equal(calls, 0);
  await agentPrompt({ transcriptPath, cwd: root, prompt: 'ok' }, { root, lang: 'zh-TW' });
  assert.equal(calls, 1);
  assert.match(read(root, P), /^Status: approved\r\n/);
});

test('prompt: Jev agrees -> listed drafts flip to approved, line endings kept, other files untouched', async () => {
  jev(0.95);
  const root = repo();
  const out = await prompt(root, [human('write the spec'), said(REVIEW)]);
  assert.equal(out.code, 0);
  const j = JSON.parse(out.stdout!);
  assert.equal(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(j.hookSpecificOutput.additionalContext, `[cto] 已簽核：${X}/CONCEPT.md, ${P}`);
  assert.equal(j.systemMessage, j.hookSpecificOutput.additionalContext);
  assert.equal(read(root, `${X}/CONCEPT.md`), '# x\n\nStatus: approved\n\nwhy\n');
  assert.equal(read(root, P), 'Status: approved\r\n\r\n## 一句話\r\n\r\n- x\r\n');
  assert.equal(read(root, `${X}/SPEC.md`), OLD_SPEC, 'a SPEC on the Review line is not signed');
  assert.equal(read(root, 'src/a.ts'), 'Status: draft\n', 'not a sign-off doc');
  assert.equal(calls, 1);
});

test('prompt: a Jev score at the threshold (0.8) -> nothing changes, no output', async () => {
  jev(0.8); // the stub's score decides; the reply text is not what is under test
  const root = repo();
  assert.deepEqual(await prompt(root, [human('write the spec'), said(REVIEW)]), { code: 0, stderr: [] });
  assert.match(read(root, `${X}/CONCEPT.md`), /Status: draft/);
  assert.match(read(root, P), /Status: Draft/);
});

test('prompt: Jev unreachable -> signoff_unavailable only, nothing changes', async () => {
  jev('down');
  const root = repo();
  const out = await prompt(root, [human('write the spec'), said(REVIEW)]);
  assert.deepEqual(JSON.parse(out.stdout!), { systemMessage: '[cto] 沒有簽核：判斷服務連不上，可以手改 Status' });
  assert.equal(out.code, 0);
  assert.match(read(root, `${X}/CONCEPT.md`), /Status: draft/);

  calls = 0;
  const again = await prompt(root, [human('write the spec'), said(REVIEW)]);
  assert.deepEqual(JSON.parse(again.stdout!), { systemMessage: '[cto] 沒有簽核：判斷服務剛才失敗，暫停中，稍後再回一次或手改 Status' });
  assert.equal(calls, 0, 'cooling down: no call, and not reported as unreachable again');
});

test('prompt: no API key -> says so, not "unreachable"', async () => {
  jev(0.95);
  delete process.env.OPENROUTER_API_KEY;
  try {
    const out = await prompt(repo(), [human('write the spec'), said(REVIEW)]);
    assert.match(JSON.parse(out.stdout!).systemMessage, /還沒設判斷服務的 API key/);
    assert.equal(calls, 0);
  } finally { process.env.OPENROUTER_API_KEY = 'k'; }
});

test('stop: a doc approved during the turn but not by the hook goes back to draft; signed or pre-approved docs stay', async () => {
  jev(0.95);
  const root = repo();
  const transcriptPath = join(root, 't.jsonl');
  writeFileSync(transcriptPath, [human('write the spec'), said(`Review: ${X}/CONCEPT.md`), human('好')].join('\n') + '\n');
  await agentPrompt({ transcriptPath, cwd: root, prompt: '好', sessionId: 'S' }, { root, lang: 'en' });
  assert.match(read(root, `${X}/CONCEPT.md`), /Status: approved/, 'signed by the hook');

  writeFileSync(join(root, P), 'Status: approved\r\n\r\n## Interface\r\n'); // e.g. sed -i on PROD*.md
  const stop = (stopHookActive: boolean) => agentStop(agents.claude, { sessionId: 'S', cwd: root, lastMessage: 'ok', stopHookActive }, { root, lang: 'en' });
  writeFileSync(join(root, X, 'SPEC.md'), 'Status: approved\r\n'); // the CTO's own doc: never reverted
  const out = await stop(false);
  assert.equal(out.code, 2);
  assert.ok(out.stderr.join('\n').includes(`back to draft: ${P}.`), out.stderr.join('\n'));
  assert.equal(read(root, `${X}/SPEC.md`), 'Status: approved\r\n', 'SPEC is not a sign-off doc');
  assert.equal(read(root, P), 'Status: draft\r\n\r\n## Interface\r\n', 'only the Status value changes');
  assert.match(read(root, `${X}/CONCEPT.md`), /Status: approved/);

  writeFileSync(join(root, P), 'Status: approved\n');
  assert.equal((await stop(false)).code, 2, 'a no-break space after the colon is still caught');
  assert.equal(read(root, P), 'Status: draft\n');

  writeFileSync(join(root, P), 'Status: approved\n');
  assert.equal((await stop(true)).code, 0, 'after a block the stop goes through');
  assert.match(read(root, P), /Status: draft/, 'but the doc is still reverted');

  // A feature's CONCEPT signed by a script after the user's last reply: the doc the commit check trusts.
  const Y = `${FLOW_DIR}/features/y`;
  mkdirSync(join(root, Y), { recursive: true });
  writeFileSync(join(root, Y, 'CONCEPT.md'), '# y\n\nStatus: approved\n\nwhy\n');
  const self = await stop(false);
  assert.equal(self.code, 2);
  assert.ok(self.stderr.join('\n').includes(`back to draft: ${Y}/CONCEPT.md.`), self.stderr.join('\n'));
  assert.equal(read(root, `${Y}/CONCEPT.md`), '# y\n\nStatus: draft\n\nwhy\n');
  assert.match(read(root, `${X}/CONCEPT.md`), /Status: approved/, 'the one the user signed stays');

  // The CONCEPT the user signed: set to draft, rules changed, approved again by a command the guard could not follow.
  writeFileSync(join(root, X, 'CONCEPT.md'), '# x\n\nStatus: approved\n\nwhy, and store cards after all\n');
  const edited = await stop(false);
  assert.equal(edited.code, 2, 'signed content changed during the turn');
  assert.ok(edited.stderr.join('\n').includes(`back to draft: ${X}/CONCEPT.md.`), edited.stderr.join('\n'));
  assert.match(read(root, `${X}/CONCEPT.md`), /Status: draft/);

  // A brain from before 0.12 holds a plain list: still reverts what was not approved, never on content.
  const { loadBrain, saveBrain } = await import('./brain.js');
  const brain = loadBrain(root);
  brain.signoff_baseline = { ...brain.signoff_baseline, old: [P] };
  saveBrain(root, brain);
  writeFileSync(join(root, P), 'Status: approved\nchanged\n');
  const old = (s: string) => agentStop(agents.claude, { sessionId: s, cwd: root, lastMessage: 'ok', stopHookActive: false }, { root, lang: 'en' });
  assert.equal((await old('old')).code, 0, 'listed, no hash: kept');

  writeFileSync(join(root, P), 'Status: approved\n');
  assert.equal((await old('other')).code, 0, 'no baseline: skipped');
});

const guard = (root: string, toolName: string, toolInput: unknown) => agentGuard(agents.claude, { cwd: root, toolName, toolInput }, { root, lang: 'en' });

test('guard: self-approval and protected edits are blocked; demotion, SPEC and other files pass', () => {
  const root = repo();
  const concept = `${X}/CONCEPT.md`;
  const blocked = guard(root, 'Edit', { file_path: join(root, concept), old_string: 'Status: draft', new_string: 'Status: approved' });
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr.join('\n'), /only the user can set Status to approved/);
  assert.doesNotMatch(blocked.stderr.join('\n'), /set Status to draft/, 'the doc is already draft: demoting is no fix');
  assert.equal(guard(root, 'Write', { file_path: P, content: 'Status: approved\n' }).code, 2, 'relative path from the repo root');
  const fromFlow = agentGuard(agents.claude, { cwd: join(root, FLOW_DIR), toolName: 'Write', toolInput: { file_path: 'PRODUCT.md', content: 'Status: approved\n' } }, { root, lang: 'en' });
  assert.equal(fromFlow.code, 2, 'relative path resolved from a cwd other than the root');

  writeFileSync(join(root, concept), CONCEPT_APPROVED);
  assert.equal(guard(root, 'Edit', { file_path: concept, old_string: 'Status: approved', new_string: 'Status: draft' }).code, 0, 'demoting is fine');
  const prot = guard(root, 'Edit', { file_path: concept, old_string: '- never store cards', new_string: '- store cards' });
  assert.equal(prot.code, 2, 'business rules are protected');
  assert.match(prot.stderr.join('\n'), /first use Edit to set Status to draft/);
  const spec = `${X}/SPEC.md`;
  assert.equal(guard(root, 'Edit', { file_path: spec, old_string: 'Status: Draft', new_string: 'Status: approved' }).code, 0, 'SPEC is not signed off');
  assert.equal(guard(root, 'MultiEdit', { file_path: spec, edits: [{ old_string: '- run()', new_string: '- walk()' }] }).code, 0, 'the Interface is the CTO\'s to change');
  assert.equal(guard(root, 'Write', { file_path: 'src/a.ts', content: 'Status: approved\n' }).code, 0, 'not a sign-off doc');

  assert.equal(guard(root, 'Write', { file_path: `${X}/TASKS.md`, content: 'Status: approved\n' }).code, 0, 'TASKS is not signed off');
});

test('guard: PowerShell naming a sign-off doc under docs/cto_jev is blocked, reads too', () => {
  const root = repo();
  assert.equal(guard(root, 'PowerShell', { command: 'Get-Content docs\\cto_jev\\features\\x\\CONCEPT.md' }).code, 2);
  assert.equal(guard(root, 'PowerShell', { command: 'Get-Content docs\\cto_jev\\features\\x\\SPEC.md' }).code, 0, 'SPEC is not signed off');
  assert.equal(guard(root, 'PowerShell', { command: 'Get-ChildItem src' }).code, 0);
});

test('pre: a Bash write to a sign-off doc is blocked before Jev; a read goes on to Jev', async () => {
  jev(0.1);
  const root = repo();
  const pre = (command: string) => agentPre(agents.claude, { command, cwd: root }, { root, lang: 'en' });
  const out = await pre(`sed -i 's/draft/approved/' ${X}/CONCEPT.md`);
  assert.equal(out.code, 2);
  assert.match(out.stderr.join('\n'), /Sign-off is the user's call/);
  assert.equal(calls, 0, 'no Jev call');
  assert.equal((await pre(`cat ${X}/CONCEPT.md`)).code, 0);
  assert.equal(calls, 1);
  assert.equal((await pre(`sed -i 's/run/walk/' ${X}/SPEC.md`)).code, 0, 'a shell write to SPEC is an ordinary command');
  assert.equal(calls, 2);
});
