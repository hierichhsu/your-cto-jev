import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { brief, flowIssues } from './brief.js';

process.env.APPDATA = mkdtempSync(join(tmpdir(), 'cto-home-')); // never read the user's real keys and prefs
// never read the developer's git config (a global core.hooksPath or commit.gpgsign breaks the temp repos)
process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'cto-gitconfig-')), 'gitconfig');
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
process.env.GIT_CONFIG_NOSYSTEM = '1';

const repo = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'cto-brief-'));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'init');
  return root;
};

test('brief shows the flow: ready in order, run-together set, overlap note, blocked with missing ids, sign-offs, unknown fields', () => {
  const F = 'docs/cto_jev/features';
  const root = repo({
    'PLAN.md': '- [ ] other checklist item\n',
    'docs/cto_jev/PRODUCT.md': '- Who pays: (unknown)\n- Pricing: unknown\n- [ ] not a plan item\n',
    'docs/cto_jev/ARCHITECTURE.md': '- Database: unknown\n- Host: fly\n',
    [`${F}/billing/CONCEPT.md`]: 'Status: approved\n## 目的\nBill them\n',
    [`${F}/billing/SPEC.md`]: 'Status: approved\n',
    [`${F}/customers/CONCEPT.md`]: 'Status: approved\n## 目的\nCustomers\n',
    [`${F}/customers/SPEC.md`]: 'Status: draft\n',
    [`${F}/customers/TASKS.md`]: [
      '- [ ] CUST-1 Customer list',
      '  - [x] CUST-1.1 Schema (files: src/customers/db/)',
      '  - [ ] CUST-1.2 List UI (files: src/customers/ui/)',
      '        accept: npm test -- ui',
      '  - [ ] CUST-1.3 Shared types (after: PERM-9, CUST-1.2) (files: src/types/)',
      '- [ ] CUST-2 Export (files: src/customers/)',
      '      accept: manual',
      '',
    ].join('\n'),
    [`${F}/permissions/CONCEPT.md`]: 'Status: approved\n',
    [`${F}/permissions/SPEC.md`]: 'Status: approved\n',
    [`${F}/permissions/TASKS.md`]: '- [ ] PERM-3 Role cache (files: src/auth/cache/)\n      accept: npm test -- auth\n',
  });
  const lines = brief(root);
  const b = lines.join('\n');
  assert.ok(existsSync(join(root, 'docs/cto_jev/INDEX.md')), 'brief regenerates INDEX.md');
  assert.match(b, /^Features · 3 · 2 active · 1 planned · sign-off pending: customers \(spec draft\)$/m);
  assert.match(b, /^Ready · 3 \(run together: CUST-1\.2, PERM-3\)$/m);
  const ready = lines.filter((l) => /^  (CUST|PERM)-\S+ .*(accept:)/.test(l));
  assert.deepEqual(ready.map((l) => l.trim().split(/\s+/)[0]), ['CUST-1.2', 'CUST-2', 'PERM-3'], 'ready tasks in file order');
  assert.match(ready[0], /^  CUST-1\.2  List UI\s+files src\/customers\/ui\/\s+accept: npm test -- ui$/);
  assert.match(ready[1], /^  CUST-2\s+Export\s+files src\/customers\/\s+accept: manual\s+\(overlaps CUST-1\.2: run after\)$/);
  assert.match(b, /^Blocked · 1$/m);
  assert.match(b, /^  CUST-1\.3  Shared types\s+waiting on PERM-9 \(missing\), CUST-1\.2$/m);
  assert.match(b, /^Unknown fields · PRODUCT\.md 2 · ARCHITECTURE\.md 1$/m);
  assert.ok(lines.every((l) => l.length <= 120), `lines fit on one screen:\n${lines.filter((l) => l.length > 120).join('\n')}`);
  // other checklists still show; the flow's own docs are not listed twice
  assert.match(b, /^Open plan items · PLAN\.md 1 · 1 unchecked$/m);
  assert.match(b, /- \[ \] other checklist item/);
  assert.ok(!b.includes('not a plan item'), 'checklists under docs/cto_jev/ are not plan items');
  assert.ok(b.indexOf('Features ·') < b.indexOf('Open plan items'), 'flow section comes first');
});

test('brief Ready: P1 first, untagged as P2, P3 last, file order within a rank; (seq) never in the run-together set', () => {
  const lines = brief(repo({
    'docs/cto_jev/features/a/TASKS.md': [
      '- [ ] A-1 polish (P3) (files: src/a1/)',
      '- [ ] A-2 normal (files: src/a2/)',
      '- [ ] A-3 urgent (P1) (files: src/a3/)',
      '- [ ] A-4 migrate (seq) (P1) (files: db/)',
      '- [ ] A-5 also normal (P2) (files: src/a5/)',
      '- [ ] A-6 untagged (P3)',
      '',
    ].join('\n'),
  }));
  const ids = lines.filter((l) => /^  A-\d /.test(l)).map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(ids, ['A-3', 'A-4', 'A-2', 'A-5', 'A-1', 'A-6']);
  assert.match(lines.join('\n'), /^Ready · 6 \(run together: A-3, A-2, A-5, A-1\)$/m);
  assert.match(lines.join('\n'), /^  A-4\s+P1 migrate .*\(seq: runs alone\)$/m);
  assert.match(lines.join('\n'), /^  A-6\s+P3 untagged .*\(no files: runs alone; add \(files:\)\)$/m, 'a task with no (files:) never joins a wave');
});

test('brief without docs/cto_jev/features has no flow section; an empty flow asks for tasks', () => {
  const plain = brief(repo({ 'PLAN.md': '- [ ] add retry\n', 'docs/cto_jev/PRODUCT.md': 'x: unknown\n' })).join('\n');
  assert.ok(!/Features ·|Ready ·|Unknown fields/.test(plain));
  assert.match(plain, /^Open plan items · PLAN\.md 1 · 1 unchecked\n  - \[ \] add retry$/m);

  const empty = brief(repo({ 'docs/cto_jev/features/billing/CONCEPT.md': 'Status: draft\n' })).join('\n');
  assert.match(empty, /^Features · 1 · 1 planned · sign-off pending: billing \(concept draft, spec missing\)$/m);
  assert.match(empty, /^Ready · none · add tasks to docs\/cto_jev\/features\/<slug>\/TASKS\.md$/m);
  assert.ok(!empty.includes('Blocked'));
});

const F = 'docs/cto_jev/features';
const SPEC = 'Status: approved\n## Interface\n## Constraints\n## Internals\n';
const CONCEPT = 'Status: approved\n## 目的\nWhy\n';
const PRODUCT = ['一句話', '使用者角色', '怎麼賺錢', '方案與限制', '不做的事', '設計約束'].map((h) => `## ${h}\nx\n`).join('');

test('flowIssues: missing feature files, orphan src dirs, missing headings; brief places the section after Blocked', () => {
  const root = repo({
    'src/billing/index.ts': '',
    'src/orphan/index.ts': '',
    'src/index.ts': '',
    'docs/cto_jev/PRODUCT.md': PRODUCT.replace('## 怎麼賺錢\nx\n', ''),
    [`${F}/billing/CONCEPT.md`]: CONCEPT,
    [`${F}/billing/SPEC.md`]: SPEC.replace('## Constraints\n', ''),
    [`${F}/billing/TASKS.md`]: [
      '- [ ] BILL-1 Invoices',
      '  - [ ] BILL-1.1 Schema (files: src/billing/)',
      '  - [ ] BILL-1.2 Webhook (after: BILL-1.1) (files: src/billing/hooks/, src/billing/)',
      '',
    ].join('\n'),
  });
  assert.deepEqual(flowIssues(root), [
    'features/billing: missing REVIEW.md',
    'src/orphan/ belongs to no feature',
    'features/billing/SPEC.md: missing heading ## Constraints',
    'PRODUCT.md: missing heading ## 怎麼賺錢',
  ], 'a task whose (files:) do not exist yet is not an issue');
  const b = brief(root).join('\n');
  assert.match(b, /^Flow issues · 4\n  features\/billing: missing REVIEW\.md\n/m);
  assert.ok(b.indexOf('Blocked · 1') < b.indexOf('Flow issues ·'), 'after Blocked');
  assert.ok(b.indexOf('Flow issues ·') < b.indexOf('Failures in the last'), 'before the tail');
});

test('flowIssues: a clean flow yields nothing, a long list is capped at 12 lines', () => {
  const clean = repo({
    'src/billing/index.ts': '',
    'src/index.ts': '',
    'docs/cto_jev/PRODUCT.md': PRODUCT,
    [`${F}/billing/CONCEPT.md`]: CONCEPT,
    [`${F}/billing/SPEC.md`]: SPEC,
    [`${F}/billing/TASKS.md`]: '- [ ] BILL-1 Invoices (files: src/billing/)\n',
    [`${F}/billing/REVIEW.md`]: '',
  });
  assert.deepEqual(flowIssues(clean), []);
  assert.ok(!brief(clean).join('\n').includes('Flow issues'));
  assert.deepEqual(flowIssues(repo({ 'README.md': 'no flow\n' })), []);

  // 15 feature folders holding only a TASKS.md: one "missing" line each.
  const many = repo(Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`${F}/f${String(i + 1).padStart(2, '0')}/TASKS.md`, ''])));
  const issues = flowIssues(many);
  assert.equal(issues.length, 13);
  assert.equal(issues[0], 'features/f01: missing CONCEPT.md, SPEC.md, REVIEW.md');
  assert.equal(issues[12], '… 3 more');
  assert.match(brief(many).join('\n'), /^Flow issues · 15$/m);
});
