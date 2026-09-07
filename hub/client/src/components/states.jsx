/** Shared page states: loading, API errors, markdown injection, badges. */

import { countLabel } from './row-format.mjs';

/** Sanitized-HTML sink. ONLY server-sanitized html (render-markdown.js) may pass
 *  through here — never user input, never client-assembled strings. */
export function Prose({ html, className = '' }) {
  return <div className={`prose ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Loading() {
  return (
    <div className="card">
      <p className="empty">Loading…</p>
    </div>
  );
}

/**
 * API failure card. Titles mirror the EJS era: 404 not found, 503 not
 * configured, 502 unreachable; the body is the server's own message.
 */
export function ErrorCard({ status, error }) {
  const title = status === 404 ? 'Not found' : status === 503 ? 'Not configured' : 'Log API unreachable';
  return (
    <div className="card">
      <h1>{title}</h1>
      <p>{error}</p>
      <p>
        <a href="/">Back to Home</a>
      </p>
    </div>
  );
}

/** Quiet count marker for two-line index rows (PR #32 idiom): rendered only when
 *  there is something to count; the .two-line flex pushes it to the right edge
 *  of the meta line. Every index reaches it through IndexRow; the label rule
 *  lives in row-format.mjs (test-plan-index-row-template). */
export function CommentCount({ n }) {
  const label = countLabel(n);
  return label ? <span className="thread-count">{label}</span> : null;
}

export function StatusBadge({ status }) {
  return <span className={`status-badge st-${status}`}>{status}</span>;
}

export function KindBadge({ kind }) {
  return <span className={`kind-badge kd-${kind}`}>{kind}</span>;
}

export function RepoBadge({ repo }) {
  return <span className="repo-badge">{repo}</span>;
}
