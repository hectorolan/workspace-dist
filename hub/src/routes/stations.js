'use strict';

const express = require('express');
const { isConfigured, listStations } = require('../lib/stations');

/**
 * Stations API (feature #6): the station registry roster with the control plane's
 * own health verdicts (see src/lib/stations.js for the two rules). `?stale_minutes=`
 * is validated here (positive integer, else dropped — injection guard, mirrors the
 * other routes' filter guards) and forwarded to the feed. Mounted in src/app.js
 * behind requireAuth.
 */
function stationsRouter(config) {
  const router = express.Router();

  router.get('/api/stations', async (req, res) => {
    if (!isConfigured(config)) {
      return res.status(503).json({
        ok: false,
        error: 'The log API is not configured for this deployment — set LOG_API_URL and LOG_API_KEY in the environment.',
      });
    }
    const raw = String(req.query.stale_minutes || '');
    const staleMinutes = /^[0-9]+$/.test(raw) && Number(raw) > 0 ? Number(raw) : undefined;
    try {
      const { stations, neverReported, staleMinutes: echoed } = await listStations(config, staleMinutes);
      res.json({ ok: true, stations, neverReported, staleMinutes: echoed });
    } catch (err) {
      console.error(`stations: log API error: ${err.message}`);
      res.status(502).json({ ok: false, error: 'The station registry could not be reached. Try again in a moment.' });
    }
  });

  return router;
}

module.exports = { stationsRouter };
