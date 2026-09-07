'use strict';

const express = require('express');
const { isConfigured, getThread } = require('../lib/threads');

/**
 * Document threads API (design: central-DB plan nexus-document-threads-design,
 * N1): the exchange anchored to one document, rendered below it. The client
 * addresses threads by the page identity it already has (pageType + slug); the
 * pageType → doc_kind mapping and the sanitization both live server-side
 * (src/lib/threads.js). Mounted in src/app.js behind requireAuth.
 */
function threadsRouter(config) {
  const router = express.Router();

  router.get('/api/threads/:pageType/:slug', async (req, res) => {
    if (!isConfigured(config)) {
      return res.status(503).json({
        ok: false,
        error: 'The log API is not configured for this deployment — set LOG_API_URL and LOG_API_KEY in the environment.',
      });
    }
    try {
      const thread = await getThread(config, req.params.pageType, req.params.slug);
      if (!thread) {
        // Unknown pageType or path-shaped ref — refused BEFORE any upstream call.
        return res.status(404).json({ ok: false, error: 'No such document thread.' });
      }
      res.json({ ok: true, thread });
    } catch (err) {
      console.error(`threads: log API error: ${err.message}`);
      res.status(502).json({ ok: false, error: 'The thread could not be loaded. Try again in a moment.' });
    }
  });

  return router;
}

module.exports = { threadsRouter };
