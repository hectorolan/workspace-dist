'use strict';

/**
 * Identity client — who this instance works for, read from the workspace log
 * API's `GET /identity` (spec: workspace server/README.md; the CEO's
 * naming-is-config ruling 2026-08-15). Same server-side client pattern as every
 * other lib: LOG_API_URL + X-Api-Key, the key never reaches the browser.
 *
 * Fail-soft by contract (TP-ceoconf-008): an unconfigured, unreachable, or
 * malformed API yields the generic labels — a hub page render must NEVER break
 * because the log API is down. Successful lookups cache ~5 minutes per API URL;
 * failures cache 60 s so a down API is retried soon but never hammered per
 * render (TP-ceoconf-007).
 */

const FALLBACK = Object.freeze({ name: 'the CEO', pronouns: 'they/them', hubTitle: 'Hub' });

const TTL_OK_MS = 5 * 60 * 1000;
const TTL_FAIL_MS = 60 * 1000;

/** logApiUrl -> { identity, until } */
const cache = new Map();

/**
 * Resolve the instance identity `{name, pronouns, hubTitle}`. Never throws.
 * `now` is an injectable clock for the cache-TTL tests only.
 */
async function getIdentity(config, now = Date.now()) {
  if (!config.logApiUrl) return FALLBACK;
  const hit = cache.get(config.logApiUrl);
  if (hit && hit.until > now) return hit.identity;
  try {
    const headers = {};
    if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
    const res = await fetch(`${config.logApiUrl}/identity`, { headers });
    if (!res.ok) throw new Error(`log API responded ${res.status}`);
    const data = await res.json();
    const id = data && data.identity;
    if (!id || typeof id !== 'object') throw new Error('malformed identity envelope');
    const identity = Object.freeze({
      name: typeof id.name === 'string' && id.name ? id.name : FALLBACK.name,
      pronouns: typeof id.pronouns === 'string' && id.pronouns ? id.pronouns : FALLBACK.pronouns,
      hubTitle: typeof id.hubTitle === 'string' && id.hubTitle ? id.hubTitle : FALLBACK.hubTitle,
    });
    cache.set(config.logApiUrl, { identity, until: now + TTL_OK_MS });
    return identity;
  } catch {
    cache.set(config.logApiUrl, { identity: FALLBACK, until: now + TTL_FAIL_MS });
    return FALLBACK;
  }
}

/** Test seam: forget every cached identity. */
function resetIdentityCache() {
  cache.clear();
}

module.exports = { getIdentity, resetIdentityCache, IDENTITY_FALLBACK: FALLBACK };
