'use strict';

const { renderMarkdown } = require('./render-markdown');

/**
 * Log API client for the Digests section (feature #1). The digest history is the
 * `daily-digest` message kind in the central DB (contract: workspace/server/README.md,
 * churn-test in workspace CLAUDE.md — cadence-generated content lives in the DB, not
 * files). All calls run server-side with the X-Api-Key header (config.logApiKey) —
 * nothing API-related ever reaches the browser except the rendered HTML. Fetched per
 * request, never cached: a digest is visible the moment the daily job stores it.
 */

/** A digest date is strictly YYYY-MM-DD; the guard doubles as the path-traversal check. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** First YYYY-MM-DD anywhere in a string (ref/subject). */
const DATE_IN_RE = /(\d{4}-\d{2}-\d{2})/;

function isConfigured(config) {
  return Boolean(config.logApiUrl);
}

async function apiGet(config, apiPath) {
  const headers = {};
  if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
  return fetch(config.logApiUrl + apiPath, { headers });
}

/**
 * A digest's canonical date: the first YYYY-MM-DD in `ref`, falling back to `subject`.
 * The row's `date` column is deliberately NOT used — evening catch-up runs store
 * tomorrow's digest under today's date (workspace clock rule), so `ref`/`subject`
 * (which carry the digest's own date, e.g. `2026-01-03` or `2026-01-03-daily-digest`)
 * are the trustworthy source. Returns null when no date can be derived (row skipped).
 */
function digestDate(entry) {
  for (const field of [entry && entry.ref, entry && entry.subject]) {
    const m = field && DATE_IN_RE.exec(String(field));
    if (m) return m[1];
  }
  return null;
}

/**
 * Strip the `GET /message/:id` header line the server prepends to a body:
 * `# <id> | <date> | <kind> | <subject> | <ref> | <n> chars\n\n<body>\n`
 * (server.js msgLine). Only stripped when the first line matches that exact shape, so a
 * body that happens to start with an `#` heading is never truncated. The trailing
 * newline the endpoint adds is also removed.
 */
function stripDetailHeader(raw) {
  const firstNl = raw.indexOf('\n');
  const firstLine = firstNl >= 0 ? raw.slice(0, firstNl) : raw;
  if (/^# \d+ \|.*\| \d+ chars$/.test(firstLine)) {
    let rest = raw.slice(firstNl + 1);
    if (rest.startsWith('\n')) rest = rest.slice(1); // the blank separator line
    return rest.replace(/\n$/, '');
  }
  return raw.replace(/\n$/, '');
}

/**
 * The digest index as [{date, id, title}], newest date first, one row per date.
 * Fetches the newest `limit` daily-digest messages (200 = the API's hard cap,
 * ≈6 months) and maps each to its canonical date; rows with no derivable date are
 * dropped. Date collisions (a re-stored digest) keep the HIGHEST message id — the
 * latest stored version wins, title included. The title is the stored message
 * subject verbatim (trimmed) with the fallback `Daily Digest — <date>` for
 * subject-less history — so composed report titles (backlog item 72) surface the
 * moment the compose job stores them, with no UI change. Throws on an API failure
 * so the route can render a 502.
 */
async function listDigests(config) {
  const res = await apiGet(config, '/message?kind=daily-digest&format=json&limit=200');
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const data = await res.json();
  const byDate = new Map();
  for (const e of data.entries || []) {
    const date = digestDate(e);
    if (!date) continue;
    const prev = byDate.get(date);
    if (!prev || Number(e.id) > Number(prev.id)) {
      byDate.set(date, { date, id: e.id, title: String(e.subject || '').trim() || `Daily Digest — ${date}` });
    }
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Load one digest and render its markdown to HTML. Returns null when the date is
 * malformed (guard BEFORE any API call — TP-digests-db-008) or unknown (not in the
 * index). The body comes from `GET /message/:id`; the server's index-line header
 * is stripped. Date navigation lives on the index page (backlog item 70), so the
 * payload is deliberately slim: no date list, no prev/next (TP-digest-index-005).
 * Throws on an API failure so the route can render a 502.
 */
async function loadDigest(config, date) {
  if (!DATE_RE.test(String(date))) return null;
  const row = (await listDigests(config)).find((d) => d.date === date);
  if (!row) return null;
  const res = await apiGet(config, `/message/${row.id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const markdown = stripDetailHeader(await res.text());
  return {
    date,
    markdown, // raw source — page-comments context (TP-page-comments-003)
    html: renderMarkdown(markdown), // sanitized — web-derived content (TP-audit-remediation-003)
  };
}

module.exports = { isConfigured, listDigests, loadDigest };
