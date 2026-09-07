'use strict';

const express = require('express');
const {
  PAGE_TYPES,
  MAX_INSTRUCTION_LENGTH,
  isConfigured,
  fetchPageContext,
  buildComment,
  postComment,
} = require('../lib/page-comments');

/**
 * Page comments (feature #5): POST /api/page-comments receives {pageType, slug,
 * instruction} from the CommentBox component's confirm step, re-fetches the page
 * content server-side, and stores the contract message in the workspace log API.
 * Mounted in src/app.js behind requireAuth. JSON responses — the caller is the
 * partial's fetch(), which keeps the CEO's text in the box on any failure.
 */
function pageCommentsRouter(config) {
  const router = express.Router();

  router.post('/api/page-comments', express.json({ limit: '64kb' }), async (req, res) => {
    if (!isConfigured(config)) {
      return res.status(503).json({
        ok: false,
        error: 'The log API is not configured for this deployment — set LOG_API_URL and LOG_API_KEY.',
      });
    }
    const { pageType, slug, instruction } = req.body || {};
    if (!PAGE_TYPES.includes(pageType)) {
      return res.status(400).json({ ok: false, error: 'Unknown page type.' }); // TP-page-comments-007
    }
    const text = typeof instruction === 'string' ? instruction.trim() : '';
    if (!text || text.length > MAX_INSTRUCTION_LENGTH) {
      return res.status(400).json({ ok: false, error: `The instruction must be non-empty and at most ${MAX_INSTRUCTION_LENGTH} characters.` }); // TP-page-comments-009, TP-audit-remediation-009
    }
    try {
      const page = await fetchPageContext(config, pageType, String(slug));
      if (!page) {
        return res.status(404).json({ ok: false, error: 'Page not found — it may have been removed.' }); // TP-page-comments-008
      }
      const message = buildComment({ pageType, slug: String(slug), title: page.title, instruction: text, content: page.content });
      await postComment(config, message);
      res.json({ ok: true, ref: message.ref });
    } catch (err) {
      console.error(`page-comments: ${err.message}`);
      res.status(502).json({
        ok: false,
        error: 'The log API is unreachable — the comment was NOT sent. Your text is still in the box; try again in a moment.',
      }); // TP-page-comments-011
    }
  });

  // Body-parser failures (413 over the 64kb cap, 400 malformed JSON) must come
  // back JSON-shaped like every other response on this route — the client fetch
  // shows `error` inline and the typed text stays in the box.
  // (TP-audit-remediation-010)
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        ok: false,
        error: `The request body is too large — keep the instruction at or under ${MAX_INSTRUCTION_LENGTH} characters.`,
      });
    }
    const status = Number.isInteger(err.status) ? err.status : 400;
    res.status(status).json({ ok: false, error: 'The request body could not be read — try again.' });
  });

  return router;
}

module.exports = { pageCommentsRouter };
