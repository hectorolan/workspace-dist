import { Link } from 'wouter';
import { Thread } from './Thread.jsx';

/**
 * THE document-page template (the CEO's consolidation, 2026-08-02): every
 * md-backed detail page — plan, digest, agent, knowledge doc, skill, legacy
 * conversation — is the same scaffold: the centred reading column, the
 * document card(s) as children, the pager back to the section index, then the
 * document's thread + comment box (Thread.jsx) below the hairline. The
 * published result stays the top of the page; the thread never bleeds into
 * the document body (CLAUDE.md "Document threads").
 *
 * The thread-only conversation page (ConversationThreadPage) is NOT this
 * scaffold on purpose: there the thread IS the content — no document card and
 * the pager sits below the thread — so it composes ThreadEntries itself.
 */
export function DocumentPage({ backHref, backLabel, pageType, slug, children }) {
  return (
    <div className="reading-col">
      {children}
      <div className="pager">
        <span>
          <Link href={backHref}>&larr; {backLabel}</Link>
        </span>
        <span></span>
      </div>
      <Thread pageType={pageType} slug={slug} />
    </div>
  );
}
