'use strict';

const fs = require('node:fs');
const path = require('node:path');
const digests = require('./digests');
const plans = require('./plans');
const features = require('./features');
const stations = require('./stations');

/**
 * Tier-2 widget layer (design `hub-home-custom-pages-design` "Tier semantics",
 * phase 3; central-DB test plan hub-pages-tier2-widgets-2026-08-29). A page
 * folder's `index.json` describes a layout composing built-in hub widgets,
 * each parameterized; this lib parses the layout and composes every widget's
 * data SERVER-side through the existing log-API client libs — the API key
 * never reaches the browser, and tier 2 never touches the tier-3
 * `/pages-view` sandbox/token machinery (that path stays tier-3-only).
 *
 * The one law of this file: **user content never crashes the hub.** A
 * malformed layout, an unknown widget, a bad parameter, or a data source
 * that errors each degrade to a VISIBLE card state in the response —
 * `layout-error` on the page, `unknown` / `invalid` / `error` /
 * `unconfigured` per widget — always HTTP 200, never a 5xx, never a thrown
 * path with user data in it. Messages shown to the user are authored here
 * (or are WidgetUserError text), never upstream response bodies.
 *
 * Catalog v1 (proposed in the test plan, the CEO trims): every widget maps
 * to data the hub already serves — digest-list (digests.js), plan-list and
 * plan-view (plans.js), feature-cells (features.js, the whitelist trim
 * reused verbatim — the control plane judges, this lib renders), and
 * stat-tiles (enumerated counts over those same feeds). The design's "log
 * query table" candidate is deliberately absent: the hub has no audit-log
 * read surface today, and a new data surface is a CEO call, not a widget.
 * The catalog is documented for users in the Guide (src/content/guide.md).
 */

const MAX_WIDGETS = 24;
const MAX_TILES = 8;
const MAX_FEATURE_IDS = 12;
const MAX_TITLE = 120;

/** A widget failure whose message is safe to show (authored by this lib). */
class WidgetUserError extends Error {}

/** Clamped integer param: wrong type falls to the default, range is enforced. */
function intParam(v, min, max, def) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** Trimmed string param, '' when wrong-typed, oversized, or empty. */
function strParam(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length >= 1 && t.length <= max ? t : '';
}

/** Array-of-strings param: non-arrays fold to [], entries trimmed, capped. */
function strListParam(v, max) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => strParam(x, 100))
    .filter(Boolean)
    .slice(0, max);
}

/** ---- stat-tile sources (enumerated — an unknown source is a per-tile error).
 * Counting rows / echoing the feeds' own verdicts is presentation; nothing
 * here recomputes health, staleness, or scope (the control-plane rule). */
const STAT_SOURCES = {
  'open-plans': {
    label: 'Open plans',
    async value(config, tile) {
      const kind = plans.KINDS.includes(tile.kind) ? tile.kind : undefined;
      let rows = await plans.listPlans(config, undefined, kind);
      const repo = strParam(tile.repo, 40);
      if (repo) rows = rows.filter((r) => plans.repoOf(r) === repo);
      return { value: String(rows.length), detail: repo ? `open documents · ${repo}` : 'open documents', href: '/plans' };
    },
  },
  'latest-digest': {
    label: 'Latest digest',
    async value(config) {
      const rows = await digests.listDigests(config);
      if (rows.length === 0) return { value: '—', detail: 'no digests yet', href: '/digests' };
      return { value: rows[0].date, detail: rows[0].title, href: `/digests/${rows[0].date}` };
    },
  },
  'stations-ok': {
    label: 'Stations healthy',
    async value(config) {
      // ok/stale are the API's verdicts, echoed by stations.js — counted, never derived.
      const { stations: rows, neverReported } = await stations.listStations(config);
      const configured = rows.filter((s) => s.configured);
      const ok = configured.filter((s) => s.ok && !s.stale).length;
      return { value: `${ok}/${configured.length + neverReported.length}`, detail: 'stations healthy', href: '/features' };
    },
  },
};

/**
 * The widget catalog. Each widget: a default card title, a params parser
 * (`{ok:true, params}` or `{ok:false, message}` — clamp what is safe, refuse
 * only missing/invalid REQUIRED params), and a fetch returning render-ready,
 * whitelisted data (plain strings/numbers; the only HTML is `plan-view`'s
 * body through the ONE sanitization pipeline inside plans.loadPlan).
 */
const CATALOG = {
  'digest-list': {
    defaultTitle: 'Recent digests',
    parseParams: (p) => ({ ok: true, params: { limit: intParam(p.limit, 1, 20, 5) } }),
    async fetch(config, { limit }) {
      const rows = (await digests.listDigests(config)).slice(0, limit).map((r) => ({ date: r.date, title: r.title }));
      return { rows };
    },
  },
  'plan-list': {
    defaultTitle: 'Documents',
    parseParams: (p) => ({
      ok: true,
      params: {
        kind: plans.KINDS.includes(p.kind) ? p.kind : undefined,
        status: plans.STATUSES.includes(p.status) ? p.status : undefined,
        repo: strParam(p.repo, 40),
        limit: intParam(p.limit, 1, 50, 10),
      },
    }),
    async fetch(config, { kind, status, repo, limit }) {
      let rows = await plans.listPlans(config, status, kind);
      if (repo) rows = rows.filter((r) => plans.repoOf(r) === repo);
      return {
        rows: rows.slice(0, limit).map((r) => ({
          slug: String(r.slug),
          title: String(r.title || r.slug),
          status: String(r.status || ''),
          kind: String(r.kind || ''),
          repo: plans.repoOf(r),
          updated: String(r.updated_at || '').slice(0, 10),
        })),
      };
    },
  },
  'plan-view': {
    defaultTitle: 'Document',
    parseParams: (p) => {
      const slug = strParam(p.slug, 100);
      if (!slug) return { ok: false, message: 'This widget needs a "slug" parameter naming the document to show.' };
      return { ok: true, params: { slug } };
    },
    async fetch(config, { slug }) {
      const row = await plans.loadPlan(config, slug); // slug guard + sanitized html live in plans.js
      if (!row) throw new WidgetUserError(`No document named "${slug}" was found.`);
      return { slug: row.slug, title: String(row.title || row.slug), status: String(row.status || ''), kind: String(row.kind || ''), html: row.html };
    },
  },
  'feature-cells': {
    defaultTitle: 'Feature health',
    parseParams: (p) => {
      const ids = strListParam(p.features, MAX_FEATURE_IDS);
      if (ids.length === 0) return { ok: false, message: 'This widget needs a "features" parameter listing feature ids.' };
      return { ok: true, params: { ids, stations: strListParam(p.stations, 20) } };
    },
    async fetch(config, { ids, stations: wanted }) {
      const feed = await features.listFeatures(config); // the existing whitelist trim, verbatim
      // The stations param filters to roster MEMBERS; an intersection that
      // empties (typos) falls back to the full roster — visible data beats blank.
      const filtered = feed.stations.filter((env) => wanted.includes(env));
      const stationList = wanted.length && filtered.length ? filtered : feed.stations;
      const rows = ids.map((id) => {
        const f = feed.features.find((x) => x.id === id);
        if (!f) return { id, title: id, missing: true, cells: {} };
        const cells = {};
        for (const env of stationList) {
          const c = f.cells[env];
          cells[env] = { state: c ? c.state : 'unmeasured' }; // verdicts echoed, never derived
        }
        return { id: f.id, title: f.title || f.id, missing: false, cells };
      });
      return { stations: stationList, features: rows };
    },
  },
  'stat-tiles': {
    defaultTitle: 'At a glance',
    parseParams: (p) => {
      if (!Array.isArray(p.tiles) || p.tiles.length === 0) {
        return { ok: false, message: 'This widget needs a "tiles" parameter listing the stats to show.' };
      }
      return { ok: true, params: { tiles: p.tiles.slice(0, MAX_TILES) } };
    },
    async fetch(config, { tiles }) {
      const out = await Promise.all(
        tiles.map(async (t) => {
          const tile = t && typeof t === 'object' && !Array.isArray(t) ? t : {};
          const source = strParam(tile.source, 40);
          const def = STAT_SOURCES[source];
          const label = strParam(tile.label, 60) || (def ? def.label : source || 'stat');
          if (!def) return { label, error: source ? `Unknown stat source "${source}".` : 'This tile names no stat source.' };
          try {
            return { label, ...(await def.value(config, tile)) };
          } catch {
            return { label, error: 'The stat’s data source did not answer.' };
          }
        })
      );
      return { tiles: out };
    },
  },
};

/** Card title for one layout entry: entry override, else the widget's default. */
function cardTitle(entry, def, name) {
  return strParam(entry.title, MAX_TITLE) || (def ? def.defaultTitle : name || 'Widget');
}

/** Render one layout entry into its widget card state (never throws). */
async function renderWidget(config, entry, index) {
  const key = `w${index}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { key, widget: '', title: 'Invalid entry', state: 'invalid', message: 'Each "widgets" entry must be an object with a "widget" field.' };
  }
  const name = strParam(entry.widget, 60);
  const def = CATALOG[name];
  const title = cardTitle(entry, def, name);
  if (!def) {
    return {
      key,
      widget: name,
      title,
      state: 'unknown',
      message: name ? `"${name}" is not in this hub's widget catalog.` : 'This entry names no widget.',
    };
  }
  const rawParams = entry.params && typeof entry.params === 'object' && !Array.isArray(entry.params) ? entry.params : {};
  const parsed = def.parseParams(rawParams);
  if (!parsed.ok) return { key, widget: name, title, state: 'invalid', message: parsed.message };
  if (!config.logApiUrl) {
    return { key, widget: name, title, state: 'unconfigured', message: 'The hub has no data source configured (LOG_API_URL).' };
  }
  try {
    return { key, widget: name, title, state: 'ok', data: await def.fetch(config, parsed.params) };
  } catch (err) {
    const message = err instanceof WidgetUserError ? err.message : 'The widget’s data source did not answer.';
    return { key, widget: name, title, state: 'error', message };
  }
}

/**
 * Render a tier-2 page: read + parse the folder's index.json, then compose
 * every widget in parallel. `page` is the scan roster entry (slug/title).
 * Every failure shape is an in-page card — the return value is ALWAYS a
 * well-formed `{slug, tier:'widgets', title, ...}` detail, HTTP-200 material.
 */
async function renderWidgetsPage(config, slug, page) {
  const base = { slug, tier: 'widgets', title: page.title };
  const fail = (message) => ({ ...base, layoutError: message, widgets: [] });
  let raw;
  try {
    raw = fs.readFileSync(path.join(config.pagesDir, slug, 'index.json'), 'utf8');
  } catch {
    return fail('The layout file could not be read.');
  }
  let layout;
  try {
    layout = JSON.parse(raw);
  } catch {
    return fail('index.json is not valid JSON — fix the file and reload.');
  }
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    return fail('The layout must be a JSON object, e.g. { "widgets": [...] }.');
  }
  if (!Array.isArray(layout.widgets) || layout.widgets.length === 0) {
    return fail('The layout must declare a non-empty "widgets" array.');
  }
  const title = strParam(layout.title, MAX_TITLE); // like tier 1's `# ` heading: document title only, the tab keeps the scan's
  const entries = layout.widgets.slice(0, MAX_WIDGETS);
  const widgets = await Promise.all(entries.map((e, i) => renderWidget(config, e, i)));
  if (layout.widgets.length > MAX_WIDGETS) {
    widgets.push({
      key: 'truncated',
      widget: '',
      title: 'Layout truncated',
      state: 'invalid',
      message: `Only the first ${MAX_WIDGETS} widgets are rendered.`,
    });
  }
  return { ...base, ...(title ? { title } : {}), widgets };
}

module.exports = { renderWidgetsPage, CATALOG, STAT_SOURCES };
