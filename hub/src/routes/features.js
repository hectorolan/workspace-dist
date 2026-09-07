'use strict';

const express = require('express');
const { isConfigured, listFeatures } = require('../lib/features');

/**
 * Features API (Part B of the feature-registry restructure): the log API's
 * server-aggregated feature-major matrix, proxied with the src/lib/features.js
 * trim. `?stale_minutes=` is validated here (positive integer, else dropped —
 * injection guard, mirrors /api/stations) and forwarded to the feed. Mounted in
 * src/app.js behind requireAuth.
 */
function featuresRouter(config) {
  const router = express.Router();

  router.get('/api/features', async (req, res) => {
    if (!isConfigured(config)) {
      return res.status(503).json({
        ok: false,
        error: 'The log API is not configured for this deployment — set LOG_API_URL and LOG_API_KEY in the environment.',
      });
    }
    const raw = String(req.query.stale_minutes || '');
    const staleMinutes = /^[0-9]+$/.test(raw) && Number(raw) > 0 ? Number(raw) : undefined;
    try {
      const data = await listFeatures(config, staleMinutes);
      res.json({ ok: true, ...data });
    } catch (err) {
      console.error(`features: log API error: ${err.message}`);
      res.status(502).json({ ok: false, error: 'The feature registry could not be reached. Try again in a moment.' });
    }
  });

  return router;
}

module.exports = { featuresRouter };
