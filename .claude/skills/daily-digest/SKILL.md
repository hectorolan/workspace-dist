---
name: daily-digest
description: "Compose and deliver the CEO's daily digest ('personal newspaper') — portfolio status, world news quick read, tech news, a daily tech-learning section, and a couple of unvetted idea sparks. Use whenever asked to produce the daily digest, briefing, or any of its sections, or when a scheduled digest run fires."
---

# Daily Digest

One markdown file per day, ~5 minutes total read time. The composer saves the archive; the runner delivers — a delivery failure must never lose content.

**Read budget (token rule):** before composing, read exactly two things — the rolling summary (`node workspace/cli/ws.js plan get digest-rolling-summary`, below) and at most the **last 3** digests if extra context is needed (`ws query --messages --kind daily-digest --limit 3`, then `ws query --message-id <id>` for a body). Never scan history; the rolling summary carries the memory.

## Output locations

- Digest file: write it to the path the runner names in the prompt (`{output}`, an absolute path in the per-machine data dir `WS_DATA_DIR`, e.g. `<data>/job-out/<yyyy-mm-dd>.md`). In an interactive session with no prompt-given path, the data dir defaults to `~/sources/data` (one definition: `dataDir()` in `cli/util/clock.js`). The runner stores it as a DB `message` (kind `daily-digest`) — that message is the durable source of truth, not the file.
- Rolling summary: update the `digest-rolling-summary` plan in the DB in the same run — read it with `ws plan get digest-rolling-summary`, edit a scratch copy, write it back with `ws plan set digest-rolling-summary --file <scratch> --kind doc -a newsroom` (see below).
- Email: **the composer never sends the digest — in any run mode.** Delivery belongs to the runner (`ws run-job daily-digest`): it picks up the digest file and owns email + run-logging; when the file already exists it skips compose and only delivers. Composing is delivery-agnostic — never invoke the `email-delivery` skill or any send script for a digest, and never work around that with an alternative mechanism (2026-07-19: a subagent emailed on its own inside a scheduled run and Hector got the digest twice). In an interactive session, write the file, update the rolling-summary plan, and tell the CEO it's ready; delivery still goes through the runner. The DB message is the source of truth.
- Log: **scheduled runs (`SCHEDULED_RUN=1` in the environment), don't log — the runner records the run.** Interactive runs end with one call: `node workspace/cli/ws.js log -a newsroom digest done "<path>"`. When unsure which mode you're in (`printenv SCHEDULED_RUN`), don't log.
- Scheduled compose sessions are tool-restricted **and** audited. Bash allows exactly `node workspace/cli/ws.js query …`, `node workspace/cli/ws.js plan …` and `printenv` — run them in that form from the session's working directory and don't pipe them into anything; everything else (email, log, git, curl, `node -e`) answers "This command requires approval" and fails, since a headless run has no approver. Any email/log/git step that does slip through becomes a loud `failed` compliance line in the central log (Hector 2026-07-19: misbehavior is surfaced, never hidden). The allowlist itself is built by `composeTools()` in `cli/util/runjob.js` — that function is the one place it is defined.

## Title (first line of the digest file)

The digest file OPENS with a one-line marker: `Title: <headline>` — a front-page-style headline (≤ 80 chars) capturing the day, e.g. `Title: Quiet markets, loud agents`. Then a blank line, then the sections. The runner lifts it into the email and index subject as `Daily Digest — <date>: <headline>` and strips the marker line from the delivered body — so never put the date or "Daily Digest" in the headline, and don't repeat the headline as a body heading. If the marker is missing the subject falls back to the date-only form; nothing breaks, the report just loses its name.

## Rolling summary (the `digest-rolling-summary` plan, kind `doc`)

The digest's compressed memory — read it instead of history, update it every run:

- **Last digest**: date of the newest archived digest (drives the catch-up note).
- **Topics covered**: dated one-liners for tech-learn topics and major stories from the last 14 days — this is the no-repeat check. Prune entries older than 14 days.
- **Ongoing threads**: important topics worth dragging forward (unresolved stories, things the CEO is tracking). Carry a thread only while it stays relevant; drop stale ones instead of letting the file grow.
- Hard cap ~60 lines. If it's bigger, compress before saving.

## Sections (in this order)

1. **Portfolio status** — from ONE call: `node workspace/cli/ws.js query --summary --days 7` (open PRs, blockers, last activity per repo). Do not read `ops/log.md` files. If there are no entries yet, one line saying so. This replaces a separate orchestrator report on digest days.
   **Wednesdays: this section expands into the full weekly portfolio report** (the separate weekly job was merged here 2026-07-17). Use `--days 14`, and structure it: Completed / In review (PRs awaiting the CEO) / Blocked / Regressions / Suggested next actions. Report only — never dispatch work from a digest run. The rest of the digest follows as normal.
2. **World brief** — 3–5 bullets of significant/"shocking" news. One sentence each + link. Prefer ground.news links (the CEO subscribes; fetch public pages via WebFetch, search via WebSearch). Neutral tone, no editorializing.
3. **Tech news** — 3–5 bullets: releases, acquisitions, security incidents, notable OSS. One sentence + link each.
4. **Tech learn** — the daily learning section, 150–300 words. Rotate between: intro to a popular/emerging framework or tool, an explainer of how some technology works, or a deep-ish dive into one current tech story. End with 1–2 links to go deeper. Avoid repeating a topic in the rolling summary's "Topics covered" list (do not scan the archive for this).
5. **Idea sparks (unvetted)** — 1–2 raw passive-income ideas, one sentence each, under an `**Idea sparks (unvetted)**` heading. These are deliberately un-researched pokes at creativity for the CEO to read for inspiration — no scoring, no market claims, no advice; novelty over polish is fine. **Never evaluate, score, or research income opportunities in a digest run.** Don't repeat ideas in the rolling summary's sparks list; record today's sparks there (14-day no-repeat window).

## Catch-up policy (missed runs)

News goes stale; do not backfill full retroactive digests. On each run, read the last digest date from the rolling summary. If days were missed, add a one-line note at the top ("Last digest: <date>; <n> day(s) missed") and fold anything important from the gap into today's sections.

## Style — the email is read as plain text

The digest is delivered as raw markdown in a plain-text email, so whitespace IS the formatting. Hector's feedback (2026-07-17): no big blocks of text — break everything up.

Layout follows the **internal-comms skill** (`.claude/skills/internal-comms`) — apply its closest guideline (e.g. company-newsletter/general-comms) to the digest's structure, the format Hector selected 2026-07-26. Every content section this skill requires stays; internal-comms shapes how they read, never what they contain.

- **Blank line between every bullet/item.** Never stack bullets into a dense block.
- **One item = one idea, max 2 sentences.** Start each bullet with a short bold lead-in, then a dash: `**Fed holds rates** — one-sentence summary. [link]`
- Tech-learn: paragraphs of max 3 sentences, blank line between them.
- Separate sections with a blank line, `---`, and another blank line (reads as a divider in plain text, renders as a rule in the hub viewer).
- Plain language, short sentences, links inline. No filler, no hype. If a section has nothing worth reading today, write one honest line instead of padding.
