'use strict';

const express = require('express');
const { isConfigured, listDigests, loadDigest } = require('../lib/digests');
const { threadCounts } = require('../lib/threads');

/**
 * Digests API (feature #1). The digest history is the `daily-digest` message kind
 * in the workspace log API (see src/lib/digests.js) — read server-side; the API
 * key never reaches the browser, and the markdown is rendered + sanitized here
 * (assumption 1 of the React refactor test plan): the client only ever receives
 * safe HTML. Mounted in src/app.js behind requireAuth.
 */
function digestsRouter(config) {
  const router = express.Router();

  const notConfigured = (res) =>
    res.status(503).json({
      ok: false,
      error: 'The log API is not configured for this deployment — set LOG_API_URL and LOG_API_KEY in the environment.',
    });

  const unreachable = (res, err) => {
    console.error(`digests: log API error: ${err.message}`);
    res.status(502).json({ ok: false, error: 'The digest service could not be reached. Try again in a moment.' });
  };

  // The digest index (backlog item 70): two-line rows newest first — date,
  // title (stored subject, `Daily Digest — <date>` fallback), and the per-date
  // thread-entry count joined best-effort from the anchor listing (per-digest
  // anchors, doc_ref = the date). A /thread failure means no counts, never a
  // broken index (TP-digest-index-004); zero is silent — the field is absent
  // (quiet ledger, mirrors the Plans index join).
  router.get('/api/digests', async (req, res) => {
    if (!isConfigured(config)) return notConfigured(res);
    try {
      const [index, counts] = await Promise.all([listDigests(config), threadCounts(config, 'digest')]);
      res.json({
        ok: true,
        digests: index.map(({ date, title }) => ({
          date,
          title,
          ...(counts[date] ? { comments: counts[date] } : {}),
        })),
      });
    } catch (err) {
      unreachable(res, err);
    }
  });

  // One digest: sanitized html only — date navigation lives on the index
  // (TP-digest-index-005). The strict date guard in loadDigest rejects
  // malformed/path-shaped params BEFORE any API call (TP-react-011).
  router.get('/api/digests/:date', async (req, res) => {
    if (!isConfigured(config)) return notConfigured(res);
    try {
      const digest = await loadDigest(config, req.params.date);
      if (!digest) {
        return res.status(404).json({ ok: false, error: `Digest not found for "${String(req.params.date).slice(0, 40)}".` });
      }
      const { date, html } = digest; // raw markdown stays server-side
      res.json({ ok: true, digest: { date, html } });
    } catch (err) {
      unreachable(res, err);
    }
  });

  return router;
}

module.exports = { digestsRouter };
