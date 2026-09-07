import { Link, useSearch } from 'wouter';
import { useApi } from '../api.js';
import { ErrorCard, Loading } from '../components/states.jsx';

/**
 * Features: the ONE health surface (Part C of the feature-registry restructure —
 * design: central-DB plan features-ui-restructure-design, C-1; layout pass:
 * central-DB test plan hub-features-kind-tabs-2026-08-27). Rows are the
 * DECLARED registry features, one KIND at a time behind an in-page tab row
 * derived from the kinds present in the feed (never a hardcoded list — a future
 * kind gets its tab automatically; `?kind=` deep-links a tab, the
 * Records-subtab idiom for a data-derived axis). Each row is title + inline
 * scope tag, then its colloquial `description` from the feed (C-2 — the prose
 * lives ONLY in the registry, never hardcoded here), then the data meta line;
 * columns are the configured stations; every cell state is the control plane's
 * own verdict (`GET /api/features` proxies the log API's aggregated
 * `GET /feature`), echoed verbatim — this page never derives liveness.
 *
 * The Stations page merged into this one: station column headers wear the
 * control plane's health/stale/never-reported verdicts and humanized
 * last-report age (a best-effort `/api/stations` join — the matrix renders with
 * plain header names if that feed fails, never broken), and each header links
 * to the per-station detail at `/stations/:env`. Never-reported stations render
 * as dimmed columns. Stations that report but are NOT in configs can't be
 * matrix columns (the feed's roster is configured stations only), so they
 * surface in the "Also reporting" strip below, badge intact — nothing the old
 * Stations page knew is lost.
 *
 * Reading rules the rendering must keep honest:
 * - `n/a` = the station is OUTSIDE the feature's scope: the quietest cell of
 *   all, visually distinct from `missing` (absence of duty, not of capability).
 * - `unmeasured` = declared with no evidence found — distinct from ready AND
 *   from n/a; a feature with `evidence: []` additionally wears its
 *   "declared, unmeasured" note. Never fake liveness.
 * - Job rows carry their last-run outcome and disabled state from the feed.
 */

/** Format the server's age verdict (minutes) for headers and detail metas. */
export function age(mins) {
  if (mins == null) return '';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h}h ${mins % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

/** css-safe suffix for a cell state ('n/a' and 'never-reported' need mapping). */
const stateClass = (state) => (state === 'n/a' ? 'na' : state === 'never-reported' ? 'never' : state);

/** One state chip — shared with the station detail page. */
export function StateChip({ state, title }) {
  return (
    <span className={`feature-chip fc-${stateClass(state)}`} title={title || undefined}>
      {state}
    </span>
  );
}

/** Hover text for a cell: its evidence rows, verbatim strings from the feed. */
function cellTitle(cell) {
  if (!cell || !cell.checks || cell.checks.length === 0) return '';
  return cell.checks
    .map((c) => `${c.id}: ${c.state}${c.detail ? ` — ${c.detail}` : ''}${c.via ? ` (via ${c.via})` : ''}`)
    .join('\n');
}

/** Known kinds in display order; a kind outside this list still gets its own
 *  tab (labeled with the raw kind, appended in feed order) — the tab row is
 *  derived from the DATA, so a future registry kind appears automatically. */
const KIND_LABELS = [
  ['job', 'Jobs'],
  ['service', 'Services'],
  ['tool', 'Tools'],
  ['check', 'Checks'],
  ['page', 'Pages'],
];

function kindTabs(features) {
  const present = [];
  for (const f of features) if (!present.includes(f.kind)) present.push(f.kind);
  const known = KIND_LABELS.filter(([k]) => present.includes(k));
  const unknown = present.filter((k) => !KIND_LABELS.some(([kk]) => kk === k)).map((k) => [k, k]);
  return [...known, ...unknown].map(([kind, label]) => ({
    kind,
    label,
    rows: features.filter((f) => f.kind === kind),
  }));
}

/** The feature row's data line: job outcome, note, id. */
function metaLine(f) {
  const parts = [f.id];
  if (f.job) {
    parts.push(`job ${f.job.name}`);
    if (f.job.disabled) parts.push('disabled');
    else if (f.job.lastRun) parts.push(`last ${f.job.lastRun.status} ${f.job.lastRun.date}`);
    else parts.push('no runs recorded');
  }
  if (f.note) parts.push(f.note);
  return parts.join(' · ');
}

function FeatureRow({ feature: f, stations, stationInfo }) {
  return (
    <tr>
      <td className="fm-feature">
        <strong>{f.title}</strong>
        <span className="scope-badge">{f.scope}</span>
        {f.job && f.job.disabled ? <StateChip state="off" title="job disabled in jobs.json" /> : null}
        {!f.measured ? <span className="feature-chip fc-unmeasured">declared, unmeasured</span> : null}
        {f.description ? <div className="fm-desc">{f.description}</div> : null}
        <div className="fm-meta">{metaLine(f)}</div>
      </td>
      {stations.map((env) => {
        const cell = f.cells[env] || { state: 'unmeasured', checks: [] };
        const info = stationInfo[env];
        const never = info ? info.neverReported : false;
        return (
          <td key={env} className={`fm-cell fmc-${stateClass(cell.state)}${never ? ' fm-col-never' : ''}`}>
            <StateChip state={cell.state} title={cellTitle(cell)} />
          </td>
        );
      })}
    </tr>
  );
}

/**
 * A station column header: the env name linking to its `/stations/:env` detail,
 * plus the control plane's verdicts (best-effort — with no station info the
 * name renders plain). Never-reported columns dim (absence is normal, quiet).
 */
function StationTh({ env, info, search }) {
  const never = info ? info.neverReported : false;
  return (
    <th className={`fm-station${never ? ' fm-col-never' : ''}`}>
      <Link href={`/stations/${encodeURIComponent(env)}${search}`}>{env}</Link>
      {info ? (
        <span className="fmh-verdicts">
          {never ? (
            <span className="station-badge sn-never">never reported</span>
          ) : (
            <>
              <span className={`station-badge ${info.ok ? 'sn-ok' : 'sn-failing'}`}>{info.ok ? 'ok' : 'failing'}</span>
              {info.stale ? <span className="station-badge sn-stale">stale</span> : null}
              {info.ageMinutes != null ? <span className="fmh-age">{age(info.ageMinutes)}</span> : null}
            </>
          )}
        </span>
      ) : null}
    </th>
  );
}

export function FeaturesPage() {
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const sm = sp.get('stale_minutes') || '';
  const kindParam = sp.get('kind') || '';
  const query = sm ? `?stale_minutes=${encodeURIComponent(sm)}` : '';
  const { loading, status: httpStatus, data, error } = useApi(`/api/features${query}`);
  // Station health for the column headers + the not-in-configs strip —
  // best-effort: a failed read renders plain header names, never a broken page.
  const stationsApi = useApi(`/api/stations${query}`);

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={httpStatus} error={error} />;
  const { stations, features, staleMinutes, scheduleOwner } = data;
  const tabs = kindTabs(features);
  // The active tab: validated against the kinds actually present — an unknown
  // or absent ?kind falls back to the first tab, never an error or empty page.
  const active = tabs.find((t) => t.kind === kindParam) || tabs[0] || null;
  const hrefFor = (kind) =>
    `/features?kind=${encodeURIComponent(kind)}${sm ? `&stale_minutes=${encodeURIComponent(sm)}` : ''}`;

  // env -> control-plane verdicts, echoed verbatim (never derived here).
  const stationInfo = {};
  if (stationsApi.data) {
    for (const s of stationsApi.data.stations) {
      stationInfo[s.env] = { ok: s.ok, stale: s.stale, ageMinutes: s.ageMinutes, configured: s.configured };
    }
    for (const env of stationsApi.data.neverReported) stationInfo[env] = { neverReported: true };
  }
  // Reporters outside the configured roster: visible here, never a column.
  const rogue = stationsApi.data
    ? stationsApi.data.stations.filter((s) => !stations.includes(s.env))
    : [];

  return (
    <>
      <div className="card">
        <h1>Features</h1>
        <p className="ledger-meta">
          The declared registry, joined by the control plane against station reports and job runs (no report in{' '}
          {staleMinutes} min = stale{scheduleOwner ? `; schedule owner ${scheduleOwner}` : ''}). n/a = station outside
          the feature&apos;s scope; unmeasured = declared with no evidence — liveness is never assumed. Click a station
          header for its machine detail.
        </p>
      </div>
      {active === null ? (
        <div className="card">
          <p className="empty">No features declared — an empty registry is normal for a fresh deployment.</p>
        </div>
      ) : (
        <>
          <nav className="kind-tabs">
            {tabs.map((t) => (
              <Link key={t.kind} href={hrefFor(t.kind)} className={active.kind === t.kind ? 'active' : ''}>
                {t.label}
              </Link>
            ))}
          </nav>
          <div className="card feature-group">
            <h2>{active.label}</h2>
            <table className="feature-matrix">
              <thead>
                <tr>
                  <th>feature</th>
                  {stations.map((env) => (
                    <StationTh key={env} env={env} info={stationInfo[env]} search={query} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {active.rows.map((f) => (
                  <FeatureRow key={f.id} feature={f} stations={stations} stationInfo={stationInfo} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {rogue.length > 0 ? (
        <div className="card">
          <h2 className="fm-rogue-title">Also reporting</h2>
          <p className="ledger-meta">Stations filing reports without a configs entry — not part of the declared roster.</p>
          <ul className="rogue-list">
            {rogue.map((s) => (
              <li key={s.env}>
                <Link href={`/stations/${encodeURIComponent(s.env)}${query}`}>{s.env}</Link>
                <span className={`station-badge ${s.ok ? 'sn-ok' : 'sn-failing'}`}>{s.ok ? 'ok' : 'failing'}</span>
                {s.stale ? <span className="station-badge sn-stale">stale</span> : null}
                <span className="station-badge sn-stale">not in configs</span>
                {s.ageMinutes != null ? <span className="fmh-age">{age(s.ageMinutes)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
