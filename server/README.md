# server/ — the central logging API service

One SQLite table replaces every `ops/log.md` append. Agents make **one call** instead of
read-file + edit + git add/commit/push; the orchestrator reads **one summary** instead of
N markdown files. This folder is tracked in the workspace repo, so every environment
(VM container, PC, future hosts) gets the same scripts via git sync.

## Pieces

| File | Role |
|---|---|
| `server.js` | Express + `node:sqlite` HTTP API (the only npm dependency is express) |
| `start.sh` | starts the server with the right node:sqlite flag (manual runs and pre-2026-07-30 images; current images: the ws scheduler supervises `server.js` directly — SYSTEM.md "Log-API supervision") |
| `ws` (`node cli/ws.js`) | **THE client** — one implementation (`cli/util/apiclient.js`), one runtime on every host; every script reuses it and never reimplements the API calls. Full subcommand roster + module map: **[`cli/README.md`](../cli/README.md)** (the one authoritative list) |
| `conversations.js` | threading rules for the email ask/response history (chain → subject → create); shared by server.js |
| `dump.js` / `restore.js` | text dump / disaster-recovery restore |
| `import-log-md.js` | disaster-recovery re-import of a fallback md file (`<WS_DATA_DIR>/fallback/log.md` or a project repo's `ops/log.md`) into the DB (idempotent). The common case is drained automatically by `ws pull` (`apiclient.replayFallback`); this script is the manual/bulk path. The other one-time migration scripts (import-messages, import-seen, backfill-conversations) were removed 2026-07-19 after running — git history keeps them |

## Tables

Eight tables; definitions and row counts come from `GET /schema` (the authoritative DDL —
this list is just the map):

- **`log`** — the audit trail: one line per agent operation (`date | repo | area | status | message` + agent, source, ts).
- **`message`** — full documents: inbox requests/replies, page comments (+ lifecycle columns), digests, reports; deduped on `(kind, ref)`.
- **`conversation`** — threads grouping the inbox/page-comment message kinds (see `conversations.js`).
- **`thread_entry`** — document threads (see "Document threads" below): anchor `(doc_kind, doc_ref)` + `role` + `message_id` + `created` per entry; bodies stay `message` rows.
- **`inbox_seen`** — the dedup ledger: handled email Message-IDs, page-comment refs, and `claim:<key>` rows.
- **`plan`** — one row per plan slug (kind, status, repo, full markdown body) — the plans source of truth.
- **`plan_revision`** — the body as it was before each plan update (read via `GET /plan/:slug/revisions`).
- **`station`** — the station registry: one row per station of **observed** state (last report ts, ok verdict, public IP, full env-doctor payload), last-write-wins. The definition (identity, ports, tunnel) stays in `configs/environments.json` — repo = definition, DB = observed state.

## API — endpoints

Every endpoint below. The concept sections that follow (threading, page-comment
lifecycle, plan kinds, auth) explain the behavior these rows reference.

| Category | Endpoint | What it does | Params & notes |
|---|---|---|---|
| Audit trail | `POST /log` | Append one audit line | Required `area`, `status`, `message`; optional `repo` (default `workspace`), `agent`. Inserts, **re-reads the row from the table**, and returns it — a 201 is proof of save. |
| Audit trail | `GET /log` | Read the trail | `?repo=&area=&status=&since=&days=&limit=` → compact `date \| repo \| area \| status \| message` lines; `since` = exact lower-bound date (`YYYY-MM-DD`, inclusive); `format=json` for structured output. |
| Audit trail | `GET /summary` | Per-repo status sweep | `?days=14` → per repo: last entry, status counts, and every blocked/failed/PR-open line in the window. |
| Documents | `POST /message` | Store a full document — email requests/replies, digests, reports | Required `kind`, `body`; optional `subject`, `ref`, `meta`. Dedupes on `(kind, ref)` so runner retries and backfills are idempotent. Runners and the email senders write these automatically (`ws msg` / `ws email-out`) — zero AI tokens. |
| Documents | `GET /message` | Document index (bodies elided) | `?kind=&q=&days=&limit=&before_id=&state=`. `q` searches subject + body; `before_id` returns only rows with `id <` N (descending pagination); `state` filters page comments by lifecycle state (unknown state → 400). Any read with `kind=page-comment` or a `state` filter runs the lifecycle sweep first, so answers are always past stale-claim reverts and 24h expiry. Comment lines append `\| <state>` (and `-> reply <id>` once answered); other kinds are unchanged. |
| Documents | `GET /message/:id` | One full document body | |
| Conversations | `GET /conversation` | List threads, newest activity first | `?days=&limit=&status=` → `id \| date \| status \| n msgs \| title` lines; `format=json` → `{id, title, status, created_at, updated_at, message_count}` (what the hub Conversations page consumes). `?status=active` / `archived` filters; omitting it or `?status=all` returns ALL (backward-compatible default) — hub's default view requests `?status=active` to hide the archive. A bad value → 400. |
| Conversations | `GET /conversation/:id` | One thread + its messages in order, full bodies (JSON) | |
| Conversations | `PATCH /conversation/:id` | Rename and/or archive a thread | `title` and/or `status` (`active` / `archived` — the soft-delete toggle; conversations are never hard-deleted). Both optional but at least one required (400 if neither); an invalid `status` → 400. CLI: `ws conv-title`, `ws conv-status` — both are plain PATCH calls that spend no tokens; the haiku title *generation* happens inside `ws run-inbox`. |
| Threads | `GET /thread` | Document threads (see "Document threads" below) | With `doc_kind`+`doc_ref`: one thread — entries flat-ordered by `created`, each joined with its full message body, role carried (JSON, like `/conversation/:id`); an anchor with no entries is an EMPTY thread (`ok`, `entries: []`), never a 404. Without `doc_ref`: the anchor listing with entry counts + last activity, newest first (`doc_kind \| doc_ref \| n entries \| date \| subject` lines; `format=json` → `{ok, count, threads}`, each row also carrying the opener entry's `conversation_id` + `conversation_status` — how the hub Conversations index reads page-born archive state, see "Page-born conversations" below) — `?doc_kind=conversation` is the document-less-threads view the hub Documents page (Conversations subtab) lists. With `?role=` (`ceo\|agent\|trigger`; invalid → 400; cannot combine with `doc_ref` → 400): the flat-entries mode — every entry of that role joined with its message's `ref` + `conversation_id` (`{ok, count, entries: [{id, doc_kind, doc_ref, role, created, message_id, message_ref, conversation_id, subject}]}`, JSON always, newest first, `limit` default 500 cap 1000, composes with `doc_kind`). `role=trigger` is the ONE-call reverse lookup (conversation → generated artifacts) for the whole Conversations index: group by `conversation_id` (legacy rows) or `message_ref` (a page-born opener's ref IS its `conv-<epoch-ms>` doc_ref); each row deep-links `/plans/<doc_ref>`. CLI: `ws thread get` / `ws thread list`. |
| Threads | `POST /thread` | Append one thread entry | Required `role` (`ceo\|agent\|trigger`) + `message_id` (an EXISTING message row — the body is never duplicated here; store it first via `POST /message`); anchor is explicit `doc_kind`+`doc_ref` or `anchor_ref` = a page-comment ref whose existing entry supplies the anchor (the inbox runner's reply path — no pageType mapping client-side). Idempotent on the exact entry (runner retries never double-post); re-reads the row before returning, 201 created / 200 duplicate = proof of save. |
| Threads | `PATCH /thread/:id` | Re-anchor one entry — the ONLY mutation (no delete: an entry that can vanish is a worse primitive than one that can only be re-homed) | Required `doc_kind`+`doc_ref` (the new anchor). Idempotent: the current anchor → 200 `moved:false` no-op; an identical `(anchor, message_id, role)` row already at the target under another id → 409 (never a duplicate pair). Unknown id 404, invalid anchor 400 — nothing written. Re-reads the row before returning. What the monthly backlog prune uses to carry prior-month `plan/backlog` entries into `backlog-history-YYYY-MM` (SYSTEM.md "Monthly backlog prune"). Client: `threadMove` in `cli/util/apiclient.js`. |
| Plans | `GET /plan` | Plan index | `?status=` and `?kind=` are single-value equality filters; `?exclude=done,archived` (comma-separated) hides those statuses via `status NOT IN (...)`, so a default view is one query, not fetch-all-and-hide; omitting it returns all. All filters combine (AND). Lines: `slug \| kind \| status \| date \| title`; `format=json` elides bodies and adds `body_length` (what the hub Documents page lists). |
| Plans | `GET /plan/:slug` | Full body as text (`# <index line>` header) | `format=json` returns the full row. |
| Plans | `GET /plan/:slug/revisions` | Revision history — the read path for `plan_revision` | `id \| date \| updated_by \| n chars` lines, newest snapshot first; `format=json` returns full rows including bodies. `limit` default 50, cap 200. CLI: `ws plan history <slug>`. This is what makes plan history reachable from every environment, not just via direct SQLite access on the VM. |
| Plans | `PUT /plan/:slug` | Upsert — the ONE write call | Create requires `title` + `body` (status defaults `active`, kind `plan`); update accepts any subset and only provided fields change; an invalid `kind` → 400 with nothing written. **A body carrying the banner this API renders on read is stripped before storing** (see "Plan header" below) — read-modify-write round-trips byte-identically from any client. Re-reads the row before returning: 201 (created) / 200 (updated) + row is proof of save. **No offline fallback** — if the API is down `ws plan set` fails loudly and the agent logs `blocked`; plans are not append-only log lines. Bulk import: `node cli/util-tools/plans-import.js` (idempotent). |
| Inbox | `GET /seen` · `POST /seen` | The dedup ledger (`inbox_seen`) | Seen email Message-IDs and handled page-comment refs — one per line / record one. POST: `message_id` required (idempotent), optional `answer_id` = the stored reply's message id. Lives in the DB so it rides the daily backup — a rebuilt VM never re-processes old mail or comments. Written by the inbox runner (`ws run-inbox`, `cli/util/inbox.js` — API first, `<WS_DATA_DIR>/inbox-tmp/processed.log` as offline fallback). Mail and comments alike are marked seen only AFTER the handling attempt (WS-M1) — a crash before the attempt re-captures on the next poll. For a page-comment ref this also advances the lifecycle to `answered` (never resurrecting `never_processed`). |
| Inbox | `POST /claim` | Atomic dispatch claim (WS-M2) | The runner claims each request key (mail Message-ID or comment ref) BEFORE spawning the agent session, so a manual `ws run-inbox` racing the scheduled one cannot double-run a request. Claim rows live in `inbox_seen` as `claim:<key>` (never colliding with real refs); a stale claim (older than `ttl_minutes`, default 60 — crashed run) is taken over so crash-retry survives. Returns `{granted, takeover}`; a denied claim is skipped loudly (opslog). A granted claim on a page-comment ref advances it to `read`; a `never_processed` ref is denied outright. |
| Stations | `PUT /station/:env` | Report one station's observed state — the upsert every station's 15-min `ws pull` tick makes | Body `{report}` = the `env-doctor` `payload()` (+ `publicIp`); the server stamps `ts`/`date` and extracts the indexed columns (`ok`, `platform`, `public_ip`). **Last-write-wins, one row per station, no revision** — see "Station registry" below for why this is not a plan. 201 created / 200 updated + line = proof of save. CLI: the `ws pull` tick (automatic) or `ws station report` (on demand). |
| Stations | `GET /station` | The station roster with control-plane-side findings | Every reported row (`env \| ok/FAILING:<ids> \| last <ts> (<n>m ago[, STALE]) \| ip \| platform`) **plus every configured-but-silent station as `NEVER REPORTED`** — a station whose tunnel/API is down is exactly the one that cannot file a report, so absence and staleness are judged here at read time, never station-side. `?stale_minutes=` overrides the 45-min default (3 missed ticks); `format=json` returns structured rows (parsed report, `age_minutes`, `stale`, `configured`) + `never_reported` — what the future hub page consumes. CLI: `ws station list`. |
| Stations | `GET /station/:env` | One station's full stored report | Text = index line + pretty-printed payload; `format=json` = the full row with the report parsed. CLI: `ws station get <env>`. |
| Features | `GET /feature` | The feature-major join: declared registry (`configs/features.json`) × station reports × job-run `runner` log rows — see "Feature registry" below (the contract's one home) | Read-only aggregation, nothing written. `?stale_minutes=` as `GET /station`; text = one line per feature, `format=json` = the structured matrix (what hub's Part B proxies). An invalid registry → 500 `{ok:false, error, errors}` — loud by design, the registry is kept valid by `cli/test/features.test.js`. |
| Ops | `GET /schema` | CREATE statements + row counts for every table | Inspect/iterate on the definition. |
| Ops | `GET /health` | `{ok, db, entries}` | |
| Ops | `GET /identity` | `{ok, identity: {name, pronouns, hubTitle}}` — who this instance works for and their chosen hub-page name, resolved by `cli/util/ceo.js` from `configs/environments.json` (the ONE naming home; the CEO's naming-is-config ruling 2026-08-15). Fail-soft: an unreadable config serves the generic labels (`the CEO` / `Hub`), never an error — the hub app renders from this | Keyed like everything else. Consumer: the hub web app (server-side fetch + cache) |

### Environment

| Var | Default | Purpose |
|---|---|---|
| `LOG_DB_PATH` | `~/sources/data/logs.db` | DB file — inside the container volume, outside any git tree |
| `LOG_API_PORT` | `8790` | Server listen port |
| `LOG_API_HOST` | `127.0.0.1` | Bind host. A non-loopback value makes `LOG_API_KEY` mandatory |
| `LOG_API_URL` | `http://127.0.0.1:8790` | Client-side — where `ws` looks for the API |
| `LOG_API_KEY` | *(unset)* | Required whenever `LOG_API_HOST` is not loopback |
| `WS_JOBS_CONFIG` | `../configs/jobs/jobs.json` | Override path to the jobs config the server reads its schedule timezone from (test seam — the same knob `ws scheduler` honors) |
| `WS_FEATURES_CONFIG` | `../configs/features.json` | Override path to the feature registry `GET /feature` reads (test seam, like `WS_ENVS_CONFIG` for the station roster) |

**Dates.** Row `date` stamps and every `?days=` cutoff are calendar dates in the
**schedule timezone** (`configs/jobs/jobs.json` — the same source as `cli/util/clock.js`;
ported into server.js because the server is CommonJS). Durations — the `/claim` TTL,
page-comment expiry/stale-revert, and `GET /conversation ?days=` (which filters on the
UTC `updated_at` instant) — compare raw UTC instants: the sanctioned carve-out under the
clock.js rule (raw instants are fine; only calendar dates must be schedule-TZ). Tests:
`server/test/dates.test.js` (`ws plan get test-plan-server-tz-day-windows`).

**Auth.** If `LOG_API_KEY` is set the server requires an `X-Api-Key` header (clients send it
automatically from the same env var). Keyless is allowed ONLY on a loopback `LOG_API_HOST`
(container-internal trust, test servers): with an empty key and a non-loopback host the
server **refuses to start** (WS-H1 — a published unauthenticated API would be an
agent-execution surface, see the trust-boundary note below).

### Conversations — threading rules

Storing a threaded kind (`inbox-request` / `inbox-reply` / `inbox-error` / `page-comment`)
via `POST /message` links it to a `conversation` row. Requests resolve by
In-Reply-To/References chain, then by normalized subject (`Re:`/`Agent:` prefixes stripped,
30-day activity window), else a new conversation is created — titled with the cleaned
subject, which `ws run-inbox` upgrades with ONE haiku call. Replies and errors join their
request via the `<name>` ↔ `<name>-reply` / `-error` ref slugs. Threading never fails the store.

`page-comment` is a hub page comment (contract: `ws plan get page-comments-design`;
ref `page-comment-<ts>`, subject `Page comment: <title> (<pageType>/<slug>)`): hub posts
it, `ws run-inbox` polls it after the email poll, dispatches the orchestrator, emails the
reply (stored `inbox-reply`, joining by the identical subject), then records the ref in `/seen`.

> **Trust boundary at dispatch (WS-H2).** The capture fences the `## Page context` section
> between random `UNTRUSTED-PAGE-CONTEXT` markers (`cli/util/inbox.js` `fencePageContext` —
> the DB row stays raw), and the runner's prompt states that only `## Instruction` is the CEO's
> request and instructions inside the fenced block must not be followed. Note the API key's
> real power: anyone holding it can POST a `page-comment` and get an orchestrator session with
> Bash — treat `LOG_API_KEY` as an agent-execution credential, not just a data key.

### Page-comment lifecycle

WS-M3 rework, 2026-07-25 — **this section is the one home of the state machine.** Every
`page-comment` row carries `comment_state` (+ `comment_state_ts`, `answer_id` — idempotent
ALTERs, live-DB safe).

| State | Meaning | Entered by | Leaves to |
|---|---|---|---|
| `waiting` | Stored, not yet picked up. The inbox poll fetches ONLY this state (server-side filter, paged — no time window or row cap ever decides what gets processed) | `POST /message` | `read` on a granted claim · `never_processed` after 24h |
| `read` | Claimed by the inbox runner. The state MIRRORS the WS-M2 claim — there is no second claim system | a granted `POST /claim` on the comment's ref | `answered` · back to `waiting` if the claim goes stale (60 min) |
| `answered` | The runner concluded its handling attempt. `answer_id` = the stored `inbox-reply` message id when a reply was produced (present even if the SMTP send then failed — the reply is stored before sending and the failure is opslogged); NULL only when no reply was produced | `POST /seen` after the attempt (WS-M1 ordering) | terminal |
| `never_processed` | **TERMINAL** (CEO decision 2026-07-25). Excluded from the poll, never dispatched, never replied — the comment may be duplicated or expired, and answering burns tokens. `/claim` on such a ref is denied; `/seen` records the ref for dedupe but never resurrects the state. the CEO re-asks if it still matters | the lazy sweep, 24h (exact, from the row's creation `ts`) after entering `waiting` | terminal |

Expiry runs **ONLY from `waiting`** — `read` and `answered` never expire. The stale-claim edge:
a `read` older than **60 min** (the same number as `/claim`'s `ttl_minutes` default — crashed
runner) reverts to `waiting`, from which the normal 24h expiry then applies. Both transitions
happen in a lazy server-side sweep, triggered by any `kind=page-comment` / `state` read (i.e.
every 15-min poll tick), and each logs a loud `failed` compliance line (agent
`comment-lifecycle`, area `inbox` — never-hide). The env seams `COMMENT_WAIT_EXPIRY_HOURS`
(24) and `COMMENT_READ_STALE_MINUTES` (60) exist only for tests; production never sets them.
Rows predating the lifecycle were backfilled once at startup: ref in `inbox_seen` → `answered`
(historical, `answer_id` NULL), else `waiting`.

On top of the server-side `waiting` filter, the runner itself skips comments
whose conversation is archived — a selection-time filter that touches no
lifecycle state (see "Page-born conversations" under Document threads, the one
home of that rule).

```bash
node cli/ws.js query --messages --kind page-comment --state waiting          # queue right now
node cli/ws.js query --messages --kind page-comment --state never_processed  # what was dropped (re-ask if still relevant)
node cli/ws.js query --messages --kind page-comment --state answered         # each line ends "answered -> reply <id>"
node cli/ws.js query --message-id <id>                                       # the reply body for that comment
```

### Document threads — conversations under the documents they are about

Design: `ws plan get nexus-document-threads-design` (W1 landed 2026-08-01; N1/N2 render
these in hub). A thread is an **anchor + flat ordered entries**: anchor
`(doc_kind, doc_ref)` — a plan slug (`plan`), a digest date-ref (`digest`), an
agent/skill/knowledge name, or `conversation` + its own ref for document-less threads — and one
`thread_entry` row per entry carrying `role` (`ceo` | `agent` | `trigger`) and
`created` (the ordering key; threads are flat by design — one CEO, alternating turns,
no parent pointer).

**Why a dedicated table, not message meta** (the CEO's call, 2026-08-01): the table maps
*relationships only* — entry bodies stay `message` rows, so nothing is duplicated and
the existing message machinery (dedupe, lifecycle, backup) is untouched. The one query
that matters — "the thread for document X" — is a single indexed lookup on
`(doc_kind, doc_ref)`, and one message can legitimately appear in two threads (a
`trigger` entry attaches the comment that caused a generated doc to that doc), which
JSON riding a message row cannot express as a queryable relation.

How entries appear:

- **Intake** (`POST /message`, kind `page-comment`): the hub meta
  (`pageType`/`slug`, contract above) is mapped to an anchor (`server/threads.js`)
  and the comment is recorded as a role-`ceo` entry under that document. ADDITIONAL
  relationship only — the page-comment lifecycle above is untouched, and an
  absent/unmappable meta (or any capture failure) never fails the store: the comment
  simply has no thread, exactly like every pre-threads comment.
- **The inbox runner** (`ws run-inbox`): after storing the orchestrator's reply it
  posts a role-`agent` entry on the same anchor (`anchor_ref` resolution), THEN sends
  the email — the thread is the record, the email stays the notification channel
  (design decision 1; email behavior is byte-identical, and `answer_id` on `/seen`
  still records the same reply message).
- **`trigger`** entries are posted by sessions that generate a new document from a
  conversation, attaching the originating entry's message to the new doc's thread.

**Page-born conversations — archive state and provenance
(hub-conversation-archive-api-2026-08-17).** A page-born thread's anchor is
`(conversation, conv-<epoch-ms>)` (the ref is hub-generated — NOT a conversation
id, NOT a message id; it is also the opener page-comment's message `ref`).
Because `page-comment` is a THREADED_KIND, the opener is always assigned a
`conversation` row at intake — so page-born archive/unarchive needs **no schema
change and no new endpoint**: archive state lives ONLY in `conversation.status`,
toggled by the existing `PATCH /conversation/:id {status}` (reversible, never
deleted). One page-born thread can span more than one conversation row (the
opener's `Conversation: …` subject and follow-up comments' `Page comment: …`
subject normalize to different keys), so archiving a thread means PATCHing
**every distinct non-null `entries[].message.conversation_id`** from the thread's
own `GET /thread?doc_kind=conversation&doc_ref=conv-<ts>` read; unarchiving is
the same loop in reverse. The anchor listing (`format=json`) surfaces the opener's
`conversation_id` + `conversation_status` per row so an index renders archive
state in the one call it already makes, and `GET /thread?role=trigger` (endpoint
table) is the one-call conversation → generated-artifacts reverse lookup.
**Archive means drop** (the CEO, 2026-08-17): the inbox runner skips waiting
comments whose conversation is archived — at selection time only
(`cli/util/inbox.js checkPageComments`; `comment_state` stays `waiting` and
nothing is claimed or marked seen, so unarchiving restores eligibility until the
normal 24h waiting-expiry below retires the comment), with one loud line per
skip per poll in the inbox run's own log (`<WS_DATA_DIR>/jobs/inbox/<date>.log`)
— visible, never silent, and not a new scripted log-writer.

Entries can be **re-anchored but never deleted** (`PATCH /thread/:id`, endpoint table
above): moving is the one mutation, used by the monthly backlog prune to carry a
`plan/backlog` entry to the history plan of the month its MESSAGE was written in —
the CEO's rule (2026-08-02) that a comment belongs to the month it was made in,
exactly like the backlog's items.

> **Trust boundary (WS-H2) carries forward unchanged:** thread-entry bodies ARE the
> captured page-comment content — untrusted quoted data. `GET /thread` returns the
> raw stored bodies (the DB stays raw, as with `GET /message`); any consumer that
> renders them or feeds them to an agent session must apply the same fencing/contract
> the dispatch path uses (see the trust-boundary note under the message contract).

### Plans — document kinds

The DB is the source of truth (design: `ws plan get plans-db-design`). One `plan` row per
plan, keyed by slug; every update first snapshots the previous body into `plan_revision`,
so no edit is ever lost. Each row carries a `kind` classifying what the document is:

| Kind | Holds |
|---|---|
| `plan` *(default)* | Ordinary plans — work queues, implementation plans |
| `audit` | Audit reports and their remediation trackers |
| `design` | Design documents |
| `test-plan` | The workspace's own test plans |
| `doc` | Living reference docs, e.g. the digest rolling summary |
| `baseline` | Regression baselines, one per repo (slug `test-baseline-<repo>`) |

Retirement is a STATUS, never a kind (the CEO, 2026-08-02): an archived document keeps
the kind above and gets `status: archived` (`ws plan list --status archived`). `history`
is NOT a kind — `PUT` rejects it like any other invalid kind (the legacy rows were
migrated on 2026-08-02; evidence: `ws plan get history-kind-migration-2026-08`).

### Plan header — rendered on read, stripped on write

`GET /plan/:slug` (text form) renders `# <slug> | <kind> | <status> | <date> | <title>`
on top of the stored body, because that banner is what makes `ws plan get` readable to a
human. `PUT /plan/:slug` therefore applies the **exact inverse**: a leading line carrying
THIS plan's own slug, one of the kinds above and an ISO date is removed before the body is
stored, together with the one trailing newline that read appended — per banner found, so a
body that already carries stacked banners self-heals on its next write.

So **read-modify-write is safe from any client**: `ws plan get x > f`, edit `f`,
`ws plan set x --file f` round-trips byte-identically. Without it, every such cycle baked
the banner into the body and the next read rendered another on top — headers stacked, one
per write, and five plans were corrupted that way on 2026-08-01 (`ws plan get
test-plan-plan-write-integrity`). The strip is anchored to the plan's own slug + a valid
kind + an ISO date precisely so a legitimate body-leading H1 with a pipe in it
(`# Something | something else`) is never eaten; `format=json` is unaffected (it never
renders a banner). Reading code that then *compares* a body still normalizes what it read
(`stripPlanHeader` in `cli/util/planclose.js`) — the read is still rendered by design.

### Regression baseline — why a plan IS the right carrier here

The opposite call to the station registry below, from the same weighing (backlog 59,
2026-07-28). A baseline is written only on a **green suite run** — a few times a day at
most, not ~288 — so revision bloat never arises, and its revision history is the
feature: `ws plan history test-baseline-<repo>` answers "when did this baseline last
move, and to what", the first question asked while diagnosing a regression. So it stays
on `ws plan` with no parallel storage path. `baseline` is a kind of its own rather than
a `test-plan`: pr-watch closes active `test-plan`-kind plans on PR merge and would
otherwise close a repo's baseline the first time any PR landed. Shape, states and the
read/update flow: SYSTEM.md "Regression baseline".

### Station registry — why a dedicated table, not a plan

Decided 2026-07-28 (plan `environment-setup-streamlining`, W3/D1b). Plans are the default
DB carrier, but `PUT /plan/:slug` snapshots a `plan_revision` on **every** write by design,
and the registry is written by 3 stations × ~96 ticks/day — a plan carrier would
manufacture ~288 meaningless revisions daily (revision bloat by construction). A
message-kind carrier fails the other way: `(kind, ref)` dedupe makes a re-post a no-op
(never an update), and a fresh ref per tick accretes ~100k rows/year with no read value.
The registry is **observed state with no history worth keeping** — the current row is the
only truth, and absence/staleness is the finding — so it gets its own one-row-per-station
upsert. This is not a parallel storage path: the endpoints live in this same server and are
reached only through `cli/util/apiclient.js` / `ws station` — one client, one HTTP path.
The hard boundary stands: `configs/environments.json` remains the definition a station
needs *before* it can reach the DB at all (fresh-clone/empty-DB invariant); the table holds
only what stations regenerate and re-report every tick, so a dead station loses nothing.

### Feature registry — `GET /feature` (the contract's one home)

Design: `ws plan get features-ui-restructure-design` (the CEO, 2026-08-27); test plan
`ws plan get features-registry-2026-08-27`. The **declared** catalog of what the system can
do lives in `configs/features.json` (hand-authored — repo = definition; shape + evidence/scope
grammar documented in that file's `_note` and enforced by `cli/util/features.js`, the
loader/validator this server lazily imports). Liveness is **derived, never declared**: this
endpoint joins the registry against the `station` table's observed reports and the newest
job-run `runner` log rows, and evidence that cannot be found reads `unmeasured` — never
`ready` (never fake liveness). The registry is read fresh on every request (tiny file, no
cache to go stale; `WS_FEATURES_CONFIG` overrides the path — test seam, like `WS_ENVS_CONFIG`).

`format=json` returns `{ok, count, stale_minutes, schedule_owner, stations, features}`.
Per feature: `id`, `title`, `description` (REQUIRED in the registry — C-2: 1–2 colloquial
sentences for an operator unfamiliar with the system, passed through verbatim; the UI
renders it as the row's second line and never hardcodes prose per feature; the validator
refuses an absent/empty one), `kind` (`job|service|page|tool|check`), `scope`
(`all` | `schedule-owner` | `env:<name>` | `kind:<station-kind>`), optional `note`,
`measured` (false ⇒ `evidence: []` — declared, unmeasured), for job features a `job` block
(`{name, cron, disabled, last_run}` — `last_run` = the newest log row with agent `runner` in
the job's own area or a declared `runner-log:<area>` alias; null when the job writes no
per-run rows), and `cells` — one per **configured** station:

- `state`: `n/a` (station outside the feature's scope) · `never-reported` / `stale`
  (station-level, judged here at read time exactly like `GET /station`; same 45-min default,
  same `?stale_minutes=` override) · else the worst-wins fold of the evidence states —
  `missing` > `warn` > `stale` > `off` > `unmeasured` > `ready`. Check evidence maps a
  cp-env row's own `data.state` (ready/off/missing) directly, otherwise env-doctor level
  (OK→ready, WARN→warn, FAIL→missing, INFO→off); job evidence maps disabled→off,
  last run done/sent→ready, failed→missing, other→warn, none→unmeasured.
- `checks`: the per-evidence rows (`id`, `state`, `level`, `detail`, and `via: <env>` when
  the check id was found in another station's report — how control-plane facts probed from a
  tunneled PC render on the `env:azure-vm` cell they are *about*).

Text form: `id | kind | scope | <env>=<state> ... [| declared, unmeasured] [| job <name>: disabled|last <status> <date>|no runs recorded]`
(no description — the text lines stay terminal-scannable; JSON carries the prose).
Tests: `server/test/features.test.js` + `cli/test/features.test.js`.

## The client (`ws`)

Everything on this page is reached through **`ws` (`node cli/ws.js`)** — one client, one
runtime, on every host. The authoritative subcommand roster, the shared `cli/util/`
modules, and the forged-tool inventory all live in **[`cli/README.md`](../cli/README.md)**
(one doc, never restated here).

## Agent usage

```bash
node cli/ws.js log -a newsroom digest done "archived daily-digest 2026-07-17 (DB message)"
node cli/ws.js log -r hub -a implementer feat/viewer PR-open "digest viewer, PR #1"
node cli/ws.js query --summary --days 14        # status sweep
node cli/ws.js query --repo hub --days 7   # one repo's recent lines
node cli/ws.js email-out "Subject" body.md      # capture a sent email (senders do this automatically)
node cli/ws.js sync "chore: update SYSTEM.md"          # workspace push, one call
```

## Deploy runbook (VM `agent-worker`) — requires the CEO's go-ahead

1. On the VM: `git -C ~/agent/workspace pull && cd ~/agent/workspace && docker compose up -d --build --force-recreate`
   — `--build` whenever entrypoint.sh changed (it's baked into the image).
2. Verify: `docker exec workspace-agent-1 node /home/node/sources/workspace/cli/ws.js health`
   (the API key guards every route including `/health`, so a bare curl returns 401 here;
   `ws health` reads the key from the container's own env and prints no secret), container
   `(healthy)` in `docker ps`, and the entrypoint log showing `starting ws scheduler` with
   one `[scheduler] armed <job>` line per jobs.json entry. (The 2026-07-17 one-time
   migrations — import-seen, backfill-conversations — already ran; scripts removed.)
3. Manual backup run: `node cli/ws.js backup` — confirm the `logs.sql` commit lands in workspace-backups.

## PC (off-host) access

The API speaks plain HTTP, so **off-host clients reach it through an SSH tunnel** — never
across the internet in cleartext (that would put `X-Api-Key`, plan bodies and comment
instructions on the wire). On a PC `LOG_API_URL=http://127.0.0.1:8790` and ssh forwards
that port to the VM's own loopback; `LOG_API_KEY` is a PC user env var (the key value lives
only in env / the VM `.env`). The tunnel is config, not procedure:
`configs/environments.json` → `environments.<WS_ENV>.logApiTunnel` (each PC has its own
block, its own SSH key, and its own NSG source entry), kept alive by
`cli/util/tunnel.js` — `ws pull` ensures it every tick (so it heals itself after a reboot,
a dropped link, or an ssh kill), and `node cli/util-tools/log-api-tunnel.js [--status]`
heals/inspects it immediately. Supervisor log: `<WS_DATA_DIR>/tunnel/log-api-tunnel.log`.
Compose still publishes 8790 on the VM (the hub app container reaches it via
`host.docker.internal`), but **no NSG rule admits 8790 from the internet** — the tunnel is the
only off-host path, so a PC IP change needs nothing but the SSH rule. If the API is unreachable,
`ws log` falls back to the classic md line in `<WS_DATA_DIR>/fallback/log.md` and `ws pull`
replays it once the API is reachable again — nothing is lost or stranded.

## Disaster recovery

**Automatic:** a fresh container (destroyed VM, wiped volume) restores the DB by itself —
`entrypoint.sh` sees an empty/missing `logs.db`, clones the `workspace-backups` repo, and
runs `restore.js`. `restore.js` refuses to overwrite a non-empty DB, so restarts are always safe.
It is non-fatal by design, so an unreachable backup repo produces a healthy container with an
EMPTY DB — always verify the entry count after a rebuild. Rebuilding the whole live host (this
step in context, plus the deadline it has): `docs/live-host-rebuild.md`.

**Manual:**

```bash
git clone https://github.com/hectorolan/workspace-backups.git
node server/restore.js workspace-backups/logs.sql   # writes ~/sources/data/logs.db
```
