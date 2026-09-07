---
name: hub-page-authoring
description: "Agent-authored hub pages (custom-pages design, agent path): take a 'build me a page' request and deliver it as a folder in the hub's pages root — no branch, no PR, no test plan; the CEO reviews the rendered tab. Covers reaching the pages root (live host over ssh, local dev), the folder contract, per-operation ws log lines, the conversational iteration loop, and the blocked path when the root is not wired. Use when asked to build, change, or remove a custom hub page."
---

# Agent-authored hub pages

The CEO asks for a page ("build me a board showing X"); the deliverable is a **folder in
the hub's pages root**, not a repo PR or a package change (CEO decision 2026-08-29 —
provenance and rationale: `ws plan get hub-home-custom-pages-design`, "Agent-authored
pages"). The orchestrator routes the request here; the implementer (or the session doing
the work) follows this skill end to end. A client without the agent system keeps the
identical by-hand path — the framework does not depend on agents; this skill only
automates what a human would do in the same folder.

## The deliverable — a folder, not a PR

- **No branch → PR → merge gate.** Pages are user content, not product code. The
  review gate is the CEO looking at the rendered tab; iteration is conversational
  ("make the chart bigger"), each pass logged (below).
- **No test plan.** A complex tier-3 app MAY carry its own checks at the author's
  judgment, kept **inside its folder** (e.g. `checks/`) — never in the hub suite.
- The folder contract and the three tiers are the hub's own user manual — the Guide,
  a Home subtab (hub `src/content/guide.md`), the one doc on authoring. Operate on
  this much: one subfolder of the pages root = one page = one tab; the folder name is
  the slug; exactly one index file decides the tier (`index.html` > `index.json` >
  `index.md`); everything else in the folder is that page's private assets; optional
  `page.json` sets `title`/`order`/`icon`. The tab appears on the next page load
  after the pages scan cache expires (`pagesScanTtlMs`, ~5s) — no restart, ever.

## Where the pages root is, and how to reach it

The root is wherever the hub deployment's `HUB_PAGES_DIR` points (hub `.env.example`
documents the setting; unset = feature off).

- **Live host**: the host-side path, wiring state, and the exact wiring commands live
  in workspace `.claude/SETUP.md`, HO-Nexus table, row **"Custom pages root (live
  host)"** — read that row first; while it is ❌ the live feature is OFF and you are on
  the blocked path below. Reach the host over ssh — that same SETUP.md row carries the
  literal ssh target and host path (its one home; on a PC station the target also
  appears as `sshTarget` in the station's `logApiTunnel` block in
  `configs/environments.json`, but not every station has one): `scp -r <local>/<slug>
  <target>:<host pages dir>/` or an `ssh ... 'cat > …'` heredoc. Writing files into
  that directory is normal agent work; **changing the compose file, the hub `.env`, or
  restarting containers is not** — that is the CEO/devops production gate.
- **Local dev hub**: write straight into whatever `HUB_PAGES_DIR` in `sources/hub/.env`
  points at.

## Authoring and verifying

1. Pick the smallest tier that serves the request; compose only real hub data
   (tier-2 widget catalog and parameters: the Guide).
2. Build the folder locally first, in `<WS_DATA_DIR>/pages-build/<slug>/`.
3. Verify before delivering when the change isn't trivial: run the hub locally with
   `HUB_PAGES_DIR` pointed at the build dir (`AUTH_BYPASS=true`, this station's
   `LOG_API_URL`/`LOG_API_KEY` for real data) and check `GET /api/pages/<slug>`
   renders with no `error`/`invalid`/`unknown` card states. Broken files degrade to
   visible cards, never a crash — so also eyeball the rendered tab when you can.
4. Deliver: copy the folder into the pages root; confirm the tab (live: reload the
   hub, or `GET /api/pages` roster).

## Audit trail

One `ws log` line per operation, repo `hub`, area `pages`:

```
node workspace/cli/ws.js log -a <agent> -r hub pages done "<slug>: created|<what this pass changed>"
```

- Create = one line; every iteration pass = one line; removal = one line.
- Blocked delivery (root unreachable / not wired) = a `blocked` line naming the slug
  and pointing at where the built folder waits.

## When the root is not wired (blocked path)

Build and verify locally as above, then make the folder deliverable from **any**
station: store its exact contents as a DB doc (`ws plan set hub-page-<slug> --kind doc
--status archived --file <runbook.md>` — files verbatim + the one delivery command),
log `blocked`, and add a backlog item pointing at the doc and at the SETUP.md wiring
row. Never invent host config, never edit production compose/env yourself.

## Boundaries

- Secrets only via env — a page never embeds a key, token, or credential (tier-3
  pages cannot call external servers anyway; the sandbox is the hub's, not yours to
  loosen).
- No AI attribution inside page content (workspace standing rule).
- Never start/restart production containers; never set `HUB_PAGES_DIR` on the live
  host yourself — that is the SETUP.md row's CEO step.
