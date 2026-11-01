import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { AgentName } from './agents.js';

// Guidance for coding agents, in two layers:
// 1. A short rules block in each agent's always-loaded project file (CLAUDE.md, AGENTS.md, GEMINI.md). Skills load
//    only when the agent decides they are relevant, so rules that must always hold live here.
// 2. One detailed skill at .agents/skills/cto (read by Codex, Gemini CLI and Cursor; the rules block points Claude
//    Code to the same file). A single copy, so Cursor (which also scans .claude/skills) never sees two.
// Every rule names the check that enforces it, and every enforcing check has a rule.

export const SKILL_MARK = '<!-- Managed by `cto setup`. Re-run it to update; local edits are overwritten. -->';
export const SKILL_PATH = '.agents/skills/cto/SKILL.md';
const LEGACY_SKILL = '.claude/skills/cto/SKILL.md'; // 0.5.0 pre-release layout, cleaned up on sync

const MD_START = '<!-- >>> YOUR CTO JEV START >>> -->';
const MD_END = '<!-- <<< YOUR CTO JEV END <<< -->';
const mdBlockRe = /\n?<!-- >>> YOUR CTO JEV START >>> -->\n[\s\S]*?<!-- <<< YOUR CTO JEV END <<< -->\n?/;

export const MEMORY_FILES: { path: string; agents: AgentName[] }[] = [
  { path: 'CLAUDE.md', agents: ['claude'] },
  { path: 'AGENTS.md', agents: ['codex', 'cursor'] },
  { path: 'GEMINI.md', agents: ['gemini'] },
];

export const FLOW_SKILL_PATH = '.agents/skills/cto-flow/SKILL.md';
/** The one extra rule when `cto setup` chose the development flow: the plan lives in docs/cto_jev/. */
export const FLOW_RULE = `- **Work is planned in \`docs/cto_jev/\`.** Before planning, breaking down, dispatching or accepting work, read \`${FLOW_SKILL_PATH}\`; \`cto brief\` lists what is ready.`;

export const rulesBlock = (flow: boolean) => `${MD_START}
## Rules enforced by cto

This repo is guarded by cto: every rule below is checked automatically, and breaking one gets you blocked.

- **Start with \`cto brief\`.** It shows the sprint goal, the command that verifies this repo, open plan items, and how commands failed here before and what fixed them. Skip it only if cto is not installed.
- **Secrets stay out of code.** Use environment variables, never literal keys, tokens or passwords. (\`credential_leak\` blocks the commit)
- **Fix the code, not the tests.** Never skip, delete or loosen a test, rewrite an expectation to match wrong output, or lower coverage. (\`test_tampering\` blocks the commit)
- **Done means verified.** After your last code change, run the relevant tests or build and see them pass before saying done or checking off a plan item; otherwise say what is unverified. (\`done_unverified\` sends you back)
- **Two strikes, change approach.** Same command, same error twice: stop retrying and try something different. (\`infinite_loop\` blocks the retry)
- **Ask before anything irreversible:** deleting data, force-pushing, rewriting history, dropping a database. (\`destructive_command\` blocks it)
- **Stay on the sprint goal in \`.cto.json\` and keep changes simple.** (\`architecture_violation\` and \`code_complexity\` warn)
- **Run \`cto check\` before committing**, and never bypass a block (\`--no-verify\`, editing hooks or thresholds). If a block looks wrong, tell the user.
${flow ? FLOW_RULE + '\n' : ''}
Details and how to handle a block: \`${SKILL_PATH}\`.
${MD_END}
`;
export const RULES_BLOCK = rulesBlock(false);

export const SKILL_TEXT = `---
name: cto
description: Development rules enforced in this repository by the cto gatekeeper, with what each check looks for and what to do when blocked. Use before committing, before saying a task is done, after a command fails, before running anything destructive, and whenever a cto hook blocks you.
---
${SKILL_MARK}

# cto: the rules of this repo

This repository is guarded by **cto** (your-cto-jev). Hooks review your commits and commands with a decision model.
Each rule below has a check behind it. Following the rules is faster than being blocked.

| Rule | What enforces it |
|---|---|
| **Secrets stay out of code.** Never write API keys, tokens, passwords or private keys into code or committed files. Read them from environment variables. | \`credential_leak\` blocks the commit |
| **Fix the code, not the tests.** When a test fails, change the code under test. Never skip, comment out or delete a test, loosen an assertion, change an expected value to match wrong output, swallow the error, or lower a coverage threshold. A test may only go away together with the feature it covers, and you say so. | \`test_tampering\` blocks the commit |
| **Done means verified.** After your last code change, run the relevant tests, build or type check and see it pass before you say the work is done. Checking off a plan item (\`- [x]\`) is the same claim; check off a phase or parent item only when everything under it is done. If you cannot, say plainly what is not verified and why. | \`done_unverified\` sends you back to work |
| **Two strikes, change approach.** If a command fails with the same error twice, stop retrying. Read the error, inspect the code, and try something different. | \`infinite_loop\` blocks the retry once |
| **Ask before anything irreversible.** Get the user's explicit OK before deleting data outside build output, force-pushing, rewriting shared history, or dropping a database. | \`destructive_command\` blocks the command |
| **Stay on the sprint goal.** If \`.cto.json\` sets a \`sprint_goal\`, keep changes inside it and point out anything unrelated. | \`architecture_violation\` warns |
| **Keep it simple.** Prefer the smallest change that solves the problem. | \`code_complexity\` warns |

## Before you start

Run \`cto brief\`. It prints the sprint goal, the command that verifies this repo, the open plan items, and the lessons
of this repo: commands that failed before, how often, and the edit that made them pass. When a command you are about
to run is listed there, read its lesson first. Lessons are collected automatically from every failed command and kept
in \`.cto-lessons.jsonl\`; add a note to one with care, since the file is shared with the team.

## Before you commit

Run \`cto check\`. It runs the same commit checks on your staged changes (or, if nothing is staged, on all working-tree
changes including new files) without committing, and prints every score with its threshold. Fix anything it flags,
then commit. If \`cto\` is not installed on this machine, skip this step.

## When cto blocks you

Read the message, fix the cause, and try again. Never bypass a block: no \`git commit --no-verify\`, no disabling or
editing hooks, no changing \`.cto.json\` thresholds to get through. If you believe a block is wrong, stop and tell the
user what was blocked and why you disagree; the user decides. The user can record a wrong call with \`cto report\`, which
turns it into a calibration case; you do not run that yourself.

## Commands

- \`cto brief\`: sprint goal, verify command, open plan items, and this repo's lessons. Run it before you start.
- \`cto check\`: preview the commit checks on your current changes.
- \`cto doctor\`: show whether cto is working here (keys, hooks, recent checks).
- \`cto index\`: regenerate \`docs/cto_jev/INDEX.md\` (only in a repo that uses the development flow).
- \`cto docs\`: list stale planning markdown outside \`docs/cto_jev/\` with a suggestion per file; changes nothing.
`;

// The flow skill: how the host agent plans, dispatches and accepts work under docs/cto_jev/. Written only when
// `cto setup` chose the flow; the body mirrors docs/cto_jev/features/cto-flow/SPEC.md.
export const FLOW_SKILL_TEXT = `---
name: cto-flow
description: The development flow of this repo, kept in docs/cto_jev/. Its jobs are named so they cannot be confused with another skill's steps - "cto-jev init" (first-time setup, also "set up PRODUCT.md and ARCHITECTURE.md"), "cto-jev feature" (a request bigger than one edit), "cto-jev tasks" (break an approved spec down), "cto-jev work" (dispatch, accept, review, commit), "cto-jev release" (review everything unreleased, then merge to main), "cto-jev docs" (clean up old documents), "cto-jev decision" (record an architecture decision). Load it when the user names one of them, and whenever you are about to plan, dispatch, tick a task or commit.
---
${SKILL_MARK}

# cto-flow

You are the CTO of this repo. You plan, break down, dispatch, accept and review; sub-agents write the code. The plan lives in \`docs/cto_jev/\`; the only state is the checkboxes in TASKS.md. cto checks what you claim: a tick without a passing check is sent back, a commit on a feature without sign-off is blocked.

Seven jobs, each named \`cto-jev <job>\`. When the user says the name, do that job and nothing else. Each says when it applies, the steps, and where you stop.

## cto-jev init

**When:** the user says "cto-jev init" or "set up PRODUCT.md and ARCHITECTURE.md", or \`cto brief\` shows \`Unknown fields\`.

This is a conversation, not a form. The files are done when the user says so, not when every heading has text.

1. Scan before asking: README, the package manifest, lock file, .env.example, the directory tree, existing docs.
2. Fill every field you can prove, tagged \`(from: <file>)\`. Never guess a field; \`unknown\` is a valid value.
3. Ask what is left, at most five questions per message, each with your best guess so the user only confirms. \`skip\` leaves \`unknown\`. An interview skill the user has installed (a "grill me" style one) may drive these rounds; the headings below, the five-per-round cap and \`unknown\` as a valid answer stay.
4. Write both files with the fixed headings below, \`Status: draft\`, and walk the user through them heading by heading: say what you wrote and what it will be used for (non-goals and principles become drift checks). Each answer that opens a new question gets asked in the next round. Keep going until the user has nothing to add or correct.
5. Repeat the walk-through after every edit the user asks for.

**Stop:** when the user says the files are complete; they set \`Status: approved\`. Do not continue to \`cto-jev feature\` in the same breath unless asked.

PRODUCT.md headings: \`## 一句話\`, \`## 使用者角色\`, \`## 怎麼賺錢\`, \`## 方案與限制\`, \`## 不做的事\`, \`## 設計約束\`.
ARCHITECTURE.md headings: \`## 技術棧\`, \`## 目錄地圖\`, \`## 外部服務與資料\`, \`## 驗證指令\`, \`## 不變的原則\`.
Short bullets or a table per heading. \`## 不做的事\` and \`## 不變的原則\` feed the drift checks: one rule per line.

## cto-jev feature

**When:** the user says "cto-jev feature", or asks for something bigger than one edit.

1. Run \`cto-jev docs\` first when it has not run this session; bring its suggestions to the user before opening a feature.
2. Read \`docs/cto_jev/INDEX.md\` and classify:
   - Inside an existing feature, within its Constraints: add tasks to its TASKS.md (\`cto-jev tasks\`). No new docs.
   - Changes a feature's \`## Constraints\` or \`## Interface\`: edit its SPEC.md, set \`Status: draft\`, stop for sign-off.
   - A new module: \`features/<slug>/\` with the four files below.
   - An existing module with no feature folder yet: create its folder describing what exists today (short CONCEPT, SPEC with the three sections), \`Status: draft\`, before any task on it.
   - Infrastructure (CI, build, deploy, dependency upgrades): a task under \`features/platform/\`.
3. Talk before you write. Restate the request in two sentences and ask until every question below has an answer or an explicit "not relevant". At most five questions per message, each with your best guess; an installed interview skill may run the rounds, the questions below are what must be answered. Do not write CONCEPT.md until the first group is settled, nor SPEC.md until the second.
   - For CONCEPT: who uses this and what changes for them; which business rules apply, including what happens on failure, limits, roles and paid tiers; what is explicitly out of scope; which existing features it touches.
   - For SPEC: which data and tables change; what other features may call (the Interface) and what stays private; the error cases and what the user sees; the hard rules the code must never break (the Constraints); how each part will be verified.
4. Write CONCEPT.md, then SPEC.md. Constraints are testable rules ("a refund always writes an audit row"), not aspirations. Interface is only what other features may call.
5. Walk the user through both files section by section and ask what is wrong or missing. Edit, walk through again, until they have nothing to add.

**Stop:** when the user says the docs are complete; they set \`Status: approved\`. Never write TASKS.md before the SPEC is approved; cto blocks the commit anyway.

CONCEPT.md: \`Status:\` line, then \`## 目的\` (one sentence), \`## 動機\`, \`## 商業規則\`, \`## 不做的事\`.
SPEC.md: \`Status:\` line, then \`## Interface\`, \`## Constraints\`, \`## Internals\`.
REVIEW.md: created empty with one line saying it is pending.

## cto-jev tasks

**When:** the user says "cto-jev tasks", or SPEC.md is \`Status: approved\` and TASKS.md is empty or the request adds work.

1. One parent per deliverable, children small enough for one sub-agent and one acceptance command.
2. Every child gets \`(files:)\` (the directories it changes, never bare \`src/\`), \`(after:)\` for anything that must be ticked first (across features too), and an acceptance line: a runnable command, or \`manual\` when only a human can judge.
3. Shared files (route tables, shared types, migrations, a single test file, the CLI entry point) get their own sequential task; take them out of the other tasks' \`(files:)\`.
4. Run \`cto index\` and read \`cto brief\`: Ready should list the first wave; nothing should be Blocked on a missing id.

\`\`\`md
- [ ] CUST-1 Customer list
  - [ ] CUST-1.1 List API, filtered by role (after: PERM-2) (files: src/customers/api/)
        驗收: npm test -- customers/api
  - [ ] CUST-1.2 List UI (after: CUST-1.1) (files: src/customers/ui/)
        驗收: manual
\`\`\`

IDs: \`<PREFIX>-<n>\`, children \`<n>.<m>\`, prefix uppercase and unique across the repo. A parent has no \`(files:)\` and no acceptance line; it is done when all children (at most 15) are ticked. \`accept:\` is accepted as a synonym for \`驗收:\`.

Two more tags, on any task:
- **Priority** \`(P1)\` / \`(P2)\` / \`(P3)\`. P1: do first, and nothing releases while one is open (blockers, review findings that are wrong or unsafe). P2: normal work; the default when the tag is absent. P3: when nothing else is left (polish, nice-to-have). brief lists Ready as P1, then P2, then P3.
- **Sync** \`(seq)\`: this task runs alone, whatever its \`(files:)\` say. Use it for migrations, shared types, route tables, anything that touches state every other task reads. Without the tag a task may run together with any Ready task whose \`(files:)\` do not overlap its own; brief computes that and shows the "run together" set.

\`\`\`md
- [ ] CUST-3 Add customer_tier column (P1) (seq) (files: db/migrations/)
      驗收: npm run migrate:test
- [ ] CUST-4 Tier badge in the list (P3) (after: CUST-3) (files: src/customers/ui/)
      驗收: manual
\`\`\`

## cto-jev work

**When:** the user says "cto-jev work" or "continue", or \`cto brief\` shows Ready tasks.

Branches: work on an integration branch (\`review\`, or whatever the repo calls it; see the table under \`cto-jev release\`). The release branch only receives \`cto-jev release\`. Never commit to it directly; ask the user to add it to \`protected_branches\` in \`.cto.json\` if it is not there.

1. \`cto brief\`. Dispatch only Ready tasks; the "run together" set is safe to run at once. P1 tasks go first.
2. One sub-agent per task. Give it only: the task line, the feature's SPEC.md, the \`## Interface\` of each feature it depends on, the list of files it may touch, and "do not edit anything else, write nothing outside this repo (no notes, no lesson logs), no git commands; report what you changed and what you found ambiguous". Each sub-agent writes its own new test file; nobody appends to a shared one.
3. When they return: \`git status\`; revert anything outside the union of their \`(files:)\`. Integrate the shared files yourself. Fix any existing test their change broke. A sub-agent's "the SPEC does not say" goes into the SPEC now, not into the code's comments.
4. Accept by running the task's acceptance command yourself; never trust the report. Tick only on a pass. \`manual\` waits for the user to confirm in the conversation; say "accepted manually" when you tick it. Tick the parent when its last child is ticked.
5. **Review before you commit.** Dispatch a reviewer with none of your context: it reads the feature's CONCEPT.md and SPEC.md and the uncommitted diff, and returns findings each marked P1 (wrong, unsafe, breaks a Constraint or the Interface) or P2 (should improve, can wait). Fix every P1 now and re-run acceptance. Write every P2 as a \`(P2)\` task in TASKS.md. Append one entry to REVIEW.md: date, scope (the task ids of the wave), how many P1/P2, which task ids they became.
6. \`cto check\`, then commit the wave to the review branch.

Without sub-agents: do the Ready tasks yourself in brief's order, one at a time, accepting each before the next; review your own diff with fresh eyes against the SPEC before each commit.

## cto-jev release

**When:** the user says "cto-jev release", or asks to merge, ship or deploy.

First decide what "release" means in this repo. Look at \`git branch -a\` and the deploy config once, tell the user which row applies, and keep it:

| The repo has | Work goes to | Release means | Review scope |
|---|---|---|---|
| \`main\` only, one developer | \`main\` directly, after the wave review in \`cto-jev work\` | a tag (\`vX.Y.Z\`) or a deploy from \`main\` | \`git diff <last tag>..HEAD\` |
| \`main\` + feature branches | a branch per feature or per wave | the PR into \`main\` | the PR diff, \`cto check --base main\` |
| \`main\` + an integration branch (\`review\`, \`develop\`, \`staging\`) | the integration branch | merging it into \`main\` (what deploys to production) | \`git diff main...<integration>\` |
| \`staging\` and \`live\` (or \`production\`) deploy branches | \`staging\` | promoting \`staging\` to \`live\` | \`git diff live...staging\`; a second, lighter release review |

Whatever the row, one rule holds: the branch that reaches users receives nothing without a release review, and \`protected_branches\` in \`.cto.json\` names it.

1. Everything to be released is on the work branch and every P1 task is ticked. If not, stop and list what is open.
2. Dispatch a reviewer with none of your context over the whole unreleased diff (the review scope above) plus the SPECs of every feature it touches. Findings get P1, P2 or P3 like a wave review, written into TASKS.md.
3. P1 findings are fixed (through \`cto-jev work\`) before anything else; P2 and P3 stay as tasks for after the release. Tell the user both lists and let them decide which P2 should move up.
4. \`cto check --base <release branch>\` must pass. Then prepare the merge, PR or tag; the user performs it. Append one REVIEW.md entry per feature released: date, "release", counts, task ids.

**Stop:** before the merge, with the P1/P2/P3 lists in front of the user.

## cto-jev docs

**When:** the user says "cto-jev docs", before opening a feature, or when the user asks to tidy the repo.

1. \`cto docs\`. It lists markdown outside \`docs/cto_jev/\` that looks like an old plan, grouped as Delete / Merge into a feature / Archive / Needs a look. It changes nothing.
2. Show the list to the user with one line per file; they decide.
3. Then act: merge = fold the still-open items into the right TASKS.md or SPEC.md and delete the file; archive = move to \`docs/cto_jev/archive/<YYYYMM>-<name>/\`; delete = \`git rm\`. Never act before the user answers.

## cto-jev decision

**When:** the user says "cto-jev decision", a commit warns \`architecture_undocumented\`, or a change adds or removes a service, store, dependency, layer or boundary, or bends a line in \`## 不變的原則\`.

Write \`docs/cto_jev/decisions/NNNN-<slug>.md\` (next number): \`# <NNNN>: <title>\`, \`## Context\`, \`## Decision\`, \`## Consequences\`. Append-only; a reversal is a new record. Update ARCHITECTURE.md in the same commit when a principle changed.

## Never

- Set \`Status: approved\` yourself. Only the user does.
- Keep state anywhere but TASKS.md checkboxes: no side lists, no status files.
- Hand-edit INDEX.md; \`cto index\` and \`cto brief\` regenerate it.
- Guess a PRODUCT.md or ARCHITECTURE.md field.
- Read \`docs/cto_jev/archive/\`.
- Let a sub-agent commit, or write outside the files its task names.

## Layout (fixed names, fixed count)

\`\`\`
docs/cto_jev/
  INDEX.md                 generated by cto
  PRODUCT.md               cto-jev init; user signs off
  ARCHITECTURE.md          cto-jev init; user signs off
  decisions/NNNN-<slug>.md cto-jev decision; append-only
  features/<slug>/
    CONCEPT.md             why: 目的, 動機, 商業規則, 不做的事
    SPEC.md                how: Interface, Constraints, Internals
    TASKS.md               the only state; review findings carry (P1)/(P2)
    REVIEW.md              one entry per wave review and per release
  archive/<YYYYMM>-<name>/ cto-jev docs moves old documents here; nobody reads them
\`\`\`

Three top-level files, four per feature, \`features/platform/\` always present. Headings must match exactly: \`cto brief\` reports a reworded heading as missing and the checks skip it.
`;

// Removes exactly what appendMd added: the block, its trailing newline, and the one blank separator line before it.
const removeMd = (s: string) => s.replace(mdBlockRe, '');
const appendMd = (s: string, flow: boolean) => {
  const base = removeMd(s);
  return (base && !base.endsWith('\n') ? base + '\n' : base) + (base.trim() ? '\n' : '') + rulesBlock(flow);
};

function removeFileAndEmptyDirs(root: string, path: string) {
  unlinkSync(path);
  for (let d = dirname(path), i = 0; i < 3 && !relative(root, d).startsWith('..') && relative(root, d) !== ''; i++, d = dirname(d)) {
    try { if (readdirSync(d).length) break; rmdirSync(d); } catch { break; }
  }
}

/**
 * Bring guidance in line with the chosen agents: write/refresh the rules block and the skill for them; with
 * removeOthers (exact mode or uninstall) take cto's content out of files no chosen agent reads. Only cto-marked
 * content is ever removed or overwritten. With flow, the rules block carries the extra docs/cto_jev/ rule.
 */
export function syncGuidance(root: string, chosen: Set<AgentName>, removeOthers: boolean, flow = false): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  for (const m of MEMORY_FILES) {
    const path = join(root, m.path);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (m.agents.some((a) => chosen.has(a))) {
      const next = appendMd(current, flow);
      if (next !== current) { writeFileSync(path, next); written.push(m.path); }
    } else if (removeOthers && mdBlockRe.test(current)) {
      const rest = removeMd(current);
      if (rest.trim()) writeFileSync(path, rest); else unlinkSync(path);
      removed.push(m.path);
    }
  }
  const skill = join(root, SKILL_PATH);
  if (chosen.size) {
    if (!existsSync(skill) || readFileSync(skill, 'utf8') !== SKILL_TEXT) {
      mkdirSync(dirname(skill), { recursive: true });
      writeFileSync(skill, SKILL_TEXT);
      written.push(SKILL_PATH);
    }
  } else if (removeOthers && existsSync(skill) && readFileSync(skill, 'utf8').includes(SKILL_MARK)) {
    removeFileAndEmptyDirs(root, skill);
    removed.push(SKILL_PATH);
  }
  const legacy = join(root, LEGACY_SKILL);
  if (existsSync(legacy) && readFileSync(legacy, 'utf8').includes(SKILL_MARK)) removeFileAndEmptyDirs(root, legacy);
  return { written, removed };
}

/** Write or refresh the cto-flow skill when the flow is enabled; remove it (only if cto-marked) when not. */
export function syncFlowSkill(root: string, enabled: boolean): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  const skill = join(root, FLOW_SKILL_PATH);
  if (enabled) {
    if (!existsSync(skill) || readFileSync(skill, 'utf8') !== FLOW_SKILL_TEXT) {
      mkdirSync(dirname(skill), { recursive: true });
      writeFileSync(skill, FLOW_SKILL_TEXT);
      written.push(FLOW_SKILL_PATH);
    }
  } else if (existsSync(skill) && readFileSync(skill, 'utf8').includes(SKILL_MARK)) {
    removeFileAndEmptyDirs(root, skill);
    removed.push(FLOW_SKILL_PATH);
  }
  return { written, removed };
}

/** The guidance files the given agents use (what should be committed for them). */
export function guidancePaths(agentsInUse: Iterable<AgentName>): string[] {
  const set = new Set(agentsInUse);
  if (!set.size) return [];
  return [...MEMORY_FILES.filter((m) => m.agents.some((a) => set.has(a))).map((m) => m.path), SKILL_PATH];
}

/**
 * Guidance files that are missing or differ from what this version would write, for the given agents.
 * Without `flow`, a block with or without the flow rule both count as current (callers that do not know the setting).
 */
export function staleGuidance(root: string, agentsInUse: AgentName[], flow?: boolean): string[] {
  if (!agentsInUse.length) return [];
  const stale: string[] = [];
  const blocks = (flow === undefined ? [false, true] : [flow]).map((f) => rulesBlock(f).trimEnd());
  for (const m of MEMORY_FILES) {
    if (!m.agents.some((a) => agentsInUse.includes(a))) continue;
    const path = join(root, m.path);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (!blocks.some((b) => current.includes(b))) stale.push(m.path);
  }
  const skill = join(root, SKILL_PATH);
  if (!existsSync(skill) || readFileSync(skill, 'utf8') !== SKILL_TEXT) stale.push(SKILL_PATH);
  return stale;
}
