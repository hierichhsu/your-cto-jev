// Sign-off guard helpers (pure): which doc a path or command touches, what an edit produces, and whether the
// change is the CTO approving its own doc. The hook wiring (I/O, messages) lives elsewhere.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { docStatus, FLOW_DIR } from './flow.js';
import { maskSensitiveState } from './masker.js';

export const SIGNOFF_DOCS = ['CONCEPT.md', 'SPEC.md', 'PRODUCT.md', 'ARCHITECTURE.md'];
const DOC_NAME = /\b(?:concept|spec|product|architecture)\.md\b/i;
const REVIEW = /^[\s>*+\-_`]*Review[*_`]*\s*:[*_`]*\s*(.*)$/;

const lastReview = (lines: string[]) => lines.findLastIndex((l) => REVIEW.test(l));

/** Paths on the last `Review:` line of a message; tolerates bold, quotes, bullets, backticks and code fences. */
export function reviewPaths(message: string): string[] {
  const lines = message.split(/\r?\n/);
  const i = lastReview(lines);
  if (i < 0) return [];
  return REVIEW.exec(lines[i])![1].split(/[,，]/).map((p) => p.replace(/^[\s`'"*]+|[\s`'"*]+$/g, '')).filter(Boolean);
}

// The handoff sections after the key points (zh and en wording from the skill).
const AFTER_KEY_POINTS = /^[\s>*+\-_`]*(?:可能漏掉的?|資料|Might be missing|Data)[*_`]*\s*[:：]/i;
export const SIGNOFF_CTO_CHARS = 800;
const unquote = (s: string) => maskSensitiveState(s).replace(/"{3,}/g, '"');

/** Jev input for signoff_approved: the last Review line and its key points (capped), then the user's reply; neither can forge the delimiters. */
export function signoffState(review: string, prompt: string): string {
  const lines = review.split(/\r?\n/);
  const start = Math.max(lastReview(lines), 0);
  const end = lines.findIndex((l, i) => i > start && AFTER_KEY_POINTS.test(l));
  const cto = unquote(lines.slice(start, end < 0 ? undefined : end).join('\n').trim()).slice(0, SIGNOFF_CTO_CHARS);
  return `CTO (written by the agent):\n"""\n${cto}\n"""\n\nUSER (the user's reply):\n"""\n${unquote(prompt.trim())}\n"""`;
}

// Forward slashes, `\\?\` dropped, Git Bash `/d/...` to `d:/...`, `..` resolved without climbing above the drive.
function absolute(cwd: string, p: string): string {
  const slash = (s: string) => s.replace(/\\/g, '/').replace(/^\/\/[?.]\//, '').replace(/^\/([a-z])(?=\/|$)/i, '$1:');
  const q = slash(p);
  const full = /^([a-z]:)?\//i.test(q) ? q : `${slash(cwd)}/${q}`;
  const [, drive = '', rest] = /^([a-z]:)?(.*)$/is.exec(full)!;
  return drive.toLowerCase() + posix.normalize(rest).replace(/\/+$/, '');
}

// An NTFS stream (`SPEC.md::$DATA`, `SPEC.md:x`) is the same file. Only the last segment: `:` is legal in POSIX folder names.
const noStream = (full: string) => full.replace(/(\/[^/:]*):[^/]*$/, '$1');

// 8.3 short names (`ARCHIT~1.MD`) and symlinks: the deepest part that exists becomes its real long path.
function real(p: string): string {
  let head = p, tail = '';
  while (!existsSync(head)) {
    const i = head.lastIndexOf('/');
    if (i <= 0 || /^[a-z]:$/i.test(head.slice(0, i))) return p;
    tail = head.slice(i) + tail;
    head = head.slice(0, i);
  }
  try { return absolute('/', realpathSync.native(head)) + tail; } catch { return p; }
}

// Repo-relative path, or undefined when it is outside root. Case-insensitive like the file systems it guards.
// The path as written first, so a symlinked docs/cto_jev or doc stays guarded; then the real paths, for 8.3 names.
function relative(root: string, cwd: string, p: string): string | undefined {
  const r = absolute('/', root), full = noStream(absolute(cwd, p));
  return inside(r, full) ?? inside(real(r), real(full));
}

function inside(r: string, full: string): string | undefined {
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
  let lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => docStatus(l) === 'missing');
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
  // git add/diff/log on a sign-off doc is how its changes get committed; only git, in every statement, passes.
  // shortcut: git checkout/restore can still rewrite a doc this way; the pre-commit check is the backstop.
  if (command.split(/;|&&|\|\||\|/).every((s) => /^\s*git\s/i.test(s))) return false;
  if (inFlow(relative(root, '/', cwd))) return true;
  const cmd = command.replace(/\\/g, '/').toLowerCase();
  return DOC_NAME.test(cmd) && cmd.includes(FLOW_DIR);
}

/**
 * For the Bash rule: paths from shellWrites; `?` (target unknown) is let through. Targets resolve against cwd and
 * every `cd` dir in the command (`cd docs/cto_jev/x && cp a .`). A bare doc name in a command that mentions cto_jev
 * blocks (a `cd` this cannot follow), and so does a folder under docs/cto_jev as the target when the command names a
 * sign-off doc (`cp SPEC.md docs/cto_jev/features/x/`).
 * shortcut: globs (`SPE*.md`), variables and `cd docs/cto_*` still get through; a post-Bash Status check would close them.
 */
export function shellWritesSignoffDoc(root: string, cwd: string, writtenPaths: string[], command = ''): boolean {
  const cmd = command.replace(/\\/g, '/').toLowerCase();
  let at = cwd; // each cd starts where the previous one left off
  const bases = [cwd, ...[...command.matchAll(/(?:^|[;&|(]\s*)cd\s+['"]?([^\s;&|'")]+)/g)].map((m) => (at = absolute(at, m[1])))];
  const isDir = (rel: string) => { try { return statSync(posix.join(absolute('/', root), rel)).isDirectory(); } catch { return false; } };
  return writtenPaths.some((p) => {
    if (p === '?') return false;
    if (bases.some((b) => signoffDoc(root, b, p) !== undefined)) return true;
    if (!/[\\/]/.test(p) && cmd.includes('cto_jev') && SIGNOFF_DOCS.some((d) => d.toLowerCase() === p.replace(/:.*$/s, '').toLowerCase())) return true;
    return DOC_NAME.test(cmd) && bases.some((b) => { const rel = relative(root, b, p); return inFlow(rel) && (/[\\/.]$/.test(p) || isDir(rel!)); });
  });
}
