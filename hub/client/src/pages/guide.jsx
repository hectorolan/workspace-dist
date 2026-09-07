import { useApi } from '../api.js';
import { ErrorCard, Loading, Prose } from '../components/states.jsx';

/**
 * Sectioned-document layout — the Guide's renderer, graduated into the shared
 * tier-1 custom-page renderer in phase 2 (design hub-home-custom-pages-design
 * Part 2 dogfooding decision, test plan hub-pages-framework-core-2026-08-29):
 * content on the left, a sticky right-hand column enumerating the `## `
 * sections (plain in-page anchors, so wouter never intercepts them). Section
 * ids are the SERVER's slugs, placed here on React-rendered wrappers — never
 * inside the sanitized HTML; the headings are likewise rendered here, stripped
 * from each section body server-side. Documents with fewer than two sections
 * render as a single column (a TOC of one is noise). On narrow viewports the
 * TOC collapses above the content as a jump list (app.css .guide-layout).
 */
export function SectionedDocument({ title, intro, sections }) {
  const toc = sections.length >= 2;
  const main = (
    <div className="card rail-accent guide-main">
      <h1>{title}</h1>
      {intro ? <Prose html={intro} /> : null}
      {sections.map((s) => (
        <section key={s.id} id={s.id} className="guide-section">
          <h2 className="guide-heading">{s.title}</h2>
          <Prose html={s.html} />
        </section>
      ))}
    </div>
  );
  if (!toc) return main;
  return (
    <div className="guide-layout">
      {main}
      <aside className="card guide-toc" aria-label="Document sections">
        <p className="eyebrow">On this page</p>
        <nav>
          <ul>
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    </div>
  );
}

/**
 * /guide — the hub's user manual (Home > Guide; design
 * hub-home-custom-pages-design Part 1, test plan hub-home-restructure-2026-08-29),
 * rendered through the shared sectioned-document layout above.
 */
export function GuidePage() {
  const { loading, status, data, error } = useApi('/api/guide');

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={status} error={error} />;
  const { title, intro, sections } = data.guide;
  return <SectionedDocument title={title} intro={intro || ''} sections={sections} />;
}
