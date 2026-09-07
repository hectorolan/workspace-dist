import { useApi } from '../api.js';
import { ErrorCard, Loading } from '../components/states.jsx';
import { SectionedDocument } from './guide.jsx';
import { WidgetBoard } from './widgets.jsx';

/**
 * /pages/:slug — one custom page (design hub-home-custom-pages-design Part 2,
 * test plan hub-pages-framework-core-2026-08-29). The tier decides the render:
 *
 * - `md` (tier 1): the shared sectioned-document layout — a tier-1 page looks
 *   exactly like the Guide (sticky TOC with ≥2 sections, single column below).
 * - `html` (tier 3): the folder served as a static site under its own
 *   token-scoped path, displayed in a SANDBOXED iframe — `allow-scripts
 *   allow-forms`, never `allow-same-origin`, so page code runs with an opaque
 *   origin: no hub cookies, no hub API, no reach into the hub shell.
 * - `widgets` (tier 2): the server-composed widget board (test plan
 *   hub-pages-tier2-widgets-2026-08-29) — layout and data errors arrive as
 *   visible card states, never a crash. Anything else (a future tier this
 *   hub build predates) renders a visible placeholder.
 */
export function CustomPage({ params }) {
  const slug = params.slug;
  const { loading, status, data, error } = useApi(`/api/pages/${encodeURIComponent(slug)}`);

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={status} error={error} />;
  const page = data.page;

  if (page.tier === 'md') {
    return <SectionedDocument title={page.title} intro={page.intro || ''} sections={page.sections} />;
  }
  if (page.tier === 'html') {
    return (
      <iframe
        className="page-frame"
        sandbox="allow-scripts allow-forms"
        src={page.src}
        title={page.title}
      />
    );
  }
  if (page.tier === 'widgets') {
    return <WidgetBoard page={page} />;
  }
  return (
    <div className="card">
      <h1>{page.title}</h1>
      <p className="empty">This page type is not supported by this hub version.</p>
    </div>
  );
}
