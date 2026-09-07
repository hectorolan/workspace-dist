import { useRef, useState } from 'react';
import { apiPost } from '../api.js';

/**
 * Page comment box (feature #5) — included at the END of content detail pages
 * only. Submit opens the confirmation modal PRE-FILLED with the typed text;
 * final edits happen there and ONLY the modal's confirm sends (design contract:
 * central-DB plan page-comments-design). Element ids are stable test hooks
 * (e2e suite + test-plan assumption 6). Guarded behaviors, all under e2e test:
 *   - empty box refuses to open the modal (TP-nexus-e2e-040)
 *   - open/cancel/Escape never send (041/042/043; Escape is the <dialog>'s own)
 *   - modal edits are what gets sent, and survive a failed send (045/046)
 *   - in-flight guard: both buttons disabled while a send is pending (047)
 *
 * Three presentations, one machinery (document-threads N1/N2): `thread` mode
 * sits at the foot of a document's thread ("add to this thread"; the reply lands
 * in the thread in ~15 min and by email, TP-nexus-e2e-067) and calls `onPosted`
 * after a successful send so the thread refetches; `compose` mode is the "new
 * conversation" box on the Plans conversation view — its confirm POSTs
 * /api/conversations (the opener rides the same page-comment intake
 * server-side) and hands the new thread ref to `onCreated` for navigation; the
 * default keeps the legacy comment-on-this-page copy for pages without a
 * rendered thread. The trust boundary — confirm-only-sends, server-side context
 * re-fetch — is identical in all three.
 */
export function CommentBox({ pageType, slug, thread = false, compose = false, onPosted, onCreated }) {
  const [text, setText] = useState('');
  const [modalText, setModalText] = useState('');
  const [status, setStatus] = useState({ message: '', cls: '' });
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef(null);

  function openModal() {
    if (!text.trim()) {
      setStatus({ message: 'Type an instruction first.', cls: 'comment-err' });
      return;
    }
    setModalText(text); // pre-filled with the typed text; edit freely there
    setStatus({ message: '', cls: '' });
    dialogRef.current.showModal();
  }

  // ONLY this handler sends.
  async function confirmSend() {
    const instruction = modalText;
    setText(instruction); // modal edits survive any failure — nothing is ever lost
    dialogRef.current.close();
    if (!instruction.trim()) {
      setStatus({ message: 'Type an instruction first.', cls: 'comment-err' });
      return;
    }
    setStatus({ message: 'Sending…', cls: '' });
    setBusy(true);
    try {
      const { status: code, data } = compose
        ? await apiPost('/api/conversations', { instruction })
        : await apiPost('/api/page-comments', { pageType, slug, instruction });
      setBusy(false);
      if (code >= 200 && code < 300 && data.ok) {
        setText('');
        setStatus({
          message: compose
            ? 'Conversation started — opening its thread…'
            : thread
              ? 'Added to the thread — the reply lands here in about 15 minutes, and by email.'
              : 'Sent — the reply will arrive by email.',
          cls: 'comment-ok',
        });
        if (compose && onCreated) onCreated(data.ref);
        if (!compose && onPosted) onPosted();
      } else {
        setStatus({ message: data.error || 'Sending failed — your text is still in the box; try again.', cls: 'comment-err' });
      }
    } catch {
      setBusy(false);
      setStatus({ message: 'Sending failed — your text is still in the box; try again.', cls: 'comment-err' });
    }
  }

  return (
    <>
      <div className="card comment-box" id="comment-box" data-page-type={compose ? 'conversations' : pageType} data-slug={compose ? 'new' : slug}>
        <h2>{compose ? 'Start a conversation' : thread ? 'Add to this thread' : 'Comment on this page'}</h2>
        <p className="sub">
          {compose
            ? "Your message opens a new conversation; the agent's reply lands in its thread in about 15 minutes — and in your email."
            : thread
              ? "Your note joins this document's thread; the agent's reply lands here in about 15 minutes — and in your email."
              : "Your instruction is sent to the orchestrator with this page's content as context; the reply arrives by email."}
        </p>
        <textarea
          id="comment-text"
          rows={4}
          maxLength={20000}
          placeholder={compose ? 'Ask or instruct anything — no document needed… (20000 characters max)' : 'Type an instruction about this page… (20000 characters max)'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="comment-actions">
          <button type="button" className="btn-primary" id="comment-open" disabled={busy} onClick={openModal}>
            Send…
          </button>
          <span id="comment-status" role="status" className={status.cls}>
            {status.message}
          </span>
        </div>
      </div>
      <dialog id="comment-modal" ref={dialogRef}>
        <h2>Confirm content and send</h2>
        <p className="sub">Review or edit the final text below. Nothing is sent until you confirm.</p>
        <textarea
          id="comment-modal-text"
          rows={8}
          maxLength={20000}
          value={modalText}
          onChange={(e) => setModalText(e.target.value)}
        />
        <div className="comment-actions">
          <button type="button" className="btn-primary" id="comment-confirm" disabled={busy} onClick={confirmSend}>
            Confirm and send
          </button>
          <button type="button" id="comment-cancel" onClick={() => dialogRef.current.close()}>
            Cancel
          </button>
        </div>
      </dialog>
    </>
  );
}
