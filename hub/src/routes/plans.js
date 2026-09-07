'use strict';

const express = require('express');
const {
  isConfigured,
  listPlans,
  listPlansAll,
  loadPlan,
  heldPlanSlugs,
  isRecordKind,
  recordKindOptions,
  repoOf,
  repoOptions,
  STATUSES,
  KINDS,
} = require('../lib/plans');
const { threadCounts } = require('../lib/threads');
const { listConversationItems } = require('../lib/conversations');

/**
 * Plans API (feature #4): every plan in the central log DB, visible the moment it
 * is created or updated. Filter semantics are unchanged from the EJS era: known
 * `?status=` overrides the default done/archived exclude, `?kind=` filters
 * app-side (unknown ignored), `?repo=` validates against options derived from the
 * fetched set (injection guard). Mounted in src/app.js behind requireAuth.
 *
 * Document-threads N2 additions:
 *  - every index row whose document has a thread carries `comments: <n>` (joined
 *    server-side from the /thread anchor listing, best-effort — zero is silent
 *    and a join failure never breaks the index);
 *  - `?kind=conversation` is the conversation view — document-less threads +
 *    legacy email conversations (src/lib/conversations.js
 *    listConversationItems) in a `conversations` array, `plans` empty. The
 *    echoed `kinds` list always includes `conversation` so the chip renders.
 *    `?archived=1` adds archived legacy rows (the subtab toggle, TP-docsub-016).
 *
 * Documents-subtab views (hn-documents-subtabs-2026-08-15) — DISPLAY grouping
 * only, the stored kinds/statuses and the workspace /plan API are untouched:
 *  - `?view=tests` — the Tests subtab: kind=test-plan split into `plans` (open:
 *    active/draft, held-first — a pinned CEO block sorts to the top with
 *    `needsCeo: true`) and `closed` (done/archived), both newest-activity-first.
 *  - `?view=records` — the Records subtab: every kind that is not plan/test-plan
 *    (design, audit, doc, baseline, future kinds — the catch-all) in one list;
 *    done stays visible (a finished record is still a reference), archived only
 *    with `?archived=1`; `?kind=` narrows to one record kind (validated against
 *    the derived roster, which is echoed as `kinds`).
 *  - no `?view=` keeps the legacy contract verbatim (TP-docsub-018).
 */
function plansRouter(config) {
  const router = express.Router();

  // The chip roster: plan kinds + the conversation view (not a plan kind — a view).
  const INDEX_KINDS = [...KINDS, 'conversation'];

  const notConfigured = (res) =>
    res.status(503).json({
      ok: false,
      error: 'The log API is not configured for this deployment — set LOG_API_URL and LOG_API_KEY in the environment.',
    });

  const unreachable = (res, err) => {
    console.error(`plans: log API error: ${err.message}`);
    res.status(502).json({ ok: false, error: 'The plans service could not be reached. Try again in a moment.' });
  };

  /** Index-row shape shared by every view; `comments` only when nonzero. */
  const toRow = (comments) => (p) => ({
    slug: p.slug,
    title: p.title,
    status: p.status,
    kind: p.kind,
    repo: repoOf(p),
    updated_at: p.updated_at,
    ...(comments[p.slug] ? { comments: comments[p.slug] } : {}),
  });

  // Index: newest updated first; ?status= + ?kind= + ?repo= filters (TP-react-012);
  // ?view=tests|records for the Documents subtabs.
  router.get('/api/plans', async (req, res) => {
    if (!isConfigured(config)) return notConfigured(res);
    const view = ['tests', 'records'].includes(req.query.view) ? req.query.view : '';
    const status = STATUSES.includes(req.query.status) ? req.query.status : '';
    const kind = INDEX_KINDS.includes(req.query.kind) ? req.query.kind : '';
    const wantArchived = req.query.archived === '1';

    // The conversation view (TP-nexus-n2-003): its data IS the page content, so
    // an upstream failure here surfaces as 502, unlike the count decoration.
    if (kind === 'conversation') {
      try {
        const conversations = await listConversationItems(config, { includeArchived: wantArchived });
        return res.json({
          ok: true,
          plans: [],
          conversations,
          repos: ['workspace'],
          statuses: STATUSES,
          kinds: INDEX_KINDS,
          status: '',
          kind,
          repo: '',
          archived: wantArchived,
        });
      } catch (err) {
        return unreachable(res, err);
      }
    }

    // The Tests subtab (TP-docsub-008/009/010).
    if (view === 'tests') {
      try {
        const [all, comments] = await Promise.all([listPlansAll(config), threadCounts(config, 'plan')]);
        const tests = all.filter((p) => p.kind === 'test-plan');
        const repos = repoOptions(tests);
        const repo = repos.includes(req.query.repo) ? req.query.repo : '';
        const scoped = repo ? tests.filter((p) => repoOf(p) === repo) : tests;
        const open = scoped.filter((p) => p.status === 'active' || p.status === 'draft');
        const closed = scoped.filter((p) => p.status === 'done' || p.status === 'archived');
        // Held plans (pinned CEO block) are the CEO's action items: flag and
        // sort them first. Best-effort — a failed body check just drops the flag.
        const held = await heldPlanSlugs(config, open);
        const rows = open.map(toRow(comments)).map((p) => (held.has(p.slug) ? { ...p, needsCeo: true } : p));
        rows.sort((a, b) => (b.needsCeo ? 1 : 0) - (a.needsCeo ? 1 : 0)); // stable: activity order within each group
        return res.json({
          ok: true,
          view,
          plans: rows,
          closed: closed.map(toRow(comments)),
          repos,
          repo,
          statuses: STATUSES,
          kinds: INDEX_KINDS,
        });
      } catch (err) {
        return unreachable(res, err);
      }
    }

    // The Records subtab (TP-docsub-011..014).
    if (view === 'records') {
      try {
        const [all, comments] = await Promise.all([listPlansAll(config), threadCounts(config, 'plan')]);
        let records = all.filter((p) => isRecordKind(p.kind));
        if (!wantArchived) records = records.filter((p) => p.status !== 'archived');
        const kinds = recordKindOptions(records);
        const recordKind = kinds.includes(req.query.kind) ? req.query.kind : '';
        if (recordKind) records = records.filter((p) => p.kind === recordKind);
        const repos = repoOptions(records);
        const repo = repos.includes(req.query.repo) ? req.query.repo : '';
        if (repo) records = records.filter((p) => repoOf(p) === repo);
        return res.json({
          ok: true,
          view,
          plans: records.map(toRow(comments)),
          repos,
          repo,
          kinds,
          kind: recordKind,
          statuses: STATUSES,
          archived: wantArchived,
        });
      } catch (err) {
        return unreachable(res, err);
      }
    }

    try {
      const [all, comments] = await Promise.all([
        listPlans(config, status, kind),
        threadCounts(config, 'plan'), // best-effort; {} on failure (TP-nexus-n2-002)
      ]);
      const repos = repoOptions(all);
      const repo = repos.includes(req.query.repo) ? req.query.repo : '';
      const plans = (repo ? all.filter((p) => repoOf(p) === repo) : all).map(toRow(comments));
      res.json({ ok: true, plans, repos, statuses: STATUSES, kinds: INDEX_KINDS, status, kind, repo });
    } catch (err) {
      unreachable(res, err);
    }
  });

  // One plan: meta + sanitized html body (TP-react-013).
  router.get('/api/plans/:slug', async (req, res) => {
    if (!isConfigured(config)) return notConfigured(res);
    try {
      const plan = await loadPlan(config, req.params.slug);
      if (!plan) {
        return res.status(404).json({ ok: false, error: `Plan not found for "${String(req.params.slug).slice(0, 60)}".` });
      }
      const { slug, title, status, kind, updated_at, html } = plan;
      res.json({ ok: true, plan: { slug, title, status, kind, repo: repoOf(plan), updated_at, html } });
    } catch (err) {
      unreachable(res, err);
    }
  });

  return router;
}

module.exports = { plansRouter };
