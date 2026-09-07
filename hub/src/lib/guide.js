'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderMarkdown } = require('./render-markdown');

/**
 * The hub's user manual (Home > Guide) — design `hub-home-custom-pages-design`
 * Part 1, phase 1 (test plan hub-home-restructure-2026-08-29).
 *
 * The manual is authored as ONE markdown file in the repo (src/content/guide.md)
 * and split into `## `-delimited sections server-side. Each section's BODY runs
 * through the one sanitization pipeline (render-markdown.js) with the heading
 * stripped: the client renders the heading itself and puts the section's slug id
 * on a React-rendered wrapper element, so anchor ids never live inside sanitized
 * HTML and the sanitizer allowlist does not widen (TP-home-002). Markdown
 * authoring also keeps the phase-2 dogfooding option cheap — the manual is
 * already a tier-1-shaped document.
 */

const GUIDE_FILE = path.join(__dirname, '..', 'content', 'guide.md');

/** Slug for a section heading: lowercase, alnum runs joined by hyphens. */
function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parse sectioned markdown into `{title, intro, sections:[{id, title, html}]}`.
 * The `# ` line is the document title (falling back to `defaultTitle`); any
 * content between it and the first `## ` heading becomes the rendered `intro`
 * (empty for guide.md itself); each `## ` heading opens a section. Ids are
 * de-duplicated defensively (`-2`, `-3`, …) so the TOC anchors stay unique even
 * if two headings ever collide after slugging. Since phase 2 this parser IS
 * the tier-1 custom-page renderer too (the dogfooding graduation recorded in
 * test plan hub-pages-framework-core-2026-08-29) — arbitrary user index.md
 * files pass through here, so nothing may be silently dropped or thrown.
 */
function parseGuide(source, defaultTitle = 'Guide') {
  let title = defaultTitle;
  let intro = '';
  const sections = [];
  const seen = new Map();
  for (const chunk of String(source).split(/\n(?=## )/)) {
    if (!chunk.startsWith('## ')) {
      const m = chunk.match(/^# (.+)$/m);
      if (m) title = m[1].trim();
      const preamble = chunk.replace(/^# .+$/m, '').trim();
      if (preamble) intro = renderMarkdown(preamble);
      continue;
    }
    const nl = chunk.indexOf('\n');
    const heading = (nl === -1 ? chunk : chunk.slice(0, nl)).slice(3).trim();
    const body = nl === -1 ? '' : chunk.slice(nl + 1);
    const base = slugify(heading) || 'section';
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    sections.push({
      id: n === 1 ? base : `${base}-${n}`,
      title: heading,
      html: renderMarkdown(body.trim()),
    });
  }
  return { title, intro, sections };
}

/** Read and render the packaged manual. Throws if the file is unreadable. */
function loadGuide() {
  return parseGuide(fs.readFileSync(GUIDE_FILE, 'utf8'));
}

module.exports = { loadGuide, parseGuide };
