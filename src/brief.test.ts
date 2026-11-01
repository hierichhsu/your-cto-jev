import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { brief } from './brief.js';

process.env.APPDATA = mkdtempSync(join(tmpdir(), 'cto-home-')); // never read the user's real keys and prefs

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

test('brief without docs/cto_jev/features has no flow section; an empty flow asks for tasks', () => {
  const plain = brief(repo({ 'PLAN.md': '- [ ] add retry\n', 'docs/cto_jev/PRODUCT.md': 'x: unknown\n' })).join('\n');
  assert.ok(!/Features ·|Ready ·|Unknown fields/.test(plain));
  assert.match(plain, /^Open plan items · PLAN\.md 1 · 1 unchecked\n  - \[ \] add retry$/m);

  const empty = brief(repo({ 'docs/cto_jev/features/billing/CONCEPT.md': 'Status: draft\n' })).join('\n');
  assert.match(empty, /^Features · 1 · 1 planned · sign-off pending: billing \(concept draft, spec missing\)$/m);
  assert.match(empty, /^Ready · none · add tasks to docs\/cto_jev\/features\/<slug>\/TASKS\.md$/m);
  assert.ok(!empty.includes('Blocked'));
});
