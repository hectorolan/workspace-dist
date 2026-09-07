import { useEffect } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useApi } from '../api.js';
import { DocumentPage } from '../components/DocumentPage.jsx';
import { IndexCard, IndexRow } from '../components/IndexRow.jsx';
import { ErrorCard, KindBadge, Loading, Prose, RepoBadge, StatusBadge } from '../components/states.jsx';
import { useReportDocKind } from '../components/doc-kind.js';

/**
 * The Documents section's plan-backed subtabs (hn-documents-subtabs-2026-08-15):
 * Plans (/plans, kind=plan), Tests (/tests, kind=test-plan, held-first with the
 * closed list behind ?closed=1) and Records (/records, every other kind merged,
 * archived behind ?archived=1). A DISPLAY grouping only — the data, kinds and
 * statuses are untouched; /plans/:slug stays the canonical detail URL for every
 * kind. The Conversations subtab lives in pages/conversations.jsx.
 */

/** Compose a query string from the truthy pairs, in a stable order. */
function qs(pairs) {
  const parts = Object.entries(pairs)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** One li per plan row — the shared adapter onto the IndexRow template. */
function PlanRow({ p }) {
  return (
    <IndexRow
      key={p.slug}
      className={p.status === 'archived' ? 'rail-archived' : ''}
      href={`/plans/${p.slug}`}
      title={
        <>
          {p.title} <KindBadge kind={p.kind} />
          <StatusBadge status={p.status} />
          {p.needsCeo ? <span className="needs-ceo">needs the CEO</span> : null}
          {p.repo && p.repo !== 'workspace' ? <RepoBadge repo={p.repo} /> : null}
        </>
      }
      date={p.updated_at}
      refKey={p.slug}
      count={p.comments}
    />
  );
}

/** Repo filter chips (shared by the three plan-backed subtabs). */
function RepoFilters({ repos, repo, hrefFor }) {
  return (
    <p className="filters">
      <Link href={hrefFor('')} className={repo === '' ? 'active' : ''}>
        All repos
      </Link>
      {repos.map((rp) => (
        <Link key={rp} href={hrefFor(rp)} className={repo === rp ? 'active' : ''}>
          {rp}
        </Link>
      ))}
    </p>
  );
}

/**
 * Where a legacy `/plans?kind=…` URL lives now (assumption 2 of the test plan):
 * every pre-subtab bookmark resolves to its owning subtab, carrying the repo
 * axis (and mapping a done/archived status onto the matching toggle). Returns
 * null when the URL is not legacy-kind-shaped (no redirect).
 */
function legacyKindTarget(sp) {
  const kind = sp.get('kind');
  if (!kind) return null;
  const status = sp.get('status') || '';
  const repo = sp.get('repo') || '';
  if (kind === 'conversation') return '/conversations';
  if (kind === 'test-plan') {
    return `/tests${qs({ repo, closed: status === 'done' || status === 'archived' ? '1' : '' })}`;
  }
  if (kind === 'plan') return `/plans${qs({ status, repo })}`;
  // Every other kind (audit/design/doc/baseline — and anything unknown, which
  // the Records API ignores as a filter) belongs to Records.
  return `/records${qs({ kind, repo, archived: status === 'archived' ? '1' : '' })}`;
}

/**
 * Plans subtab: the backlog — open kind=plan rows, newest activity first.
 * Status chips keep done/archived reachable on demand (never the default read);
 * repo chips as before. Also owns the legacy `?kind=` redirects, since /plans
 * was the all-kinds index before the subtabs.
 */
export function PlansPage() {
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const [, navigate] = useLocation();
  const legacyTarget = legacyKindTarget(sp);
  useEffect(() => {
    if (legacyTarget) navigate(legacyTarget, { replace: true });
  }, [legacyTarget, navigate]);

  // The fetch runs even on a legacy URL (hooks are unconditional); the redirect
  // effect wins the race and the stale response is dropped by useApi's cleanup.
  const apiQuery = qs({ status: sp.get('status') || '', kind: 'plan', repo: sp.get('repo') || '' });
  const { loading, status: httpStatus, data, error } = useApi(`/api/plans${apiQuery}`);

  if (legacyTarget || loading) return <Loading />;
  if (error) return <ErrorCard status={httpStatus} error={error} />;

  // The server validated the filters (unknown values fall back to '') — render
  // active states from ITS echo, not the raw query string.
  const { plans, repos, statuses, status, repo } = data;

  const filters = (
    <>
      <p className="filters">
        <Link href={`/plans${qs({ repo })}`} className={status === '' ? 'active' : ''}>
          All
        </Link>
        {statuses.map((s) => (
          <Link key={s} href={`/plans${qs({ status: s, repo })}`} className={status === s ? 'active' : ''}>
            {s}
          </Link>
        ))}
      </p>
      <RepoFilters repos={repos} repo={repo} hrefFor={(rp) => `/plans${qs({ status, repo: rp })}`} />
    </>
  );

  const empty =
    plans.length === 0
      ? status || repo
        ? `No ${[status, repo].filter(Boolean).join(' ')} plans.`
        : 'No plans yet — create one with ws plan set and it will show up here.'
      : null;

  return (
    <IndexCard title="Plans" beforeList={filters} empty={empty}>
      {plans.map((p) => (
        <PlanRow key={p.slug} p={p} />
      ))}
    </IndexCard>
  );
}

/**
 * The Tests view's explainer standfirst (hn-tests-explainer-2026-08-16): a
 * distributed hub reaches users who didn't build the system, so the view
 * opens by saying what test plans are, what an open entry means, and what to
 * do about one. Static copy on the IndexCard `sub` pattern (the Core subtab's
 * explainer idiom) — /tests only.
 */
const TESTS_EXPLAINER =
  'Test plans are proof of correctness: every change ships with one, and it ' +
  'closes automatically once its evidence is complete — its PR merges or a ' +
  'green run covers its cases. Open plans are still in progress or waiting on ' +
  'your attention; follow up in a Claude session to move them along. Closed ' +
  'plans stay here as history.';

/**
 * Tests subtab: open test-plans first — a held plan (pinned CEO block) sorts to
 * the top with a "needs the CEO" marker, since those are the CEO's action items.
 * Closed (done/archived) test-plans stay behind the ?closed=1 toggle: history on
 * demand, never in the default read.
 */
export function TestsPage() {
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const showClosed = sp.get('closed') === '1';
  const apiQuery = qs({ view: 'tests', repo: sp.get('repo') || '' });
  const { loading, status: httpStatus, data, error } = useApi(`/api/plans${apiQuery}`);

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={httpStatus} error={error} />;
  const { plans, closed, repos, repo } = data;

  const filters = (
    <>
      <RepoFilters repos={repos} repo={repo} hrefFor={(rp) => `/tests${qs({ repo: rp, closed: showClosed ? '1' : '' })}`} />
      <p className="filters">
        <Link href={`/tests${qs({ repo, closed: showClosed ? '' : '1' })}`} className={showClosed ? 'active' : ''}>
          {showClosed ? `Hide closed (${closed.length})` : `Show closed (${closed.length})`}
        </Link>
      </p>
    </>
  );

  const empty = plans.length === 0 ? (repo ? `No open ${repo} test plans.` : 'No open test plans — all green.') : null;

  return (
    <>
      <IndexCard title="Tests" sub={TESTS_EXPLAINER} beforeList={filters} empty={empty}>
        {plans.map((p) => (
          <PlanRow key={p.slug} p={p} />
        ))}
      </IndexCard>
      {showClosed ? (
        <IndexCard title="Closed" empty={closed.length === 0 ? 'No closed test plans yet.' : null}>
          {closed.map((p) => (
            <PlanRow key={p.slug} p={p} />
          ))}
        </IndexCard>
      ) : null}
    </>
  );
}

/**
 * Records subtab: the reference shelf — design, audit, doc, baseline (and any
 * future kind) merged in one list, every row wearing its kind badge. Kind chips
 * narrow to a single kind in one click; done records stay visible (a finished
 * record is still a reference); archived only behind the ?archived=1 toggle.
 */
export function RecordsPage() {
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const showArchived = sp.get('archived') === '1';
  const apiQuery = qs({
    view: 'records',
    kind: sp.get('kind') || '',
    repo: sp.get('repo') || '',
    archived: showArchived ? '1' : '',
  });
  const { loading, status: httpStatus, data, error } = useApi(`/api/plans${apiQuery}`);

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={httpStatus} error={error} />;
  const { plans, repos, repo, kinds, kind, archived } = data;
  const arch = archived ? '1' : '';

  const filters = (
    <>
      <p className="filters">
        <Link href={`/records${qs({ repo, archived: arch })}`} className={kind === '' ? 'active' : ''}>
          All kinds
        </Link>
        {kinds.map((k) => (
          <Link key={k} href={`/records${qs({ kind: k, repo, archived: arch })}`} className={kind === k ? 'active' : ''}>
            {k}
          </Link>
        ))}
      </p>
      <RepoFilters repos={repos} repo={repo} hrefFor={(rp) => `/records${qs({ kind, repo: rp, archived: arch })}`} />
      <p className="filters">
        <Link href={`/records${qs({ kind, repo, archived: archived ? '' : '1' })}`} className={archived ? 'active' : ''}>
          {archived ? 'Hide archived' : 'Show archived'}
        </Link>
      </p>
    </>
  );

  const empty =
    plans.length === 0
      ? kind || repo
        ? `No ${[kind, repo].filter(Boolean).join(' ')} records.`
        : 'No records yet — designs, audits, docs and baselines will show up here.'
      : null;

  return (
    <IndexCard title="Records" beforeList={filters} empty={empty}>
      {plans.map((p) => (
        <PlanRow key={p.slug} p={p} />
      ))}
    </IndexCard>
  );
}

/** One plan: meta line + sanitized markdown body, on the DocumentPage template.
 *  Reports its kind so the Documents subtab bar lights the owning subtab
 *  (doc-kind.js — /plans/:slug hosts every kind). */
export function PlanPage({ params }) {
  const { loading, status: httpStatus, data, error } = useApi(`/api/plans/${encodeURIComponent(params.slug)}`);
  useReportDocKind(data && data.plan ? data.plan.kind : null);

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={httpStatus} error={error} />;
  const plan = data.plan;

  return (
    <DocumentPage backHref="/plans" backLabel="All plans" pageType="plans" slug={plan.slug}>
      <div className="card rail-accent">
        <h1>
          {plan.title} <KindBadge kind={plan.kind} />
          <StatusBadge status={plan.status} />
        </h1>
        <p className="ledger-meta">
          {plan.slug}
          {plan.repo ? ` · ${plan.repo}` : ''} · updated {String(plan.updated_at).slice(0, 10)}
        </p>
        <Prose html={plan.html} className="plan-body" />
      </div>
    </DocumentPage>
  );
}
