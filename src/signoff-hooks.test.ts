import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agents, promptOutput } from './agents.js';
import { FLOW_DIR } from './flow.js';
import { agentGuard, agentPre, agentPrompt } from './hooks.js';

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
const SPEC_APPROVED = 'Status: approved\n\n## Interface\n\n- run()\n\n## Constraints\n\n- never store cards\n\n## Internals\n\n- uses a map\n';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'cto-signoff-'));
  mkdirSync(join(root, X), { recursive: true });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, X, 'CONCEPT.md'), '# x\n\nStatus: draft\n\nwhy\n');
  writeFileSync(join(root, X, 'SPEC.md'), 'Status: Draft\r\n\r\n## Interface\r\n\r\n- run()\r\n'); // CRLF must survive
  writeFileSync(join(root, 'src', 'a.ts'), 'Status: draft\n');
  return root;
}
const read = (root: string, p: string) => readFileSync(join(root, p), 'utf8');

const L = JSON.stringify;
const human = (text: string) => L({ type: 'user', message: { role: 'user', content: text } });
const said = (text: string) => L({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const REVIEW = `請你看\n**Review:** ${X}/CONCEPT.md, ${X}/SPEC.md, src/a.ts\n\n重點：\n- 做 x`;

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

test('prompt: Jev agrees -> listed drafts flip to approved, line endings kept, other files untouched', async () => {
  jev(0.95);
  const root = repo();
  const out = await prompt(root, [human('write the spec'), said(REVIEW)]);
  assert.equal(out.code, 0);
  const j = JSON.parse(out.stdout!);
  assert.equal(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(j.hookSpecificOutput.additionalContext, `[cto] 已簽核：${X}/CONCEPT.md, ${X}/SPEC.md`);
  assert.equal(j.systemMessage, j.hookSpecificOutput.additionalContext);
  assert.equal(read(root, `${X}/CONCEPT.md`), '# x\n\nStatus: approved\n\nwhy\n');
  assert.equal(read(root, `${X}/SPEC.md`), 'Status: approved\r\n\r\n## Interface\r\n\r\n- run()\r\n');
  assert.equal(read(root, 'src/a.ts'), 'Status: draft\n', 'not a sign-off doc');
  assert.equal(calls, 1);
});

test('prompt: Jev at or under the threshold -> nothing changes, no output', async () => {
  jev(0.8);
  const root = repo();
  assert.deepEqual(await prompt(root, [human('write the spec'), said(REVIEW)], '好，但 X 改一下'), { code: 0, stderr: [] });
  assert.match(read(root, `${X}/CONCEPT.md`), /Status: draft/);
  assert.match(read(root, `${X}/SPEC.md`), /Status: Draft/);
});

test('prompt: Jev unreachable -> signoff_unavailable only, nothing changes', async () => {
  jev('down');
  const root = repo();
  const out = await prompt(root, [human('write the spec'), said(REVIEW)]);
  assert.deepEqual(JSON.parse(out.stdout!), { systemMessage: '[cto] 沒有簽核：判斷服務連不上，可以手改 Status' });
  assert.equal(out.code, 0);
  assert.match(read(root, `${X}/CONCEPT.md`), /Status: draft/);
});

const guard = (root: string, toolName: string, toolInput: unknown) => agentGuard(agents.claude, { cwd: root, toolName, toolInput }, { root, lang: 'en' });

test('guard: self-approval and protected edits are blocked; demotion, Internals and other files pass', () => {
  const root = repo();
  const spec = `${X}/SPEC.md`;
  const blocked = guard(root, 'Edit', { file_path: join(root, spec), old_string: 'Status: Draft', new_string: 'Status: approved' });
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr.join('\n'), /Sign-off is the user's call/);
  assert.equal(guard(root, 'Write', { file_path: `${X}/CONCEPT.md`, content: 'Status: approved\n' }).code, 2, 'relative path resolved from cwd');

  writeFileSync(join(root, spec), SPEC_APPROVED);
  assert.equal(guard(root, 'Edit', { file_path: spec, old_string: 'Status: approved', new_string: 'Status: draft' }).code, 0, 'demoting is fine');
  assert.equal(guard(root, 'Edit', { file_path: spec, old_string: '- never store cards', new_string: '- store cards' }).code, 2, 'Constraints are protected');
  assert.equal(guard(root, 'MultiEdit', { file_path: spec, edits: [{ old_string: '- uses a map', new_string: '- uses a set' }] }).code, 0, 'Internals stay editable');
  assert.equal(guard(root, 'Write', { file_path: 'src/a.ts', content: 'Status: approved\n' }).code, 0, 'not a sign-off doc');
  assert.equal(guard(root, 'Write', { file_path: `${X}/TASKS.md`, content: 'Status: approved\n' }).code, 0, 'TASKS is not signed off');
});

test('guard: PowerShell naming a sign-off doc under docs/cto_jev is blocked, reads too', () => {
  const root = repo();
  assert.equal(guard(root, 'PowerShell', { command: 'Get-Content docs\\cto_jev\\features\\x\\SPEC.md' }).code, 2);
  assert.equal(guard(root, 'PowerShell', { command: 'Get-ChildItem src' }).code, 0);
});

test('pre: a Bash write to a sign-off doc is blocked before Jev; a read goes on to Jev', async () => {
  jev(0.1);
  const root = repo();
  const pre = (command: string) => agentPre(agents.claude, { command, cwd: root }, { root, lang: 'en' });
  const out = await pre(`sed -i 's/draft/approved/' ${X}/SPEC.md`);
  assert.equal(out.code, 2);
  assert.match(out.stderr.join('\n'), /Sign-off is the user's call/);
  assert.equal(calls, 0, 'no Jev call');
  assert.equal((await pre(`cat ${X}/SPEC.md`)).code, 0);
  assert.equal(calls, 1);
});
