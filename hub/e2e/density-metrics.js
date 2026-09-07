'use strict';

/**
 * In-page density metrics for the responsive rework (test plan
 * hn-test-plan-2026-08-01-mobile-density). Shared by the regression spec
 * (e2e/responsive-density.spec.js) and the before/after report script
 * (e2e/measure-density.js) so both always agree on what "chrome" and
 * "characters per line" mean:
 *
 *   - chromePx / chromePct — viewport width minus the .card CONTENT box:
 *     everything between the viewport edge and the first rendered character
 *     (shell padding + card border + card padding; at desktop widths it also
 *     counts the shell's centering margins, which is why the chrome target
 *     only binds at phone/tablet widths).
 *   - cpl — .prose content width divided by the average glyph width of the
 *     computed reading font, measured empirically by laying out a
 *     representative English sample in that exact font (IBM Plex Serif
 *     averages ~0.5em/glyph; we measure rather than assume).
 */

/** Runs INSIDE the browser via page.evaluate — must stay self-contained. */
function measureDensity() {
  const prose = document.querySelector('.prose');
  const card = (prose && prose.closest('.card')) || document.querySelector('.card');
  if (!prose || !card) return { error: 'no .prose/.card on this page' };

  const proseStyle = getComputedStyle(prose);
  const probe = document.createElement('span');
  probe.textContent =
    'The quick brown fox jumps over the lazy dog while the operator reads a plain daily digest of world news and technical notes.';
  probe.style.font = proseStyle.font;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  document.body.appendChild(probe);
  const avgCharPx = probe.getBoundingClientRect().width / probe.textContent.length;
  probe.remove();

  const cardStyle = getComputedStyle(card);
  const cardContentPx =
    card.clientWidth - parseFloat(cardStyle.paddingLeft) - parseFloat(cardStyle.paddingRight);
  const prosePx =
    prose.clientWidth - parseFloat(proseStyle.paddingLeft) - parseFloat(proseStyle.paddingRight);
  const viewportPx = window.innerWidth;
  const chromePx = viewportPx - cardContentPx;

  return {
    viewportPx,
    prosePx: Math.round(prosePx * 10) / 10,
    cardContentPx: Math.round(cardContentPx * 10) / 10,
    chromePx: Math.round(chromePx * 10) / 10,
    chromePct: Math.round((chromePx / viewportPx) * 1000) / 10,
    fontSizePx: parseFloat(proseStyle.fontSize),
    lineHeightPx: Math.round(parseFloat(proseStyle.lineHeight) * 10) / 10,
    avgCharPx: Math.round(avgCharPx * 100) / 100,
    cpl: Math.round((prosePx / avgCharPx) * 10) / 10,
    hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
  };
}

module.exports = { measureDensity };
