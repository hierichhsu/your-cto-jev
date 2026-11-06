// Sign-off guard helpers (pure): which doc a path or command touches, what an edit produces, and whether the
// change is the CTO approving its own doc. The hook wiring (I/O, messages) lives elsewhere.
import { posix } from 'node:path';
import { docStatus, FLOW_DIR } from './flow.js';

export const SIGNOFF_DOCS = ['CONCEPT.md', 'SPEC.md', 'PRODUCT.md', 'ARCHITECTURE.md'];
const DOC_NAME = /\b(?:concept|spec|product|architecture)\.md\b/i;
const REVIEW = /^[\s>*+\-_`]*Review[*_`]*\s*:[*_`]*\s*(.*)$/;

/** Paths on the last `Review:` line of a message; tolerates bold, quotes, bullets, backticks and code fences. */
export function reviewPaths(message: string): string[] {
  const line = message.split(/\r?\n/).filter((l) => REVIEW.test(l)).pop();
  if (!line) return [];
  return REVIEW.exec(line)![1].split(/[,，]/).map((p) => p.replace(/^[\s`'"*]+|[\s`'"*]+$/g, '')).filter(Boolean);
}

// Forward slashes, Git Bash `/d/...` to `d:/...`, `..` resolved without climbing above the drive.
function absolute(cwd: string, p: string): string {
  const slash = (s: string) => s.replace(/\\/g, '/').replace(/^\/([a-z])(?=\/|$)/i, '$1:');
  const q = slash(p);
  const full = /^([a-z]:)?\//i.test(q) ? q : `${slash(cwd)}/${q}`;
  const [, drive = '', rest] = /^([a-z]:)?(.*)$/is.exec(full)!;
  return drive.toLowerCase() + posix.normalize(rest).replace(/\/+$/, '');
}

// Repo-relative path, or undefined when it is outside root. Case-insensitive like the file systems it guards.
function relative(root: string, cwd: string, p: string): string | undefined {
  const r = absolute('/', root), full = absolute(cwd, p);
  if (full.toLowerCase() === r.toLowerCase()) return '';
  return full.toLowerCase().startsWith(r.toLowerCase() + '/') ? full.slice(r.length + 1) : undefined;
}

const inFlow = (rel: string | undefined) => rel !== undefined && (rel.toLowerCase() + '/').startsWith(FLOW_DIR + '/');

/** The repo-relative path of a sign-off doc under docs/cto_jev/, or undefined for anything else. */
export function signoffDoc(root: string, cwd: string, p: string): string | undefined {
  const rel = relative(root, cwd, p);
  const name = rel?.split('/').pop()?.toLowerCase();
  return inFlow(rel) && SIGNOFF_DOCS.some((d) => d.toLowerCase() === name) ? rel : undefined;
}

interface Edit { old_string: string; new_string: string; replace_all?: boolean }

/** File content after the tool runs, or undefined when an old_string is missing (the tool fails, nothing to guard). */
export function afterEdit(before: string | undefined, toolName: 'Edit' | 'Write' | 'MultiEdit', input: any): string | undefined {
  if (toolName === 'Write') return String(input?.content ?? '');
  const edits: Edit[] = toolName === 'MultiEdit' ? input?.edits ?? [] : [input];
  let text = before ?? '';
  for (const e of edits) {
    const i = text.indexOf(e.old_string);
    if (i < 0) return undefined;
    // slice/split instead of String.replace, which would expand `$&` and `$$` in new_string
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.slice(0, i) + e.new_string + text.slice(i + e.old_string.length);
  }
  return text;
}

// CONCEPT/PRODUCT/ARCHITECTURE: everything but the Status line. SPEC: `## Interface` up to `## Internals`.
function protectedText(file: string, text: string): string {
  let lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^Status:\s*(draft|approved)\s*$/i.test(l));
  if (/(^|\/)spec\.md$/i.test(file.replace(/\\/g, '/'))) {
    const start = lines.findIndex((l) => /^##\s+Interface\b/.test(l));
    const end = lines.findIndex((l) => /^##\s+Internals\b/.test(l));
    lines = lines.slice(Math.max(start, 0), end < 0 ? undefined : end);
  }
  return lines.join('\n');
}

/** before undefined = new file. Demoting to draft is always ok. */
export function guardVerdict(file: string, before: string | undefined, after: string): 'ok' | 'self_approve' | 'protected_edit' {
  if (docStatus(after) !== 'approved') return 'ok';
  if (before === undefined || docStatus(before) !== 'approved') return 'self_approve';
  return protectedText(file, before) === protectedText(file, after) ? 'ok' : 'protected_edit';
}

/** PowerShell gets no write parser: any mention of a sign-off doc together with docs/cto_jev blocks, reads too. */
export function powershellHitsSignoffDoc(root: string, cwd: string, command: string): boolean {
  if (inFlow(relative(root, '/', cwd))) return true;
  const cmd = command.replace(/\\/g, '/').toLowerCase();
  return DOC_NAME.test(cmd) && cmd.includes(FLOW_DIR);
}

/** For the Bash rule: paths from shellWrites; `?` (target unknown) is let through. */
export function shellWritesSignoffDoc(root: string, cwd: string, writtenPaths: string[]): boolean {
  return writtenPaths.some((p) => p !== '?' && signoffDoc(root, cwd, p) !== undefined);
}
