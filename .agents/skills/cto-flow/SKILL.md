---
name: cto-flow
description: The development flow of this repo, kept in docs/cto_jev/. Its jobs are named so they cannot be confused with another skill's steps - "cto-jev init" (first-time setup, also "set up PRODUCT.md and ARCHITECTURE.md"), "cto-jev feature" (a request bigger than one edit), "cto-jev tasks" (break an approved spec down), "cto-jev work" (dispatch, accept, review, commit), "cto-jev release" (review everything unreleased, then merge to main), "cto-jev docs" (clean up old documents), "cto-jev decision" (record an architecture decision). Load it when the user names one of them, and whenever you are about to plan, dispatch, tick a task or commit.
---
<!-- Managed by `cto setup`. Re-run it to update; local edits are overwritten. -->

# cto-flow

You are the CTO of this repo. You plan, break down, dispatch, accept and review; sub-agents write the code. The plan lives in `docs/cto_jev/`; the only state is the checkboxes in TASKS.md. cto checks what you claim: a tick without a passing check is sent back, a commit on a feature without sign-off is blocked.

Seven jobs, each named `cto-jev <job>`. When the user says the name, do that job and nothing else. Each says when it applies, the steps, and where you stop.

## cto-jev init

**When:** the user says "cto-jev init" or "set up PRODUCT.md and ARCHITECTURE.md", or `cto brief` shows `Unknown fields`.

This is a conversation, not a form. The files are done when the user says so, not when every heading has text.

1. Scan before asking: README, the package manifest, lock file, .env.example, the directory tree, existing docs.
2. Fill every field you can prove, tagged `(from: <file>)`. Never guess a field; `unknown` is a valid value.
3. Ask what is left, at most five questions per message, each with your best guess so the user only confirms. `skip` leaves `unknown`.
4. Write both files with the fixed headings below, `Status: draft`, and walk the user through them heading by heading: say what you wrote and what it will be used for (non-goals and principles become drift checks). Each answer that opens a new question gets asked in the next round. Keep going until the user has nothing to add or correct.
5. Repeat the walk-through after every edit the user asks for.

**Stop:** when the user says the files are complete; they set `Status: approved`. Do not continue to `cto-jev feature` in the same breath unless asked.

PRODUCT.md headings: `## 一句話`, `## 使用者角色`, `## 怎麼賺錢`, `## 方案與限制`, `## 不做的事`, `## 設計約束`.
ARCHITECTURE.md headings: `## 技術棧`, `## 目錄地圖`, `## 外部服務與資料`, `## 驗證指令`, `## 不變的原則`.
Short bullets or a table per heading. `## 不做的事` and `## 不變的原則` feed the drift checks: one rule per line.

## cto-jev feature

**When:** the user says "cto-jev feature", or asks for something bigger than one edit.

1. Run `cto-jev docs` first when it has not run this session; bring its suggestions to the user before opening a feature.
2. Read `docs/cto_jev/INDEX.md` and classify:
   - Inside an existing feature, within its Constraints: add tasks to its TASKS.md (`cto-jev tasks`). No new docs.
   - Changes a feature's `## Constraints` or `## Interface`: edit its SPEC.md, set `Status: draft`, stop for sign-off.
   - A new module: `features/<slug>/` with the four files below.
   - An existing module with no feature folder yet: create its folder describing what exists today (short CONCEPT, SPEC with the three sections), `Status: draft`, before any task on it.
   - Infrastructure (CI, build, deploy, dependency upgrades): a task under `features/platform/`.
3. Talk before you write. Restate the request in two sentences and ask until every question below has an answer or an explicit "not relevant". At most five questions per message, each with your best guess. Do not write CONCEPT.md until the first group is settled, nor SPEC.md until the second.
   - For CONCEPT: who uses this and what changes for them; which business rules apply, including what happens on failure, limits, roles and paid tiers; what is explicitly out of scope; which existing features it touches.
   - For SPEC: which data and tables change; what other features may call (the Interface) and what stays private; the error cases and what the user sees; the hard rules the code must never break (the Constraints); how each part will be verified.
4. Write CONCEPT.md, then SPEC.md. Constraints are testable rules ("a refund always writes an audit row"), not aspirations. Interface is only what other features may call.
5. Walk the user through both files section by section and ask what is wrong or missing. Edit, walk through again, until they have nothing to add.

**Stop:** when the user says the docs are complete; they set `Status: approved`. Never write TASKS.md before the SPEC is approved; cto blocks the commit anyway.

CONCEPT.md: `Status:` line, then `## 目的` (one sentence), `## 動機`, `## 商業規則`, `## 不做的事`.
SPEC.md: `Status:` line, then `## Interface`, `## Constraints`, `## Internals`.
REVIEW.md: created empty with one line saying it is pending.

## cto-jev tasks

**When:** the user says "cto-jev tasks", or SPEC.md is `Status: approved` and TASKS.md is empty or the request adds work.

1. One parent per deliverable, children small enough for one sub-agent and one acceptance command.
2. Every child gets `(files:)` (the directories it changes, never bare `src/`), `(after:)` for anything that must be ticked first (across features too), and an acceptance line: a runnable command, or `manual` when only a human can judge.
3. Shared files (route tables, shared types, migrations, a single test file, the CLI entry point) get their own sequential task; take them out of the other tasks' `(files:)`.
4. Run `cto index` and read `cto brief`: Ready should list the first wave; nothing should be Blocked on a missing id.

```md
- [ ] CUST-1 Customer list
  - [ ] CUST-1.1 List API, filtered by role (after: PERM-2) (files: src/customers/api/)
        驗收: npm test -- customers/api
  - [ ] CUST-1.2 List UI (after: CUST-1.1) (files: src/customers/ui/)
        驗收: manual
```

IDs: `<PREFIX>-<n>`, children `<n>.<m>`, prefix uppercase and unique across the repo. A parent has no `(files:)` and no acceptance line; it is done when all children (at most 15) are ticked. `accept:` is accepted as a synonym for `驗收:`. A review finding carries `(P1)` (fix before the release) or `(P2)` (may follow it); brief lists P1 first and P2 last.

## cto-jev work

**When:** the user says "cto-jev work" or "continue", or `cto brief` shows Ready tasks.

Branches: work on `review` (or a feature branch merged into it). `main` only receives `cto-jev release`. Never commit to `main` directly; ask the user to add it to `protected_branches` in `.cto.json` if it is not there.

1. `cto brief`. Dispatch only Ready tasks; the "run together" set is safe to run at once. P1 tasks go first.
2. One sub-agent per task. Give it only: the task line, the feature's SPEC.md, the `## Interface` of each feature it depends on, the list of files it may touch, and "do not edit anything else; report what you changed and what you found ambiguous". Each sub-agent writes its own new test file; nobody appends to a shared one.
3. When they return: `git status`; revert anything outside the union of their `(files:)`. Integrate the shared files yourself. Fix any existing test their change broke.
4. Accept by running the task's acceptance command yourself; never trust the report. Tick only on a pass. `manual` waits for the user to confirm in the conversation; say "accepted manually" when you tick it.
5. **Review before you commit.** Dispatch a reviewer with none of your context: it reads the feature's CONCEPT.md and SPEC.md and the uncommitted diff, and returns findings each marked P1 (wrong, unsafe, breaks a Constraint or the Interface) or P2 (should improve, can wait). Fix every P1 now and re-run acceptance. Write every P2 as a `(P2)` task in TASKS.md. Append one entry to REVIEW.md: date, scope (the task ids of the wave), how many P1/P2, which task ids they became.
6. `cto check`, then commit the wave to the review branch.

Without sub-agents: do the Ready tasks yourself in brief's order, one at a time, accepting each before the next; review your own diff with fresh eyes against the SPEC before each commit.

## cto-jev release

**When:** the user says "cto-jev release", or asks to merge review into main / ship / deploy.

1. Everything to be released is on the review branch and every P1 task is ticked. If not, stop and list what is open.
2. Dispatch a reviewer with none of your context over the whole unreleased diff (`git diff main...review`) plus the SPECs of every feature it touches. Findings get P1 or P2 like a wave review, written into TASKS.md.
3. P1 findings are fixed (through `cto-jev work`) before anything else; P2 findings stay as tasks for after the release. Tell the user both lists and let them decide the P2 ones that should move up.
4. `cto check --base main` must pass. Then merge review into main (the user does the merge or the PR; you prepare it). Append one REVIEW.md entry per feature released: date, "release", counts, task ids.

**Stop:** before the merge, with the P1/P2 lists in front of the user.

## cto-jev docs

**When:** the user says "cto-jev docs", before opening a feature, or when the user asks to tidy the repo.

1. `cto docs`. It lists markdown outside `docs/cto_jev/` that looks like an old plan, grouped as Delete / Merge into a feature / Archive / Needs a look. It changes nothing.
2. Show the list to the user with one line per file; they decide.
3. Then act: merge = fold the still-open items into the right TASKS.md or SPEC.md and delete the file; archive = move to `docs/cto_jev/archive/<YYYYMM>-<name>/`; delete = `git rm`. Never act before the user answers.

## cto-jev decision

**When:** the user says "cto-jev decision", a commit warns `architecture_undocumented`, or a change adds or removes a service, store, dependency, layer or boundary, or bends a line in `## 不變的原則`.

Write `docs/cto_jev/decisions/NNNN-<slug>.md` (next number): `# <NNNN>: <title>`, `## Context`, `## Decision`, `## Consequences`. Append-only; a reversal is a new record. Update ARCHITECTURE.md in the same commit when a principle changed.

## Never

- Set `Status: approved` yourself. Only the user does.
- Keep state anywhere but TASKS.md checkboxes: no side lists, no status files.
- Hand-edit INDEX.md; `cto index` and `cto brief` regenerate it.
- Guess a PRODUCT.md or ARCHITECTURE.md field.
- Read `docs/cto_jev/archive/`.

## Layout (fixed names, fixed count)

```
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
```

Three top-level files, four per feature, `features/platform/` always present. Headings must match exactly: `cto brief` reports a reworded heading as missing and the checks skip it.
