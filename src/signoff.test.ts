import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { afterEdit, guardVerdict, powershellHitsSignoffDoc, reviewPaths, shellWritesSignoffDoc, signoffDoc } from './signoff.js';
import { shellWrites } from './shellwrites.js';
import { docStatus, setStatus } from './flow.js';

test('docStatus and setStatus: one line only, NBSP counts as a blank, line endings kept', () => {
  assert.equal(docStatus('Status:\napproved\n'), 'missing', 'a Status line does not run onto the next line');
  assert.equal(docStatus('Status:\n\nStatus: draft\n'), 'draft');
  assert.equal(docStatus('Status: approved\r\n'), 'approved');
  assert.equal(docStatus('status: Approved \t\n'), 'approved');
  assert.equal(setStatus('# S\r\n\r\nStatus: approved\r\n', 'approved', 'draft'), '# S\r\n\r\nStatus: draft\r\n');
  assert.equal(setStatus('Status: draft\nStatus: draft\n', 'draft', 'approved'), 'Status: approved\nStatus: draft\n', 'first line only');
  assert.equal(setStatus('Status: drafty\n', 'draft', 'approved'), 'Status: drafty\n');
});

const F = 'docs/cto_jev/features/x';

test('reviewPaths: last Review line wins; bold, backticks, quotes, bullets and code fences tolerated', () => {
  assert.deepEqual(reviewPaths(`Review: ${F}/OLD.md\n重點：x\n\n**Review:** \`${F}/CONCEPT.md\`, '${F}/SPEC.md'，${F}/PRODUCT.md\n重點：y`), [
    `${F}/CONCEPT.md`, `${F}/SPEC.md`, `${F}/PRODUCT.md`,
  ]);
  assert.deepEqual(reviewPaths(`text\n\`\`\`\nReview: ${F}/SPEC.md\n重點：z\n\`\`\``), [`${F}/SPEC.md`]);
  assert.deepEqual(reviewPaths(`> - **Review**: ${F}/SPEC.md`), [`${F}/SPEC.md`]);
  assert.deepEqual(reviewPaths('Reviewer: a.md\nplease review: b.md'), []);
});

test('signoffDoc: resolves against cwd, normalizes, rejects escapes and non-sign-off files', () => {
  const root = 'D:\\Github\\repo';
  assert.equal(signoffDoc(root, 'D:\\Github\\repo', `${F}/SPEC.md`), `${F}/SPEC.md`);
  assert.equal(signoffDoc(root, 'D:\\Github\\repo\\docs\\cto_jev\\features', 'x/./CONCEPT.md'), `${F}/CONCEPT.md`);
  assert.equal(signoffDoc(root, '/d/Github/repo/src', '../docs/cto_jev/PRODUCT.md'), 'docs/cto_jev/PRODUCT.md');
  assert.equal(signoffDoc(root, '/', 'd:\\github\\REPO\\Docs\\CTO_JEV\\architecture.md'), 'Docs/CTO_JEV/architecture.md');
  assert.equal(signoffDoc(root, '/c/elsewhere', '/d/Github/repo/docs/cto_jev/features/x/SPEC.md'), `${F}/SPEC.md`);
  assert.equal(signoffDoc(root, root, `${F}/TASKS.md`), undefined);
  assert.equal(signoffDoc(root, root, 'SPEC.md'), undefined);
  assert.equal(signoffDoc(root, root, 'docs/other/SPEC.md'), undefined);
  assert.equal(signoffDoc(root, root, '../repo2/docs/cto_jev/SPEC.md'), undefined);
  assert.equal(signoffDoc(root, `${root}\\docs\\cto_jev`, '../../../other/docs/cto_jev/SPEC.md'), undefined);
  assert.equal(signoffDoc('/home/u/repo', '/home/u/repo/docs', 'cto_jev/SPEC.md'), 'docs/cto_jev/SPEC.md');
});

test('afterEdit: Edit, replace_all, MultiEdit in order, Write, missing old_string, `$` kept literal', () => {
  assert.equal(afterEdit('a a', 'Edit', { old_string: 'a', new_string: '$&b' }), '$&b a');
  assert.equal(afterEdit('a a', 'Edit', { old_string: 'a', new_string: 'b', replace_all: true }), 'b b');
  assert.equal(afterEdit('abc', 'MultiEdit', { edits: [{ old_string: 'a', new_string: 'x' }, { old_string: 'xb', new_string: 'y' }] }), 'yc');
  assert.equal(afterEdit('abc', 'Edit', { old_string: 'zz', new_string: 'y' }), undefined);
  assert.equal(afterEdit('old', 'Write', { content: 'new' }), 'new');
  assert.equal(afterEdit(undefined, 'Write', { content: 'new' }), 'new');
});

const spec = (status: string, iface: string, internals: string) =>
  `# S\n\nStatus: ${status}\n\n## Interface\n\n${iface}\n\n## Constraints\n\n- c\n\n## Internals\n\n${internals}\n`;

test('guardVerdict: self-approval, protected content, demotion and new files', () => {
  const s = `${F}/SPEC.md`, c = `${F}/CONCEPT.md`;
  assert.equal(guardVerdict(s, undefined, spec('approved', 'i', 'n')), 'self_approve');
  assert.equal(guardVerdict(s, undefined, spec('draft', 'i', 'n')), 'ok');
  const draft = spec('draft', 'i', 'n');
  assert.equal(guardVerdict(s, draft, afterEdit(draft, 'Edit', { old_string: 'Status: draft', new_string: 'Status: approved' })!), 'self_approve');
  const ok = spec('approved', 'i', 'n');
  assert.equal(guardVerdict(s, ok, spec('draft', 'i changed', 'n')), 'ok');
  assert.equal(guardVerdict(s, ok, spec('approved', 'i', 'n plus Assumed: x')), 'ok');
  assert.equal(guardVerdict(s, ok, ok.replace('- c', '- c2')), 'protected_edit');
  assert.equal(guardVerdict(s, ok, spec('approved', 'i2', 'n')), 'protected_edit');
  assert.equal(guardVerdict(s, ok, ok.replace(/\n/g, '\r\n')), 'ok');
  const acc = ok.replace('## Internals', '## Acceptance\n\n- 375px: no horizontal scroll\n\n## Internals');
  assert.equal(guardVerdict(s, acc, acc.replace('375px', '320px')), 'protected_edit', 'the user-confirmed expectations are signed too');
  const concept = '# C\n\nStatus: approved\n\n## 目的\n\nx\n';
  assert.equal(guardVerdict(c, concept, concept.replace('x', 'y')), 'protected_edit');
  assert.equal(guardVerdict(c, concept, concept.replace('approved', 'APPROVED')), 'ok');
  assert.equal(guardVerdict(c, concept, concept.replace('approved', 'draft').replace('x', 'y')), 'ok');
});

test('powershellHitsSignoffDoc: cwd under docs/cto_jev, or a sign-off doc name plus docs/cto_jev in the command', () => {
  const root = 'D:\\Github\\repo';
  assert.equal(powershellHitsSignoffDoc(root, root, `Get-Content docs\\cto_jev\\features\\x\\SPEC.md`), true);
  assert.equal(powershellHitsSignoffDoc(root, root, `(gc ${F}/concept.md) -replace 'draft','approved' | sc ${F}/CONCEPT.md`), true);
  assert.equal(powershellHitsSignoffDoc(root, `${root}\\docs\\cto_jev\\features\\x`, 'ls'), true);
  assert.equal(powershellHitsSignoffDoc(root, '/d/Github/repo/docs/cto_jev', 'ls'), true);
  assert.equal(powershellHitsSignoffDoc(root, root, `Get-Content ${F}/TASKS.md`), false);
  assert.equal(powershellHitsSignoffDoc(root, root, 'Get-Content README.md SPEC.md'), false);
  assert.equal(powershellHitsSignoffDoc(root, `${root}\\docs`, 'git status'), false);
});

test('powershellHitsSignoffDoc: git on a sign-off doc passes; git chained with a writer does not', () => {
  const root = 'D:\\Github\\repo';
  assert.equal(powershellHitsSignoffDoc(root, root, 'git add docs\\cto_jev\\features\\x\\SPEC.md'), false);
  assert.equal(powershellHitsSignoffDoc(root, root, `git diff -- ${F}/CONCEPT.md; git log -1 -- ${F}/CONCEPT.md`), false);
  assert.equal(powershellHitsSignoffDoc(root, `${root}\\docs\\cto_jev\\features\\x`, 'git diff SPEC.md'), false);
  assert.equal(powershellHitsSignoffDoc(root, root, `git add ${F}/SPEC.md; Set-Content ${F}/SPEC.md 'Status: approved'`), true);
  assert.equal(powershellHitsSignoffDoc(root, root, `git show HEAD:${F}/SPEC.md | Out-File ${F}/SPEC.md`), true);
});

test('shellWritesSignoffDoc: shellWrites targets resolved like the guard; `?` let through', () => {
  const root = '/home/u/repo';
  assert.equal(shellWritesSignoffDoc(root, root, shellWrites(`sed -i 's/draft/approved/' ${F}/SPEC.md`)), true);
  assert.equal(shellWritesSignoffDoc(root, `${root}/docs/cto_jev`, shellWrites('echo x > features/x/CONCEPT.md')), true);
  assert.equal(shellWritesSignoffDoc(root, root, shellWrites(`cp /tmp/a ${F}/TASKS.md`)), false);
  assert.equal(shellWritesSignoffDoc(root, root, shellWrites(`cat ${F}/SPEC.md`)), false);
  assert.equal(shellWritesSignoffDoc(root, root, ['?']), false);
});

test('shellWritesSignoffDoc: a cd into docs/cto_jev or a folder target still blocks', () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-sw-'));
  mkdirSync(join(root, F), { recursive: true });
  const hit = (c: string) => shellWritesSignoffDoc(root, root, shellWrites(c), c);
  assert.equal(hit(`cd ${F} && sed -i 's/draft/approved/' SPEC.md`), true);
  assert.equal(hit(`cp /tmp/SPEC.md ${F}/`), true);
  assert.equal(hit(`cp /tmp/SPEC.md ${F}`), true, 'existing folder, no trailing slash');
  assert.equal(hit(`cp /tmp/TASKS.md ${F}/`), false, 'no sign-off doc named');
  assert.equal(hit(`cd ${F} && echo x >> TASKS.md`), false);
  assert.equal(hit(`sed -i 's/a/b/' SPEC.md`), false, 'a SPEC.md outside docs/cto_jev');
  assert.equal(hit(`cd ${F} && cp /tmp/SPEC.md .`), true, 'target resolved against the cd dir');
  assert.equal(hit(`cp /tmp/SPEC.md /tmp/dummy ${F}/`), true, 'several sources: the last argument is the target');
  assert.equal(hit(`cat ${F}/SPEC.md > /tmp/SPEC.md`), false, 'a copy out of docs/cto_jev is a read');
  assert.equal(hit(`cp ${F}/SPEC.md ${F}/SPEC.md.bak`), false);
  for (const tail of [' 2>/dev/null', ' &', ' | cat', ' # done']) assert.equal(hit(`cp /tmp/new ${F}/SPEC.md${tail}`), true, tail);
  assert.equal(hit(`(cp /tmp/new ${F}/SPEC.md)`), true, 'subshell');
  assert.equal(hit(`cd docs && cd cto_jev/features/x && sed -i s/draft/approved/ ./SPEC.md`), true, 'chained cd');
});

test('signoffDoc: a `:` in a POSIX folder name and a symlinked docs/cto_jev stay guarded', () => {
  assert.equal(signoffDoc('/home/u/proj:v2', '/home/u/proj:v2', `${F}/SPEC.md`), `${F}/SPEC.md`);
  assert.equal(signoffDoc('/home/u/repo', '/home/u/repo', `a:b/../${F}/SPEC.md`), `${F}/SPEC.md`);
  const root = mkdtempSync(join(tmpdir(), 'cto-link-')), outside = mkdtempSync(join(tmpdir(), 'cto-out-'));
  mkdirSync(join(root, 'docs'));
  symlinkSync(outside, join(root, 'docs', 'cto_jev'), 'junction');
  assert.equal(signoffDoc(root, root, 'docs/cto_jev/SPEC.md'), 'docs/cto_jev/SPEC.md');
});

test('signoffDoc: NTFS streams, \\\\?\\ prefix and 8.3 short names resolve to the doc', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cto-ads-'));
  mkdirSync(join(tmp, F), { recursive: true });
  writeFileSync(join(tmp, F, 'SPEC.md'), 'Status: approved\n');
  const long = realpathSync.native(tmp);
  assert.equal(signoffDoc(long, long, `${F}/SPEC.md::$DATA`), `${F}/SPEC.md`);
  assert.equal(signoffDoc(long, long, `${F}/SPEC.md:x`), `${F}/SPEC.md`);
  assert.equal(signoffDoc(long, '/', `\\\\?\\${join(long, F, 'SPEC.md')}`), `${F}/SPEC.md`);
  // os.tmpdir() is a short name on some Windows machines (C:\Users\ERICHS~1); the long root must still match.
  assert.equal(signoffDoc(long, '/', join(tmp, F, 'SPEC.md')), `${F}/SPEC.md`);
  assert.equal(signoffDoc(tmp, '/', join(long, F, 'SPEC.md')), `${F}/SPEC.md`);
});
