'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseGuide } = require('./guide');

/**
 * The custom pages framework core (design `hub-home-custom-pages-design`
 * Part 2, phase 2; central-DB test plan hub-pages-framework-core-2026-08-29).
 *
 * Pages are files, discovered by folder: `config.pagesDir` (HUB_PAGES_DIR;
 * unset = feature off) is a user-owned root whose direct subfolders each
 * become ONE top-level tab. The folder's index file decides the tier —
 * precedence `index.html` (tier 3, static site in a sandboxed iframe) >
 * `index.json` (tier 2, a widget layout composed server-side by
 * page-widgets.js) > `index.md` (tier 1, rendered through the one
 * sanitization pipeline via the Guide's section parser — the tier-1 renderer
 * IS the Guide's renderer, graduated). A folder with no index is skipped,
 * never a crash: user content must not be able to break the hub.
 *
 * The scan is cheap (one readdir + a few stats per folder) and short-cached
 * per app instance (config.pagesScanTtlMs, default 5 s): dropping a folder in
 * shows the tab on next load — no rebuild, no restart. That scan is the
 * distribution story: a packaged, immutable hub customized purely by config
 * plus user files.
 *
 * Tier-3 serving auth — signed path tokens (test-plan assumption, security
 * review docs/security-review-pages-serving.md): the iframe is sandboxed
 * WITHOUT allow-same-origin, so its origin is opaque and browsers withhold
 * SameSite session cookies from its subresource requests — cookie auth alone
 * would break every asset in real (non-bypass) auth. Instead, an
 * authenticated /api/pages/:slug response embeds a short-lived HMAC token
 * (signed with sessionSecret, scoped to that one slug) as a PATH segment of
 * the iframe src, so every relative asset URL inherits it. Nothing under
 * /pages-view is reachable without first holding an authenticated session.
 */

/** Page folder names are URL slugs: strict charset is the first traversal guard. */
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Index files in precedence order (design: html > json > md). */
const INDEX_TIERS = [
  ['index.html', 'html'],
  ['index.json', 'widgets'],
  ['index.md', 'md'],
];

const PAGE_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 h; the shell re-mints on reload
const TOKEN_SHAPE = /^\d{1,16}\.[0-9a-f]{64}$/;

/** Humanize a folder name into a tab title: `my-notes` → "My Notes". */
function humanizeName(name) {
  return String(name)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Read a folder's optional page.json manifest — `{title?, order?, icon?}`
 * (test-plan schema: title trimmed 1–80 chars, order a finite number, icon
 * trimmed ≤16 chars). Wrong-typed or oversized fields are ignored one by one;
 * malformed JSON ignores the whole manifest — the page still appears with
 * defaults. User content never crashes the hub.
 */
function readManifest(dir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'page.json'), 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  if (typeof raw.title === 'string') {
    const t = raw.title.trim();
    if (t.length >= 1 && t.length <= 80) out.title = t;
  }
  if (typeof raw.order === 'number' && Number.isFinite(raw.order)) out.order = raw.order;
  if (typeof raw.icon === 'string') {
    const i = raw.icon.trim();
    if (i.length >= 1 && i.length <= 16) out.icon = i;
  }
  return out;
}

/** Tier of a page folder from its index file, or null when none exists. */
function tierOf(dir) {
  for (const [file, tier] of INDEX_TIERS) {
    try {
      if (fs.statSync(path.join(dir, file)).isFile()) return tier;
    } catch {
      /* try the next index file */
    }
  }
  return null;
}

/** Uncached scan of the pages root. Unreadable root = empty result, never a throw. */
function scanUncached(pagesDir) {
  let entries;
  try {
    entries = fs.readdirSync(pagesDir, { withFileTypes: true });
  } catch {
    return { pages: [], skipped: [] };
  }
  const pages = [];
  const skipped = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue; // stray files (and symlinks) in the root are not pages
    if (!VALID_NAME.test(e.name)) {
      skipped.push({ name: e.name, reason: 'invalid-name' });
      continue;
    }
    const dir = path.join(pagesDir, e.name);
    const tier = tierOf(dir);
    if (!tier) {
      skipped.push({ name: e.name, reason: 'no-index' });
      continue;
    }
    const manifest = readManifest(dir);
    pages.push({
      slug: e.name,
      tier,
      title: manifest.title || humanizeName(e.name),
      icon: manifest.icon || '',
      order: 'order' in manifest ? manifest.order : null,
    });
  }
  // Manifest order ascending first, then unordered alphabetically by title (design).
  pages.sort((a, b) => {
    const ao = a.order === null ? Infinity : a.order;
    const bo = b.order === null ? Infinity : b.order;
    if (ao !== bo) return ao - bo;
    return a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug);
  });
  return { pages, skipped };
}

/** Per-app-instance scan cache (keyed on the config object, so tests never bleed). */
const scanCache = new WeakMap();

/** Scan the configured pages root, short-cached (config.pagesScanTtlMs, default 5 s). */
function scanPages(config) {
  if (!config.pagesDir) return { pages: [], skipped: [] };
  const ttl = config.pagesScanTtlMs === undefined ? 5000 : config.pagesScanTtlMs;
  const hit = scanCache.get(config);
  if (hit && Date.now() - hit.at < ttl) return hit.result;
  const result = scanUncached(config.pagesDir);
  scanCache.set(config, { at: Date.now(), result });
  return result;
}

/** Mint a tier-3 serving token: `<expiryMs>.<hmac>`, scoped to ONE slug. */
function mintPageToken(config, slug) {
  const exp = Date.now() + PAGE_TOKEN_TTL_MS;
  return `${exp}.${tokenHmac(config, slug, exp)}`;
}

function tokenHmac(config, slug, exp) {
  return crypto.createHmac('sha256', String(config.sessionSecret)).update(`pages:${slug}:${exp}`).digest('hex');
}

/** Verify a serving token for a slug: shape, expiry, constant-time HMAC match. */
function verifyPageToken(config, slug, token) {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return false;
  const [expStr, mac] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = tokenHmac(config, slug, exp);
  return crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Load one page's detail for /api/pages/:slug. Unknown/skipped slug => null
 * (the scan roster IS the lookup — same validate-against-listing traversal
 * guard as agents/skills). Tier 1 parses through the Guide's section parser:
 * ≥2 `## ` sections get the sticky-TOC layout client-side, fewer render as a
 * single column; a `# ` heading overrides the tab title as the document title.
 */
function loadPage(config, slug) {
  const { pages } = scanPages(config);
  const page = pages.find((p) => p.slug === slug);
  if (!page) return null;
  if (page.tier === 'md') {
    let source;
    try {
      source = fs.readFileSync(path.join(config.pagesDir, slug, 'index.md'), 'utf8');
    } catch {
      return null; // deleted between scan and read — a 404, never a crash
    }
    const { title, intro, sections } = parseGuide(source, page.title);
    return { slug, tier: 'md', title, intro, sections };
  }
  if (page.tier === 'html') {
    return {
      slug,
      tier: 'html',
      title: page.title,
      src: `/pages-view/${mintPageToken(config, slug)}/${slug}/`,
    };
  }
  // Tier 2 (widgets): the roster shape only — the route hands it to
  // page-widgets.js renderWidgetsPage for the layout parse + server-side
  // widget composition (phase 3, test plan hub-pages-tier2-widgets-2026-08-29).
  // The scan itself still never parses index.json content.
  return { slug, tier: page.tier, title: page.title };
}

module.exports = {
  scanPages,
  loadPage,
  humanizeName,
  readManifest,
  mintPageToken,
  verifyPageToken,
  VALID_NAME,
  TOKEN_SHAPE,
};
