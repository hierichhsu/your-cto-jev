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
// Not typed by the user: the interrupt marker, and what a slash command echoes or prints into the transcript.
const NOT_TYPED = /^\[Request interrupted by user|<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)>/;
const isRealHuman = (j: any) => isHumanTurn(j) && !NOT_TYPED.test(textOf(j.message?.content).trim());

/**
 * The assistant text the user is answering with `prompt`: every assistant text block after the previous real human
 * message, up to the current prompt (skipped when the transcript already holds it). Undefined when unreadable or no anchor.
 */
export function reviewMessage(transcriptPath: string, prompt: string): string | undefined {
  const lines = readTranscript(transcriptPath);
  if (!lines) return undefined;
  const humans = lines.flatMap((j, i) => (isRealHuman(j) ? [i] : []));
  let end = lines.length;
  const last = humans.at(-1);
  // This prompt is already in the transcript only if the last human entry has its text AND nothing answered it yet;
  // text alone would match an earlier identical reply ("ok" twice) and reach back to an older Review.
  const answered = (i: number) => lines.slice(i + 1).some((j) => j?.type === 'assistant');
  if (last !== undefined && !answered(last) && textOf(lines[last].message?.content).trim() === prompt.trim()) end = humans.pop()!;
  const anchor = humans.at(-1);
  if (anchor === undefined) return undefined;
  return lines.slice(anchor + 1, end).flatMap((j) => (j?.type === 'assistant' && Array.isArray(j.message?.content)
    ? j.message.content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? ''))
    : [])).join('\n');
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
  const at = lines.indexOf(item);
  if (at < 0) return undefined;
  const indent = BOX.exec(item)![1].length;
  for (const l of lines.slice(at + 1)) {
    if (!l.trim()) continue;
    if (l.length - l.trimStart().length <= indent || BOX.test(l)) return undefined; // next item, or a child's own line
    const m = ACCEPT.exec(l);
    if (m) return m[1].replace(/^`+|`+$/g, '').trim() || undefined;
  }
  return undefined;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const MANUAL = /^manual\b/i;
const TASK_ID = /^[A-Z][A-Z0-9]*-\d+(?:\.\d+)*\b/;

/** The final message says this task was accepted manually: the phrase, not negated, in a line naming the task's id. */
function acceptedManually(t: Ticked, lastMessage: string): boolean {
  const id = TASK_ID.exec(t.text)?.[0];
  return lastMessage.split(/\r?\n|(?<=[.。;；])\s*/).some((s) =>
    /accepted manually/i.test(s) && !/\bnot\s+(?:yet\s+)?accepted manually/i.test(s) && (!id || s.includes(id)));
}

/** Ticked `manual` tasks the final message does not report as accepted by the user: a text check, so no model judges it. */
export const manualUnconfirmed = (ticked: Ticked[], lastMessage: string) =>
  ticked.filter((t) => MANUAL.test(squash(t.accept ?? '')) && !acceptedManually(t, lastMessage));

/** `cmd` run as a command of its own: at a command boundary, and not with its failure swallowed (`|| true`). */
const runsCommand = (command: string, cmd: string) => {
  const esc = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[;&|(]\\s*)${esc}\\s*(?:$|&&|;|\\)|\\|(?!\\|))`).test(command);
};

/**
 * Computed, not judged: for each ticked task with an acceptance line, whether that exact command ran and passed after
 * the last code edit, or for `manual`, whether the final message says the user accepted it.
 */
function acceptFacts(ticked: Ticked[], actions: Action[], lastEdit: number, lastMessage: string): string {
  const lines = ticked.filter((t) => t.accept).slice(0, 20).map((t) => {
    const name = oneLine(t.text, 60);
    const cmd = squash(t.accept!);
    if (MANUAL.test(cmd)) {
      return acceptedManually(t, lastMessage)
        ? `"${name}" is accepted by the user (manual), and the final message says it was accepted manually.`
        : `"${name}" is accepted by the user (manual), but the final message does not say the user accepted it.`;
    }
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
