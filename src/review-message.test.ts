import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { docStatus } from './flow.js';
import { reviewMessage } from './turn.js';

const user = (content: unknown) => ({ type: 'user', message: { content } });
const say = (...text: string[]) => ({ type: 'assistant', message: { content: text.map((t) => ({ type: 'text', text: t })) } });
const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } };
const result = user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);

const transcript = (entries: unknown[]) => {
  const p = join(mkdtempSync(join(tmpdir(), 'cto-review-')), 't.jsonl');
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n{broken');
  return p;
};

test('reviewMessage: assistant text after the anchor, current prompt skipped, tool entries ignored', () => {
  const p = transcript([user('old'), say('before'), user('write the spec'), say('working'), tool, result, say('Review: a.md', '重點：x'), user([{ type: 'text', text: ' ok ' }])]);
  assert.equal(reviewMessage(p, 'ok'), 'working\nReview: a.md\n重點：x');
  // The transcript does not hold this prompt yet: the last human message is the anchor.
  assert.equal(reviewMessage(p, 'something else'), '');
  const q = transcript([user('write the spec'), say('Review: a.md')]);
  assert.equal(reviewMessage(q, 'ok'), 'Review: a.md');
});

test('reviewMessage: interrupt markers, slash command output and meta entries are not anchors; an interrupted reply is', () => {
  const p = transcript([
    user('write the spec'), say('Review: a.md'),
    user('wait'), say('half'), user([{ type: 'text', text: '[Request interrupted by user]' }]),
    user('<command-name>/cost</command-name>\n<command-message>cost</command-message>'),
    user('<local-command-stdout>$0.12</local-command-stdout>'),
    { type: 'user', isMeta: true, message: { content: 'skill text' } },
    say('after'), user('ok'),
  ]);
  assert.equal(reviewMessage(p, 'ok'), 'half\nafter');
});

test('reviewMessage: the same reply twice, second not yet in the transcript, answers the latest Review only', () => {
  const p = transcript([user('write it'), say('Review: a.md'), user('ok'), say('Review: b.md')]);
  assert.equal(reviewMessage(p, 'ok'), 'Review: b.md');
});

test('reviewMessage: a background task notification is not an anchor', () => {
  const p = transcript([user('write it'), say('Review: a.md'), user('<task-notification>\n<result>ok</result>\n</task-notification>'), say('noted')]);
  assert.equal(reviewMessage(p, 'ok'), 'Review: a.md\nnoted');
});

test('reviewMessage: unreadable file or no anchor is undefined', () => {
  assert.equal(reviewMessage(join(tmpdir(), 'cto-no-such-transcript.jsonl'), 'ok'), undefined);
  assert.equal(reviewMessage(transcript([say('hi'), user('ok')]), 'ok'), undefined);
  assert.equal(reviewMessage(transcript([user('[Request interrupted by user]'), say('hi')]), 'ok'), undefined);
});

test('docStatus: first draft/approved Status line, any case; otherwise missing', () => {
  assert.equal(docStatus('# X\nStatus: unknown\nstatus: APPROVED\nStatus: draft\n'), 'approved');
  assert.equal(docStatus('Status: Draft\r\n'), 'draft');
  assert.equal(docStatus('Status: approved later\n'), 'missing');
  assert.equal(docStatus(''), 'missing');
});
