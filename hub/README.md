# hub

The CEO's private operations hub — a small web UI over the workspace's central
SQLite log DB. It is the single pane for reading and lightly steering the
automation, in three built-in top tabs: Home (Digests — the daily read — plus
the Guide, the hub's own user manual), Documents (Plans / Tests / Records /
Conversations from the central DB), and Claude (Core — the governing docs —
plus Agents, Skills and Features), with a per-page comment box for leaving
instructions back to the agents. After the built-ins, the nav grows one tab
per user-defined custom page when `HUB_PAGES_DIR` is set (see below).

It is single-tenant by design: the only account that can sign in is the owner
(the `ALLOWED_EMAIL` env var), enforced server-side — unset means every login
is denied (the gate fails closed).

## What it shows

| Section | Path | Source |
| --- | --- | --- |
| Home | `/` | the latest digest in full; lights the Home tab (Digests subtab) |
| Home · Digests | `/digests`, `/digests/:date` | log API `daily-digest` messages |
| Home · Guide | `/guide` | packaged user manual (`src/content/guide.md`) |
| Documents · Plans | `/plans`, `/plans/:slug` | log API central DB (`/plans/:slug` is the detail URL for every kind) |
| Documents · Tests | `/tests` | central-DB test-plans (held ones flagged first) |
| Documents · Records | `/records` | central-DB design/audit/doc/baseline kinds |
| Documents · Conversations | `/conversations`, `/conversations/:id` | page-born threads + legacy log API `/conversation` store |
| Claude · Core | `/knowledge`, `/knowledge/:slug` | workspace `.claude/` governing docs |
| Claude · Agents | `/agents`, `/agents/:name` | workspace `.claude/agents/` dir |
| Claude · Skills | `/skills`, `/skills/:name` | workspace `.claude/skills/` dir |
| Claude · Features | `/features` | log API feature registry (feature-major matrix, station health in the column headers) |
| Station detail | `/stations/:env` | log API station registry (`/stations` redirects to `/features`) |
| Custom pages | `/pages/:slug` | user-authored page folders under `HUB_PAGES_DIR` (one subfolder = one tab; unset = feature off, no tabs) |
| Tier-3 page assets | `/pages-view/:token/:slug/*` | static serving of tier-3 (HTML/JS) page folders, displayed in a sandboxed iframe |
| Comment box | `POST /api/page-comments` | writes a `page-comment` message to the log API |

`/` renders the latest digest in full — the morning read — and lights the Home
tab; `/digests` is the index (two-line rows, newest first, or a quiet empty
line if there is none) and a row opens `/digests/:date`. Every
section is a React view over a matching `/api/*` JSON endpoint (same paths,
`/api` prefix). `archive`/`unarchive` on a conversation is a JSON
`POST /api/conversations/:id/status` that proxies `PATCH /conversation/:id`.

## How it works

- **Stack:** Node 22 + Express 4 as a pure backend (auth, `/api/*` JSON, static
  hosting of the built SPA) and a React 19 + Vite frontend (`client/` → `dist/`).
  Markdown is rendered with `marked` and scrubbed with `sanitize-html` ON THE
  SERVER — API responses carry sanitized HTML only; raw markdown and the
  workspace files never ship to the browser. Sessions use `express-session`.
  The Express app is built by a factory in `src/app.js` (`createApp(config)`)
  so tests can spin up isolated instances; `src/server.js` is the runtime entry
  point. The visual system is token-driven (`client/src/styles/tokens.css`).
- **Server-side API proxy:** the Digests, Documents (Plans / Tests / Records /
  Conversations), Features/station-detail and comment-box
  sections talk to the workspace log API from the Node process, sending the key
  as an `X-Api-Key` header. `LOG_API_URL` / `LOG_API_KEY` (see the workspace
  `server/README.md`) live only in the server environment — the API key never
  reaches the browser. If `LOG_API_URL` is unset, those sections render a
  friendly "not configured" page and the rest of the app keeps working.
- **The Claude tab's Core / Agents / Skills pages** read the mounted workspace
  `.claude/` directory directly (`WORKSPACE_CLAUDE_DIR`); unset means those
  pages show empty lists rather than erroring (Features, the fourth Claude
  subtab, is log-API-backed).
- **Auth:** Google OIDC, scopes `openid email` only. Access is hard-restricted
  server-side to the single address in the `ALLOWED_EMAIL` env var, failing
  CLOSED — unset/empty denies every login and logs one loud boot line naming
  the var. The allowlist is checked both at the auth callback and again on
  every protected request.
- **Route wall:** `src/app.js` mounts every section behind `requireAuth`.
  `GET /healthz`, `/public/*` (terminal-page stylesheet), `/auth/*` (OAuth
  callback + logout) and `/pages-view/*` (tier-3 custom-page serving) are the
  only paths above the cookie wall; an anonymous page request redirects into
  Google's consent flow, an anonymous `/api` fetch gets 401 JSON.
  `/pages-view` sits above the wall on purpose: the sandboxed iframe's opaque
  origin withholds session cookies, so its credential is a short-lived
  slug-scoped HMAC path token minted only inside authenticated
  `/api/pages/:slug` responses — the full analysis is
  `docs/security-review-pages-serving.md`. A strict per-response
  Content-Security-Policy (`script-src 'self'`,
  `style-src 'self'` — no inline code at all) is set as defense in depth behind
  the markdown sanitizer.

Content and behavior conventions shared across the CEO's repos (conventional
commits, branch → PR → owner-merge, test-plan-first) live in the workspace
`CLAUDE.md`; this README covers only hub.

## Running it locally

Requires Node 22+.

```sh
npm install
cp .env.example .env   # then fill in the values
npm run build          # vite build → dist/ (the SPA Express serves)
npm start              # http://localhost:8080
```

For frontend iteration, `npm run dev` starts Vite with HMR on :5173, proxying
`/api` + `/auth` to a locally running Express on :8080.

Or containerized (same port, mounts the local workspace `.claude` read-only):

```sh
docker compose up --build
```

Run the automated suites. Neither needs the network or a real Google login — the
log API is stubbed both times, and the browser suite runs with the documented
dev auth bypass:

```sh
npm test         # unit/route suite (node --test + supertest)

npx playwright install chromium   # once
npm run test:e2e # browser suite (Playwright, headless chromium)
```

### Environment variables

Copy `.env.example` to `.env` (gitignored) and fill it in. Names only below;
`.env.example` carries the full comments.

| Variable | Purpose |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth web client credentials |
| `ALLOWED_EMAIL` | **Required** — the ONE account allowed in (exact match, fails closed when unset) |
| `BASE_URL` | Public base URL; the redirect URI is `BASE_URL + /auth/callback` |
| `PORT` | Listen port (keep `8080` locally to match the registered redirect URI) |
| `SESSION_SECRET` | Signs the session cookie (use a long random string in real use) |
| `LOG_API_URL` / `LOG_API_KEY` | Workspace log API base URL + key (Digests / Documents / Features / comments). Server-side only |
| `WORKSPACE_CLAUDE_DIR` | Workspace `.claude/` directory (the Claude tab's Core / Agents / Skills pages) |
| `HUB_PAGES_DIR` | Custom-pages root — one subfolder = one user tab (unset = feature off, no tabs) |
| `AUTH_BYPASS` / `AUTH_BYPASS_EMAIL` | **Dev/test only** — see below |

Only the two Google redirect URIs registered with the Cloud project are valid:
`http://localhost:8080/auth/callback` and
`https://ho-nexus.westus2.cloudapp.azure.com/auth/callback`. The callback path
and local port `8080` are load-bearing.

### `AUTH_BYPASS` — must stay OFF in production

When `AUTH_BYPASS` is the literal string `true`, the app skips the Google
round-trip and treats every request as authenticated as `AUTH_BYPASS_EMAIL`
(default the owner). It exists only for local dev and the automated tests — the
server-side allowlist still runs, so a non-owner bypass email still gets a 403.

Anything other than the literal `true` means off, and it is off by default. It
must **never** be set in a production environment: `src/config.js` refuses to
start (throws) if `AUTH_BYPASS=true` is combined with an `https://` `BASE_URL`.

## How it deploys

- **CI:** GitHub Actions (`.github/workflows/ci.yml`) runs the unit suite and
  then the Playwright browser suite on every pull request and on push to `main`
  (the browser job uploads its report as an artifact when it fails). There is no
  auto-merge — the CEO reviews and merges.
- **Staging CD:** `.github/workflows/cd-staging.yml` runs after CI concludes
  success on `main`. It builds the production Dockerfile and health checks the
  container on a GitHub-hosted runner, then — on a self-hosted runner on the VM —
  invokes the workspace's one deploy pipeline
  (`setup-scripts/deploy/deploy.sh hub-staging`) to deploy the staging twin
  (own compose project, host-local port 8081, no TLS name, no OAuth redirect;
  `/healthz` is what it serves). The workflow never re-implements deploy steps,
  and the runner is outbound-only, so there are no repository secrets and no
  inbound network holes. The deploy job is gated on the repository variable
  `CD_STAGING_ENABLED`.
- **Production:** the same Docker image runs on the Azure VM behind a Caddy TLS
  proxy at <https://ho-nexus.westus2.cloudapp.azure.com>, deployed by the VM host
  cron running the same pipeline script every 5 minutes, via a production
  compose file kept on the VM (not committed here). Production overrides
  `BASE_URL` to the public HTTPS URL, mounts the agent container's
  `workspace_sources` volume read-only for the `.claude` data (the Claude tab's
  Core / Agents / Skills pages), and sets `LOG_API_URL` / `LOG_API_KEY` to reach the log API
  published on the VM host. Custom pages need one more override there —
  `HUB_PAGES_DIR` plus a read-only bind mount of the host pages folder (the
  live-host recipe and its wiring state live in the workspace `.claude/SETUP.md`
  HO-Nexus table, row "Custom pages root (live host)"); until that row is
  wired the feature is simply off in production. `AUTH_BYPASS` is never set
  there.
- **Health check:** the container's `HEALTHCHECK` and any external monitor hit
  `GET /healthz`, which returns `{ "ok": true }`.

## License

Apache-2.0 — see [LICENSE](LICENSE).
