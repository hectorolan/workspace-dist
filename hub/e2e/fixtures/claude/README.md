# E2E fixture .claude index

Curated-summary source for the browser suite (TP-readme-summ-008/009 and the
TP-readme-summ-011 conversion, TP-nexus-e2e-036): the index pages must show
every summary cell below, while the detail pages keep each file's frontmatter
description. This document deliberately mirrors the REAL workspace
`.claude/README.md` shape — intro prose, a paragraph between each heading and
its table, code-span names, markdown and escaped `\|` pipes inside summary
cells, `external — repo` origin cells, and a trailing non-table section — so
the suite proves that shape parses end to end. Extend cells only AFTER their
first sentence: TP-readme-summ-008/009 pin those sentences verbatim.

## Agents

One row per `agents/*.md`. Before editing any agent file, read the
[fixture conventions](CLAUDE.md) first.

| Agent | Model | Role |
|---|---|---|
| `e2e-devops` | sonnet | Curated devops role from the fixture README table. Runs **tests** and CI. |
| `e2e-orchestrator` | opus | Curated orchestrator role from the fixture README table. |

## Skills

One row per `skills/<dir>/`. Origin comes from `skills/sources.json` — skills
listed there are external (pinned to an upstream commit), everything else is
workspace-authored.

| Skill | Origin | What it does |
|---|---|---|
| `e2e-external-skill` | external — example-org/example-skills | Curated external-skill summary from the fixture README table. |
| `e2e-internal-skill` | workspace | Curated internal-skill summary from the fixture README table. Strips a [link](CLAUDE.md) and an escaped `a \| b` pipe. |

## Metadata contract

Agent and skill descriptions live in each file's YAML frontmatter — that is the
single source; this README only summarizes them for the index pages. Table
hygiene: escape any pipe inside a cell as `\|`.
