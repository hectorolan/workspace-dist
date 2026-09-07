# Editing agent files — read before touching *.md here

Frontmatter is YAML: **quote any `description:` that contains a colon-space** (`: `), or the
file is invalid and Claude Code silently drops the agent from registration (bit us
2026-07-16 → 17: implementer vanished; `model: fable` was innocent).

The same trap applies to **every YAML the system parses** — gh-workflow files
included: a `run:` plain scalar containing `: ` inside prose kills the whole gh-workflow
at parse time (a 0s run marked "workflow file issue", GitHub's own wording). Use `run: >-` block scalars for commands
with message text, and validate before pushing: `npx --yes js-yaml <file>`.

Verify after every edit (forged tool — static frontmatter check; `--live` adds the headless registration diff):

```
node cli/util-tools/agent-doctor.js --live
```

All six agents (orchestrator, implementer, jr_implementer_github_dependabot, devops, newsroom, coo) must appear. The doctor also validates every skill's `SKILL.md` frontmatter and the `.claude/README.md` agents/skills tables (drift guard) — not just the agent files.
