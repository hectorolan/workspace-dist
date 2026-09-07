'use strict';

/**
 * Minimal server-rendered terminal pages (auth failures, access denied, missing
 * build). These are the ONLY HTML the backend produces since the React refactor —
 * everything else is the built SPA plus JSON under /api. They render for people
 * who are OUTSIDE the auth wall, so they must not depend on the gated bundle;
 * styling comes from the small public stylesheet (/public/base.css), keeping the
 * strict CSP (style-src 'self', no inline styles) intact.
 */

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A complete, self-contained page with the ledger look's terminal state. */
function htmlPage({ title, message, backHref = '/', backLabel = 'Back to hub' }) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} · hub</title>`,
    '<link rel="stylesheet" href="/public/base.css">',
    '</head>',
    '<body class="terminal">',
    '<main class="terminal-card">',
    '<p class="terminal-brand">hub</p>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(message)}</p>`,
    `<p><a href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a></p>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}

/** Send a terminal error page with the given HTTP status. */
function sendErrorPage(res, status, title, message) {
  res.status(status).type('html').send(htmlPage({ title, message }));
}

module.exports = { htmlPage, sendErrorPage, escapeHtml };
