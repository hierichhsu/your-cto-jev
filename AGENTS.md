<!-- >>> YOUR CTO JEV START >>> -->
## Rules enforced by cto

This repo is guarded by cto: every rule below is checked automatically, and breaking one gets you blocked.

- **Start with `cto brief`.** It shows the sprint goal, the command that verifies this repo, open plan items, and how commands failed here before and what fixed them. Skip it only if cto is not installed.
- **Secrets stay out of code.** Use environment variables, never literal keys, tokens or passwords. (`credential_leak` blocks the commit)
- **Fix the code, not the tests.** Never skip, delete or loosen a test, rewrite an expectation to match wrong output, or lower coverage. (`test_tampering` blocks the commit)
- **Done means verified.** After your last code change, run the relevant tests or build and see them pass before saying done or checking off a plan item; otherwise say what is unverified. (`done_unverified` sends you back)
- **Two strikes, change approach.** Same command, same error twice: stop retrying and try something different. (`infinite_loop` blocks the retry)
- **Ask before anything irreversible:** deleting data, force-pushing, rewriting history, dropping a database. (`destructive_command` blocks it)
- **Stay on the sprint goal in `.cto.json` and keep changes simple.** (`architecture_violation` and `code_complexity` warn)
- **Run `cto check` before committing**, and never bypass a block (`--no-verify`, editing hooks or thresholds). If a block looks wrong, tell the user.
- **Work is planned in `docs/cto_jev/`.** Before planning, breaking down, dispatching or accepting work, read `.agents/skills/cto-flow/SKILL.md`; `cto brief` lists what is ready.

Details and how to handle a block: `.agents/skills/cto/SKILL.md`.
<!-- <<< YOUR CTO JEV END <<< -->
