'use strict';

const express = require('express');
const {
  listAgents,
  loadAgent,
  listKnowledge,
  loadKnowledge,
} = require('../lib/claude-workspace');
const { threadCounts } = require('../lib/threads');

/**
 * Agents API (feature #3): the workspace agents and their governing docs
 * ("Knowledge": CLAUDE.md, SETUP.md), read live from WORKSPACE_CLAUDE_DIR.
 * Markdown is rendered + sanitized server-side. Mounted behind requireAuth.
 *
 * Document-threads N3: index rows join thread-entry counts (`comments: <n>`)
 * from the /thread anchor listing, best-effort — zero is silent, and an
 * unconfigured or failing log API means no counts, never a broken index
 * (TP-agents-skills-013): this section must keep working with no log API at all.
 */
function agentsRouter(config) {
  const router = express.Router();

  // Index: agents + knowledge docs (TP-react-017), with thread counts (N3).
  router.get('/api/agents', async (req, res) => {
    const [agentComments, knowledgeComments] = await Promise.all([
      threadCounts(config, 'agent'),
      threadCounts(config, 'knowledge'),
    ]);
    const withCount = (row, counts, key) => ({
      ...row,
      // Quiet ledger: the field exists only when there is something to say.
      ...(counts[key] ? { comments: counts[key] } : {}),
    });
    res.json({
      ok: true,
      agents: listAgents(config.workspaceClaudeDir).map((a) => withCount(a, agentComments, a.name)),
      knowledge: listKnowledge(config.workspaceClaudeDir).map((d) => withCount(d, knowledgeComments, d.slug)),
    });
  });

  // One agent: frontmatter meta + sanitized html body.
  router.get('/api/agents/:name', (req, res) => {
    const agent = loadAgent(config.workspaceClaudeDir, req.params.name);
    if (!agent) {
      return res.status(404).json({ ok: false, error: `Agent not found for "${String(req.params.name).slice(0, 40)}".` });
    }
    const { name, description, model, tools, html } = agent; // raw source stays server-side
    res.json({ ok: true, agent: { name, description, model, tools, html } });
  });

  // One knowledge doc, whitelisted slug. Destructured: the raw `source` (the
  // page-comment context) stays server-side (TP-agents-skills-015).
  router.get('/api/knowledge/:slug', (req, res) => {
    const doc = loadKnowledge(config.workspaceClaudeDir, req.params.slug);
    if (!doc) {
      return res.status(404).json({ ok: false, error: `Knowledge doc not found for "${String(req.params.slug).slice(0, 40)}".` });
    }
    const { slug, file, title, html } = doc;
    res.json({ ok: true, doc: { slug, file, title, html } });
  });

  return router;
}

module.exports = { agentsRouter };
