import { Link } from 'wouter';
import { Prose } from '../components/states.jsx';
import { StateChip } from './features.jsx';

/**
 * Tier-2 widget board (design hub-home-custom-pages-design "Tier semantics",
 * phase 3; test plan hub-pages-tier2-widgets-2026-08-29). The server composed
 * everything (/api/pages/:slug, src/lib/page-widgets.js): this file only
 * renders the handed-back card states — `ok` per widget kind, and the
 * degraded states (`unknown` / `invalid` / `error` / `unconfigured`, plus a
 * page-level `layoutError`) as visible cards. A widget kind or state this
 * client build predates renders the generic placeholder — forward tolerance,
 * never a crash. All data is plain strings rendered through React; the ONE
 * HTML field (plan-view's body) was sanitized server-side by the one
 * pipeline, like every other document body in the app.
 */

function DigestListWidget({ data }) {
  if (!data.rows.length) return <p className="empty">No digests yet.</p>;
  return (
    <ul className="widget-rows">
      {data.rows.map((r) => (
        <li key={r.date}>
          <Link href={`/digests/${r.date}`}>{r.title}</Link>
          <span className="widget-meta">{r.date}</span>
        </li>
      ))}
    </ul>
  );
}

function PlanListWidget({ data }) {
  if (!data.rows.length) return <p className="empty">No documents match.</p>;
  return (
    <ul className="widget-rows">
      {data.rows.map((r) => (
        <li key={r.slug}>
          <Link href={`/plans/${r.slug}`}>{r.title}</Link>
          <span className="widget-meta">
            {[r.kind, r.status, r.repo, r.updated].filter(Boolean).join(' · ')}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PlanViewWidget({ data }) {
  return (
    <div className="widget-plan-view">
      <p className="widget-meta">
        <Link href={`/plans/${data.slug}`}>{data.title}</Link>
        {' · '}
        {[data.kind, data.status].filter(Boolean).join(' · ')}
      </p>
      <Prose html={data.html} />
    </div>
  );
}

function FeatureCellsWidget({ data }) {
  return (
    <div className="widget-table-wrap">
      <table className="widget-feature-table">
        <thead>
          <tr>
            <th />
            {data.stations.map((env) => (
              <th key={env}>{env}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.features.map((f) => (
            <tr key={f.id}>
              <td>{f.missing ? <span className="widget-meta">{f.id} — not in the registry</span> : f.title}</td>
              {data.stations.map((env) => (
                <td key={env}>
                  {f.missing ? <span className="widget-meta">—</span> : <StateChip state={f.cells[env].state} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatTilesWidget({ data }) {
  return (
    <div className="stat-tiles">
      {data.tiles.map((t, i) => (
        <div key={i} className={`stat-tile${t.error ? ' stat-tile-error' : ''}`}>
          {t.error ? (
            <>
              <span className="stat-value">—</span>
              <span className="widget-meta">{t.label}</span>
              <span className="widget-meta">{t.error}</span>
            </>
          ) : (
            <>
              <span className="stat-value">{t.href ? <Link href={t.href}>{t.value}</Link> : t.value}</span>
              <span className="widget-meta">{t.label}</span>
              {t.detail ? <span className="widget-meta">{t.detail}</span> : null}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

const WIDGET_RENDERERS = {
  'digest-list': DigestListWidget,
  'plan-list': PlanListWidget,
  'plan-view': PlanViewWidget,
  'feature-cells': FeatureCellsWidget,
  'stat-tiles': StatTilesWidget,
};

function WidgetCard({ w }) {
  const Renderer = w.state === 'ok' ? WIDGET_RENDERERS[w.widget] : null;
  return (
    <section className={`card widget-card widget-${w.state}`} data-widget={w.widget || 'none'}>
      <h2>{w.title}</h2>
      {Renderer ? (
        <Renderer data={w.data} />
      ) : (
        // Every non-ok state — and any ok widget kind this client predates —
        // degrades to a visible message, never a broken page.
        <p className="empty">{w.message || 'This hub version cannot render this widget.'}</p>
      )}
    </section>
  );
}

export function WidgetBoard({ page }) {
  return (
    <div className="widget-board">
      <div className="card rail-accent widget-board-head">
        <h1>{page.title}</h1>
      </div>
      {page.layoutError ? (
        <div className="card widget-card widget-layout-error">
          <p className="empty">{page.layoutError}</p>
        </div>
      ) : (
        <div className="widget-grid">
          {page.widgets.map((w) => (
            <WidgetCard key={w.key} w={w} />
          ))}
        </div>
      )}
    </div>
  );
}
