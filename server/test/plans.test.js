'use strict';
// TP-plans-db: /plan endpoints (see ws plan get test-plan-plans-db)

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_KEY = 'test-key-plans';
let proc;
let base;
let dbPath;

const api = (p, opts = {}) =>
  fetch(base + p, { ...opts, headers: { 'X-Api-Key': API_KEY, ...(opts.headers || {}) } });
const put = (p, fields) =>
  api(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-plans-test-'));
  dbPath = path.join(dir, 'logs.db');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      LOG_DB_PATH: dbPath,
      LOG_API_PORT: '0',
      LOG_API_HOST: '127.0.0.1',
      LOG_API_KEY: API_KEY,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => reject(new Error('server exited early: ' + code + ' ' + out)));
  });
});

test.after(() => { if (proc) proc.kill(); });

test('TP-plans-db-008: /plan requires X-Api-Key', async () => {
  for (const [p, opts] of [['/plan', {}], ['/plan/x', {}], ['/plan/x', { method: 'PUT' }]]) {
    const res = await fetch(base + p, opts);
    assert.equal(res.status, 401, `${opts.method || 'GET'} ${p}`);
  }
});

test('TP-plans-db-001: PUT creates — 201, re-read row is proof of save, defaults applied', async () => {
  const res = await put('/plan/income-pipeline', {
    title: 'Income pipeline',
    body: '# Income pipeline\n\nresearch, scoring, validation.',
    agent: 'coo',
  });
  assert.equal(res.status, 201);
  const { ok, plan, line } = await res.json();
  assert.equal(ok, true);
  assert.equal(plan.slug, 'income-pipeline');
  assert.equal(plan.title, 'Income pipeline');
  assert.equal(plan.status, 'active'); // schema default
  assert.equal(plan.repo, null);
  assert.equal(plan.updated_by, 'coo');
  assert.equal(plan.created_at, plan.updated_at);
  assert.equal(plan.kind, 'plan'); // schema default (audit-approved kind column)
  assert.match(line, /^income-pipeline \| plan \| active \| \d{4}-\d{2}-\d{2} \| Income pipeline$/);
});

test('TP-plans-db-002: PUT create with missing title or body is a 400', async () => {
  let res = await put('/plan/new-one', { body: 'body only' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'missing field: title');
  res = await put('/plan/new-one', { title: 'title only' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'missing field: body');
  // nothing was created
  assert.equal((await api('/plan/new-one')).status, 404);
});

test('TP-plans-db-003: update with a subset — 200, previous body snapshotted, updated_at bumped', async () => {
  const before = (await (await api('/plan/income-pipeline?format=json')).json()).plan;
  await new Promise((r) => setTimeout(r, 5)); // updated_at must move
  const res = await put('/plan/income-pipeline', { body: 'v2 body', agent: 'implementer' });
  assert.equal(res.status, 200);
  const { plan } = await res.json();
  assert.equal(plan.body, 'v2 body');
  assert.equal(plan.title, 'Income pipeline'); // untouched fields keep values
  assert.equal(plan.status, 'active');
  assert.equal(plan.created_at, before.created_at);
  assert.ok(plan.updated_at > before.updated_at);
  assert.equal(plan.updated_by, 'implementer');

  // Snapshot holds the body as it was BEFORE the update.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const revs = db.prepare(
    'SELECT r.* FROM plan_revision r JOIN plan p ON p.id = r.plan_id WHERE p.slug = ? ORDER BY r.id'
  ).all('income-pipeline');
  db.close();
  assert.equal(revs.length, 1);
  assert.equal(revs[0].body, before.body);
  assert.equal(revs[0].updated_by, 'coo');
});

test('TP-plans-db-004: status-only update also snapshots; body intact; empty update is 400', async () => {
  const res = await put('/plan/income-pipeline', { status: 'done' });
  assert.equal(res.status, 200);
  const { plan } = await res.json();
  assert.equal(plan.status, 'done');
  assert.equal(plan.body, 'v2 body');

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const { n } = db.prepare(
    'SELECT COUNT(*) AS n FROM plan_revision r JOIN plan p ON p.id = r.plan_id WHERE p.slug = ?'
  ).get('income-pipeline');
  db.close();
  assert.equal(n, 2);

  assert.equal((await put('/plan/income-pipeline', {})).status, 400);
});

test('TP-plans-db-009: title-only update (retitle) — body + created_at preserved, updated_at bumped, revision snapshotted', async () => {
  // The page-comment/inbox "rename this doc's title to X" flow lands here:
  // the picking-up agent runs `ws plan set <slug> --title "<new>"` (no body),
  // which PUTs only { title }. Content must survive untouched.
  const before = (await (await api('/plan/income-pipeline?format=json')).json()).plan;
  const revsBefore = (await (await api('/plan/income-pipeline/revisions?format=json')).json()).count;
  await new Promise((r) => setTimeout(r, 5)); // updated_at must move
  const res = await put('/plan/income-pipeline', { title: 'Income pipeline (renamed)', agent: 'orchestrator' });
  assert.equal(res.status, 200);
  const { plan } = await res.json();
  assert.equal(plan.title, 'Income pipeline (renamed)'); // title changed
  assert.equal(plan.body, before.body); // content NOT clobbered
  assert.equal(plan.created_at, before.created_at); // created-date NOT wiped
  assert.ok(plan.updated_at > before.updated_at); // updated-date bumped
  assert.equal(plan.status, before.status); // other fields untouched
  assert.equal(plan.kind, before.kind);
  assert.equal(plan.updated_by, 'orchestrator');

  // A revision was created holding the body as it was before the retitle.
  const revsAfter = (await (await api('/plan/income-pipeline/revisions?format=json')).json());
  assert.equal(revsAfter.count, revsBefore + 1);
  assert.equal(revsAfter.revisions[0].body, before.body);
});

test('TP-plans-db-005: GET /plan — index lines, ?status= filter, json elides bodies', async () => {
  await put('/plan/mobile-nexus', { title: 'Mobile nexus', body: 'nexus body', repo: 'ho-nexus' });
  let text = await (await api('/plan')).text();
  assert.match(text, /income-pipeline \| plan \| done \| \d{4}-\d{2}-\d{2} \| Income pipeline/);
  assert.match(text, /mobile-nexus \| plan \| active \| \d{4}-\d{2}-\d{2} \| Mobile nexus/);

  text = await (await api('/plan?status=active')).text();
  assert.match(text, /mobile-nexus/);
  assert.doesNotMatch(text, /income-pipeline/);

  const json = await (await api('/plan?format=json')).json();
  assert.equal(json.ok, true);
  assert.equal(json.count, 2);
  const mn = json.plans.find((p) => p.slug === 'mobile-nexus');
  assert.equal(mn.body, undefined);
  assert.equal(mn.body_length, 'nexus body'.length);
  assert.equal(mn.repo, 'ho-nexus');
});

test('TP-plans-db-006: GET /plan/:slug — text with index-line header, json full row, 404 unknown', async () => {
  const text = await (await api('/plan/mobile-nexus')).text();
  assert.match(text, /^# mobile-nexus \| plan \| active \| \d{4}-\d{2}-\d{2} \| Mobile nexus\n\nnexus body\n$/);

  const json = await (await api('/plan/mobile-nexus?format=json')).json();
  assert.equal(json.ok, true);
  assert.equal(json.plan.body, 'nexus body');

  assert.equal((await api('/plan/nope')).status, 404);
  assert.equal((await api('/plan/nope?format=json')).status, 404);
});

test('TP-plans-db-007: regression — /schema lists plan and plan_revision', async () => {
  const schema = await (await api('/schema')).text();
  assert.match(schema, /-- plan: \d+ rows/);
  assert.match(schema, /-- plan_revision: \d+ rows/);
});

// TP-logs-retirement: the extra plan kinds (test-plan/doc, plus `baseline`
// from backlog 59 - the regression-baseline carrier) + the ?kind= filter
test('TP-logs-retirement-001 / TP-baseline-022 / TP-histret2-003: test-plan/doc/baseline are accepted kinds; a bogus kind is still a 400', async () => {
  for (const kind of ['test-plan', 'doc', 'baseline']) {
    const res = await put(`/plan/k-${kind}`, { title: `T ${kind}`, body: `body ${kind}`, kind, agent: 'test' });
    assert.equal(res.status, 201, kind);
    assert.equal((await res.json()).plan.kind, kind);
  }
  const bad = await put('/plan/k-bogus', { title: 'x', body: 'y', kind: 'nope' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /invalid kind: nope \(expected plan\|audit\|design\|test-plan\|doc\|baseline\)/);
  assert.equal((await api('/plan/k-bogus')).status, 404); // nothing written
});

test('TP-histret2-001 / TP-histret2-002: history is an INVALID kind — rejected like any bogus kind, on create and update, nothing written', async () => {
  // Create: same 400 shape as `nope` above, and no row lands.
  const create = await put('/plan/k-history', { title: 'T history', body: 'body history', kind: 'history' });
  assert.equal(create.status, 400);
  assert.match((await create.json()).error, /invalid kind: history \(expected plan\|audit\|design\|test-plan\|doc\|baseline\)/);
  assert.equal((await api('/plan/k-history')).status, 404); // nothing written

  // Update: an existing row cannot be re-kinded to history either.
  const upd = await put('/plan/k-doc', { kind: 'history' });
  assert.equal(upd.status, 400);
  assert.match((await upd.json()).error, /invalid kind: history/);
  const row = await (await api('/plan/k-doc?format=json')).json();
  assert.equal(row.plan.kind, 'doc'); // kind and body untouched
  assert.equal(row.plan.body, 'body doc');
});

test('TP-logs-retirement-002 / TP-histret2-004: GET /plan?kind= filters the index by kind', async () => {
  const text = await (await api('/plan?kind=doc')).text();
  assert.match(text, /k-doc \| doc \| active \|/);
  assert.doesNotMatch(text, /k-test-plan/);
  assert.doesNotMatch(text, /k-baseline/);
  // kind + status combine
  const both = await (await api('/plan?kind=test-plan&status=active')).text();
  assert.match(both, /k-test-plan \| test-plan \| active \|/);
});

// TP-plan-exclude: the default-view filter — hide done+archived in one query
test('TP-plan-exclude-001: GET /plan?exclude= hides those statuses (NOT IN); omitting returns all', async () => {
  // Seed a done and an archived plan alongside the active ones already present.
  await put('/plan/exc-done', { title: 'Excluded done', body: 'b', status: 'done' });
  await put('/plan/exc-archived', { title: 'Excluded archived', body: 'b', status: 'archived' });
  await put('/plan/exc-active', { title: 'Kept active', body: 'b', status: 'active' });

  const all = await (await api('/plan')).text();
  assert.match(all, /exc-done \| plan \| done \|/);
  assert.match(all, /exc-archived \| plan \| archived \|/);

  const def = await (await api('/plan?exclude=done,archived')).text();
  assert.doesNotMatch(def, /exc-done/);
  assert.doesNotMatch(def, /exc-archived/);
  assert.match(def, /exc-active \| plan \| active \|/);

  // JSON count reflects the exclusion too.
  const json = await (await api('/plan?exclude=done,archived&format=json')).json();
  assert.ok(!json.plans.some((p) => ['done', 'archived'].includes(p.status)));
});

test('TP-plan-exclude-002: ?exclude= composes with ?kind= (AND); ?status= equality still works unchanged', async () => {
  await put('/plan/exc-doc-done', { title: 'doc done', body: 'b', kind: 'doc', status: 'done' });
  await put('/plan/exc-doc-active', { title: 'doc active', body: 'b', kind: 'doc', status: 'active' });

  const combined = await (await api('/plan?kind=doc&exclude=done,archived')).text();
  assert.match(combined, /exc-doc-active \| doc \| active \|/);
  assert.doesNotMatch(combined, /exc-doc-done/);

  // existing single-value ?status= equality filter is untouched
  const doneOnly = await (await api('/plan?status=done')).text();
  assert.match(doneOnly, /exc-done \| plan \| done \|/);
  assert.doesNotMatch(doneOnly, /exc-active/);
});

// TP-plan-integrity: the write path strips the header its own read path renders
// (`ws plan get test-plan-plan-write-integrity`). Read-modify-write used to bake
// the `# slug | kind | status | date | title` banner into the body and the next
// read rendered another on top — five plans were corrupted that way on 2026-08-01.
const planBody = async (slug) => (await api(`/plan/${slug}?format=json`)).json().then((j) => j.plan.body);

test('TP-plan-integrity-001: PUT strips a body that carries this plan\'s own rendered banner; GET renders exactly one', async () => {
  await put('/plan/hdr-one', { title: 'Header one', body: '# Real Heading\n\nreal body' });
  const rendered = await (await api('/plan/hdr-one')).text();
  assert.match(rendered, /^# hdr-one \| plan \| active \| \d{4}-\d{2}-\d{2} \| Header one\n\n/);

  await put('/plan/hdr-one', { body: rendered });
  assert.equal(await planBody('hdr-one'), '# Real Heading\n\nreal body');
  const again = await (await api('/plan/hdr-one')).text();
  assert.equal((again.match(/^# hdr-one \|/gm) || []).length, 1);
});

test('TP-plan-integrity-002: GET → PUT verbatim → GET is byte-identical — no banner and no trailing-newline accretion', async () => {
  await put('/plan/hdr-round', { title: 'Round trip', body: '# Doc\n\nline one\nline two' });
  let previous = await (await api('/plan/hdr-round')).text();
  for (let i = 0; i < 3; i++) {
    await put('/plan/hdr-round', { body: previous });
    const next = await (await api('/plan/hdr-round')).text();
    assert.equal(next, previous, `cycle ${i + 1} was not byte-identical`);
    previous = next;
  }
  assert.equal(await planBody('hdr-round'), '# Doc\n\nline one\nline two');
});

test('TP-plan-integrity-003: an already-stacked body is fully healed by its next write', async () => {
  await put('/plan/hdr-stacked', { title: 'Stacked', body: 'seed' });
  const stacked = '# hdr-stacked | plan | active | 2026-07-30 | Stacked\n\n'
    + '# hdr-stacked | plan | active | 2026-07-31 | Stacked\n\n'
    + '# hdr-stacked | plan | active | 2026-08-01 | Stacked\n\n'
    + '# Real Heading\n\nbody\n\n\n';
  await put('/plan/hdr-stacked', { body: stacked });
  assert.equal(await planBody('hdr-stacked'), '# Real Heading\n\nbody');
});

test('TP-plan-integrity-004: a legitimate H1 containing a pipe is never eaten', async () => {
  const body = '# Something | something else\n\nthe pipe is part of the title';
  await put('/plan/hdr-lookalike', { title: 'Look-alike', body });
  assert.equal(await planBody('hdr-lookalike'), body);
});

test('TP-plan-integrity-005: a banner naming another slug, an invalid kind, or a non-ISO date is left alone', async () => {
  const cases = {
    'hdr-otherslug': '# some-other-plan | plan | active | 2026-08-01 | Title\n\nbody',
    'hdr-badkind': '# hdr-badkind | notakind | active | 2026-08-01 | Title\n\nbody',
    'hdr-baddate': '# hdr-baddate | plan | active | yesterday | Title\n\nbody',
  };
  for (const [slug, body] of Object.entries(cases)) {
    await put(`/plan/${slug}`, { title: 'Precision', body });
    assert.equal(await planBody(slug), body, slug);
  }
});

test('TP-plan-integrity-006: the create path strips too — a new plan cannot be born with a banner', async () => {
  const res = await put('/plan/hdr-created', {
    title: 'Created clean',
    body: '# hdr-created | test-plan | active | 2026-08-01 | Created clean\n\n# Real Heading\n\nbody\n',
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).plan.body, '# Real Heading\n\nbody');
});

test('TP-plan-integrity-007: a body with no banner is stored byte-for-byte, trailing whitespace and all', async () => {
  const body = 'plain body\n\n\n';
  await put('/plan/hdr-untouched', { title: 'Untouched', body });
  assert.equal(await planBody('hdr-untouched'), body);
});

test('TP-plan-integrity-009: a banner-shaped line further down the body is never touched', async () => {
  const body = '# Doc\n\nexample of what a read returns:\n\n'
    + '```\n# hdr-inline | plan | active | 2026-08-01 | Doc\n```\n';
  await put('/plan/hdr-inline', { title: 'Doc', body });
  assert.equal(await planBody('hdr-inline'), body);
});

