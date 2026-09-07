// TP-backlog-prune: monthly backlog prune — moves whole `## Resolved (date)`
// sections and marker-dated inline items from a month earlier than the current
// one into `backlog-history-YYYY-MM` (kind plan, archived), history written
// and VERIFIED before the backlog is trimmed; anything ambiguous stays with a
// reason (see ws plan get test-plan-backlog-prune). All plan-API traffic is
// faked — no network, no real writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKLOG_SLUG,
  ITEMS_HEADING,
  currentMonth,
  historySlug,
  mergeHistory,
  planPrune,
  planThreadCarry,
  pruneBacklog,
  PRUNE_AGENT,
} from '../util/backlogprune.js';
import { today } from '../util/clock.js';

/** The run month every fixture is judged against. */
const MONTH = '2026-08';

/** A synthetic backlog exercising every shape the real one contains. */
const FIXTURE = [
  '# Backlog — improvement ideas (living)',
  '',
  'Intro prose that must survive untouched.',
  '',
  '## Awaiting the CEO',
  '',
  '41. **Skills gates** — pending decision. src: `ws plan get x`. (2026-07-26)',
  '- **RESOLVED 2026-07-26 — thing one merged** — evidence and detail. src: a.',
  '- **CLOSED 2026-07-28 — thing two registered.** More detail. src: b.',
  '59. **RESOLVED 2026-08-01 (was: divergence)** — fixed. Delete this line once reviewed.',
  '54. **RESOLVED — verified already shipped 2026-07-30 (was: w1w2)** — no leading date.',
  '47. **Azure cost review** — R4 DECLINED by CEO 2026-07-26 — decisions remain. src: y.',
  '',
  '## Engineering',
  '',
  '4. **Stale-status sweep** — still pending. src: legacy audit.',
  '48. **SHIPPED 2026-06-30 (was: june thing)** — a june item,',
  '    with a continuation line that must move with it.',
  '',
  '## Resolved (2026-07-29)',
  '',
  '- **Station registry SHIPPED (was item 55)** — merged 2026-07-29. src: s.',
  '',
  '## Resolved (2026-08-01)',
  '',
  '- current-month resolved section item — stays a month.',
  '',
  '## Resolved',
  '',
  '- item under a dateless Resolved heading — must stay.',
].join('\n');

/**
 * In-memory plan store. `get` renders the API banner (so strip-on-read is
 * always exercised, TP-backlog-prune-016); `set` records calls in order.
 * @param {{bodies?: Record<string, string>, failSetFor?: string[], liar?: boolean}} [opts]
 */
function fakePlans({ bodies = {}, failSetFor = [], liar = false } = {}) {
  /** @type {Array<{slug: string, [k: string]: unknown}>} */
  const sets = [];
  return {
    sets,
    bodies,
    /** @param {string} slug */
    get: async (slug) => {
      if (!(slug in bodies)) throw new Error(`plan not found: ${slug}`);
      return `# ${slug} | plan | active | 2026-08-01 | Title\n\n${bodies[slug]}`;
    },
    /** @param {string} slug @param {{title?: string, body?: string, kind?: string, status?: string, repo?: string, agent?: string}} [fields] */
    set: async (slug, fields = {}) => {
      if (failSetFor.includes(slug)) throw new Error('API returned not-ok');
      sets.push({ slug, ...fields });
      if (!liar && fields.body !== undefined) bodies[slug] = fields.body;
      return { line: '', created: true };
    },
  };
}

/** Fresh fixture store with the backlog seeded. */
const seeded = () => fakePlans({ bodies: { [BACKLOG_SLUG]: FIXTURE } });

/**
 * In-memory thread store for the carry half (TP-btc cases): `get` lists the
 * entries under an anchor, `move` re-anchors in place and records the call.
 * @param {{entries?: Array<{id: number, doc_kind: string, doc_ref: string, role: string, message_id: number, message: {date?: string|null}}>, failMoveFor?: number[], failGet?: boolean}} [opts]
 */
function fakeThreads({ entries = [], failMoveFor = [], failGet = false } = {}) {
  /** @type {Array<{id: number, docKind: string, docRef: string}>} */
  const moved = [];
  return {
    moved,
    entries,
    /** @param {string} docKind @param {string} docRef */
    get: async (docKind, docRef) => {
      if (failGet) throw new Error('thread API down');
      return { entries: entries.filter((e) => e.doc_kind === docKind && e.doc_ref === docRef) };
    },
    /** @param {number} id @param {{docKind: string, docRef: string}} anchor */
    move: async (id, { docKind, docRef }) => {
      if (failMoveFor.includes(id)) throw new Error('API returned not-ok');
      const e = entries.find((x) => x.id === id);
      if (!e) throw new Error(`thread entry not found: ${id}`);
      e.doc_kind = docKind;
      e.doc_ref = docRef;
      moved.push({ id, docKind, docRef });
      return { entry: e, moved: true };
    },
  };
}

/** The live-case shape: entries backfilled in August carrying July messages. */
const threadSeed = () => [
  { id: 3, doc_kind: 'plan', doc_ref: BACKLOG_SLUG, role: 'ceo', message_id: 89, message: { date: '2026-07-29' } },
  { id: 4, doc_kind: 'plan', doc_ref: BACKLOG_SLUG, role: 'agent', message_id: 90, message: { date: '2026-07-29' } },
  { id: 5, doc_kind: 'plan', doc_ref: BACKLOG_SLUG, role: 'ceo', message_id: 95, message: { date: '2026-08-01' } },
];

test('TP-backlog-prune-001: an earlier-month Resolved section moves whole, bucketed by its own date', () => {
  const { moves } = planPrune(FIXTURE, MONTH);
  const s = moves.find((u) => u.kind === 'section' && u.heading === '## Resolved (2026-07-29)');
  assert.ok(s, 'the July section is selected');
  assert.equal(s.month, '2026-07');
  assert.ok(s.lines.join('\n').includes('Station registry SHIPPED'));
});

test('TP-backlog-prune-002: a current-month Resolved section stays', () => {
  const { moves, keptCurrent, newBody } = planPrune(FIXTURE, MONTH);
  assert.ok(!moves.some((u) => u.heading === '## Resolved (2026-08-01)'));
  assert.ok(keptCurrent.some((k) => k.label.includes('(2026-08-01)')));
  assert.ok(newBody.includes('current-month resolved section item'));
});

test('TP-backlog-prune-003: an inline RESOLVED item with an earlier-month date moves, bucketed by its own month', () => {
  const { moves, newBody } = planPrune(FIXTURE, MONTH);
  const it = moves.find((u) => u.kind === 'item' && u.label.includes('RESOLVED 2026-07-26'));
  assert.ok(it, 'the July inline item is selected');
  assert.equal(it.month, '2026-07');
  assert.ok(!newBody.includes('thing one merged'));
});

test('TP-backlog-prune-004: CLOSED/SHIPPED/DECIDED with a date are recognized; lowercase or unknown words are not', () => {
  const { moves } = planPrune(FIXTURE, MONTH);
  assert.ok(moves.some((u) => u.label.includes('CLOSED 2026-07-28')));
  assert.ok(moves.some((u) => u.label.includes('SHIPPED 2026-06-30')));
  const lower = planPrune('- resolved 2026-07-01 lowercase marker.\n- **DONE 2026-07-01** unknown word.\n', MONTH);
  assert.equal(lower.moves.length, 0);
  assert.equal(lower.ambiguous.length, 0);
});

test('TP-backlog-prune-005: a marker word without an ISO date at the item start stays, reported ambiguous', () => {
  const { moves, ambiguous, newBody } = planPrune(FIXTURE, MONTH);
  assert.ok(!moves.some((u) => u.label.includes('verified already shipped')));
  const a = ambiguous.find((x) => x.label.includes('verified already shipped'));
  assert.ok(a, 'item 54 is reported ambiguous');
  assert.match(a.reason, /marker word/);
  assert.ok(newBody.includes('verified already shipped'));
});

test('TP-backlog-prune-006: a marker word mid-text is a pending item — untouched and not flagged', () => {
  const { moves, ambiguous, newBody } = planPrune(FIXTURE, MONTH);
  assert.ok(!moves.some((u) => u.label.includes('Azure cost review')));
  assert.ok(!ambiguous.some((a) => a.label.includes('Azure cost review')));
  assert.ok(newBody.includes('R4 DECLINED by CEO 2026-07-26'));
});

test('TP-backlog-prune-007: a current-month inline resolved item stays, reported kept-for-now', () => {
  const { moves, keptCurrent, newBody } = planPrune(FIXTURE, MONTH);
  assert.ok(!moves.some((u) => u.label.includes('RESOLVED 2026-08-01')));
  assert.ok(keptCurrent.some((k) => k.label.includes('RESOLVED 2026-08-01')));
  assert.ok(newBody.includes('RESOLVED 2026-08-01 (was: divergence)'));
});

test('TP-backlog-prune-008: every line outside a moved unit survives verbatim — pending items can never be lost', () => {
  const { moves, newBody } = planPrune(FIXTURE, MONTH);
  const movedLines = new Set(moves.flatMap((u) => u.lines).map((l) => l.trim()).filter(Boolean));
  const kept = new Set(newBody.split('\n').map((l) => l.trim()));
  for (const line of FIXTURE.split('\n')) {
    const t = line.trim();
    if (!t || movedLines.has(t)) continue;
    assert.ok(kept.has(t), `kept verbatim: ${t.slice(0, 60)}`);
  }
});

test('TP-backlog-prune-009: units from several months land in one history plan per month', async () => {
  const plans = seeded();
  const res = await pruneBacklog({ plans, threads: fakeThreads(), month: MONTH });
  assert.equal(res.ok, true);
  assert.deepEqual(res.months, ['2026-06', '2026-07']);
  assert.ok(plans.bodies[historySlug('2026-06')].includes('SHIPPED 2026-06-30'));
  assert.ok(plans.bodies[historySlug('2026-07')].includes('## Resolved (2026-07-29)'));
  assert.ok(!plans.bodies[historySlug('2026-06')].includes('2026-07-29'));
});

test('TP-backlog-prune-010: a new history plan is created kind=plan status=archived with the month title', async () => {
  // Kind `plan`, never `history`: archived is a STATUS, not a kind (the CEO,
  // 2026-08-02 — ws plan get test-plan-history-kind-retirement, TP-histmig-020).
  const plans = seeded();
  await pruneBacklog({ plans, threads: fakeThreads(), month: MONTH });
  const w = plans.sets.find((s) => s.slug === historySlug('2026-07'));
  assert.ok(w, 'history write happened');
  assert.equal(w.kind, 'plan');
  assert.equal(w.status, 'archived');
  assert.equal(w.title, 'Backlog history — 2026-07');
  assert.equal(w.agent, PRUNE_AGENT);
});

test('TP-backlog-prune-011: history write failure → backlog untouched, loud not-ok result', async () => {
  const plans = fakePlans({ bodies: { [BACKLOG_SLUG]: FIXTURE }, failSetFor: [historySlug('2026-06')] });
  const res = await pruneBacklog({ plans, threads: fakeThreads(), month: MONTH });
  assert.equal(res.ok, false);
  assert.match(res.summary, /backlog unchanged/);
  assert.ok(!plans.sets.some((s) => s.slug === BACKLOG_SLUG), 'backlog never written');
  assert.equal(plans.bodies[BACKLOG_SLUG], FIXTURE);
});

test('TP-backlog-prune-012: a write the read-back cannot verify → backlog untouched', async () => {
  const plans = fakePlans({ bodies: { [BACKLOG_SLUG]: FIXTURE }, liar: true });
  // liar: set claims success but stores nothing, so verification must catch it.
  plans.bodies[historySlug('2026-06')] = '# Backlog history — 2026-06\n\nempty\n';
  plans.bodies[historySlug('2026-07')] = '# Backlog history — 2026-07\n\nempty\n';
  const res = await pruneBacklog({ plans, threads: fakeThreads(), month: MONTH });
  assert.equal(res.ok, false);
  assert.match(res.summary, /verification failed/);
  assert.ok(!plans.sets.some((s) => s.slug === BACKLOG_SLUG));
});

test('TP-backlog-prune-013: rerun after a successful apply performs zero writes', async () => {
  const plans = seeded();
  const first = await pruneBacklog({ plans, threads: fakeThreads(), month: MONTH });
  assert.equal(first.applied, true);
  const before = plans.sets.length;
  const second = await pruneBacklog({ plans, threads: fakeThreads(), month: MONTH });
  assert.equal(second.ok, true);
  assert.equal(second.applied, false);
  assert.equal(plans.sets.length, before, 'no further set calls');
  assert.match(second.summary, /nothing to prune/);
});

test('TP-backlog-prune-014: units already in history (failed prior run) are not duplicated; the trim still completes', async () => {
  const primed = seeded();
  const probe = await pruneBacklog({ plans: primed, threads: fakeThreads(), month: MONTH });
  assert.equal(probe.applied, true);
  // Seed both history plans with the exact bodies a prior run landed, keep the
  // backlog untrimmed — the recovery shape.
  const done = /** @type {Record<string, string>} */ (
    { [historySlug('2026-06')]: primed.bodies[historySlug('2026-06')], [historySlug('2026-07')]: primed.bodies[historySlug('2026-07')] }
  );
  const recovery = fakePlans({ bodies: { [BACKLOG_SLUG]: FIXTURE, ...done } });
  const res = await pruneBacklog({ plans: recovery, threads: fakeThreads(), month: MONTH });
  assert.equal(res.ok, true);
  assert.equal(res.applied, true);
  const historyWrites = recovery.sets.filter((s) => s.slug !== BACKLOG_SLUG);
  assert.equal(historyWrites.length, 0, 'nothing appended twice');
  const july = recovery.bodies[historySlug('2026-07')];
  assert.equal(july.split('Station registry SHIPPED').length, 2, 'unit appears exactly once');
  assert.ok(!recovery.bodies[BACKLOG_SLUG].includes('Station registry SHIPPED'), 'backlog trimmed');
});

test('TP-backlog-prune-015: merging appends into an existing history plan without clobbering its content', () => {
  const existing = [
    '# Backlog history — 2026-07',
    '',
    'Hand-written preamble that must survive.',
    '',
    '## Resolved (2026-07-29)',
    '',
    '- an item archived earlier. src: q.',
  ].join('\n');
  const { moves } = planPrune(FIXTURE, MONTH);
  const july = moves.filter((u) => u.month === '2026-07');
  const merged = mergeHistory(existing, july, '2026-07');
  assert.equal(merged.changed, true);
  assert.ok(merged.body.includes('Hand-written preamble that must survive.'));
  assert.ok(merged.body.includes('- an item archived earlier. src: q.'));
  assert.ok(merged.body.includes('Station registry SHIPPED'));
  assert.equal(merged.body.split('## Resolved (2026-07-29)').length, 2, 'heading not duplicated');
  assert.ok(merged.body.includes(ITEMS_HEADING), 'inline items get their section');
});

test('TP-backlog-prune-016: the rendered plan banner is stripped on read and never written into any body', async () => {
  const plans = seeded(); // fake get always renders the banner
  await pruneBacklog({ plans, threads: fakeThreads(), month: MONTH });
  for (const s of plans.sets) {
    assert.ok(!/^#\s+\S+\s+\|/m.test(String(s.body)), `no banner in write to ${s.slug}`);
  }
});

test('TP-backlog-prune-017: dry run reports the full judgement and performs zero writes', async () => {
  const plans = seeded();
  const res = await pruneBacklog({ plans, threads: fakeThreads(), dryRun: true, month: MONTH });
  assert.equal(res.ok, true);
  assert.equal(res.applied, false);
  assert.ok(res.plan && res.plan.moves.length > 0);
  assert.equal(plans.sets.length, 0);
  assert.equal(plans.bodies[BACKLOG_SLUG], FIXTURE);
});

test('TP-backlog-prune-018: the trimmed backlog has no 3+ blank-line runs and ends with a single newline', () => {
  const { newBody } = planPrune(`${FIXTURE}\n\n\n\n\n`, MONTH);
  assert.ok(!/\n{3,}/.test(newBody));
  assert.match(newBody, /[^\n]\n$/);
});

test('TP-backlog-prune-019: a Resolved heading without a parseable date stays, reported ambiguous', () => {
  const { moves, ambiguous, newBody } = planPrune(FIXTURE, MONTH);
  assert.ok(!moves.some((u) => u.heading === '## Resolved'));
  assert.ok(ambiguous.some((a) => a.label === '## Resolved' && /date/.test(a.reason)));
  assert.ok(newBody.includes('item under a dateless Resolved heading'));
});

test('TP-backlog-prune-020: a multi-line item block moves whole, never split', () => {
  const { moves, newBody } = planPrune(FIXTURE, MONTH);
  const it = moves.find((u) => u.label.includes('SHIPPED 2026-06-30'));
  assert.ok(it);
  assert.equal(it.lines.length, 2);
  assert.ok(it.lines[1].includes('continuation line'));
  assert.ok(!newBody.includes('continuation line'));
});

test('TP-backlog-prune-021: the default current month derives from clock.today() (schedule timezone)', () => {
  assert.equal(currentMonth(), today().slice(0, 7));
});

test('TP-backlog-prune-022: backlog read failure → no writes, skipped summary', async () => {
  const plans = fakePlans({ bodies: {} });
  const res = await pruneBacklog({ plans, threads: fakeThreads(), month: MONTH });
  assert.equal(res.ok, false);
  assert.match(res.summary, /skipped \(backlog read failed/);
  assert.equal(plans.sets.length, 0);
});

test('TP-backlog-prune-023: a future-dated Resolved section stays, reported ambiguous', () => {
  const body = '## Resolved (2026-09-15)\n\n- item from the future.\n';
  const { moves, ambiguous, newBody } = planPrune(body, MONTH);
  assert.equal(moves.length, 0);
  assert.ok(ambiguous.some((a) => /future/.test(a.reason)));
  assert.ok(newBody.includes('item from the future'));
});

// Thread entries follow their month (the CEO's rule, 2026-08-02) — test plan:
// ws plan get test-plan-backlog-thread-carry. A backlog with ONLY pending
// items, so the carry is judged on its own (the live shape after a prune).
const PENDING_ONLY = '# Backlog\n\n1. **Still pending** — src: x.\n';

test('TP-btc-010: earlier-month MESSAGE dates re-anchor to that month history plan, never the entry created date', async () => {
  const plans = seeded();
  const threads = fakeThreads({ entries: threadSeed() });
  const res = await pruneBacklog({ plans, threads, month: MONTH });
  assert.equal(res.ok, true);
  assert.equal(res.applied, true);
  // Entries 3 + 4 (messages dated 2026-07-29, backfilled in August) moved to July.
  assert.deepEqual(threads.moved.map((m) => m.id).sort(), [3, 4]);
  for (const m of threads.moved) {
    assert.deepEqual({ docKind: m.docKind, docRef: m.docRef }, { docKind: 'plan', docRef: historySlug('2026-07') });
  }
  const e3 = threads.entries.find((e) => e.id === 3);
  assert.equal(e3 && e3.doc_ref, historySlug('2026-07'));
});

test('TP-btc-011: current-month message entries stay on the backlog', async () => {
  const threads = fakeThreads({ entries: threadSeed() });
  const res = await pruneBacklog({ plans: seeded(), threads, month: MONTH });
  assert.equal(res.ok, true);
  assert.ok(!threads.moved.some((m) => m.id === 5));
  const e5 = threads.entries.find((e) => e.id === 5);
  assert.equal(e5 && e5.doc_ref, BACKLOG_SLUG);
  assert.ok(res.threads && res.threads.kept.some((k) => k.id === 5));
});

test('TP-btc-012: a thread-only month creates its history plan first; a failed ensure moves nothing', async () => {
  // June entry, no June items: the history plan must be created (kind plan,
  // status archived — TP-histmig-020) and verified before the entry moves.
  const june = [{ id: 9, doc_kind: 'plan', doc_ref: BACKLOG_SLUG, role: 'ceo', message_id: 70, message: { date: '2026-06-15' } }];
  const plans = fakePlans({ bodies: { [BACKLOG_SLUG]: PENDING_ONLY } });
  const threads = fakeThreads({ entries: june.map((e) => ({ ...e })) });
  const res = await pruneBacklog({ plans, threads, month: MONTH });
  assert.equal(res.ok, true);
  const w = plans.sets.find((s) => s.slug === historySlug('2026-06'));
  assert.ok(w, 'history plan created for the thread-only month');
  assert.equal(w.kind, 'plan');
  assert.equal(w.status, 'archived');
  assert.deepEqual(threads.moved.map((m) => m.id), [9]);

  const failing = fakePlans({ bodies: { [BACKLOG_SLUG]: PENDING_ONLY }, failSetFor: [historySlug('2026-06')] });
  const threads2 = fakeThreads({ entries: june.map((e) => ({ ...e })) });
  const res2 = await pruneBacklog({ plans: failing, threads: threads2, month: MONTH });
  assert.equal(res2.ok, false);
  assert.equal(threads2.moved.length, 0, 'no entry moves when its history plan cannot land');
});

test('TP-btc-013: dry-run reports the carry judgement and performs zero moves and zero writes', async () => {
  const plans = seeded();
  const threads = fakeThreads({ entries: threadSeed() });
  const res = await pruneBacklog({ plans, threads, dryRun: true, month: MONTH });
  assert.equal(res.ok, true);
  assert.equal(res.applied, false);
  assert.ok(res.threads && res.threads.moves.length === 2);
  assert.equal(threads.moved.length, 0);
  assert.equal(plans.sets.length, 0);
});

test('TP-btc-014: a message without a parseable date leaves its entry in place, with a reason', async () => {
  const entries = [{ id: 7, doc_kind: 'plan', doc_ref: BACKLOG_SLUG, role: 'ceo', message_id: 80, message: {} }];
  const threads = fakeThreads({ entries });
  const res = await pruneBacklog({ plans: fakePlans({ bodies: { [BACKLOG_SLUG]: PENDING_ONLY } }), threads, month: MONTH });
  assert.equal(res.ok, true);
  assert.equal(res.applied, false, 'nothing movable at all');
  assert.equal(threads.moved.length, 0);
  assert.ok(res.threads && res.threads.left.some((l) => l.id === 7 && /no parseable date/.test(l.reason)));
});

test('TP-btc-015: the carry runs even when the item prune finds nothing to move (items already archived)', async () => {
  const plans = fakePlans({ bodies: { [BACKLOG_SLUG]: PENDING_ONLY } });
  const threads = fakeThreads({ entries: threadSeed() });
  const res = await pruneBacklog({ plans, threads, month: MONTH });
  assert.equal(res.ok, true);
  assert.equal(res.applied, true);
  assert.deepEqual(threads.moved.map((m) => m.id).sort(), [3, 4]);
  assert.ok(!plans.sets.some((s) => s.slug === BACKLOG_SLUG), 'no backlog trim when no item moved');
});

test('TP-btc-016: a failed move is loud with a rerun-to-finish summary; the rerun moves only what is left', async () => {
  const entries = threadSeed();
  const failing = fakeThreads({ entries, failMoveFor: [4] });
  const res = await pruneBacklog({ plans: seeded(), threads: failing, month: MONTH });
  assert.equal(res.ok, false);
  assert.match(res.summary, /thread re-anchor failed for entry 4/);
  assert.match(res.summary, /rerun to finish/);
  // Rerun over the same store, failure cleared: only the stranded entry moves.
  const retry = fakeThreads({ entries });
  const res2 = await pruneBacklog({ plans: seeded(), threads: retry, month: MONTH });
  assert.equal(res2.ok, true);
  assert.deepEqual(retry.moved.map((m) => m.id), [4], 'entry 3 already moved — not selected again');
});

test('TP-btc-017: thread listing failure → not-ok before any write, items included', async () => {
  const plans = seeded();
  const res = await pruneBacklog({ plans, threads: fakeThreads({ failGet: true }), month: MONTH });
  assert.equal(res.ok, false);
  assert.match(res.summary, /backlog thread read failed/);
  assert.equal(plans.sets.length, 0, 'judgement precedes every write');
});

test('TP-btc-018: with no thread entries the item prune behaves exactly as before', async () => {
  const plans = seeded();
  const res = await pruneBacklog({ plans, threads: fakeThreads(), month: MONTH });
  assert.equal(res.ok, true);
  assert.equal(res.applied, true);
  assert.deepEqual(res.months, ['2026-06', '2026-07']);
  assert.match(res.summary, /0 thread entries/);
});

test('TP-btc-019: planThreadCarry is pure judgement — future dates left with a reason, nothing mutated', () => {
  const entries = [
    { id: 1, role: 'ceo', message_id: 10, message: { date: '2026-09-09' } },
    { id: 2, role: 'agent', message_id: 11, message: { date: '2026-07-01' } },
  ];
  const carry = planThreadCarry(entries, MONTH);
  assert.deepEqual(carry.moves.map((m) => m.id), [2]);
  assert.equal(carry.moves[0].month, '2026-07');
  assert.ok(carry.left.some((l) => l.id === 1 && /future/.test(l.reason)));
});

test('TP-backlog-prune-100: a trigger entry NEVER moves to history — the document\'s origin stays with it', () => {
  // Live case 2026-08-02: the July-dated conversation that CREATED the backlog
  // (conv 10) was linked as a role-trigger entry; without this rule the first
  // prune after linking would carry the backlog\u2019s origin off to
  // backlog-history-2026-07 by its message month.
  const entries = [
    { id: 1, role: 'trigger', message_id: 10, message: { date: '2026-07-20' } },
    { id: 2, role: 'ceo',     message_id: 11, message: { date: '2026-07-20' } },
  ];
  const c = planThreadCarry(entries, '2026-08');
  assert.deepEqual(c.moves.map((m) => m.id), [2], 'only the ceo entry moves');
  assert.equal(c.left.length, 1);
  assert.equal(c.left[0].id, 1);
  assert.match(c.left[0].reason, /origin stays/);
});
