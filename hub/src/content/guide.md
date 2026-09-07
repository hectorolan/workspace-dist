# Hub guide

## What the hub is

The hub is your operations home: one gated web app where everything the agent
system produces — daily digests, plans, test plans, conversations, audit
records, agent and skill definitions, station health — is read in one place.

It is a viewer with an inbox, not an editor: documents are produced by the
agents and the scheduled jobs, and the hub renders them; your side of the
conversation happens through the comment boxes, which land in the same audit
trail everything else uses.

Access is restricted to one signed-in owner. Every page except the health
probe and the login flow sits behind that wall.

## Home: digests and this guide

Home is the landing surface — the title click and the Home tab both bring you
here.

- **Digests** opens the latest daily digest in full, with its comment thread
  below. *All digests* leads to the full history, one row per day, newest
  first; any row opens that day's digest. Old digest links from email keep
  working unchanged.
- **Guide** is this manual. The column on the right lists every section; a
  click jumps straight there.

## Documents: plans, tests, records, conversations

The Documents tab is the paper trail, grouped into four subtabs:

- **Plans** — active plans and designs from the central database.
- **Tests** — test plans; a held plan shows what it is waiting on at the top.
- **Records** — archived material: closed plans, audits, retired designs.
- **Conversations** — threads started from any page's comment box, plus the
  legacy email conversations, newest activity first. Archiving a conversation
  drops it from the inbox run; unarchiving restores it.

Every document page renders its own thread underneath: comments you leave
there are answered in the thread and by email.

## Claude: the agent system

The Claude tab shows the system itself, in four subtabs:

- **Core** — the governing documents (workspace conventions, setup state).
- **Agents** — every agent definition, rendered from its source file.
- **Skills** — the skill library, with upstream provenance where known.
- **Features** — the health matrix: every declared feature against every
  reporting station, with per-station drill-downs. Cell verdicts come from
  the control plane; the hub only renders them.

## Comments and threads

Every document page and conversation carries a comment box. A comment is
confirmed before it sends, lands in the central audit trail, and is picked up
by the inbox run (about every 15 minutes); replies arrive in the thread and
by email. Comments are how you steer: corrections, follow-ups, and new
conversation openers all ride the same machinery.

## Custom pages: build your own tabs

The hub can grow tabs you define yourself: point it at a folder of pages, and
every subfolder becomes one new tab, from a single markdown note to a complete
web app. There are three authoring tiers — climb as far as you want — plus a
zero-effort path where the agents build the page for you. The sections below
describe each path.

Setup happens once: set `HUB_PAGES_DIR` in the hub's environment to the folder
that holds your pages, and restart the hub. Locally that is one line in the
hub's `.env`; a hosted hub sets it in its deployment configuration instead — a
one-time step for whoever operates the deployment, along with making the
folder visible to the hub. That is the only restart there will ever be — from
then on, every direct
subfolder of that root is one page and one tab, discovered live: drop a folder
in and its tab appears on the next page load. Leave `HUB_PAGES_DIR` unset and
the feature is simply off — no tabs, no change.

Inside a page folder, the hub looks for one **index file** — `index.html`
(tier 3), `index.json` (tier 2), or `index.md` (tier 1), in that order of
precedence — and an optional `page.json` manifest that can set the tab's
`title`, `order` (tabs sort by order, then alphabetically), and `icon` (a
short glyph shown before the title). Without a manifest, the tab is named
after the folder: `my-notes` becomes "My Notes". A folder with no index file
is quietly skipped — it never breaks the hub.

## Tier 1 — markdown pages

Write one markdown file, get one tab: the fastest way to a page of your own,
rendered exactly like the hub's other documents. Your first page in five
minutes:

1. In your pages folder, create a subfolder — say `my-notes`.
2. Inside it, create `index.md` and write plain markdown: start with a
   `# Title` line, then anything — paragraphs, lists, tables, links.
3. Reload the hub. A **My Notes** tab is there, rendered in the hub's own
   style.
4. Use `## ` headings for your sections: a page with two or more of them gets
   the same sticky right-hand section list this guide has, with working jump
   links.
5. Want a different tab name, position, or icon? Add a `page.json` next to
   the file, e.g. `{ "title": "Notes", "order": 1, "icon": "N" }`.

Tier-1 pages are text-first and run zero JavaScript: the markdown is rendered
and sanitized server-side like every other hub document. Images should use
full `https://` URLs; when a page outgrows text — scripts, styling, local
assets — move up to tier 3.

## Tier 2 — widget layouts

Compose the hub's built-in widgets — digest lists, document lists and views,
feature health cells, stat tiles — into your own dashboard with one JSON
file, no code. Your first board in five minutes:

1. In your pages folder, create a subfolder — say `ops-board`.
2. Inside it, create `index.json`:

   ```json
   {
     "widgets": [
       { "widget": "digest-list", "params": { "limit": 5 } },
       { "widget": "stat-tiles", "params": { "tiles": [
         { "source": "open-plans" },
         { "source": "stations-ok" }
       ] } }
     ]
   }
   ```

3. Reload the hub. The **Ops Board** tab renders each widget as a card, in
   the order you listed them.
4. Optional extras: a top-level `"title"` sets the board's heading (the tab
   name still comes from the folder or `page.json`, like every tier); each
   widget entry takes its own `"title"` to rename its card.

The widget catalog — every widget shows live hub data, refreshed on each
page load:

| Widget | Shows | Parameters |
|---|---|---|
| `digest-list` | The most recent daily digests, linked | `limit` (1–20, default 5) |
| `plan-list` | Document rows from the central database, linked | `kind`, `status`, `repo`, `limit` (1–50, default 10) |
| `plan-view` | One document's full rendered body | `slug` (required) |
| `feature-cells` | Health cells for chosen features, straight from the Features matrix | `features` (required list of feature ids), `stations` (optional list) |
| `stat-tiles` | Headline numbers | `tiles` (required list of `{ "source", "label" }`); sources: `open-plans` (takes `repo`/`kind`), `latest-digest`, `stations-ok` |

Boards have generous but real caps: a board renders up to 24 widgets (a
longer list shows the first 24 plus a card saying so), a `stat-tiles` widget
shows up to 8 tiles, and `feature-cells` reads up to 12 feature ids — extras
beyond those two limits are quietly dropped.

Mistakes are safe: a widget name the hub does not know, a bad parameter, or
a data source that is down each render a card saying exactly that, and a
layout file that is not valid JSON shows one clear message — the page and
the rest of the hub carry on. When a board outgrows the catalog, move up to
tier 3.

## Tier 3 — full HTML/JS sites

Drop a complete static site or app into a folder and it runs under its own
tab, sandboxed from the rest of the hub. Your first site in five minutes:

1. Create a subfolder — say `fleet-app` — with an `index.html` in it. A
   single self-contained file with inline `<script>` and `<style>` is a
   perfectly good start.
2. Grow it like any static site: sibling files and subfolders (`app.js`,
   `style.css`, `img/…`) are served alongside, so plain relative paths just
   work.
3. Reload the hub — the tab is there, and your site runs inside it.
4. `page.json` works the same as every tier for title, order, and icon.

The sandbox rules, so nothing surprises you: the site runs in a sandboxed
frame under the hub's roof but outside its walls — scripts and forms run
freely, but the page cannot see the hub's session, call the hub's API, reach
the surrounding hub shell, or make network calls to other servers (external
images and fonts are fine). Keep tier-3 apps self-contained; a documented
opt-in bridge to the hub's API is planned for a later phase.

## Ask the orchestrator: agent-built pages

The zero-effort tier: describe the page you want and the agent system builds
it into your pages folder — then iterates with you conversationally, with
every pass logged in the audit trail.

- **How to ask.** Say what you want in plain language — "build me a board
  showing open plans and the latest digest" — in an agent session, or as a
  comment on any hub page (comments reach the agents on the next inbox run,
  about every 15 minutes). The request is routed like any other work.
- **What happens.** An agent writes the page folder — index file, assets,
  optional `page.json` — straight into your pages folder; once the folder
  lands there, the tab is on your next page load. No pull request, no merge,
  no deploy: pages are your content, not the hub's product code, so the
  folder itself is the delivery.
- **You are the review gate.** Open the tab and say what to change — "make
  the chart bigger", "add the digests list" — and the agents revise the page
  in place, pass by pass, until it looks right to you. Every operation lands
  as one line in the audit trail, so a page's history is as traceable as
  everything else here.
- **Boundaries.** Agents follow the same rules as the rest of the system: no
  secrets inside page content, and they never touch the hub itself. If your
  pages folder is not configured yet (`HUB_PAGES_DIR` above), the page is
  still built and verified, then parked ready to deliver, and you get the one
  setup step that turns it on — the agents never guess at your hub's
  configuration, so the tab appears once that step is done.

The by-hand tiers above and this path write into the same folder, under the
same contract — a hub without the agent system loses nothing but the typing.
