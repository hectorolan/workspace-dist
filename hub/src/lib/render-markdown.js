'use strict';

const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

/**
 * The ONE markdown → safe-HTML pipeline (2026-07-24 audit, finding C). Every
 * `<%- %>` sink in the app renders through this wrapper — marked v15 passes raw
 * HTML straight through, and plan/conversation/digest sources include genuinely
 * external-origin content (inbound email, web-derived digests). Never call
 * `marked.parse` directly from a lib that feeds a view; import this instead.
 *
 * The allowlist is sanitize-html's default (no script/style/iframe, no event
 * handler attributes, no javascript: scheme) extended with only what marked
 * emits for the markdown these sources actually use: images, GFM task-list
 * checkboxes, fence-language classes, and table cell alignment.
 */
const SANITIZE_OPTIONS = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'input', 'del'],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ['src', 'alt', 'title'],
    input: ['type', 'checked', 'disabled'],
    code: ['class'],
    pre: ['class'],
    th: ['align'],
    td: ['align'],
  },
  // Defaults allow http/https/ftp/mailto — javascript: and data: are dropped.
  allowedSchemes: [...sanitizeHtml.defaults.allowedSchemes],
};

/** Render markdown to sanitized HTML. Nullish input renders as empty. */
function renderMarkdown(markdown) {
  return sanitizeHtml(marked.parse(markdown || ''), SANITIZE_OPTIONS);
}

module.exports = { renderMarkdown };
