/**
 * Pure string mapping for the two-line index rows (IndexRow.jsx) — kept free
 * of JSX so the Node test runner can pin its edges directly
 * (test/index-row.test.js, central-DB plan test-plan-index-row-template).
 * `.mjs` because this package has no `"type": "module"` and both Vite (import)
 * and the CJS test suite (dynamic import) must load it.
 */

/**
 * Line 2's facts: `date · key` when the row carries a date, the key alone when
 * it doesn't (filesystem-backed rows). Full ISO stamps truncate to the date —
 * the callers' `String(x).slice(0, 10)` idiom, now in one place. Keys arrive
 * caller-built (`digests/<date>`, `conversations/<ref>`, a bare plan slug) and
 * pass through verbatim.
 */
export function metaFacts(date, refKey) {
  const d = date ? String(date).slice(0, 10) : '';
  return d ? `${d} · ${refKey}` : String(refKey);
}

/** The comment-count label: silent (empty) at zero — the quiet-ledger rule. */
export function countLabel(n) {
  return n ? `${n} comment${n === 1 ? '' : 's'}` : '';
}
