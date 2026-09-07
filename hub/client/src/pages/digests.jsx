import { useEffect } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useApi } from '../api.js';
import { DocumentPage } from '../components/DocumentPage.jsx';
import { IndexCard, IndexRow } from '../components/IndexRow.jsx';
import { ErrorCard, Loading, Prose } from '../components/states.jsx';

/**
 * `/` — the morning read: the LATEST digest in full, body + thread, rendered by
 * the same DigestPage the detail route uses (test-plan-home-latest-digest) —
 * `/` is just "the newest one" without needing to know the date. Fetches the
 * index and delegates to DigestPage for its newest row; no digests at all is a
 * quiet line (the states.jsx treatment), never chrome. Legacy `/?date=X` links
 * keep redirecting to /digests/X — `/` hosted the index (and before that the
 * query-form digest URL) until now, so old emails never break.
 */
export function HomeLatestDigest() {
  const search = useSearch();
  const legacyDate = new URLSearchParams(search).get('date');
  const [, navigate] = useLocation();
  const { loading, status, data, error } = useApi('/api/digests');

  useEffect(() => {
    if (legacyDate) navigate(`/digests/${encodeURIComponent(legacyDate)}`, { replace: true });
  }, [legacyDate, navigate]);

  if (legacyDate || loading) return <Loading />;
  if (error) return <ErrorCard status={status} error={error} />;
  if (data.digests.length === 0) {
    return (
      <div className="card">
        <p className="empty">There are no digests yet — check back after the next daily run.</p>
      </div>
    );
  }
  return <DigestPage params={{ date: data.digests[0].date }} />;
}

/**
 * /digests: the digest INDEX (backlog item 70) — the full history, picked by
 * date; the CEO's daily read lives on `/` (HomeLatestDigest). Rows are the
 * IndexRow template (PR #32 two-line idiom): line 1 the title (stored subject;
 * fallback `Daily Digest — <date>` for subject-less history — composed titles
 * from backlog item 72 light up here with no UI change), line 2
 * `date · digests/<date>` with the comment count pushed right, nonzero only.
 * A legacy /digests?date=X link still redirects to /digests/X (emails carry
 * them).
 */
export function DigestsHome() {
  const search = useSearch();
  const legacyDate = new URLSearchParams(search).get('date');
  const [, navigate] = useLocation();
  const { loading, status, data, error } = useApi('/api/digests');

  useEffect(() => {
    if (legacyDate) navigate(`/digests/${encodeURIComponent(legacyDate)}`, { replace: true });
  }, [legacyDate, navigate]);

  if (legacyDate || loading) return <Loading />;
  if (error) return <ErrorCard status={status} error={error} />;

  return (
    <IndexCard
      title="Daily digests"
      // Quiet empty state — a line, not chrome.
      empty={data.digests.length === 0 ? 'There are no digests yet — check back after the next daily run.' : null}
    >
      {data.digests.map((d) => (
        <IndexRow
          key={d.date}
          href={`/digests/${d.date}`}
          title={d.title}
          date={d.date}
          refKey={`digests/${d.date}`}
          count={d.comments}
        />
      ))}
    </IndexCard>
  );
}

/** One digest: body + its document thread, on the DocumentPage template. The
 *  date dropdown retired with the index page — the index IS the date navigation. */
export function DigestPage({ params }) {
  const date = params.date;
  const { loading, status, data, error } = useApi(`/api/digests/${encodeURIComponent(date)}`);

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={status} error={error} />;
  const digest = data.digest;

  return (
    <DocumentPage backHref="/digests" backLabel="All digests" pageType="digests" slug={digest.date}>
      <div className="card rail-accent digest-body">
        <Prose html={digest.html} />
      </div>
    </DocumentPage>
  );
}
