'use strict';

const { loadPlan } = require('./plans');
const { loadDigest } = require('./digests');
const { loadAgent, loadSkill, loadKnowledge } = require('./claude-workspace');
const { loadConversation } = require('./conversations');
const { CONV_REF_RE, newConversationRef, getConversationContext } = require('./threads');

/**
 * Page comments: turn an instruction typed on a content detail page into a
 * `page-comment` message in the workspace log API (contract: central-DB plan
 * `page-comments-design`). The page context is ALWAYS re-fetched server-side
 * through the same lib functions the detail routes render with — content never
 * round-trips through the browser (TP-page-comments-010).
 */

/** The contract's pageType enum — every md-backed detail page threads (N3). */
const PAGE_TYPES = ['plans', 'digests', 'agents', 'skills', 'knowledge', 'conversations'];

/** Safety bound for the instruction text (plan doc "Assumptions"). */
const MAX_INSTRUCTION_LENGTH = 20000;

function isConfigured(config) {
  return Boolean(config.logApiUrl);
}

/**
 * Resolve a page's title + raw source content by pageType/slug, or null when the
 * page doesn't exist (each loader's own guard doubles as the traversal guard).
 */
async function fetchPageContext(config, pageType, slug) {
  switch (pageType) {
    case 'plans': {
      const plan = await loadPlan(config, slug);
      return plan ? { title: plan.title, content: plan.body || '' } : null;
    }
    case 'digests': {
      const digest = await loadDigest(config, String(slug));
      return digest ? { title: `Digest ${digest.date}`, content: digest.markdown } : null;
    }
    case 'agents': {
      const agent = loadAgent(config.workspaceClaudeDir, String(slug));
      return agent ? { title: `Agent: ${agent.name}`, content: agent.source } : null;
    }
    case 'skills': {
      const skill = loadSkill(config.workspaceClaudeDir, String(slug));
      return skill ? { title: `Skill: ${skill.name}`, content: skill.source } : null;
    }
    case 'knowledge': {
      // N3: the governing docs thread too. Whitelisted slug = traversal guard.
      const doc = loadKnowledge(config.workspaceClaudeDir, String(slug));
      return doc ? { title: doc.title, content: doc.source } : null;
    }
    case 'conversations': {
      // Two stores, one pageType (N2): a `conv-*` slug is a page-born
      // conversation — its own thread is the context; a numeric slug is a
      // legacy /conversation store transcript.
      if (CONV_REF_RE.test(String(slug))) return getConversationContext(config, slug);
      const thread = await loadConversation(config, slug);
      if (!thread) return null;
      const transcript = thread.messages.map((m) => `### ${m.who} — ${m.date}\n\n${m.body}`).join('\n\n');
      return { title: thread.conversation.title, content: transcript };
    }
    default:
      return null;
  }
}

/** Build the contract message body/envelope for POST /message. */
function buildComment({ pageType, slug, title, instruction, content }) {
  return {
    kind: 'page-comment',
    ref: `page-comment-${Date.now()}`, // raw instant as ID is fine per contract
    subject: `Page comment: ${title} (${pageType}/${slug})`,
    body: `## Instruction\n${instruction}\n\n## Page context (${pageType}/${slug})\n${content}\n`,
    meta: JSON.stringify({ source: 'hub', pageType, slug }),
  };
}

/**
 * The opening message of a page-born conversation (N2): the SAME intake contract
 * as buildComment — kind, meta with pageType `conversations` — so W1 anchors it
 * to `(conversation, conv-<ts>)` as the role-`ceo` entry and the inbox tick
 * answers it through the one existing path. Differences, all by design: the
 * message ref is the conv-* doc_ref itself (see below), the subject wrapper
 * says `Conversation:` (titled from the instruction's first line — there is no
 * page to name it), and the body has NO page-context section — a new
 * conversation has nothing to quote, and the runner's fence passes
 * instruction-only bodies through unchanged.
 * Returns {message, ref} where ref = the thread's doc_ref for navigation.
 */
function buildConversationOpener(instruction) {
  const ref = newConversationRef();
  const title = instruction.split('\n')[0].trim().slice(0, 80);
  return {
    ref,
    message: {
      kind: 'page-comment',
      // The opener's message ref IS the thread's conv-<epoch-ms> doc_ref
      // (piece-1 contract, workspace server/README.md "Page-born
      // conversations"): the trigger reverse lookup keys page-born rows on
      // `message_ref`, so the two must be the same string. Follow-up comments
      // keep the page-comment-<ts> shape.
      ref,
      subject: `Conversation: ${title} (conversations/${ref})`,
      body: `## Instruction\n${instruction}\n`,
      meta: JSON.stringify({ source: 'hub', pageType: 'conversations', slug: ref }),
    },
  };
}

/**
 * Store the message via the log API `POST /message` — same server-side client
 * config (logApiUrl + X-Api-Key) as the conversations lib, never a parallel API
 * implementation. Throws on any failure; the caller reports it without losing
 * the typed text (TP-page-comments-011).
 */
async function postComment(config, message) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
  const res = await fetch(`${config.logApiUrl}/message`, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data.ok === false) throw new Error('log API returned not-ok');
  return data;
}

module.exports = {
  PAGE_TYPES,
  MAX_INSTRUCTION_LENGTH,
  isConfigured,
  fetchPageContext,
  buildComment,
  buildConversationOpener,
  postComment,
};
