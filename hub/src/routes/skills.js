'use strict';

const express = require('express');
const { listSkills, loadSkill } = require('../lib/claude-workspace');
const { threadCounts } = require('../lib/threads');

/**
 * Skills API (feature #3): the workspace skills (.claude/skills/<dir>/SKILL.md),
 * including upstream provenance for vendored skills (sources.json). Markdown is
 * rendered + sanitized server-side. Mounted behind requireAuth.
 *
 * Document-threads N3: index rows join thread-entry counts best-effort — zero is
 * silent, an unconfigured/failing log API means no counts, never a broken index
 * (TP-agents-skills-014).
 */
function skillsRouter(config) {
  const router = express.Router();

  // Index: all skills, sorted by directory name (TP-react-017), with counts (N3).
  router.get('/api/skills', async (req, res) => {
    const comments = await threadCounts(config, 'skill');
    res.json({
      ok: true,
      skills: listSkills(config.workspaceClaudeDir).map((s) => ({
        ...s,
        // Quiet ledger: the field exists only when there is something to say.
        ...(comments[s.name] ? { comments: comments[s.name] } : {}),
      })),
    });
  });

  // One skill: sanitized SKILL.md html + upstream source line data.
  router.get('/api/skills/:name', (req, res) => {
    const skill = loadSkill(config.workspaceClaudeDir, req.params.name);
    if (!skill) {
      return res.status(404).json({ ok: false, error: `Skill not found for "${String(req.params.name).slice(0, 40)}".` });
    }
    const { name, description, html, upstream } = skill; // raw source stays server-side
    res.json({ ok: true, skill: { name, description, html, upstream } });
  });

  return router;
}

module.exports = { skillsRouter };
