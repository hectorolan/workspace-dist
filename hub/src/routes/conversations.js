'use strict';

const express = require('express');
const { isConfigured, loadConversation, setConversationStatus, SET_STATUSES } = require('../lib/conversations');
const { MAX_INSTRUCTION_LENGTH, buildConversationOpener, postComment } = require('../lib/page-comments');

/**
 * Conversations API. The index route retired with the Conversations page
 * (document-threads N2) — the listing now lives in the Plans conversation view
 * (`GET /api/plans?kind=conversation`). What remains here:
 *  - POST /api/conversations — start a page-born conversation: stores the
 *    opening message through the SAME page-comment intake machinery the comment
 *    box uses (src/lib/page-comments.js buildConversationOpener; W1 anchors it
 *    as the role-`ceo` entry, the inbox tick answers into the thread + email).
 *  - GET /api/conversations/:id — one legacy email thread (read-only render).
 *  - POST /api/conversations/:id/status — archive/unarchive (server-side PATCH).
 * Mounted in src/app.js behind requireAuth.
 */
function conversationsRouter(config) {
  const router = express.Router();

  const notConfigured = (res) =>
    res.status(503).json({
      ok: false,
      error: 'The log API is not configured for this deployment — set LOG_API_URL and LOG_API_KEY in the environment.',
    });

  const unreachable = (res, err) => {
    console.error(`conversations: log API error: ${err.message}`);
    res.status(502).json({ ok: false, error: 'The conversations service could not be reached. Try again in a moment.' });
  };

  // Start a conversation (TP-nexus-n2-006/007): the compose box's confirm step
  // posts {instruction}; the response ref is the new thread's doc_ref, which the
  // client navigates to (/conversations/<ref>).
  router.post('/api/conversations', express.json({ limit: '64kb' }), async (req, res) => {
    if (!isConfigured(config)) return notConfigured(res);
    const { instruction } = req.body || {};
    const text = typeof instruction === 'string' ? instruction.trim() : '';
    if (!text || text.length > MAX_INSTRUCTION_LENGTH) {
      return res.status(400).json({
        ok: false,
        error: `The message must be non-empty and at most ${MAX_INSTRUCTION_LENGTH} characters.`,
      });
    }
    try {
      const { ref, message } = buildConversationOpener(text);
      await postComment(config, message);
      res.json({ ok: true, ref });
    } catch (err) {
      console.error(`conversations: opener failed: ${err.message}`);
      res.status(502).json({
        ok: false,
        error: 'The log API is unreachable — the conversation was NOT started. Your text is still in the box; try again in a moment.',
      });
    }
  });

  // Archive / unarchive, BOTH populations (TP-convarch-004): a numeric :id is a
  // legacy store row, a conv-* ref is a page-born thread (the lib PATCHes every
  // backing conversation row). JSON POST -> server PATCH(es) -> the client
  // refetches; fully reversible, never a delete, and deliberately no confirm
  // dialog (CEO ruling 2026-08-17: archive means drop it — the inbox runner
  // skips archived threads; unarchiving restores eligibility). The API key
  // stays server-side (TP-react-016).
  router.post('/api/conversations/:id/status', express.json({ limit: '4kb' }), async (req, res) => {
    if (!isConfigured(config)) return notConfigured(res);
    const { status } = req.body || {};
    if (!SET_STATUSES.includes(status)) {
      return res.status(400).json({ ok: false, error: 'A conversation can only be set to active or archived.' });
    }
    try {
      const result = await setConversationStatus(config, req.params.id, status);
      if (result === null) {
        return res.status(404).json({ ok: false, error: `Conversation not found for "${String(req.params.id).slice(0, 40)}".` });
      }
      return res.json({ ok: true, status });
    } catch (err) {
      // Pre-deploy the API may reject a status-only PATCH — surface it, don't crash.
      console.error(`conversations: archive failed: ${err.message}`);
      return res.status(502).json({ ok: false, error: 'The conversation status could not be updated — try again in a moment.' });
    }
  });

  // One legacy thread: the CEO's questions + agent replies in order, each
  // message's markdown rendered + sanitized server-side (TP-react-015).
  router.get('/api/conversations/:id', async (req, res) => {
    if (!isConfigured(config)) return notConfigured(res);
    try {
      const thread = await loadConversation(config, req.params.id);
      if (!thread) {
        return res.status(404).json({ ok: false, error: `Conversation not found for "${String(req.params.id).slice(0, 40)}".` });
      }
      res.json({
        ok: true,
        conversation: thread.conversation,
        // Artifact linkage for the detail header's chips (TP-convchip-001) —
        // absent when the conversation generated nothing.
        ...(thread.artifacts ? { artifacts: thread.artifacts } : {}),
        messages: thread.messages.map(({ id, kind, date, ts, who, cls, html }) => ({ id, kind, date, ts, who, cls, html })),
      });
    } catch (err) {
      unreachable(res, err);
    }
  });

  // JSON-shaped body-parser failures, mirroring the page-comments route.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        ok: false,
        error: `The request body is too large — keep the message at or under ${MAX_INSTRUCTION_LENGTH} characters.`,
      });
    }
    const status = Number.isInteger(err.status) ? err.status : 400;
    res.status(status).json({ ok: false, error: 'The request body could not be read — try again.' });
  });

  return router;
}

module.exports = { conversationsRouter };
