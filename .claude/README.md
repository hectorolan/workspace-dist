# .claude/ — the agent system index

This directory is the system's definition, loaded by the Claude Code harness **from
disk at startup**: `CLAUDE.md` (workspace conventions and standing rules), `SETUP.md`
(setup + configuration procedures and the access checklist — *how* you stand a box up),
`environments/` (*what* currently exists: the roster, per-box status and current config,
and the history of every environment change — `environments_setup.md` is the one doc on
that subject), `agents/` (subagent definitions), `skills/` (workflow skills), and
`settings.json` (permissions, attribution, defaults). It travels in the
workspace repo so a fresh clone is a fully-functioning agent system (repo = definition,
DB = memory). This README is the human-readable map; the drift guard in
`cli/util-tools/agent-doctor.js` fails when a table below disagrees with the files.

## Agents

One row per `agents/*.md`. Before editing any agent file, read
[`agents/README.md`](agents/README.md) — YAML frontmatter gotchas (unquoted `: `
silently drops an agent from registration) and how to verify with `agent-doctor`.

| Agent | Model | Role |
|---|---|---|
| `coo` | fable | Business operator: on-demand market snapshots and business-viability review of product definitions (market research, demand evidence, go/no-go recommendations) before anything gets built. |
| `devops` | opus | Testing, CI, builds, and deployments across repos: runs/reads test suites, diagnoses CI failures, prepares releases, checks deploy health, sets up pipelines. |
| `implementer` | fable | Implements features and bug fixes per the project-iteration skill, in two phases: requirements first, then test-plan-driven implementation ending in a PR. |
| `jr_implementer_github_dependabot` | sonnet | Fixes red Dependabot PRs on the workspace repo only: diagnoses the CI failure, adapts call sites without touching test files, merges through the guarded tool once green. Not a general implementer. |
| `newsroom` | sonnet | Produces the daily digest ("personal newspaper"): world/tech news, a learning section, and a couple of unvetted idea sparks, per the daily-digest skill. |
| `orchestrator` | opus | Coordinates the portfolio: status reports, dispatches work to the implementer/devops/newsroom/coo subagents, queries the central log API, reports statuses and regressions. |

## Skills

One row per `skills/<dir>/`. Origin comes from `skills/sources.json` — the single
source of truth for "ours vs vendored": skills listed there are external (pinned to an
upstream commit), everything else is workspace-authored.

| Skill | Origin | What it does |
|---|---|---|
| `cicd-pipeline-skill` | external — LambdaTest/agent-skills | Generates CI/CD pipeline configurations for GitHub Actions, Jenkins, GitLab CI, and Azure DevOps. |
| `cloud-solution-architect` | external — microsoft/skills | Cloud architecture design and review following Azure Architecture Center practices, patterns, and Well-Architected reviews. |
| `daily-digest` | workspace | Compose and deliver the daily digest: portfolio status, world/tech news, tech-learning section, and a couple of unvetted idea sparks. |
| `email-delivery` | workspace | Send agent email to the CEO through the one `ws email` implementation (Gmail SMTP), including the app-password setup protocol. |
| `frontend-design` | external — anthropics/skills | Guidance for distinctive, intentional visual design when building or reshaping UI. |
| `hub-page-authoring` | workspace | Agent-authored hub pages: deliver a "build me a page" request as a folder in the hub's pages root — no PR, no test plan; per-operation logging, iteration loop, and the blocked path when the root is not wired. |
| `internal-comms` | external — anthropics/skills | Formats and resources for internal communications: status reports, newsletters, FAQs, incident reports. |
| `jest-skill` | external — LambdaTest/agent-skills | Generates Jest unit and integration tests (mocking, snapshots, async, React components). |
| `project-iteration` | workspace | The standard workflow for iterating on any project repo: branching, testing, PR structure, changelog discipline. |
| `skill-creator` | external — anthropics/skills | Create new skills and improve existing ones: evals, benchmarking, description optimization. |
| `webapp-testing` | external — anthropics/skills | Playwright toolkit for exercising local web apps: frontend verification, screenshots, browser logs. |
| `windows-hosting` | workspace | The Windows PCs' hosting role (applies to every PC environment): helper Task Scheduler jobs, the S4U task recipe, the local-container rollback path, task diagnostics. |

## Metadata contract

Agent and skill descriptions live in each file's YAML frontmatter — that is the single
source; this README only summarizes them, and the hub Agents/Skills pages render
them live from the same files. External skills are pinned (repo/path/sha) in
`skills/sources.json` and updated ONLY via the upstream-sync review PR
(`cli/util/skillsync.js`) — never edited to track a moving main. Table hygiene: escape
any pipe inside a code span as `\|`, or the doctor's column-consistency check fails.
