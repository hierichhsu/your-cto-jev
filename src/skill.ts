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
`;

// The flow skill: how the host agent plans, dispatches and accepts work under docs/cto_jev/. Written only when
// `cto setup` chose the flow; the body mirrors docs/cto_jev/features/cto-flow/SPEC.md.
export const FLOW_SKILL_TEXT = `---
name: cto-flow
description: How work is planned, broken down, dispatched, accepted and reviewed in this repo through docs/cto_jev/. Load it whenever you are asked to plan, break down, dispatch or accept work, to start a new feature, or to handle a new request that is bigger than one edit.
---
${SKILL_MARK}

# cto-flow: planning and dispatch in this repo

You are the CTO of this repo. The plan lives in \`docs/cto_jev/\`; the only state is the checkboxes in TASKS.md.

## First run

When PRODUCT.md or ARCHITECTURE.md still holds \`unknown\` fields, fill them before anything else. Scan the repo first: README, package.json (or the equivalent manifest), .env.example, the directory tree, existing docs. Fill every field you can and tag each with its source, \`(from: <file>)\`. Then ask the remaining fields in ONE batch of at most five questions, each with your best guess so the user only has to confirm; \`skip\` leaves the field \`unknown\`. Write both files with \`Status: draft\` and stop: the user reads them and flips the status.

## The seven steps

1. **Start with \`cto brief\`.** It regenerates INDEX.md and lists Ready tasks (dependencies all ticked, \`(files:)\` not overlapping another Ready task), Blocked tasks and what blocks them, and the \`unknown\` fields left in PRODUCT.md and ARCHITECTURE.md. Dispatch only when there are Ready tasks; otherwise break work down first.
2. **Classify a new request against INDEX.md.** Inside an existing feature: only add tasks to its TASKS.md. Touches a feature's \`## Constraints\`: edit SPEC.md, set it back to \`Status: draft\`, stop and wait for the user's sign-off. A new module: create the four files of a new feature. An existing module that has no feature folder yet gets one describing what exists today (a short CONCEPT.md, a SPEC.md with the three sections), \`Status: draft\`, before any task on it. Infrastructure (CI, build, deploy, dependency upgrades): a task under \`features/platform/\`.
3. **Dispatch with the narrowest reading set.** One sub-agent per Ready task. Give it only: that task's line from TASKS.md, the feature's SPEC.md, and the \`## Interface\` section of each feature it depends on (\`after:\` across features). Nothing else; cross-feature reads stop at Interface.
4. **Accept by running the check yourself.** Never trust a sub-agent's report. Run the task's \`驗收:\` command yourself; tick the box only when it passes. A task whose check is \`manual\` waits for the user to confirm in the conversation; when you tick it, say it was accepted manually.
5. **Review with a zero-context reviewer.** When every task of a feature is ticked, dispatch a reviewer that has none of your context. It reads CONCEPT.md, SPEC.md and the diff, and writes REVIEW.md: what it reviewed, how many findings, which tasks they map to. Every finding becomes a new task; nothing is fixed from the review directly.
6. **Run \`cto docs\` before opening a feature.** It scans markdown outside \`docs/cto_jev/\` and suggests merge / archive / delete without touching files. Bring the suggestions to the user; they decide, then you act.
7. **Never:** set \`Status: approved\` yourself (only the user does); keep state anywhere other than TASKS.md checkboxes (no side lists, no status files, no \`cto task done\`); guess a PRODUCT.md field. \`unknown\` is a valid value; ask or leave it.

## Directory layout (fixed names, fixed count)

\`\`\`
docs/cto_jev/
  INDEX.md                 generated by cto; never hand-edit
  PRODUCT.md               CTO writes, user signs off
  ARCHITECTURE.md          CTO writes, user signs off
  decisions/NNNN-<slug>.md append-only
  features/<slug>/
    CONCEPT.md             why: purpose, motivation, business rules, non-goals
    SPEC.md                how: Interface, Constraints, Internals
    TASKS.md               parent/child tasks, dependencies, acceptance
    REVIEW.md              zero-context review: what, how many findings, which tasks
  archive/<YYYYMM>-<name>/ old documents moved in from elsewhere; agents do not read them
\`\`\`

Three top-level files, four files per feature. \`features/platform/\` always exists for infrastructure work.

## Sign-off

The first non-heading line of CONCEPT.md, SPEC.md, PRODUCT.md and ARCHITECTURE.md is \`Status: draft\` or \`Status: approved\`. You write the document and stop; the user flips it to approved. A feature with a TASKS.md but a SPEC.md that is not approved blocks commits.

## SPEC.md has exactly three sections

| Section | Reader | Holds |
|---|---|---|
| \`## Interface\` | engineers of other features | exported functions, APIs, events, tables |
| \`## Constraints\` | the drift check | hard business rules, one per line |
| \`## Internals\` | engineers of this feature | implementation detail |

Another feature reads only your Interface. Changing Interface warns every feature that depends on it.

## TASKS.md syntax

\`\`\`md
- [ ] FLOW-1 Parent description
  - [ ] FLOW-1.1 Child description (after: PERM-2) (files: src/x/)
        驗收: npm test -- x
\`\`\`

- ID: \`<PREFIX>-<n>\`, children \`<n>.<m>\`. Prefix uppercase, unique across the repo.
- Parents nest children by indent; a parent has no \`(files:)\` and no \`驗收:\`, and counts as done only when all children are ticked (at most 15).
- \`(after: ID[, ID])\`: tasks that must be ticked first. An \`after:\` into another feature is a feature dependency.
- \`(files: path/[, path/])\`: the directories or files the task changes, down to the feature's own directory, never bare \`src/\`. The union of \`(files:)\` is the feature's code scope; there is no other source.
- \`驗收:\` one runnable command, or \`manual\`.

## Size of a change

- Change inside an existing feature: only add tasks.
- Touches \`## Constraints\`: SPEC.md back to \`Status: draft\`, wait for sign-off before any task runs.
- New module: a new feature with its four files.
- Infrastructure: a task in \`platform\`.

## Shared files

Work that touches shared files (route tables, shared types, migrations) is its own task, run sequentially: it is never marked parallel and never shares a dispatch round with a task that overlaps it. When several tasks each need a shared file (the CLI entry point, a single test file), take it out of their \`(files:)\`, have each sub-agent write its own new file instead (its own test file), and do the shared-file integration yourself after they return. When sub-agents return, run \`git status\` and check that nothing outside the union of their \`(files:)\` changed; revert what did.

## When you cannot spawn sub-agents

Do the Ready tasks yourself, in the order \`cto brief\` lists them, one at a time; accept each one with its \`驗收:\` command before starting the next. Everything else above still applies.
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
