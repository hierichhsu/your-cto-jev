import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { maskSensitiveState } from './masker.js';
import type { Ticked, TurnAction } from './types.js';
import { shellWrites } from './shellwrites.js';

// Reads a Claude Code transcript (JSONL) and summarises the current turn for the end-of-turn "done?" check.

export type Action = TurnAction;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Edits that no local test could check: docs, CI and other YAML config.
const NON_CODE = /(\.(md|mdx|txt|rst|adoc|ya?ml)$)|(^|[\\/])\.github[\\/]/i;
export const isCodeFile = (f: string) => !NON_CODE.test(f);

export const isHumanTurn = (j: any) => {
  // Claude Code writes meta entries (image notes, skill text, compact summaries) as type "user" mid-turn.
  if (j?.type !== 'user' || j.isMeta || j.isCompactSummary) return false;
  const c = j.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b) => b?.type === 'text') && !c.some((b) => b?.type === 'tool_result');
};

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
};
const tailOf = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? '…' + flat.slice(-max) : flat;
};

/** Parsed JSONL entries, skipping broken lines; undefined when the file can't be read. */
const readTranscript = (path: string): any[] | undefined => {
  try {
    return readFileSync(path, 'utf8').split('\n').flatMap((l) => {
      try { return l ? [JSON.parse(l)] : []; } catch { return []; }
    });
  } catch { return undefined; }
};

const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n') : '';
// Entries the assistant never answers: the interrupt marker and command output. Anything else in a human slot
// (typed text, a slash command, a task notification) starts a new exchange, so a Review before it is no longer the
// message being answered.
const NO_REPLY = /^(?:\[Request interrupted by user|<(?:local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>)/;
const isRealHuman = (j: any) => isHumanTurn(j) && !NO_REPLY.test(textOf(j.message?.content).trim());

/**
 * The assistant text the user is answering with `prompt`: every assistant text block after the previous real human
 * message, up to the current prompt (skipped when the transcript already holds it). Undefined when unreadable or no anchor.
 */
export function reviewMessage(transcriptPath: string, prompt: string): string | undefined {
  const lines = readTranscript(transcriptPath);
  if (!lines) return undefined;
  // A prompt typed while the assistant was busy is logged as a queued_command attachment; it is the user's move too,
  // so a Review written after it was typed is not what it answers.
  const queued = (j: any) => j?.type === 'attachment' && j.attachment?.type === 'queued_command';
  const humans = lines.flatMap((j, i) => (isRealHuman(j) || queued(j) ? [i] : []));
  const said = (j: any) => (queued(j) ? String(j.attachment.prompt ?? '') : textOf(j.message?.content));
  let end = lines.length;
  const last = humans.at(-1);
  // This prompt was typed while the assistant was still working: whatever it answers, it was not the Review written since.
  if (last !== undefined && queued(lines[last]) && said(lines[last]).trim() === prompt.trim()) return undefined;
  // This prompt is already in the transcript only if the last human entry has its text AND nothing answered it yet;
  // text alone would match an earlier identical reply ("ok" twice) and reach back to an older Review.
  const answered = (i: number) => lines.slice(i + 1).some((j) => j?.type === 'assistant');
  if (last !== undefined && !answered(last) && said(lines[last]).trim() === prompt.trim()) end = humans.pop()!;
  const anchor = humans.at(-1);
  if (anchor === undefined) return undefined;
  return lines.slice(anchor + 1, end).flatMap((j) => (j?.type === 'assistant' && Array.isArray(j.message?.content)
    ? j.message.content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? ''))
    : [])).join('\n');
}

/**
 * Tool calls, and sub-agents dispatched, since the user's last message. A background agent's completion notice is
 * not the user, so it does not start a new count. Undefined when the transcript can't be read.
 */
export function turnCounts(transcriptPath: string): { tools: number; agents: number } | undefined {
  const lines = readTranscript(transcriptPath);
  if (!lines) return undefined;
  let start = 0;
  lines.forEach((j, i) => { if (isHumanTurn(j) && !/^\s*<task-notification>/.test(textOf(j.message?.content))) start = i + 1; });
  let tools = 0, agents = 0;
  for (const j of lines.slice(start)) {
    if (j?.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
    for (const b of j.message.content) if (b?.type === 'tool_use') { tools++; if (b.name === 'Agent' || b.name === 'Task') agents++; }
  }
  return { tools, agents };
}

/** Actions since the last human message, oldest first. Unreadable or partial transcripts give what could be parsed. */
export function turnActions(transcriptPath: string, cwd?: string): Action[] {
  const lines = readTranscript(transcriptPath);
  if (!lines) return [];
  let start = 0;
  lines.forEach((j, i) => { if (isHumanTurn(j)) start = i + 1; });

  const results = new Map<string, { ok: boolean; text: string }>();
  for (const j of lines.slice(start)) {
    const c = j?.type === 'user' ? j.message?.content : null;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type !== 'tool_result') continue;
      const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x?.text ?? '').join(' ') : '';
      results.set(b.tool_use_id, { ok: !b.is_error, text });
    }
  }

  const actions: Action[] = [];
  for (const j of lines.slice(start)) {
    const c = j?.type === 'assistant' ? j.message?.content : null;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type !== 'tool_use') continue;
      if (EDIT_TOOLS.has(b.name)) {
        const p = String(b.input?.file_path ?? b.input?.notebook_path ?? '');
        if (p) actions.push({ kind: 'edit', file: cwd ? relative(cwd, p) || p : p });
      } else if (b.name === 'Bash' || b.name === 'PowerShell') {
        const r = results.get(b.id);
        if (!r) continue; // not finished (or transcript lagging): no evidence either way
        const command = String(b.input?.command ?? '');
        // A successful shell command that writes files is an edit too (sed -i, redirects, formatters). Listed before
        // the run itself, since in "sed -i ... && npm test" the write happens before the test.
        if (r.ok) for (const f of shellWrites(command)) actions.push({ kind: 'edit', file: f === '?' ? `(files written by: ${oneLine(command, 60)})` : f });
        actions.push({ kind: 'run', command, ok: r.ok, tail: r.text });
      }
    }
  }
  return actions;
}

export const BOX = /^(\s*)[-*+] \[([ xX])\]\s+(.*)$/;
/** A task's acceptance line (cto-flow TASKS.md): `驗收: <command>` or `accept: <command>`, or `manual`. */
export const ACCEPT = /^\s*(?:驗收|accept)[:：]\s*(.+?)\s*$/i;
const itemKey = (file: string, text: string) => `${file}:${text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60)}`;

/**
 * Checklist items a unified diff of markdown files marks done: every added "[x]" line, except ones that were already
 * "[x]" before (reworded or moved). Works for any plan format that uses checkboxes (spec-kit, GSD, Kiro, specOS...),
 * whatever tool wrote the file. `read` returns a file's current text, for the lines nested under each item.
 */
export function tickedItems(diff: string, read: (file: string) => string | undefined): Ticked[] {
  let file = '';
  const before: string[] = [];
  const added: { file: string; text: string; line: string }[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
    if (line.startsWith('--- ')) continue;
    const m = BOX.exec(line.slice(1));
    if (!m || m[2] === ' ') continue;
    if (line[0] === '-') before.push(itemKey(file, m[3]));
    else if (line[0] === '+') added.push({ file, text: m[3].trim(), line: line.slice(1) });
  }
  // Already done before when one wording extends the other ("Fix X" -> "Fix X (see #12)").
  const wasDone = (k: string) => before.some((b) => k.startsWith(b) || b.startsWith(k));
  return added.filter((a) => !wasDone(itemKey(a.file, a.text))).map(({ line, ...a }) => {
    const text = read(a.file);
    // Only cto-flow TASKS.md carry acceptance lines; elsewhere "驗收：" is usually prose, not a command.
    const accept = a.file.startsWith('docs/cto_jev/') ? acceptOf(text, line) : undefined;
    return { ...a, children: nested(text, line), ...(accept && { accept }) };
  });
}

/** The acceptance line indented under `item`, before any nested item or anything at the item's depth or lower. */
function acceptOf(text: string | undefined, item: string): string | undefined {
  const lines = text?.split(/\r?\n/) ?? [];
  // The item itself, not an identical line inside an earlier fenced example (parseTasks skips those).
  let at = -1;
  for (let i = 0, inFence = false; i < lines.length && at < 0; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    else if (!inFence && lines[i] === item) at = i;
  }
  if (at < 0) return undefined;
  const indent = BOX.exec(item)![1].length;
  let fenced = false; // as parseTasks: a fenced example under the item is not its acceptance line
  for (const l of lines.slice(at + 1)) {
    if (!l.trim()) continue;
    const depth = l.length - l.trimStart().length;
    if (/^\s*(```|~~~)/.test(l)) { if (depth <= indent) return undefined; fenced = !fenced; continue; }
    if (fenced) continue;
    if (depth <= indent || BOX.test(l)) return undefined; // next item, or a child's own line
    const m = ACCEPT.exec(l);
    if (m) return acceptValue(m[1]);
  }
  return undefined;
}

/** What follows `驗收:` / `accept:`, without the backticks it may be wrapped in: the one reading for brief, commit and stop. */
export const acceptValue = (raw: string) => raw.replace(/^`+|`+$/g, '').trim() || undefined;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
// `manual` as a word (`manual`, `manual: x`, `manual check x`); not a command that starts with it (`manual-check.sh`).
const MANUAL = /^manual(?![\w./-])/i;
export const isManualAccept = (accept: string | undefined) => MANUAL.test(squash(accept ?? ''));
const TASK_ID = /^[A-Z][A-Z0-9]*-\d+(?:\.\d+)*\b/;

const DROPPED = /[(（]dropped[:：]\s*[^)）\s][^)）]*[)）]/i;
/** A task closed without doing it: `(dropped: reason)` on its line, then ticked. */
export const isDropped = (t: Ticked) => DROPPED.test(t.text);
/** The task's id, or its first words when it has none: how messages name it. */
export const taskName = (t: Ticked) => TASK_ID.exec(t.text)?.[0] ?? squash(t.text.replace(DROPPED, '')).slice(0, 30);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ANY_ID = '[A-Z][A-Z0-9]*-\\d+(?:\\.\\d+)*';
// What may sit between a task's name and the phrase: other ids, list punctuation, markdown, and a few verbs. A "not",
// "never" or "n't" is none of these, so a negated report does not count, nor does one about the next task.
const JOIN = `(?:[ \\t,，、:：*\`()（）]|\\band\\b|和|與|${ANY_ID})*(?:\\b(?:was|were|is|are|has been|have been|both|now)\\s+)*`;
const LIST = `(?:[\\s,，、*\`()（）-]|\\band\\b|${ANY_ID})*`;

/** A task only a person can judge: `驗收: manual`, or `manual: <what to look at> @ <where>`. */
export const isManual = (t: Ticked) => isManualAccept(t.accept);
/** What the user is asked to look at: the text after `manual:`, or the task's own words when the line says nothing. */
export const lookText = (t: Ticked) => squash(t.accept ?? '').replace(/^manual\s*[:：]?\s*/i, '') || squash(t.text.replace(TASK_ID, ''));

/**
 * The final message reports a dropped task as "dropped". Either the task's name then the word ("A-1, A-2 dropped"),
 * or the word then a list naming it ("Dropped:\n- A-1"). Reported in the message so the user sees every drop.
 */
function reportedDropped(t: Ticked, lastMessage: string): boolean {
  const id = TASK_ID.exec(t.text)?.[0];
  const word = 'dropped';
  // The id as a whole token: "A-12" or "A-1.2" does not name A-1, while "A-1." at a sentence end does.
  const me = id ? `(?<![\\w.-])${esc(id)}(?![\\w]|\\.\\d)` : esc(taskName(t));
  return new RegExp(`${me}${JOIN}${word}`, 'i').test(lastMessage)
    || new RegExp(`(?<!\\bnot\\s|\\bnever\\s|n't\\s)${word}\\s*[:：]${LIST}${me}`, 'i').test(lastMessage);
}

/** Ticked dropped tasks the final message does not report as dropped: a text check, so no model judges it. */
export const droppedUnreported = (ticked: Ticked[], lastMessage: string) =>
  ticked.filter((t) => isDropped(t) && !reportedDropped(t, lastMessage));

/** `cmd` run as a command of its own: at a command boundary, and not with its failure swallowed (`|| true`). */
const runsCommand = (command: string, cmd: string) => {
  const esc = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[;&|(]\\s*)${esc}\\s*(?:$|&&|;|\\)|\\|(?!\\|))`).test(command);
};

/**
 * Computed, not judged: for each ticked task with an acceptance line, whether that exact command ran and passed after
 * the last code edit. A `manual` task has no command: the user looks at it later, and nothing waits on that.
 */
function acceptFacts(ticked: Ticked[], actions: Action[], lastEdit: number, lastMessage: string): string {
  const lines = ticked.filter((t) => t.accept).slice(0, 20).map((t) => {
    const name = oneLine(t.text, 60);
    const cmd = squash(t.accept!);
    if (isDropped(t)) {
      return reportedDropped(t, lastMessage)
        ? `"${name}" is dropped (closed without doing it), and the final message reports it as dropped: nothing to accept.`
        : `"${name}" is dropped (closed without doing it), but the final message does not report it as dropped.`;
    }
    if (MANUAL.test(cmd)) return `"${name}" is for the user to look at later (manual): it has no acceptance command to run.`;
    const runs = actions.flatMap((a, i) => (a.kind === 'run' && runsCommand(squash(a.command), cmd) ? [{ i, ok: a.ok }] : []));
    if (runs.some((r) => r.i > lastEdit && r.ok)) return `"${name}": its acceptance command \`${cmd}\` ran after the last code edit and passed.`;
    if (runs.some((r) => r.ok)) return `"${name}": its acceptance command \`${cmd}\` passed, but only before the last code edit.`;
    if (runs.length) return `"${name}": its acceptance command \`${cmd}\` ran this turn and failed.`;
    return `"${name}": its acceptance command \`${cmd}\` did not run this turn.`;
  });
  return lines.length ? `\nFact: ${lines.join('\nFact: ')}` : '';
}

/** Checklist lines indented under `item` in `text` (at most 15). */
function nested(text: string | undefined, item: string): string[] {
  const lines = text?.split(/\r?\n/) ?? [];
  const at = lines.indexOf(item);
  if (at < 0) return [];
  const indent = BOX.exec(item)![1].length;
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.trim()) continue;
    const m = BOX.exec(l);
    if (!m || m[1].length <= indent) break;
    out.push(`[${m[2] === ' ' ? ' ' : 'x'}] ${m[3].trim()}`);
  }
  return out.slice(0, 15);
}

/** Only said when some item has nested items: "none open" next to plain items reads as support for them. */
function openParents(ticked: Ticked[]): string {
  if (!ticked.some((t) => t.children.length)) return '';
  const open = ticked.filter((t) => t.children.some((c) => c.startsWith('[ ]')));
  return '\nFact: ' + (open.length
    ? `${open.length} of the items marked done still have unchecked nested items: ${open.map((t) => oneLine(t.text, 60)).join('; ')}.`
    : 'every nested item under the items marked done is checked.');
}

export const tickedKey =(t: Ticked) => itemKey(t.file, t.text);

/** The text Jev sees: final message, the action log, the checklist items marked done, and the one fact code can compute exactly. Masked. */
export function turnState(lastMessage: string, actions: Action[], ticked: Ticked[] = []): string {
  // The fact is computed over the whole turn; only the log shown to Jev is trimmed.
  let lastEdit = -1;
  actions.forEach((a, i) => { if (a.kind === 'edit' && isCodeFile(a.file)) lastEdit = i; });
  const after = lastEdit < 0 ? null : actions.slice(lastEdit + 1).flatMap((a) => (a.kind === 'run' ? [oneLine(a.command, 120)] : []));
  const recent = actions.slice(-40);
  const fact = after === null
    ? 'No code files were edited this turn.'
    : after.length ? `Commands that ran after the last code edit: ${after.join('; ')}` : 'No command ran after the last code edit.';
  const log = recent.length
    ? recent.map((a, i) => a.kind === 'edit'
      ? `${i + 1}. edited ${a.file}`
      : `${i + 1}. ran: ${oneLine(a.command, 200)} -> ${a.ok ? 'succeeded' : 'FAILED'}${a.tail ? `\n   output tail: ${tailOf(a.tail, 200)}` : ''}`).join('\n')
    : '(none)';
  const plan = ticked.length
    ? `\n\nPlan checklist items marked done this turn:\n` + ticked.slice(0, 20).map((t) =>
      `- ${t.file}: ${oneLine(t.text, 200)}${t.children.length ? `\n  nested items: ${t.children.map((c) => oneLine(c, 80)).join('; ')}` : ''}`).join('\n') + openParents(ticked) + acceptFacts(ticked, actions, lastEdit, lastMessage)
    : '';
  return maskSensitiveState(
    `The agent's final message to the user:\n"""\n${tailOf(lastMessage, 1500)}\n"""\n\nActions this turn, in order:\n${log}${plan}\n\nFact: ${fact}`,
  );
}
