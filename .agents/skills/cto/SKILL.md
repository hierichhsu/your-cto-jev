---
name: cto
description: Development rules enforced in this repository by the cto gatekeeper, with what each check looks for and what to do when blocked. Use before committing, before saying a task is done, after a command fails, before running anything destructive, and whenever a cto hook blocks you.
---
<!-- Managed by `cto setup`. Re-run it to update; local edits are overwritten. -->

# cto: the rules of this repo

This repository is guarded by **cto** (your-cto-jev). Hooks review your commits and commands with a decision model.
Each rule below has a check behind it. Following the rules is faster than being blocked.

| Rule | What enforces it |
|---|---|
| **Secrets stay out of code.** Never write API keys, tokens, passwords or private keys into code or committed files. Read them from environment variables. | `credential_leak` blocks the commit |
| **Fix the code, not the tests.** When a test fails, change the code under test. Never skip, comment out or delete a test, loosen an assertion, change an expected value to match wrong output, swallow the error, or lower a coverage threshold. A test may only go away together with the feature it covers, and you say so. | `test_tampering` blocks the commit |
| **Done means verified.** After your last code change, run the relevant tests, build or type check and see it pass before you say the work is done. Checking off a plan item (`- [x]`) is the same claim; check off a phase or parent item only when everything under it is done. If you cannot, say plainly what is not verified and why. | `done_unverified` sends you back to work |
| **Two strikes, change approach.** If a command fails with the same error twice, stop retrying. Read the error, inspect the code, and try something different. | `infinite_loop` blocks the retry once |
| **Ask before anything irreversible.** Get the user's explicit OK before deleting data outside build output, force-pushing, rewriting shared history, or dropping a database. | `destructive_command` blocks the command |
| **Stay on the sprint goal.** If `.cto.json` sets a `sprint_goal`, keep changes inside it and point out anything unrelated. | `architecture_violation` warns |
| **Keep it simple.** Prefer the smallest change that solves the problem. | `code_complexity` warns |

## Before you start

Run `cto brief`. It prints the sprint goal, the command that verifies this repo, the open plan items, and the lessons
of this repo: commands that failed before, how often, and the edit that made them pass. When a command you are about
to run is listed there, read its lesson first. Lessons are collected automatically from every failed command and kept
in `.cto-lessons.jsonl`; add a note to one with care, since the file is shared with the team.

## Before you commit

Run `cto check`. It runs the same commit checks on your staged changes (or, if nothing is staged, on all working-tree
changes including new files) without committing, and prints every score with its threshold. Fix anything it flags,
then commit. If `cto` is not installed on this machine, skip this step.

## When cto blocks you

Read the message, fix the cause, and try again. Never bypass a block: no `git commit --no-verify`, no disabling or
editing hooks, no changing `.cto.json` thresholds to get through. If you believe a block is wrong, stop and tell the
user what was blocked and why you disagree; the user decides. The user can record a wrong call with `cto report`, which
turns it into a calibration case; you do not run that yourself.

## Commands

- `cto brief`: sprint goal, verify command, open plan items, and this repo's lessons. Run it before you start.
- `cto check`: preview the commit checks on your current changes.
- `cto doctor`: show whether cto is working here (keys, hooks, recent checks).
- `cto index`: regenerate `docs/cto_jev/INDEX.md` (only in a repo that uses the development flow).
- `cto docs`: list stale planning markdown outside `docs/cto_jev/` with a suggestion per file; changes nothing.
