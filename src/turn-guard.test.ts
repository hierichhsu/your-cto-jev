import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agents } from './agents.js';
import { agentPre, agentPrompt, agentStop } from './hooks.js';

process.env.CTO_NO_UPDATE_CHECK = '1';
process.env.APPDATA = mkdtempSync(join(tmpdir(), 'cto-home-')); // never read or write the user's real keys and prefs
process.env.OPENROUTER_API_KEY = 'k';
process.env.CTO_PROVIDER = 'openrouter';
globalThis.fetch = (async () => new Response(JSON.stringify({ model: 'jev', answers: { destructive_command: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }))) as any;

const MIN = 60_000;
const L = JSON.stringify;
const human = (text: string) => L({ type: 'user', message: { role: 'user', content: text } });
const uses = (n: number, name = 'Read') => Array.from({ length: n }, (_, i) => L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `${name}${i}`, name, input: {} }] } }));

test('turn-guard: a turn past a limit is told once, never blocked; a new user message starts over', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-turn-'));
  const transcriptPath = join(root, 't.jsonl');
  writeFileSync(transcriptPath, [human('go'), ...uses(3)].join('\n') + '\n');
  let clock = 1_000_000;
  const env = { root, lang: 'en' as const, now: () => clock };
  const prompt = (p: string) => agentPrompt({ sessionId: 'S', cwd: root, transcriptPath, prompt: p }, env);
  const pre = () => agentPre(agents.claude, { sessionId: 'S', cwd: root, transcriptPath, command: 'ls' }, env);

  await prompt('go');
  await pre(); // the session's first command carries the once-per-session provider notice
  clock += 5 * MIN;
  assert.deepEqual(await pre(), { code: 0, stderr: [] }, 'under every limit: silent');

  clock += 16 * MIN;
  const sub = await agentPre(agents.claude, agents.claude.parsePre({ session_id: 'S', cwd: root, transcript_path: transcriptPath, agent_id: 'a1', tool_input: { command: 'ls' } })!, env);
  assert.deepEqual(sub, { code: 0, stderr: [] }, "a sub-agent's command does not use up the reminder");
  const out = await pre();
  assert.equal(out.code, 0, 'never blocks');
  const j = JSON.parse(out.stdout!);
  assert.match(j.hookSpecificOutput.additionalContext, /This turn has run 21 min, 3 tool calls, 0 sub-agents\. Stop and tell the user/);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(j.systemMessage, /the agent has been asked to stop and report/);
  assert.deepEqual(await pre(), { code: 0, stderr: [] }, 'once per turn');

  await prompt('<task-notification>\ndone\n</task-notification>');
  clock += 21 * MIN;
  assert.deepEqual(await pre(), { code: 0, stderr: [] }, 'a background agent finishing is not a new turn');

  await prompt('next');
  clock += 1 * MIN;
  writeFileSync(transcriptPath, [human('go'), ...uses(3), human('next'), ...uses(2, 'Agent'), human('<task-notification>x</task-notification>'), ...uses(3, 'Agent')].join('\n') + '\n');
  const agentsOut = await pre();
  assert.match(JSON.parse(agentsOut.stdout!).hookSpecificOutput.additionalContext, /1 min, 5 tool calls, 5 sub-agents/, 'a new turn counts from the new message; more than 4 sub-agents');

  await prompt('again');
  writeFileSync(transcriptPath, [human('again'), ...uses(151)].join('\n') + '\n');
  assert.match(JSON.parse((await pre()).stdout!).hookSpecificOutput.additionalContext, /151 tool calls/, 'more than 150 tool calls');
});

test('turn-guard: a stop ends the turn, so a background agent running on afterwards is not reminded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-turn-'));
  const transcriptPath = join(root, 't.jsonl');
  writeFileSync(transcriptPath, [human('go'), ...uses(1)].join('\n') + '\n');
  let clock = 1_000_000;
  const env = { root, lang: 'en' as const, now: () => clock };
  const pre = () => agentPre(agents.claude, { sessionId: 'S', cwd: root, transcriptPath, command: 'ls' }, env);
  await agentPrompt({ sessionId: 'S', cwd: root, transcriptPath, prompt: 'go' }, env);
  await pre(); // provider notice
  await agentStop(agents.claude, { sessionId: 'S', cwd: root, transcriptPath, lastMessage: 'ok', stopHookActive: false }, env);
  clock += 25 * MIN;
  assert.deepEqual(await pre(), { code: 0, stderr: [] });
});

test('turn-guard: limits come from .cto.json, 0 turns one off; without a transcript only time counts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-turn-'));
  writeFileSync(join(root, '.cto.json'), L({ turn_limits: { minutes: 0, agents: 1 } }));
  let clock = 1_000_000;
  const env = { root, lang: 'zh-TW' as const, now: () => clock };
  const transcriptPath = join(root, 't.jsonl');
  writeFileSync(transcriptPath, [human('go'), ...uses(1, 'Agent')].join('\n') + '\n');
  await agentPrompt({ sessionId: 'S', cwd: root, transcriptPath, prompt: 'go' }, env);
  await agentPre(agents.claude, { sessionId: 'S', cwd: root, transcriptPath, command: 'ls' }, env); // provider notice
  clock += 120 * MIN;
  assert.deepEqual(await agentPre(agents.claude, { sessionId: 'S', cwd: root, transcriptPath, command: 'ls' }, env), { code: 0, stderr: [] }, 'minutes off, one sub-agent is not more than 1');

  writeFileSync(transcriptPath, [human('go'), ...uses(2, 'Agent')].join('\n') + '\n');
  const out = await agentPre(agents.claude, { sessionId: 'S', cwd: root, transcriptPath, command: 'ls' }, env);
  assert.match(JSON.parse(out.stdout!).systemMessage, /^\[cto\] 這一輪已經跑了 120 分鐘、2 次工具呼叫、2 個 sub-agent，已請 agent 停下來回報。$/);

  writeFileSync(join(root, '.cto.json'), '{}');
  await agentPrompt({ sessionId: 'T', cwd: root, prompt: 'go' }, env);
  clock += 25 * MIN;
  const timeOnly = await agentPre(agents.claude, { sessionId: 'T', cwd: root, command: 'ls' }, env);
  assert.match(JSON.parse(timeOnly.stdout!).hookSpecificOutput.additionalContext, /25 分鐘、\? 次工具呼叫/, 'no transcript: time alone');
});
