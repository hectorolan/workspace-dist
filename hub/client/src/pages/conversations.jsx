import { useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { apiPost, useApi } from '../api.js';
import { ThreadEntries } from '../components/Thread.jsx';
import { CommentBox } from '../components/CommentBox.jsx';
import { DocumentPage } from '../components/DocumentPage.jsx';
import { IndexCard, IndexRow } from '../components/IndexRow.jsx';
import { ErrorCard, KindBadge, Loading, Prose, StatusBadge } from '../components/states.jsx';

/**
 * The Conversations subtab of the Documents section
 * (hn-documents-subtabs-2026-08-15) plus the detail routes. The listing —
 * document-less page-born threads merged with legacy email conversations
 * (document-threads N2) — lived on the Plans page under the `conversation`
 * kind chip until the subtabs; `/plans?kind=conversation` now redirects HERE
 * (pages/plans.jsx), so old bookmarks and digest-email links never 404.
 * Detail routes come in two shapes:
 *
 *  - a numeric ref is a LEGACY email conversation: its transcript renders
 *    read-only from the `/conversation` store (never migrated — design
 *    decision 2), with its document thread + thread-mode comment box below,
 *    so new comments on old conversations thread into the new model;
 *  - a `conv-*` ref is a PAGE-BORN conversation: there is no document — the
 *    thread IS the content (thread-only page).
 */

/**
 * Artifact-linkage chips (TP-convarch-010, TP-convchip-004/005): a conversation
 * that generated a document links straight to it — on its index row (a SIBLING
 * of the row anchor, the Skills origin-chip idiom) AND in its detail header,
 * next to the status badge. Null when the conversation is unlinked: absence,
 * never an empty badge.
 */
function ArtifactChips({ artifacts }) {
  if (!artifacts || artifacts.length === 0) return null;
  return artifacts.map((a) => (
    <Link
      key={`${a.kind}/${a.ref}`}
      className="artifact-chip"
      href={`/plans/${a.ref}`}
      title={`Generated document: ${a.ref}`}
    >
      &rarr; {a.kind}
    </Link>
  ));
}

/**
 * Conversations index (the fourth Documents subtab): both populations merged
 * newest-activity-first, the compose box below. Archived legacy conversations
 * stay behind the ?archived=1 toggle (TP-docsub-016) — history on demand,
 * never in the default read; page-born threads have no archived state.
 */
export function ConversationsIndexPage() {
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const showArchived = sp.get('archived') === '1';
  const { loading, status: httpStatus, data, error } = useApi(
    `/api/plans?kind=conversation${showArchived ? '&archived=1' : ''}`
  );
  const [, navigate] = useLocation();

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={httpStatus} error={error} />;
  const { conversations } = data;

  const filters = (
    <p className="filters">
      <Link href={`/conversations${showArchived ? '' : '?archived=1'}`} className={showArchived ? 'active' : ''}>
        {showArchived ? 'Hide archived' : 'Show archived'}
      </Link>
    </p>
  );

  const empty = conversations.length === 0 ? 'No conversations yet — start one below, or email the agent.' : null;

  return (
    <>
      <IndexCard title="Conversations" beforeList={filters} empty={empty}>
        {conversations.map((c) => (
          <IndexRow
            key={c.ref}
            className={c.status === 'archived' ? 'rail-archived' : ''}
            href={`/conversations/${c.ref}`}
            title={
              <>
                {c.title} <KindBadge kind="conversation" />
                {c.status === 'archived' ? <StatusBadge status="archived" /> : null}
              </>
            }
            date={c.updated}
            refKey={`conversations/${c.ref}`}
            count={c.entries}
            after={<ArtifactChips artifacts={c.artifacts} />}
          />
        ))}
      </IndexCard>
      <CommentBox compose onCreated={(ref) => navigate(`/conversations/${ref}`)} />
    </>
  );
}

/**
 * Archive/unarchive control — BOTH populations (legacy numeric ids and
 * page-born conv-* refs, TP-convarch-011/012). The POST goes to the hub API,
 * which PATCHes the log API server-side (the key never reaches the browser);
 * on success the owning page refetches. Failures surface inline. Deliberately
 * no confirm dialog (CEO ruling 2026-08-17): archiving is the dismissal itself
 * — the inbox runner drops archived threads, and unarchiving reverses it.
 */
function ArchiveButton({ refId, status, onDone, onError }) {
  const [busy, setBusy] = useState(false);
  const next = status === 'archived' ? 'active' : 'archived';

  async function toggle() {
    setBusy(true);
    try {
      const { status: code, data } = await apiPost(`/api/conversations/${encodeURIComponent(refId)}/status`, { status: next });
      setBusy(false);
      if (code >= 200 && code < 300 && data.ok) onDone();
      else onError(data.error || 'The conversation status could not be updated — try again in a moment.');
    } catch {
      setBusy(false);
      onError('The conversation status could not be updated — try again in a moment.');
    }
  }

  return (
    <button type="button" className="row-action" disabled={busy} onClick={toggle}>
      {next === 'archived' ? 'Archive' : 'Unarchive'}
    </button>
  );
}

/** A legacy email thread: the CEO's questions + agent replies in order. */
function LegacyConversationPage({ id }) {
  const { loading, status: httpStatus, data, error, refetch } = useApi(`/api/conversations/${encodeURIComponent(id)}`);
  const [actionError, setActionError] = useState('');

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={httpStatus} error={error} />;
  const { conversation, messages, artifacts } = data;

  return (
    // The DocumentPage template: transcript cards as the document, its numeric-
    // anchor thread + thread-mode box below (new comments on old conversations
    // thread into the new model).
    <DocumentPage
      backHref="/conversations"
      backLabel="All conversations"
      pageType="conversations"
      slug={String(conversation.id)}
    >
      <div className="card">
        <h1>
          {conversation.title} <StatusBadge status={conversation.status} /> <ArtifactChips artifacts={artifacts} />
        </h1>
        <p className="sub">
          Started {String(conversation.created_at).slice(0, 10)} · {messages.length} message
          {messages.length === 1 ? '' : 's'}
        </p>
        {actionError ? <p className="sub comment-err">{actionError}</p> : null}
        <ArchiveButton refId={String(conversation.id)} status={conversation.status} onDone={refetch} onError={setActionError} />
      </div>
      {messages.map((m) => (
        <article key={m.id} className={`msg ${m.cls}`}>
          <header>
            <span className="who">{m.who}</span>
            <span className="when">{m.date}</span>
          </header>
          <div className="msg-body">
            <Prose html={m.html} />
          </div>
        </article>
      ))}
    </DocumentPage>
  );
}

/** A page-born conversation: no document body — the thread IS the content.
 *  Deliberately NOT the DocumentPage template: there is no document card, the
 *  pager sits BELOW the thread, and the entries render directly (ThreadEntries),
 *  not through the Thread fetcher. */
function ConversationThreadPage({ convRef }) {
  const { loading, status: httpStatus, data, error, refetch } = useApi(
    `/api/threads/conversations/${encodeURIComponent(convRef)}`
  );
  const [actionError, setActionError] = useState('');

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={httpStatus} error={error} />;
  const thread = data.thread;

  if (thread.entries.length === 0) {
    // An empty conversation anchor is a conversation that never existed.
    return <ErrorCard status={404} error={`Conversation not found for "${convRef}".`} />;
  }

  // Archive state rides the thread payload (opener's conversation row, piece 1);
  // an old API carries none — render as active, the reversible toggle still
  // surfaces a clean inline error if the archive itself can't be serviced.
  const status = thread.status === 'archived' ? 'archived' : 'active';

  return (
    // Reading page (prose-dominant thread) → the centred reading column.
    <div className="reading-col">
      <div className="card rail-accent">
        <p className="eyebrow">Conversation</p>
        <h1>
          {thread.title} <StatusBadge status={status} /> <ArtifactChips artifacts={thread.artifacts} />
        </h1>
        <p className="ledger-meta">
          {convRef} · {thread.entries.length} entr{thread.entries.length === 1 ? 'y' : 'ies'}
        </p>
        {actionError ? <p className="sub comment-err">{actionError}</p> : null}
        <ArchiveButton refId={convRef} status={status} onDone={refetch} onError={setActionError} />
      </div>
      <section className="doc-thread" id="doc-thread">
        <ThreadEntries entries={thread.entries} />
        <CommentBox pageType="conversations" slug={convRef} thread onPosted={refetch} />
      </section>
      <div className="pager">
        <span>
          <Link href="/conversations">&larr; All conversations</Link>
        </span>
        <span></span>
      </div>
    </div>
  );
}

/** Route dispatcher: numeric = legacy store, conv-* = page-born thread. */
export function ConversationPage({ params }) {
  const ref = String(params.id);
  if (/^conv-\d+$/.test(ref)) return <ConversationThreadPage convRef={ref} />;
  return <LegacyConversationPage id={ref} />;
}
