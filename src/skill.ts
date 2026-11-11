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
// \r?\n: a CLAUDE.md turned CRLF (editor, core.autocrlf) must still match, or setup appends a second rules block.
const mdBlockRe = /(?:\r?\n)?<!-- >>> YOUR CTO JEV START >>> -->\r?\n[\s\S]*?<!-- <<< YOUR CTO JEV END <<< -->(?:\r?\n)?/;

export const MEMORY_FILES: { path: string; agents: AgentName[] }[] = [
  { path: 'CLAUDE.md', agents: ['claude'] },
  { path: 'AGENTS.md', agents: ['codex', 'cursor'] },
  { path: 'GEMINI.md', agents: ['gemini'] },
];

export const FLOW_SKILL_PATH = '.agents/skills/cto-jev/SKILL.md';
const LEGACY_FLOW_SKILL = '.agents/skills/cto-flow/SKILL.md'; // 0.9.x name, removed on sync
// Claude Code reads neither .agents/skills nor (safely) .claude/skills, since Cursor scans .claude/skills too and would
// list the skill twice. A slash command is Claude-only and only points at the one skill file, so `/cto-jev init` works.
export const FLOW_COMMAND_PATH = '.claude/commands/cto-jev.md';
export const FLOW_COMMAND_TEXT = `---
description: The cto development flow - init, feature, tasks, work, release, docs, decision
argument-hint: "[init | feature <request> | tasks | work | work all | release | docs | decision]"
---
${SKILL_MARK}

Read \`${FLOW_SKILL_PATH}\` in full, then do the job named here: $ARGUMENTS

No job named: run \`cto brief\`, say in two lines where this repo stands in the flow, and name the one job to run next.
`;
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
// `cto setup` chose the flow.
export const FLOW_SKILL_TEXT = `---
name: cto-jev
description: The development flow of this repo, kept in docs/cto_jev/. Invoked by saying the job's name (in Claude Code: /cto-jev <job>; in Codex: $cto-jev). Its jobs are named so they cannot be confused with another skill's steps - "cto-jev init" (first-time setup, also "set up PRODUCT.md and ARCHITECTURE.md"), "cto-jev feature" (a request bigger than one edit), "cto-jev tasks" (break a signed-off concept down), "cto-jev work" (dispatch, accept, review and commit every wave, without stopping in between), "cto-jev work all" (the same on a branch, one review at the end), "cto-jev release" (review everything unreleased, then merge to main), "cto-jev docs" (clean up old documents), "cto-jev decision" (record an architecture decision). Load it when the user names one of them, and whenever you are about to plan, dispatch, tick a task or commit.
---
${SKILL_MARK}

# cto-jev

You are the CTO of this repo. You plan, break down, dispatch, accept and review; sub-agents write the code. The plan lives in \`docs/cto_jev/\`; the only state is the checkboxes in TASKS.md. cto checks what you claim: a tick without a passing check is sent back, a commit on a feature whose CONCEPT is not signed off is blocked.

Seven jobs, each named \`cto-jev <job>\`. When the user says the name (or types \`/cto-jev <job>\`), do that job; go on to another only where the job's **Stop** says so. Each says when it applies, the steps, and where you stop. Invoked with no job: run \`cto brief\`, say in two lines where the repo stands, and name the one job to run next.

## Where you stop

The user decides what gets built and signs it once, in CONCEPT.md. While docs are written you talk with them: the CONCEPT interview, the questions of \`cto-jev docs\` and each sign-off (the CONCEPT at the end of \`cto-jev feature\`; PRODUCT.md and ARCHITECTURE.md in \`init\` and \`docs\`) wait for their answers. Once the CONCEPT is signed, building it (\`cto-jev tasks\`, \`work\`, \`release\`) waits for the user in one place only: before the merge in \`cto-jev release\`. Everywhere else you keep going:

- **SPEC.md is yours.** It is the technical document you derive from the signed CONCEPT. Nobody signs it and nothing protects it: change any section when the work shows it is wrong, and say so in the wave's REVIEW.md entry. Tests and reviews judge it, not the user. If a SPEC change would contradict the CONCEPT, that is a CONCEPT change and the user's to make: in the middle of a run, park the task (below) and leave the CONCEPT and its \`Status:\` line alone, since a draft CONCEPT blocks every later commit of the feature; outside a run it goes through \`cto-jev feature\` (draft, edit, \`Review:\`).
- **What the CONCEPT does not decide, you decide.** Write the decision into the SPEC as \`Assumed: ...\` and carry on. Every \`Assumed:\` goes into your final report and the release report, where the user reads them in one go.
- **Never ask "shall I start?".** Dispatch what is Ready; when a wave is committed, start the next one.
- **Park, do not stop,** when a task needs the user: a decision that would contradict the signed CONCEPT, credentials, money, an outside account, anything irreversible, a drop, or a failure that survived a second approach. Parked means unticked and not dispatched again in this run; its dependants wait with it. Go on with the rest and list parked tasks in the final report.

## Sign-off

CONCEPT.md, PRODUCT.md and ARCHITECTURE.md carry a \`Status: draft\` or \`Status: approved\` line. You write and stop; the user signs. SPEC.md carries no Status line; one left over from before 0.12 means nothing.

Every time you stop for the user to look at docs (the end of \`cto-jev init\` and \`cto-jev feature\`), send a review handoff. First write each open question or guess into the doc itself as \`Assumed: ...\`. Then:

\`\`\`
Review: docs/cto_jev/features/<slug>/CONCEPT.md
Key points: at most three lines
Might be missing: one line each, what you are unsure of, pointing to the \`Assumed:\` line in the doc
Data: which tables or stores change, whether old data migrates; "none" if nothing
\`\`\`

\`Review:\` is always this English word, on its own line, with repo-relative paths separated by commas (\`cto-jev init\` lists two: \`Review: docs/cto_jev/PRODUCT.md, docs/cto_jev/ARCHITECTURE.md\`). List only sign-off docs; a SPEC.md there is ignored.

- In Claude Code the user agrees in the conversation and cto's hook sets \`Status: approved\` on the files in the \`Review:\` line. With other agents the user edits the line.
- In Claude Code, end every handoff with one line: reply "ok" to sign. Nothing else about signing.
- Only with another agent, after cto says it did not sign, or when the user asks how to approve: give this command with the real paths, for the user to type while you are not working (never run it yourself):
  \`! sed -i 's/^Status: draft/Status: approved/' docs/cto_jev/features/<slug>/CONCEPT.md\`
- Approval covers what is written, \`Assumed:\` lines included. Partial agreement signs nothing: fix and resend \`Review:\`, or resend it with only the agreed files.
- You never set approved (in Claude Code cto blocks it). To change approved CONCEPT, PRODUCT or ARCHITECTURE content, first set \`Status: draft\` with the Edit tool, then make the change and resend \`Review:\`.
- Shell commands may not write CONCEPT, PRODUCT or ARCHITECTURE under \`docs/cto_jev/\` (no \`cp\`, \`mv\`, \`sed -i\` or redirects); use the Read, Edit and Write tools.

## cto-jev init

**When:** the user says "cto-jev init" or "set up PRODUCT.md and ARCHITECTURE.md", or \`cto brief\` shows \`Unknown fields\`.

This is a conversation, not a form. The files are done when the user says so, not when every heading has text.

1. Scan before asking: README, the package manifest, lock file, .env.example, the directory tree, existing docs.
2. Fill every field you can prove, tagged \`(from: <file>)\`. Never guess a field; \`unknown\` is a valid value.
3. Ask what is left, at most five questions per message, each with your best guess so the user only confirms. \`skip\` leaves \`unknown\`. An interview skill the user has installed (a "grill me" style one) may drive these rounds; the headings below, the five-per-round cap and \`unknown\` as a valid answer stay.
4. Write both files with the fixed headings below, \`Status: draft\`, and walk the user through them heading by heading: say what you wrote and what it will be used for (non-goals and principles become drift checks). Each answer that opens a new question gets asked in the next round. Keep going until the user has nothing to add or correct.
5. Repeat the walk-through after every edit the user asks for.

**Stop:** when the user says the files are complete: send a review handoff (see "Sign-off") for both files. Do not continue to \`cto-jev feature\` in the same breath unless asked.

PRODUCT.md headings: \`## 一句話\`, \`## 使用者角色\`, \`## 怎麼賺錢\`, \`## 方案與限制\`, \`## 不做的事\`, \`## 設計約束\`.
ARCHITECTURE.md headings: \`## 技術棧\`, \`## 目錄地圖\`, \`## 外部服務與資料\`, \`## 驗證指令\`, \`## 不變的原則\`.
Short bullets or a table per heading. \`## 不做的事\` and \`## 不變的原則\` feed the drift checks: one rule per line. In a repo with a UI, \`## 驗證指令\` names the end-to-end test command (Playwright or similar) that Acceptance scenarios run under, or says there is none yet.

## cto-jev feature

**When:** the user says "cto-jev feature", or asks for something bigger than one edit.

1. Run \`cto-jev docs\` first when it has not run this session; bring its suggestions to the user before opening a feature.
2. Read \`docs/cto_jev/INDEX.md\` and classify:
   - Inside an existing feature, within its Constraints: add tasks to its TASKS.md (\`cto-jev tasks\`). No new docs.
   - Changes what the CONCEPT says (a business rule, the scope, what the user sees): edit its CONCEPT.md, set \`Status: draft\`, update the SPEC to match, run the docs review (step 5), stop for sign-off.
   - Changes only the SPEC (\`## Interface\`, \`## Constraints\`, \`## Acceptance\`, \`## Internals\`) and still does what the CONCEPT says: edit the SPEC and add the tasks. No sign-off.
   - A new module: \`features/<slug>/\` with the four files below.
   - An existing module with no feature folder yet: create its folder describing what exists today (short CONCEPT with \`Status: draft\`, SPEC with its sections; Acceptance lists what the code does today), before any task on it.
   - Infrastructure (CI, build, deploy, dependency upgrades): a task under \`features/platform/\`.
3. Talk before you write, about the CONCEPT only. Restate the request in two sentences and ask until every CONCEPT question below has an answer or an explicit "not relevant". At most five questions per message, each with your best guess; an installed interview skill may run the rounds, the questions below are what must be answered. Do not write CONCEPT.md until they are settled. The SPEC questions you answer yourself, from the CONCEPT and the code; what you cannot prove becomes an \`Assumed: ...\` line in the SPEC, not a question.
   - For CONCEPT (ask the user): who uses this and what changes for them; which business rules apply, including what happens on failure, limits, roles and paid tiers; what the user sees when it works, concrete enough that a test could fail on it ("after a refund the order page says Refunded"); what is explicitly out of scope; which existing features it touches; which simpler option was considered and why it was rejected (goes under \`## 動機\`).
   - For SPEC (answer yourself): which data and tables change, and whether existing data must migrate and how it rolls back; what other features may call (the Interface) and what stays private; the error cases and what the user sees; how a failure in production gets noticed (migration, rollback and that go under \`## Internals\`); the hard rules the code must never break (the Constraints); how each part will be verified, and for what the user sees, the acceptance scenarios (the Acceptance): the steps, the expected result a script can compare, and the screen widths. Each scenario comes from a rule in the CONCEPT, so a check you write later compares against what the user signed, not your guess.
4. Write CONCEPT.md, then SPEC.md. Constraints are testable rules ("a refund always writes an audit row"), not aspirations. Interface is only what other features may call. Acceptance is one line per scenario, step → expected result, measurable ("at 375px wide: no horizontal scroll, Save visible without scrolling"; "empty email: 'Email required' under the field, nothing sent"), never "looks right". What only taste can judge (is it pleasing, does it match the brand) is one line marked \`(look)\`; that line becomes a \`manual\` task.
5. **Review the docs before the user does.** Dispatch a reviewer with none of your context, which may read and search the code. It reads CONCEPT.md and SPEC.md and answers four questions: could an engineer new to this repo build it from these two files without making a design decision; does it build something not needed now, or something the code already has; which business rules, error cases, roles/permissions or data cases are missing; and does every Acceptance scenario have an expected result a script can check and a CONCEPT rule it comes from (a vague one, one the CONCEPT does not back, or a \`(look)\` line that could be measured, is a finding). Findings are P1 or P2; handle them as under "Review findings" below, fixing both P1 and P2 in the docs now (the docs are cheap to change). A CONCEPT gap only the user can settle goes into the CONCEPT as \`Assumed: ...\` and into the handoff's "might be missing". Append one REVIEW.md entry: date, "docs", counts, what was contested or escalated.
6. Walk the user through CONCEPT.md section by section, including what the review changed, and ask what is wrong or missing. Edit, walk through again, until they have nothing to add. Do not walk them through the SPEC.

**Stop:** when the user says the CONCEPT is complete: send a review handoff (see "Sign-off") for CONCEPT.md. Never write TASKS.md before the CONCEPT is approved; cto blocks the commit anyway. Once it is signed, go straight on to \`cto-jev tasks\` and \`cto-jev work\` unless the user said otherwise.

CONCEPT.md: \`Status:\` line, then \`## 目的\` (one sentence), \`## 動機\`, \`## 商業規則\`, \`## 不做的事\`.
SPEC.md: no \`Status:\` line; \`## Interface\`, \`## Constraints\`, \`## Acceptance\`, \`## Internals\`, in this order.
REVIEW.md: created empty with one line saying it is pending.

## cto-jev tasks

**When:** the user says "cto-jev tasks", or CONCEPT.md is \`Status: approved\` and TASKS.md is empty or the request adds work.

1. One parent per deliverable, children small enough for one sub-agent and one acceptance command.
2. Every child gets \`(files:)\` (the directories it changes, never bare \`src/\`), \`(after:)\` for anything that must be ticked first (across features too), and an acceptance line: a runnable command. A task the user sees is accepted by the end-to-end test of the SPEC's Acceptance scenarios it covers (named in the task line), e.g. \`npx playwright test e2e/customers.spec.ts\`; driving a browser by hand is how you write that test, never how you accept. If ARCHITECTURE.md \`## 驗證指令\` names no end-to-end command, do not ask: plan the harness as a \`(seq)\` task under \`features/platform/\` that the UI tasks wait on, write the choice into the SPEC as \`Assumed: ...\`, and say in your final report that ARCHITECTURE.md needs the new command (it is a signed doc: it changes only through sign-off). \`manual\` only for a \`(look)\` line: what taste must judge, not sizes or behaviour a script can measure. Write what to look at and where on the line itself, \`manual: <what to look at> @ <url, command or screenshot path>\`: cto shows the user that text, so they never have to open TASKS.md to learn what an id means.
3. Shared files (route tables, shared types, migrations, a single test file, the CLI entry point) get their own sequential task; take them out of the other tasks' \`(files:)\`.
4. Run \`cto index\` and read \`cto brief\`: Ready should list the first wave; nothing should be Blocked on a missing id.

**Stop:** none: go straight on to \`cto-jev work\`; what this job has to tell the user goes into that job's report.

\`\`\`md
- [ ] CUST-1 Customer list
  - [ ] CUST-1.1 List API, filtered by role (after: PERM-2) (files: src/customers/api/)
        驗收: npm test -- customers/api
  - [ ] CUST-1.2 List UI: Acceptance "filter by role", "375px no horizontal scroll" (after: CUST-1.1) (files: src/customers/ui/, e2e/customers.spec.ts)
        驗收: npx playwright test e2e/customers.spec.ts
  - [ ] CUST-1.3 List matches the brand (look) (after: CUST-1.2) (files: src/customers/ui/)
        驗收: manual: list page colours and spacing against the brand sheet, at 375px and 1280px @ http://localhost:3000/customers
\`\`\`

IDs: \`<PREFIX>-<n>\`, children \`<n>.<m>\`, prefix uppercase and unique across the repo. A parent has no \`(files:)\` and no acceptance line; it is done when all children (at most 15) are ticked. \`accept:\` is accepted as a synonym for \`驗收:\`.

Two more tags, on any task:
- **Priority** \`(P1)\` / \`(P2)\` / \`(P3)\`. P1: do first, and nothing releases while one is open (blockers, review findings that are wrong or unsafe). P2: normal work; the default when the tag is absent. P3: when nothing else is left (polish, nice-to-have). brief lists Ready as P1, then P2, then P3.
- **Sync** \`(seq)\`: this task runs alone, whatever its \`(files:)\` say. Use it for migrations, shared types, route tables, anything that touches state every other task reads. Without the tag a task may run together with any Ready task whose \`(files:)\` do not overlap its own; brief computes that and shows the "run together" set. A task with no \`(files:)\` also runs alone, since its reach is unknown.

\`\`\`md
- [ ] CUST-3 Add customer_tier column (P1) (seq) (files: db/migrations/)
      驗收: npm run migrate:test
- [ ] CUST-4 Tier badge in the list (P3) (after: CUST-3) (files: src/customers/ui/, e2e/tier.spec.ts)
      驗收: npx playwright test e2e/tier.spec.ts
\`\`\`

## cto-jev work

**When:** the user says "cto-jev work" or "continue", or \`cto brief\` shows Ready tasks.

Branches: work on an integration branch (\`review\`, or whatever the repo calls it; see the table under \`cto-jev release\`). The release branch only receives \`cto-jev release\`. Never commit to it directly; if it is not in \`protected_branches\` in \`.cto.json\`, say so in your final report. The one exception is a repo with only \`main\` and one developer (the first row of that table): there you commit each reviewed wave to \`main\` (\`cto-jev work all\` uses a branch instead, below), and \`main\` stays out of \`protected_branches\`, or every commit would be blocked.

Every wave, one after another, until nothing is Ready. Do not ask before a wave and do not stop between waves; the steps below are one wave.

1. \`cto brief\`. Dispatch only Ready tasks, skipping the ones you parked (see "Where you stop"); the "run together" set is safe to run at once. P1 tasks go first. Say in one line what this wave runs, then run it.
2. One sub-agent per task. Give it only: the task line, the feature's SPEC.md, the \`## Interface\` of each feature it depends on, the list of files it may touch, and "do not edit anything else, write nothing outside this repo (no notes, no lesson logs), no git commands; report what you changed and what you found ambiguous". Each sub-agent writes its own new test file; nobody appends to a shared one. A task accepted by an end-to-end test also gets the Acceptance lines it covers: the test is written from them first and seen failing, then the code.
3. When they return: \`git status\`; revert anything outside the union of their \`(files:)\`. Integrate the shared files yourself. Fix any existing test their change broke. A sub-agent's "the SPEC does not say" goes into the SPEC now, not into the code's comments.
4. Accept by running the task's acceptance command yourself; never trust the report. Tick only on a pass. A failing end-to-end test means the code is wrong. If you think the expectation is wrong instead, the CONCEPT decides: where it backs the scenario, the code is wrong after all; where it says otherwise, fix the SPEC's Acceptance first, then the test, and note it in the wave's REVIEW.md entry; where it is silent, do the same and add an \`Assumed: ...\` line. Never change a test to match the code without changing the Acceptance line it came from. \`manual\` does not wait for the user: build it, run what can be run, take screenshots at each width the Acceptance names, and tick it. cto reminds the user with the text on its acceptance line, and your final report lists every manual task of the run with that text and the screenshot paths. A task the user decided not to do: add \`(dropped: <reason>)\` to its line, tick it, and say "<id> dropped" in your final message. Dropping is the user's call: a task you think is no longer needed (what it checks is gone) is parked and listed in your report with that reason, never dropped by you; never drop a task to get past a block. A dropped task counts as closed, so the tasks that wait on it (\`(after:)\`) become Ready: drop or re-plan them first. Tick the parent when its last child is ticked.
5. **Review before you commit.** Dispatch a reviewer with none of your context: it reads the feature's CONCEPT.md and SPEC.md and the uncommitted diff, and returns findings each marked P1 (wrong, unsafe, breaks a Constraint or the Interface, does something the CONCEPT does not say or contradicts, or an acceptance test that would still pass with its scenario broken) or P2 (should improve, can wait). You wrote both the code and its tests, so the reviewer answers one question per acceptance test: if the scenario were not met, would this test fail. Handle them as under "Review findings": fix every P1 now and re-run acceptance; write every P2 as a \`(P2)\` task in TASKS.md. Append one entry to REVIEW.md: date, scope (the task ids of the wave), how many P1/P2, which task ids they became, what was contested or escalated.
6. \`cto check\`, then commit the wave to the review branch.

Without sub-agents: do the Ready tasks yourself in brief's order, one at a time, accepting each before the next; review your own diff against the SPEC before each commit. That is not a review by a fresh reader: write \`self-review\` in its REVIEW.md entry, so the release review looks harder at those waves.

**Stop:** when no task is left to run (everything open is parked, or waits on a parked task). One report: tasks done (with commits); then what waits on the user, each with your best guess: parked tasks and why, \`manual\` tasks to look at (what and where), every \`Assumed:\` added, findings left unfixed because only the user can decide them. Never release.

### cto-jev work all

**When:** the user says "cto-jev work all" (\`/cto-jev work all\`), typically on a new project: the same run as \`cto-jev work\`, but on a branch and with one review at the end instead of one per wave. Only on request.

1. Branch: in a repo with only \`main\`, create a branch \`work-all\` from \`main\` and work there, since these waves are not reviewed one by one; every other repo uses its integration branch as usual. Note the commit you start from.
2. Loop until no task is left to run: re-read \`cto brief\` and the TASKS.md files each round, then run steps 1 to 4 and step 6 of \`cto-jev work\` (dispatch, integrate, accept, commit) for the Ready tasks, skipping tasks you parked (below) and every task of a feature whose CONCEPT is not \`Status: approved\` (cto blocks those commits; list the feature instead). There is no per-wave review: each wave's REVIEW.md entry says "work all, reviewed at the end". \`cto check\` and the git hooks still run on every commit. Without sub-agents, do the tasks yourself in brief's order; the end review is then a \`self-review\`.
3. Fix along the way: a failing acceptance or a broken test is yours to fix before moving on. The same failure twice means a different approach, not a third try.
4. Never stop for the user mid-run: park the task instead. Parked means unticked, never dispatched again in this run, and its dependants wait too (they are not Ready while it is unticked). The parked ids live only in this conversation; the final report lists them, and the next run starts without them. Park a task when:
   - it needs a decision that would contradict the signed CONCEPT. Do not edit the CONCEPT or its \`Status:\` line in this run. A gap the CONCEPT leaves open you decide yourself, in any SPEC section (\`## Interface\`, \`## Constraints\`, \`## Acceptance\`, \`## Internals\`): write it there as \`Assumed: ...\`;
   - you think it should be dropped (never drop in this run; the user decides);
   - it needs credentials, money, an outside account, or anything irreversible;
   - it still fails after a second approach.
5. When no task is left to run, the review: a reviewer with none of your context reads \`git diff <start>..HEAD\` and the SPECs of every feature touched, findings P1/P2/P3, handled as under "Review findings" except that escalations and undecided contests go to the final report instead of stopping the run (a contested finding stays unfixed until the user decides). Fix every P1 (with re-reviews of the fixes, at most three rounds in all), write P2 and P3 as tasks, commit, and append one REVIEW.md entry: date, "work all", the task ids, counts.
6. In a repo with only \`main\`: once every P1 of the review is fixed, merge \`work-all\` into \`main\` (that is the reviewed commit) and delete the branch. If any P1 is contested or escalated, do not merge: leave \`work-all\` for the user and say so in the report.

**Stop:** after step 5 (and 6), never before the review. One report: tasks done (with commits); then everything waiting on the user, each as one question with your best guess: parked tasks and why, \`manual\` tasks to look at (what and where), features skipped for a draft CONCEPT, every \`Assumed:\` added, escalated findings and undecided contests. Never release; the next step is the user's answers, then \`cto-jev work\` or \`cto-jev release\`.

## Review findings

Every review (docs, wave, release) ends here. You wrote what was reviewed, so wanting to disagree is not evidence.

- **Contest** a finding only by citing something the reviewer could read: a file and symbol, or a decision written in the docs. "It was intentional" is not evidence.
- **Escalate** to the user when the evidence is outside anything the reviewer could read (a verbal decision, a team convention). Do not dismiss it yourself; if the user confirms, write the fact into the docs.
- A reviewer who could not follow the docs found missing context. Never contest that.
- Never change a severity yourself. A P1 that looks like a P2 is contested like any finding, with evidence, and the user decides.
- An escalated finding, or a contest the user has not decided, does not stop a run: leave that finding unfixed, write it into the REVIEW.md entry, go on, and list it in your final report and the release report. In a docs review it goes into the handoff's "might be missing" instead, since that job stops for sign-off anyway. Before escalating, read the CONCEPT: what it decides is not the user's to decide again.
- After fixing P1s, a new reviewer with none of your context reads only the fixes. At most three rounds per review: the first plus up to two re-reviews of only the fixes. If P1s remain after round three, stop fixing and hand them to the user (an escalation). Anything below P1 becomes a task with its severity (in a docs review, where no tasks may exist yet: fixed in the docs or put in the handoff's "might be missing").
- Without sub-agents every review here, the re-review included, is your own: say \`self-review\` in its REVIEW.md entry.

## cto-jev release

**When:** the user says "cto-jev release", or asks to merge, ship or deploy.

First decide what "release" means in this repo. Look at \`git branch -a\` and the deploy config once, tell the user which row applies, and keep it:

| The repo has | Work goes to | Release means | Review scope |
|---|---|---|---|
| \`main\` only, one developer | \`main\` directly, after the wave review in \`cto-jev work\` | a tag (\`vX.Y.Z\`) or a deploy from \`main\` | \`git diff <last tag>..HEAD\` |
| \`main\` + feature branches | a branch per feature or per wave | the PR into \`main\` | the PR diff, \`cto check --base main\` |
| \`main\` + an integration branch (\`review\`, \`develop\`, \`staging\`) | the integration branch | merging it into \`main\` (what deploys to production) | \`git diff main...<integration>\` |
| \`staging\` and \`live\` (or \`production\`) deploy branches | \`staging\` | promoting \`staging\` to \`live\` | \`git diff live...staging\`; a second, lighter release review |

Whatever the row, one rule holds: the branch that reaches users receives nothing without a release review, and \`protected_branches\` in \`.cto.json\` names it. In the \`main\`-only row the wave review before each commit is that review, and \`main\` is not protected.

1. Everything to be released is on the work branch and every P1 task is ticked. If not, run \`cto-jev work\` first; what it parks goes into this release's report. If a P1 is still open after that (parked), the release ends here: report it with the parked list, no merge.
2. Dispatch a reviewer with none of your context over the whole unreleased diff (the review scope above) plus the SPECs of every feature it touches; point it at the waves marked \`self-review\` in REVIEW.md. Findings get P1, P2 or P3, handled as under "Review findings", written into TASKS.md.
3. P1 findings are fixed (through \`cto-jev work\`, whose wave review counts as the re-review) before anything else; P2 and P3 stay as tasks for after the release. Tell the user both lists and let them decide which P2 should move up. With them, everything collected since the last release that only the user can judge, grouped by feature: every \`Assumed:\` line added, every \`manual\` task ticked (what to look at and where, from its acceptance line), every finding left unfixed for their decision. This is the one place the user reads them.
4. \`cto check --base <release branch>\` must pass. Then prepare the merge, PR or tag; the user performs it. Append one REVIEW.md entry per feature released: date, "release", counts, task ids, what was contested or escalated.

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

- Set \`Status: approved\` yourself. The user signs: in Claude Code by agreeing to your \`Review:\` handoff (cto's hook sets it), elsewhere by editing the line.
- Change approved content without first setting \`Status: draft\` with the Edit tool, or write a signed-off doc from the shell.
- Stop to ask for a go-ahead, a SPEC approval or a \`manual\` confirmation. The user signs the CONCEPT and reads the release report; in between you work.
- Build something the signed CONCEPT does not say, or contradicts, by changing only the SPEC.
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
    CONCEPT.md             why: 目的, 動機, 商業規則, 不做的事; user signs off
    SPEC.md                how: Interface, Constraints, Acceptance, Internals; yours, not signed
    TASKS.md               the only state; review findings carry (P1)/(P2)
    REVIEW.md              one entry per docs review, wave review and release
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
/** `dry`: decide exactly as a real run would, write nothing (the setup summary lists these before asking). */
export function syncGuidance(root: string, chosen: Set<AgentName>, removeOthers: boolean, flow = false, dry = false): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  for (const m of MEMORY_FILES) {
    const path = join(root, m.path);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (m.agents.some((a) => chosen.has(a))) {
      const next = appendMd(current, flow);
      if (next !== current) { if (!dry) writeFileSync(path, next); written.push(m.path); }
    } else if (removeOthers && mdBlockRe.test(current)) {
      const rest = removeMd(current);
      if (!dry) { if (rest.trim()) writeFileSync(path, rest); else unlinkSync(path); }
      removed.push(m.path);
    }
  }
  const skill = join(root, SKILL_PATH);
  if (chosen.size) {
    if (!existsSync(skill) || readFileSync(skill, 'utf8') !== SKILL_TEXT) {
      if (!dry) { mkdirSync(dirname(skill), { recursive: true }); writeFileSync(skill, SKILL_TEXT); }
      written.push(SKILL_PATH);
    }
  } else if (removeOthers && existsSync(skill) && readFileSync(skill, 'utf8').includes(SKILL_MARK)) {
    if (!dry) removeFileAndEmptyDirs(root, skill);
    removed.push(SKILL_PATH);
  }
  const legacy = join(root, LEGACY_SKILL);
  if (existsSync(legacy) && readFileSync(legacy, 'utf8').includes(SKILL_MARK)) {
    if (!dry) removeFileAndEmptyDirs(root, legacy);
    else removed.push(LEGACY_SKILL); // only the plan lists it; a real run removes it silently, as before
  }
  return { written, removed };
}

/**
 * Write or refresh the cto-jev skill when the flow is enabled, plus the `/cto-jev` command when Claude Code is one of the
 * agents; remove each (only if cto-marked) when not. The 0.9.x `cto-flow` skill is always removed.
 */
export function syncFlowSkill(root: string, enabled: boolean, dry = false, claude = false): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  const sync = (rel: string, text: string, want: boolean) => {
    const path = join(root, rel);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (want) {
      // A file of the same name without the marker is the user's own (e.g. their own /cto-jev command): never overwrite it.
      if (current === text || (current !== undefined && !current.includes(SKILL_MARK))) return;
      if (!dry) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
      written.push(rel);
    } else if (current?.includes(SKILL_MARK)) {
      if (!dry) removeFileAndEmptyDirs(root, path);
      removed.push(rel);
    }
  };
  sync(FLOW_SKILL_PATH, FLOW_SKILL_TEXT, enabled);
  sync(FLOW_COMMAND_PATH, FLOW_COMMAND_TEXT, enabled && claude);
  sync(LEGACY_FLOW_SKILL, '', false);
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
