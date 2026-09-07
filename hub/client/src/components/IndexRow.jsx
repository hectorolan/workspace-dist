import { Link } from 'wouter';
import { CommentCount } from './states.jsx';
import { metaFacts } from './row-format.mjs';

/**
 * THE index template (the CEO's consolidation, 2026-08-02): every row-shaped
 * index — Plans, the conversation view, Digests, Agents, Knowledge, Skills —
 * renders through these two components; a section keeps only a thin adapter
 * (fetch + map to the props below). The rendered DOM is the two-line ledger
 * idiom the Playwright suite pins (test-plan-two-line-index-rows,
 * TP-nexus-e2e-075..078, 089): line 1 the name and its chips, an optional
 * curated summary line, then the machine facts — date (when the row has one)
 * and the row's key, with the comment count pushed right and silent at zero.
 *
 * Pixel contract: `title` is a NODE composed by the caller (name + chips with
 * the caller's own spacing — a space before a badge is a visible ~one-word gap
 * on top of the badge margin, so the template must not normalize it). String
 * mapping lives in row-format.mjs so the Node test runner can pin its edges
 * (test-plan-index-row-template).
 */

/**
 * The index card shell: h1, optional standfirst, optional pre-list content
 * (the Plans filters), then the empty line or the two-line list. `empty` is
 * the quiet empty-state sentence — truthy swaps the list out entirely.
 */
export function IndexCard({ title, sub, beforeList, empty, children }) {
  return (
    <div className="card">
      <h1>{title}</h1>
      {sub ? <p className="sub">{sub}</p> : null}
      {beforeList}
      {empty ? <p className="empty">{empty}</p> : <ul className="conv-index two-line">{children}</ul>}
    </div>
  );
}

/**
 * One two-line row. Props: `href` the row link; `title` the line-1 node;
 * `desc` the curated summary line (rendered whenever provided — Agents/Skills
 * pass it, date-backed rows don't); `date`/`refKey` the facts line
 * (row-format.mjs); `count` the thread-entry count; `className` extra li
 * classes (the archived rail); `after` line-1 chips rendered OUTSIDE the link
 * (the Skills origin chip, the Conversations artifact chip — never nested in
 * the row anchor).
 *
 * The stretched-link idiom (the 2026-08-17 chip-column fix): the row anchor
 * wraps only the title and covers the whole row through its CSS `::after`
 * overlay, so `after` chips sit in-flow ON line 1 — immediately after the
 * title's badges — yet stay independently clickable siblings, and the whole
 * row remains one click target with no dead zones.
 */
export function IndexRow({ href, title, desc, date, refKey, count, className, after }) {
  return (
    <li className={className}>
      <span className="conv-line1">
        <Link href={href} className="row-link">
          <span className="conv-title">{title}</span>
        </Link>
        {after}
      </span>
      {desc !== undefined ? <span className="item-desc">{desc}</span> : null}
      <span className="conv-meta">
        <span className="meta-facts">{metaFacts(date, refKey)}</span>
        <CommentCount n={count} />
      </span>
    </li>
  );
}
