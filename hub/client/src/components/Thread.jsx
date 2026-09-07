import { useApi } from '../api.js';
import { CommentBox } from './CommentBox.jsx';
import { Prose } from './states.jsx';

/**
 * A document's thread (design: central-DB plan nexus-document-threads-design,
 * N1) — the exchange rendered BELOW the document it is about: the CEO
 * commenting, the agent answering, in flat order. `trigger` entries arrive
 * first from the server and are marked as the document's origin. The comment
 * box sits at the thread's foot in thread mode; a successful post refetches so
 * the new CEO entry appears without a reload (intake writes it synchronously).
 *
 * Empty thread = just the comment box, no chrome. A failed thread fetch shows a
 * muted notice and keeps the box usable — the document above already rendered.
 * Entry html is server-sanitized (src/lib/threads.js); nothing else may reach
 * the Prose sink.
 *
 * ThreadEntries is the bare entry list — shared with the thread-only
 * conversation page (N2), where the thread IS the document.
 */

const ROLE_LABEL = { ceo: 'CEO', agent: 'Agent', trigger: 'Origin' };

/**
 * The entry's stamp is the MESSAGE's date (the CEO, 2026-08-02): `entry.created`
 * is the LINK time — for backfilled history the day the entry was attached, not
 * the day the words were written — so it never displays. Time comes from the
 * message `ts` when it is ISO-shaped; a message without one stamps date-only.
 */
function entryWhen(e) {
  const ts = String(e.ts || '');
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(ts) ? `${e.date} ${ts.slice(11, 16)}` : String(e.date || '');
}

/**
 * The provenance keys under the date — "anything that can help me to trace back
 * how is saved": the source conversation when the message has one, the message
 * row, the message kind. Absent parts are omitted; all absent renders nothing.
 */
function provenance(e) {
  return [
    e.conversation_id != null ? `conversations/${e.conversation_id}` : null,
    e.message_id != null ? `message ${e.message_id}` : null,
    e.kind || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function ThreadEntries({ entries }) {
  return entries.map((e) => (
    <article key={e.id} className={`msg thread-entry ${e.role}`} data-role={e.role}>
      <header>
        <span className="who">{ROLE_LABEL[e.role] || e.role}</span>
        <span className="when-stack">
          <span className="when">{entryWhen(e)}</span>
          {provenance(e) ? <span className="prov">{provenance(e)}</span> : null}
        </span>
      </header>
      {e.role === 'trigger' ? (
        <p className="trigger-note">This document exists because of this exchange.</p>
      ) : null}
      <Prose html={e.html} className="msg-body" />
    </article>
  ));
}

export function Thread({ pageType, slug }) {
  const { loading, data, error, refetch } = useApi(
    `/api/threads/${encodeURIComponent(pageType)}/${encodeURIComponent(slug)}`
  );
  const entries = (data && data.thread.entries) || [];

  return (
    <section className="doc-thread" id="doc-thread">
      {error ? (
        <p className="thread-note" id="thread-error">
          The thread could not be loaded — comments still send.
        </p>
      ) : null}
      {!loading && entries.length > 0 ? (
        <>
          <p className="eyebrow thread-eyebrow">Thread</p>
          <ThreadEntries entries={entries} />
        </>
      ) : null}
      <CommentBox pageType={pageType} slug={slug} thread onPosted={refetch} />
    </section>
  );
}
