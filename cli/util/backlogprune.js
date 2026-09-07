// Monthly backlog prune — the scripted archiver that keeps the `backlog` plan
// (THE single iteration surface, CLAUDE.md standing rule) readable: on the 1st
// of each month, resolved material dated in an EARLIER month moves into a
// per-month DB plan `backlog-history-YYYY-MM` (kind plan, status archived —
// archived is a STATUS, never a kind (the CEO, 2026-08-02); out of every active
// listing, reachable via `ws plan list --status archived`).
// Behaviour spec: SYSTEM.md "Monthly backlog prune".
//
// THE RULE THAT OUTRANKS EVERY OTHER: losing a pending item is catastrophic;
// keeping a stale one is merely untidy. Only two structural shapes ever move:
//   - a whole `## Resolved (YYYY-MM-DD)` section (pending items never sit under
//     a Resolved heading, so this cannot take one), and
//   - an inline item whose text STARTS with a marker word (RESOLVED / CLOSED /
//     SHIPPED / DECIDED) immediately followed by an ISO date.
// Everything else — a dateless heading, a marker without a leading date, a
// marker word mid-sentence, a future date — stays in the backlog and is
// reported with a reason. Buckets come from the ITEM'S OWN date, never the run
// date, so a July item pruned late still lands in backlog-history-2026-07.
//
// WRITE ORDER IS THE SAFETY: the history plan is written AND read back verified
// before the backlog is trimmed — the data exists in two places or one, never
// zero. A failed history write changes nothing; a trimmed-backlog write that
// fails after history landed is safe (nothing lost) and the next run finishes.
//
// IDEMPOTENT: a second run finds nothing to move and performs zero writes; a
// recovery run (history landed, trim didn't) merges by item fingerprint, never
// duplicating or clobbering what a history plan already holds.
//
// THREAD ENTRIES FOLLOW THEIR MONTH (the CEO's rule, 2026-08-02): a comment on
// `plan/backlog` belongs to the month it was MADE in, so the prune also
// re-anchors backlog thread entries (PATCH /thread/:id via api.threadMove) to
// `backlog-history-<month>` — bucketed by the MESSAGE's own calendar date,
// never the entry's `created` (backfilled entries carry older messages). The
// month's history plan is created/verified before any entry moves, and a move
// is never lossy (the entry always lives somewhere; doubt leaves it in place).
//
// Zero tokens, and NO audit line from the scheduled run (scheduled runs don't
// log; the plan revisions carry agent `backlog-prune` — the plan-reap precedent
// of "a plan write, not an audit line"). Calendar months come from clock.js.
import * as api from './apiclient.js';
import { today } from './clock.js';
import { stripPlanHeader } from './planclose.js';

/** Agent name on the plan revisions this module writes. */
export const PRUNE_AGENT = 'backlog-prune';
/** The plan being pruned. */
export const BACKLOG_SLUG = 'backlog';
/** Where inline-pruned items land inside a history plan. */
export const ITEMS_HEADING = '## Archived from live sections';

/** The one recognized marker set. Forward convention is `RESOLVED YYYY-MM-DD`
 * (CLAUDE.md standing rule); the legacy words stay recognized for existing
 * items, which are never rewritten. Uppercase only — a prose "shipped" must
 * never archive an item. */
const MARKERS = ['RESOLVED', 'CLOSED', 'SHIPPED', 'DECIDED'];

const SECTION_RE = /^##\s+Resolved\b(.*)$/;
const SECTION_DATE_RE = /\((\d{4}-\d{2}-\d{2})\)/;
/** Top-level list starts only — the backlog is a flat numbered/bulleted list. */
const ITEM_START_RE = /^(?:\d+\.|[-*])\s+/;
const MARKER_DATE_RE = new RegExp(`^(?:\\*\\*)?\\s*(?:${MARKERS.join('|')})\\s+(\\d{4}-\\d{2}-\\d{2})\\b`);
const MARKER_WORD_RE = new RegExp(`^(?:\\*\\*)?\\s*(?:${MARKERS.join('|')})\\b`);
const HEADING_RE = /^#{1,2}\s/;

/** @typedef {{first: string, lines: string[]}} ItemBlock */
/** @typedef {{kind: 'section'|'item', month: string, heading: string|null, label: string, lines: string[], blocks: ItemBlock[]}} MoveUnit */
/** @typedef {{moves: MoveUnit[], ambiguous: Array<{label: string, reason: string}>, keptCurrent: Array<{label: string, month: string}>, newBody: string}} PrunePlan */

/** @param {string} month YYYY-MM */
export const historySlug = (month) => `backlog-history-${month}`;

/** The run month, from the one clock (schedule timezone — never raw UTC). */
export const currentMonth = () => today().slice(0, 7);

/** @param {unknown} e */
const msg = (e) => (e instanceof Error ? e.message : String(e));

/** Drop leading/trailing blank lines of a span. @param {string[]} span */
function trimBlock(span) {
  let a = 0;
  let b = span.length;
  while (a < b && !span[a].trim()) a++;
  while (b > a && !span[b - 1].trim()) b--;
  return span.slice(a, b);
}

/**
 * The list-item blocks inside a run of lines (an item = its start line plus
 * continuation lines up to a blank line, a heading, or the next item start).
 * @param {string[]} lines
 * @returns {ItemBlock[]}
 */
function itemBlocks(lines) {
  /** @type {ItemBlock[]} */
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (!ITEM_START_RE.test(lines[i])) { i++; continue; }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !ITEM_START_RE.test(lines[j]) && !/^#/.test(lines[j])) j++;
    blocks.push({ first: lines[i].trim(), lines: lines.slice(i, j) });
    i = j;
  }
  return blocks;
}

/**
 * Pure judgement: what moves where, what stays and why. Never mutates anything.
 * @param {string} body the backlog body, banner already stripped
 * @param {string} month the run month YYYY-MM — only STRICTLY EARLIER months move
 * @returns {PrunePlan}
 */
export function planPrune(body, month) {
  const lines = body.split(/\r?\n/);
  /** @type {MoveUnit[]} */
  const moves = [];
  /** @type {Array<{label: string, reason: string}>} */
  const ambiguous = [];
  /** @type {Array<{label: string, month: string}>} */
  const keptCurrent = [];
  /** @type {Set<number>} */
  const removed = new Set();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const sm = SECTION_RE.exec(line);
    if (sm) {
      // A Resolved section spans to the next #/## heading (or EOF); its inner
      // items are judged as one unit and never rescanned individually.
      let j = i + 1;
      while (j < lines.length && !HEADING_RE.test(lines[j])) j++;
      const label = line.trim();
      const dm = SECTION_DATE_RE.exec(sm[1] || '');
      if (!dm) {
        ambiguous.push({ label, reason: 'Resolved heading without a parseable (YYYY-MM-DD) date — left for a human' });
      } else {
        const m = dm[1].slice(0, 7);
        if (m < month) {
          const span = lines.slice(i, j);
          moves.push({ kind: 'section', month: m, heading: label, label, lines: trimBlock(span), blocks: itemBlocks(span.slice(1)) });
          for (let k = i; k < j; k++) removed.add(k);
        } else if (m === month) {
          keptCurrent.push({ label, month: m });
        } else {
          ambiguous.push({ label, reason: `dated ${dm[1]}, in the future — left for a human` });
        }
      }
      i = j;
      continue;
    }
    if (ITEM_START_RE.test(line)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !ITEM_START_RE.test(lines[j]) && !/^#/.test(lines[j])) j++;
      const text = line.replace(ITEM_START_RE, '');
      const label = line.trim().slice(0, 120);
      const md = MARKER_DATE_RE.exec(text);
      if (md) {
        const m = md[1].slice(0, 7);
        if (m < month) {
          const span = trimBlock(lines.slice(i, j));
          moves.push({ kind: 'item', month: m, heading: null, label, lines: span, blocks: [{ first: line.trim(), lines: span }] });
          for (let k = i; k < j; k++) removed.add(k);
        } else if (m === month) {
          keptCurrent.push({ label, month: m });
        } else {
          ambiguous.push({ label, reason: `marker dated ${md[1]}, in the future — left for a human` });
        }
      } else if (MARKER_WORD_RE.test(text)) {
        // e.g. `**RESOLVED — verified already shipped 2026-07-30 …` — a human
        // wrote a resolution but not in the structural shape; never guess.
        ambiguous.push({ label, reason: 'marker word not followed by an ISO date at the item start — left for a human' });
      }
      i = j;
      continue;
    }
    i++;
  }

  const newBody = lines.filter((_, ix) => !removed.has(ix)).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '')
    .concat('\n');
  return { moves, ambiguous, keptCurrent, newBody };
}

/** Every line a history plan must contain for the move to count as landed. @param {MoveUnit[]} units */
function fingerprints(units) {
  /** @type {string[]} */
  const fps = [];
  for (const u of units) {
    if (u.heading) fps.push(u.heading);
    for (const b of u.blocks) fps.push(b.first);
  }
  return fps;
}

/**
 * Merge one month's moved units into that month's history body. Append-only:
 * existing content is never rewritten, a unit already present (matched by its
 * first line) is never duplicated, and `changed: false` means the plan needs no
 * write at all — which is what makes the recovery rerun idempotent.
 * @param {string|null} existing the history body (banner stripped), or null to create
 * @param {MoveUnit[]} units this month's moves
 * @param {string} month YYYY-MM
 * @returns {{body: string, changed: boolean, appended: number}}
 */
export function mergeHistory(existing, units, month) {
  const sections = units.filter((u) => u.kind === 'section');
  const items = units.filter((u) => u.kind === 'item');
  if (existing === null) {
    const parts = [
      `# Backlog history — ${month}`,
      '',
      'Archived from the `backlog` plan by the monthly backlog prune',
      '(`cli/util-tools/backlog-prune.js`; spec: SYSTEM.md "Monthly backlog prune").',
      'Items are verbatim as they left the backlog, each keeping its own `src:`',
      'reference. Pending work never lives here — `ws plan get backlog`.',
    ];
    for (const s of sections) parts.push('', ...s.lines);
    if (items.length) {
      parts.push('', ITEMS_HEADING, '');
      for (const [ix, it] of items.entries()) {
        if (ix) parts.push('');
        parts.push(...it.lines);
      }
    }
    return { body: parts.join('\n') + '\n', changed: true, appended: units.length };
  }

  let lines = existing.split(/\r?\n/);
  const present = () => new Set(lines.map((l) => l.trim()));
  let appended = 0;
  /** Append a block at the end of `heading`'s region (creating the heading last). @param {string} heading @param {string[]} block */
  const insertUnder = (heading, block) => {
    let hi = lines.findIndex((l) => l.trim() === heading);
    if (hi === -1) {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      lines.push('', heading);
      hi = lines.length - 1;
    }
    let end = hi + 1;
    while (end < lines.length && !HEADING_RE.test(lines[end])) end++;
    let ins = end;
    while (ins > hi + 1 && !lines[ins - 1].trim()) ins--;
    lines.splice(ins, 0, '', ...block);
    appended++;
  };
  for (const s of sections) {
    const have = present();
    const missing = s.blocks.filter((b) => !have.has(b.first));
    if (!missing.length && s.blocks.length) continue;
    if (!s.blocks.length && s.heading && !have.has(s.heading)) {
      // A section with no items (unusual) still lands whole so nothing is lost.
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      lines.push('', ...s.lines);
      appended++;
      continue;
    }
    for (const b of missing) insertUnder(/** @type {string} */ (s.heading), b.lines);
  }
  for (const it of items) {
    const have = present();
    for (const b of it.blocks) {
      if (have.has(b.first)) continue;
      insertUnder(ITEMS_HEADING, b.lines);
    }
  }
  if (!appended) return { body: existing, changed: false, appended: 0 };
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '').concat('\n');
  return { body, changed: true, appended };
}

/** @typedef {{get: typeof api.planGet, set: typeof api.planSet}} PlanDeps */
/** @typedef {{id: number, role: string, message_id: number, message: {date?: string|null}}} ThreadEntryLike */
/** @typedef {{get: (docKind: string, docRef: string) => Promise<{entries: ThreadEntryLike[]}>, move: (id: number, anchor: {docKind: string, docRef: string}) => Promise<unknown>}} ThreadDeps */
/** @typedef {{id: number, messageId: number, role: string, date: string, month: string}} ThreadMove */
/** @typedef {{moves: ThreadMove[], kept: Array<{id: number, month: string}>, left: Array<{id: number, reason: string}>}} ThreadCarry */
/** @typedef {{ok: boolean, applied: boolean, plan: PrunePlan|null, threads: ThreadCarry|null, months: string[], summary: string}} PruneResult */

/**
 * Pure judgement over the backlog's thread entries: which move to which
 * month's history plan (by the MESSAGE's calendar date — never the entry's
 * `created`), which stay (current month), which are left with a reason
 * (no parseable date, future date). Never mutates anything.
 * @param {ThreadEntryLike[]} entries
 * @param {string} month the run month YYYY-MM — only STRICTLY EARLIER months move
 * @returns {ThreadCarry}
 */
export function planThreadCarry(entries, month) {
  /** @type {ThreadCarry} */
  const carry = { moves: [], kept: [], left: [] };
  for (const e of entries) {
    // A `trigger` entry is the document's ORIGIN — "this document exists because
    // of this exchange" — and stays with the living backlog forever, whatever
    // month its message carries. Without this, the July-dated conversation that
    // CREATED the backlog would be carried off to backlog-history on the first
    // prune after it was linked (live case: conv 10, linked 2026-08-02).
    if (e.role === 'trigger') {
      carry.left.push({ id: e.id, reason: 'trigger entry — the document\'s origin stays with it' });
      continue;
    }
    const d = typeof e.message?.date === 'string' ? e.message.date : '';
    const m = /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 7) : null;
    if (!m) {
      carry.left.push({ id: e.id, reason: `message ${e.message_id} has no parseable date — left in place` });
    } else if (m < month) {
      carry.moves.push({ id: e.id, messageId: e.message_id, role: e.role, date: d, month: m });
    } else if (m === month) {
      carry.kept.push({ id: e.id, month: m });
    } else {
      carry.left.push({ id: e.id, reason: `message ${e.message_id} dated ${d}, in the future — left in place` });
    }
  }
  return carry;
}

/**
 * The whole prune: read → judge (items AND thread entries) → (write history,
 * verify, move thread entries, trim backlog).
 * Never throws — every failure is an `{ok: false}` result with the reason, and
 * a failure before the backlog write changes NOTHING lossy (a thread re-anchor
 * is never lossy: the entry always lives somewhere, and reruns finish the job).
 * @param {{plans?: PlanDeps, threads?: ThreadDeps, dryRun?: boolean, month?: string}} [opts]
 * @returns {Promise<PruneResult>}
 */
export async function pruneBacklog({ plans, threads, dryRun = false, month } = {}) {
  const p = plans || { get: api.planGet, set: api.planSet };
  const t = threads || { get: api.threadGet, move: api.threadMove };
  const runMonth = month || currentMonth();
  /** @type {string} */
  let raw;
  try {
    raw = await p.get(BACKLOG_SLUG);
  } catch (e) {
    return { ok: false, applied: false, plan: null, threads: null, months: [], summary: `skipped (backlog read failed: ${msg(e)})` };
  }
  const plan = planPrune(stripPlanHeader(raw), runMonth);
  /** @type {ThreadCarry} */
  let carry;
  try {
    carry = planThreadCarry((await t.get('plan', BACKLOG_SLUG)).entries, runMonth);
  } catch (e) {
    return { ok: false, applied: false, plan, threads: null, months: [], summary: `skipped (backlog thread read failed: ${msg(e)}) — nothing moved` };
  }
  const months = [...new Set([...plan.moves.map((u) => u.month), ...carry.moves.map((m) => m.month)])].sort();
  const counts = () => {
    const s = plan.moves.filter((u) => u.kind === 'section').length;
    const it = plan.moves.length - s;
    return `${s} section(s) + ${it} item(s) + ${carry.moves.length} thread entr${carry.moves.length === 1 ? 'y' : 'ies'} → ${months.map(historySlug).join(', ')}; ` +
      `kept ${plan.keptCurrent.length} current-month resolved + ${carry.kept.length} current-month thread entr${carry.kept.length === 1 ? 'y' : 'ies'}; ` +
      `left ${plan.ambiguous.length} ambiguous + ${carry.left.length} undatable in place`;
  };
  if (!plan.moves.length && !carry.moves.length) {
    return { ok: true, applied: false, plan, threads: carry, months, summary: `nothing to prune (${plan.ambiguous.length} ambiguous + ${carry.left.length} undatable left in place, ${plan.keptCurrent.length} current-month resolved + ${carry.kept.length} current-month thread entries kept)` };
  }
  if (dryRun) {
    return { ok: true, applied: false, plan, threads: carry, months, summary: `would move ${counts()}` };
  }
  // History first, one month at a time, each verified by read-back BEFORE the
  // backlog loses anything: the data exists in two places or one, never zero.
  // Thread entries move only AFTER their month's history plan is verified, so
  // an entry can never point at a plan that does not exist.
  for (const mo of months) {
    const slug = historySlug(mo);
    const units = plan.moves.filter((u) => u.month === mo);
    /** @type {string|null} */
    let existing = null;
    try {
      existing = stripPlanHeader(await p.get(slug));
    } catch (e) {
      if (!/not found/i.test(msg(e))) {
        return { ok: false, applied: false, plan, threads: carry, months, summary: `history read failed for ${slug} (${msg(e)}) — backlog unchanged` };
      }
    }
    const merged = mergeHistory(existing, units, mo);
    if (merged.changed) {
      try {
        await p.set(slug, { title: `Backlog history — ${mo}`, body: merged.body, kind: 'plan', status: 'archived', agent: PRUNE_AGENT });
      } catch (e) {
        return { ok: false, applied: false, plan, threads: carry, months, summary: `history write failed for ${slug} (${msg(e)}) — backlog unchanged` };
      }
    }
    /** @type {string} */
    let back;
    try {
      back = stripPlanHeader(await p.get(slug));
    } catch (e) {
      return { ok: false, applied: false, plan, threads: carry, months, summary: `verification read failed for ${slug} (${msg(e)}) — backlog unchanged` };
    }
    for (const fp of fingerprints(units)) {
      if (!back.includes(fp)) {
        return { ok: false, applied: false, plan, threads: carry, months, summary: `verification failed: ${slug} is missing "${fp.slice(0, 80)}" — backlog unchanged` };
      }
    }
    // History verified — this month's thread entries can now follow their month.
    for (const tm of carry.moves.filter((x) => x.month === mo)) {
      try {
        await t.move(tm.id, { docKind: 'plan', docRef: slug });
      } catch (e) {
        return { ok: false, applied: false, plan, threads: carry, months, summary: `thread re-anchor failed for entry ${tm.id} → ${slug} (${msg(e)}) — nothing lost (already-moved entries stay moved, the backlog is untrimmed); rerun to finish` };
      }
    }
  }
  if (plan.moves.length) {
    try {
      await p.set(BACKLOG_SLUG, { body: plan.newBody, agent: PRUNE_AGENT });
    } catch (e) {
      return { ok: false, applied: false, plan, threads: carry, months, summary: `backlog trim failed AFTER history landed (${msg(e)}) — safe, nothing lost (history holds a copy); rerun to finish` };
    }
  }
  return { ok: true, applied: true, plan, threads: carry, months, summary: `moved ${counts()}` };
}
