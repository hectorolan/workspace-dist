import { Link, Redirect, useSearch } from 'wouter';
import { useApi } from '../api.js';
import { ErrorCard, Loading } from '../components/states.jsx';
import { StateChip, age } from './features.jsx';

/**
 * Per-station machine detail (Part C of the feature-registry restructure — the
 * Stations PAGE retired into the Features matrix, design: central-DB plan
 * features-ui-restructure-design, C-1). `/stations` redirects to the merged
 * surface; `/stations/:env` — reached from a matrix column header or a deep
 * link — is the drill-down: the FULL check table (git, node, identity,
 * gh-scopes, NSG, …), public IP, platform, and the control plane's verdicts.
 * A check that arrives with env-doctor's plain-language `explain` shows it as
 * secondary text (the Features-row two-line idiom) — in the table AND on the
 * FAIL/WARN headline rows; the prose is authored only in env-doctor (C-2 rule),
 * and a row without it (older cached report) renders exactly as before.
 *
 * The rules the old page enforced still hold: `stale`/`ageMinutes`/
 * `neverReported` come from the server verbatim (this page never computes
 * health from timestamps); never-reported is a NORMAL state (new box, empty
 * DB), styled quiet, not broken; "not in configs" keeps its visible badge.
 * The station's feature column is deliberately NOT repeated here — the matrix
 * owns that fact (one fact, one place).
 */

/** `/stations` → the merged surface, `?stale_minutes=` preserved. */
export function StationsRedirect() {
  const search = useSearch();
  return <Redirect to={`/features${search ? `?${search}` : ''}`} replace />;
}

/** The quiet normal state: configured, no report row yet. */
function NeverReportedDetail({ env }) {
  return (
    <div className="card station station-never">
      <h2>
        {env}
        <span className="station-badge sn-never">never reported</span>
      </h2>
      <p className="ledger-meta">
        No report yet — normal for a new box or a fresh registry. The station files its own state on its 15-minute pull tick.
      </p>
    </div>
  );
}

/** One reported station, in full: verdicts, meta, headline failures, every check. */
function StationDetail({ station: s }) {
  const failing = s.checks.filter((c) => c.level === 'FAIL');
  const warning = s.checks.filter((c) => c.level === 'WARN');
  const boring = s.ok && !s.stale && failing.length === 0 && warning.length === 0;
  const rail = failing.length || !s.ok ? 'rail-alert' : s.stale || warning.length ? 'rail-amber' : '';

  return (
    <div className={`card station ${rail}`.trim()}>
      <h2>
        {s.env}
        <span className={`station-badge ${s.ok ? 'sn-ok' : 'sn-failing'}`}>{s.ok ? 'ok' : 'failing'}</span>
        {s.stale ? <span className="station-badge sn-stale">stale</span> : null}
        {!s.configured ? <span className="station-badge sn-stale">not in configs</span> : null}
      </h2>
      <p className="ledger-meta">
        last report {String(s.ts).slice(0, 16).replace('T', ' ')} · {age(s.ageMinutes)}
        {s.publicIp ? ` · ip ${s.publicIp}` : ''}
        {s.platform ? ` · ${s.platform}` : ''}
      </p>
      {failing.length > 0 || warning.length > 0 ? (
        <ul className="check-list">
          {[...failing, ...warning].map((c) => (
            <li key={c.id} className={c.level === 'FAIL' ? 'check-fail' : 'check-warn'}>
              <span className={`station-badge lv-${c.level.toLowerCase()}`}>{c.level}</span>
              <strong>{c.name}</strong> — {c.detail}
              {c.explain ? <div className="check-explain">{c.explain}</div> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {boring ? <p className="empty station-allclear">{s.checks.length} checks ok</p> : null}
      {s.checks.length > 0 ? (
        <div className="station-checks">
          <p className="eyebrow">all {s.checks.length} checks</p>
          <table>
            <tbody>
              {s.checks.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className={`station-badge lv-${c.level.toLowerCase()}`}>{c.level}</span>
                  </td>
                  <td>{c.name}</td>
                  <td>
                    {c.detail}
                    {c.explain ? <div className="check-explain">{c.explain}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export function StationDetailPage({ params }) {
  const env = decodeURIComponent(params.env);
  const search = useSearch();
  const sm = new URLSearchParams(search).get('stale_minutes') || '';
  const query = sm ? `?stale_minutes=${encodeURIComponent(sm)}` : '';
  const { loading, status: httpStatus, data, error } = useApi(`/api/stations${query}`);

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={httpStatus} error={error} />;
  const { stations, neverReported, staleMinutes } = data;
  const station = stations.find((s) => s.env === env);
  const silent = !station && neverReported.includes(env);

  if (!station && !silent) {
    return (
      <div className="card">
        <h1>Not found</h1>
        <p>
          No station named <strong>{env}</strong> — not in configs and no report on record.
        </p>
        <p>
          <Link href="/features">Back to the Features matrix</Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h1>{env}</h1>
        <p className="ledger-meta">
          Observed state, reported by the station&apos;s 15-minute pull tick. Staleness is judged by the control plane
          (no report in {staleMinutes} min = stale). Its feature column lives on the{' '}
          <Link href={`/features${query}`}>Features matrix</Link> — this page is the machine detail.
        </p>
      </div>
      {station ? <StationDetail station={station} /> : <NeverReportedDetail env={env} />}
    </>
  );
}
