'use strict';

const express = require('express');
const { loadGuide } = require('../lib/guide');

/**
 * Guide API (Home > Guide, test plan hub-home-restructure-2026-08-29): the
 * hub's user manual, packaged with the app (src/content/guide.md) and rendered
 * server-side through the one sanitization pipeline (src/lib/guide.js).
 * Mounted behind requireAuth like every content route. A missing/unreadable
 * manual answers a clean JSON 500 — never a stack trace.
 */
function guideRouter() {
  const router = express.Router();

  router.get('/api/guide', (req, res) => {
    try {
      res.json({ ok: true, guide: loadGuide() });
    } catch {
      res.status(500).json({ ok: false, error: 'The guide could not be loaded.' });
    }
  });

  return router;
}

module.exports = { guideRouter };
