---
name: project-iteration
description: "The CEO's standard workflow for iterating on any project repo (the sibling clones under sources/, e.g. hub). Use this skill whenever the user asks to add a feature, fix a bug, refactor, or 'iterate' on a repo — even if they don't say the word 'feature'. It enforces consistent branching, testing, PR structure, and changelog updates across all repos."
---

# Project Iteration

You are working on a solo developer's project. Consistency across sessions matters more than cleverness: a future Claude session (or the CEO) must be able to pick up where you left off.

## Stack assumptions

The repo's own CLAUDE.md defines its stack and overrides this skill — read it first. For a NEW repo with no stack decided, prefer the CEO's toolkit (TypeScript/Node, React/Next.js, C#) and justify anything else in the plan.

## Workflow (always in this order)

1. **Orient.** Read the repo's CLAUDE.md and README, and skim its recent DB plans (`ws plan list --status active`, filtered by the repo). List open PRs/issues relevant to the request before writing code.
2. **Plan.** Write a short plan (goal, files touched, risks) to the central DB — `node workspace/cli/ws.js plan set <slug> --kind plan --repo <repo> --title "<title>" --file <plan.md>` (compose the markdown, then import; plans render on the hub Documents page). NOT to a `docs/plans/` file — per-feature design records are project *memory*, not repo definition (churn-test invariant, workspace CLAUDE.md). For anything touching auth, payments, or data migrations, stop and get explicit approval before implementing. If a blocking ambiguity exists, ask before coding.
3. **Test plan.** Before implementation, write the test plan to the central DB — `node workspace/cli/ws.js plan set <slug> --kind test-plan --repo <repo> --title "<title>" --file <test-plan.md>` — with stable case IDs (`TP-<slug>-NNN`): happy path, edge, error, and regression cases, each marked `automated`, `manual`, or `deferred`. NOT to a `docs/test-plans/` file. The devops agent later audits these into regression baselines.
4. **Branch.** `feat/<slug>`, `fix/<slug>`, or `chore/<slug>`. Never commit directly to main.
5. **Implement in small commits.** Write the automated tests from the plan first, then code until green. Conventional commits (`feat:`, `fix:`, `chore:`, `refactor:`). Each commit should build. Reference test-plan case IDs in test names.
6. **Verify.** Run the full existing suite too. A feature without a test is not done. If the repo has no test harness, set up the minimal one for the language and note it in the plan doc.
7. **Document.** Update CHANGELOG.md and any affected docs. If a design decision was made, record it in the DB plan from step 2 (date, decision, why) — decision records are project memory and live in the DB, never as repo md files.
8. **PR.** Open a pull request — never merge it yourself. PR description template:
   - **What**: one paragraph
   - **Why**: reference the plan slug (`ws plan get <slug>`)
   - **Test evidence**: what was run and results
   - **Risk / rollback**: how to revert
9. **Log.** ONE call to the central log (never a file edit): `node workspace/cli/ws.js log -r <repo> -a implementer <branch> <PR-open|blocked|done> "<one-line summary>"`. This is what the orchestrator reads to report status; the repo's `ops/log.md` is a gitignored, local-only offline fallback (never committed) — audit history lives in the central DB.

## Hard rules

- Human review is the merge gate. Claude opens PRs; the CEO merges.
- No secrets in code or logs, ever. Use env vars and note required vars in `.env.example`.
- If blocked (missing credentials, ambiguous requirement, failing environment), log the blocker with status `blocked` (same one-call form as step 9) and stop rather than guessing.
- Migrations: forward-only scripts, with a written rollback note in the plan doc.

## Definition of done checklist

- [ ] Plan and test plan exist in the central DB (`ws plan`, `--repo <repo>`)
- [ ] Tests pass locally / in CI
- [ ] CHANGELOG updated
- [ ] PR open with template filled
- [ ] central log entry written (step 9)
