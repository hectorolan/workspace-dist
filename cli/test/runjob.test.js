// TP-runjob: the digest runner's audit + delivery decision logic — the pure
// functions behind every 2026-07-20 incident (UTC-date catch-up, two compliance
// false positives). No I/O, no network: silent and CI-safe by construction.
// TP-runjob-gen (plan ws plan get test-plan-run-job-generalization):
// per-job config resolution from jobs.json runJob blocks + catch-up windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  slug, classifyEmailCaptures, deliveryAction,
  fill, cronWindow, resolveJobSpec, catchUpDue,
  composeTools, composeGuardrail, violatingAreas,
  extractTitle, resolveReportTitle,
} from '../util/runjob.js';

const REF = `2026-07-20-${slug('Daily Digest — 2026-07-20')}`;

test('TP-runjob-001: untagged capture for the ref is an agent violation', () => {
  const r = classifyEmailCaptures(
    [{ ref: REF, meta: JSON.stringify({ to: 'hector@example.com' }) }],
    REF,
  );
  assert.deepEqual(r, { agentEmailed: true, runnerEmailed: false });
});

test('TP-runjob-002: runner-tagged capture is a delivery record, not a violation', () => {
  const r = classifyEmailCaptures(
    [{ ref: REF, meta: JSON.stringify({ to: 'hector@example.com', sender: 'runner' }) }],
    REF,
  );
  assert.deepEqual(r, { agentEmailed: false, runnerEmailed: true });
});

test('TP-runjob-003: captures for other refs are ignored (no cross-day/cross-subject bleed)', () => {
  const r = classifyEmailCaptures(
    [
      { ref: '2026-07-19-Daily-Digest-2026-07-19', meta: '{}' },
      { ref: `${REF}-regenerated`, meta: '{}' },
    ],
    REF,
  );
  assert.deepEqual(r, { agentEmailed: false, runnerEmailed: false });
});

test('TP-runjob-004: unparseable or missing meta counts as untagged (agent)', () => {
  for (const meta of ['not json', '', undefined]) {
    const r = classifyEmailCaptures([{ ref: REF, meta }], REF);
    assert.equal(r.agentEmailed, true, `meta=${JSON.stringify(meta)}`);
  }
});

test('TP-runjob-005: mixed captures set both flags (violation still wins delivery)', () => {
  const r = classifyEmailCaptures(
    [
      { ref: REF, meta: JSON.stringify({ sender: 'runner' }) },
      { ref: REF, meta: '{}' },
    ],
    REF,
  );
  assert.deepEqual(r, { agentEmailed: true, runnerEmailed: true });
  assert.equal(deliveryAction(r), 'skip-agent-violation');
});

test('TP-runjob-010: delivery decision table', () => {
  assert.equal(deliveryAction({ agentEmailed: false, runnerEmailed: false }), 'send');
  assert.equal(deliveryAction({ agentEmailed: false, runnerEmailed: true }), 'skip-already-delivered');
  assert.equal(deliveryAction({ agentEmailed: true, runnerEmailed: false }), 'skip-agent-violation');
});

test('TP-runjob-011: slug matches the apiclient email-out derivation for digest subjects', () => {
  assert.equal(slug('Daily Digest — 2026-07-20'), 'Daily-Digest-2026-07-20');
  assert.equal(slug('Daily Digest — 2026-07-20 (regenerated)'), 'Daily-Digest-2026-07-20-regenerated');
});

// --- TP-runjob-gen: per-job config resolution + catch-up windows ---------------

const SHIPPED = JSON.parse(readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'configs', 'jobs', 'jobs.json'),
  'utf8',
));

test('TP-runjob-gen-001: fill replaces known placeholders and leaves unknown ones intact', () => {
  assert.equal(fill('a/{date}/b-{output}', { date: '2026-07-21', output: 'x.md' }), 'a/2026-07-21/b-x.md');
  assert.equal(fill('keep {unknown} as-is on {date}', { date: '2026-07-21' }), 'keep {unknown} as-is on 2026-07-21');
});

test('TP-runjob-gen-002: cronWindow parses fixed hour/dow; wildcards are open; dow 7 is Sunday', () => {
  assert.deepEqual(cronWindow('0 7 * * *'), { hour: 7, dow: null });
  assert.deepEqual(cronWindow('0 4 * * 1'), { hour: 4, dow: 1 });
  assert.deepEqual(cronWindow('3-59/15 * * * *'), { hour: null, dow: null });
  assert.deepEqual(cronWindow('0 12 * * 7'), { hour: 12, dow: 0 });
  assert.deepEqual(cronWindow(''), { hour: null, dow: null });
});

test('TP-runjob-gen-003 / TP-logs-retirement-005: shipped digest spec — data-dir output', () => {
  const spec = resolveJobSpec(SHIPPED, 'daily-digest', { date: '2026-07-20', dataDir: '/data' });
  assert.ok(spec, 'daily-digest must have a runJob block');
  assert.equal(spec.outputRel, 'job-out/2026-07-20.md', 'output is a data-dir path, not logs/');
  assert.equal(spec.output, '/data/job-out/2026-07-20.md', 'prompt gets the absolute data-dir path');
  assert.equal(spec.subject, 'Daily Digest — 2026-07-20');
  assert.equal(spec.delivery, 'email');
  // Contract, not prose: jobs.json wording changes with the product (c717ede broke
  // the old full-string equal) — pin the placeholder fills and the standing rules.
  assert.match(spec.prompt, /^Use the newsroom subagent to produce today's daily digest per the daily-digest skill/);
  assert.ok(spec.prompt.includes('Write it to /data/job-out/2026-07-20.md'), '{output} placeholder must resolve to the absolute data-dir path');
  assert.ok(spec.prompt.includes('ws plan set digest-rolling-summary'), 'rolling summary stays a DB plan update');
  assert.deepEqual(spec.agentAuditAreas, ['digest']);
  assert.ok(!spec.prompt.includes('rolling-summary.md'), 'rolling summary is a DB plan now, not a file');
  assert.equal(spec.schedHour, 7);
  assert.equal(spec.schedDow, null);
});

// TP-runjob-gen-004 (pinned the weekly COO job's shipped spec) was retired with
// that job (CEO ruling 2026-08-28, `ws plan get pipeline-automation-retirement`).

test('TP-runjob-gen-005: unknown job or missing runJob block resolves to null', () => {
  assert.equal(resolveJobSpec(SHIPPED, 'no-such-job', { date: '2026-07-21' }), null);
  assert.equal(resolveJobSpec(SHIPPED, 'workspace-pull', { date: '2026-07-21' }), null);
  assert.equal(resolveJobSpec(null, 'daily-digest', { date: '2026-07-21' }), null);
});

test('TP-runjob-gen-006: tag is appended to the subject (JOB_TAG semantics)', () => {
  const spec = resolveJobSpec(SHIPPED, 'daily-digest', { date: '2026-07-20', tag: ' (regenerated)' });
  assert.ok(spec);
  assert.equal(spec.subject, 'Daily Digest — 2026-07-20 (regenerated)');
});

test('TP-runjob-gen-007: defaults — delivery none, subject template, audit areas', () => {
  const cfg = { jobs: [{ name: 'j', cron: '0 5 * * *', runJob: { output: 'job-out/{date}-j.md', prompt: 'p {output}' } }] };
  const spec = resolveJobSpec(cfg, 'j', { date: '2026-07-21', dataDir: '/d' });
  assert.ok(spec);
  assert.equal(spec.delivery, 'none');
  assert.equal(spec.subject, 'j — 2026-07-21');
  assert.equal(spec.output, '/d/job-out/2026-07-21-j.md');
  assert.equal(spec.prompt, 'p /d/job-out/2026-07-21-j.md');
  assert.deepEqual(spec.agentAuditAreas, []);
});

test('TP-runjob-gen-008: catch-up never runs when the output exists', () => {
  assert.equal(catchUpDue({ outputExists: true, hour: 23, dow: 1, schedHour: 4, schedDow: 1 }), false);
});

test('TP-runjob-gen-009: weekly catch-up — day and hour gates', () => {
  const base = { outputExists: false, schedHour: 4, schedDow: 1 };
  assert.equal(catchUpDue({ ...base, hour: 12, dow: 2 }), false, 'wrong day');
  assert.equal(catchUpDue({ ...base, hour: 3, dow: 1 }), false, 'right day, before the slot');
  assert.equal(catchUpDue({ ...base, hour: 4, dow: 1 }), true, 'right day, slot passed');
});

test('TP-runjob-gen-010: daily catch-up (open dow) keeps the pre-change digest semantics', () => {
  const base = { outputExists: false, schedHour: 7, schedDow: null };
  assert.equal(catchUpDue({ ...base, hour: 6, dow: 3 }), false);
  assert.equal(catchUpDue({ ...base, hour: 7, dow: 3 }), true);
  assert.equal(catchUpDue({ ...base, hour: 19, dow: 0 }), true);
});

// TP-runjob-tools: the compose-session Bash allowlist (2026-07-26 incident — the
// subagent called the CLI by absolute path and every ws call was denied).

test('TP-runjob-tools-001: both the relative and the absolute CLI form are allowlisted', () => {
  const tools = composeTools('/home/node/sources/workspace');
  assert.ok(tools.includes('Bash(node workspace/cli/ws.js query:*)'), 'relative query form');
  assert.ok(tools.includes('Bash(node /home/node/sources/workspace/cli/ws.js query:*)'), 'absolute query form');
  assert.ok(tools.includes('Bash(node /home/node/sources/workspace/cli/ws.js plan:*)'), 'absolute plan form');
  assert.ok(tools.includes('Bash(node ./workspace/cli/ws.js plan:*)'), 'dot-relative form');
});

test('TP-runjob-tools-002: a Windows workspace path is offered in both separators', () => {
  const tools = composeTools('C:\\Users\\olanh\\sources\\workspace');
  assert.ok(tools.includes('Bash(node C:/Users/olanh/sources/workspace/cli/ws.js query:*)'), 'git-bash form');
});

test('TP-runjob-tools-003: the lockdown holds — no log/sync/email reachable from a compose session', () => {
  const tools = composeTools('/w');
  for (const forbidden of ['ws.js log', 'ws.js sync', 'ws.js email', 'ws.js run-job', 'Bash(git', 'Bash(*)']) {
    assert.ok(!tools.includes(forbidden), `must not allowlist ${forbidden}`);
  }
  // Only query/plan subcommands, printenv, and non-Bash tools are granted.
  for (const rule of tools.split(',').filter((t) => t.startsWith('Bash('))) {
    assert.match(rule, /(ws\.js (query|plan):\*|printenv:\*)\)$/, `unexpected Bash grant: ${rule}`);
  }
});

test('TP-runjob-tools-004: the guardrail names the sanctioned forms and forbids logging', () => {
  const g = composeGuardrail();
  assert.ok(g.includes('node workspace/cli/ws.js query'), 'query form stated');
  assert.ok(g.includes('node workspace/cli/ws.js plan get'), 'plan get form stated');
  assert.match(g, /absolute path/, 'warns off the absolute path that broke 2026-07-26');
  assert.match(g, /Logging, email, git and push/, 'states what the runner owns');
  assert.ok(g.endsWith('\n'), 'prepends cleanly to the job prompt');
});

// TP-runjob-audit: compliance verdict is scoped to THIS run's compose window.

test('TP-runjob-audit-001: a line written during the compose window is a violation', () => {
  const since = '2026-07-26T14:00:00.000Z';
  const entries = [{ area: 'digest', ts: '2026-07-26T14:03:00.000Z', agent: 'newsroom' }];
  assert.deepEqual(violatingAreas(entries, ['digest'], since), ['digest']);
});

test('TP-runjob-audit-002: same-day line from BEFORE the run is not this run (2026-07-26 false positive)', () => {
  // The PC logged `digest` at 01:49; the container's 07:00 run was accused by the
  // old date-only match even though its own session never logged anything.
  const since = '2026-07-26T14:00:00.000Z';
  const entries = [{ area: 'digest', ts: '2026-07-26T08:49:00.000Z', agent: 'newsroom' }];
  assert.deepEqual(violatingAreas(entries, ['digest'], since), []);
});

test('TP-runjob-audit-003: the runner\'s own lines never accuse the agent', () => {
  const since = '2026-07-26T14:00:00.000Z';
  const entries = [{ area: 'digest', ts: '2026-07-26T14:05:00.000Z', agent: 'runner' }];
  assert.deepEqual(violatingAreas(entries, ['digest'], since), []);
});

test('TP-runjob-audit-004: unrelated areas and malformed rows are ignored', () => {
  const since = '2026-07-26T14:00:00.000Z';
  const entries = [
    { area: 'coo-review', ts: '2026-07-26T14:05:00.000Z', agent: 'coo' },
    { area: 'digest', agent: 'newsroom' }, // no ts (pre-migration row)
  ];
  assert.deepEqual(violatingAreas(entries, ['digest'], since), []);
  assert.deepEqual(violatingAreas(entries, ['coo-review', 'digest'], since), ['coo-review']);
});

// --- TP-report-titles: composed report titles lifted into the subject (backlog 72,
// plan ws plan get test-plan-report-titles). The compose output's first line may
// carry a `Title: <headline>` marker; the runner lifts it into the stored-message
// and email subject and strips it from the delivered body. A missing/degenerate
// marker ALWAYS falls back to the base subject — never a blank.

test('TP-report-titles-001: Title marker on the first line is lifted and stripped from the body', () => {
  const r = extractTitle('Title: Quiet markets, loud agents\n\n# Daily Digest\n\nbody\n');
  assert.equal(r.title, 'Quiet markets, loud agents');
  assert.equal(r.body, '# Daily Digest\n\nbody\n');
});

test('TP-report-titles-002: marker tolerance — leading blanks, CRLF, bold and heading variants', () => {
  assert.equal(extractTitle('\n\nTitle: After the blanks\nbody').title, 'After the blanks');
  assert.equal(extractTitle('Title: CRLF headline\r\n\r\nbody\r\n').title, 'CRLF headline');
  assert.equal(extractTitle('**Title:** Bold marker\n\nbody').title, 'Bold marker');
  assert.equal(extractTitle('# Title: Heading marker\n\nbody').title, 'Heading marker');
});

test('TP-report-titles-003: no marker (older archive shape) — null title, body untouched', () => {
  const content = '# Daily Digest — 2026-07-20\n\nbody as before\n';
  const r = extractTitle(content);
  assert.equal(r.title, null);
  assert.equal(r.body, content);
});

test('TP-report-titles-004: degenerate marker (empty or emphasis-only) is treated as missing', () => {
  for (const content of ['Title:\n\nbody\n', 'Title:   \nbody\n', 'Title: ***\nbody\n']) {
    const r = extractTitle(content);
    assert.equal(r.title, null, JSON.stringify(content));
    assert.equal(r.body, content);
  }
});

test('TP-report-titles-005: overlong headline is truncated to 120 chars', () => {
  const long = 'x'.repeat(200);
  const r = extractTitle(`Title: ${long}\nbody`);
  assert.equal(r.title?.length, 120);
  assert.ok(r.title?.endsWith('…'));
});

test('TP-report-titles-006: subject composition — titled, fallback, and JOB_TAG base forms', () => {
  const titled = resolveReportTitle({
    subject: 'Daily Digest — 2026-08-02',
    content: 'Title: Quiet markets, loud agents\n\nbody',
    output: '/data/job-out/2026-08-02.md',
  });
  assert.equal(titled.subject, 'Daily Digest — 2026-08-02: Quiet markets, loud agents');
  const fallback = resolveReportTitle({
    subject: 'Weekly Report — 2026-08-03',
    content: '# summary\n\nno marker',
    output: '/data/job-out/2026-08-03-report.md',
  });
  assert.equal(fallback.subject, 'Weekly Report — 2026-08-03'); // never blank
  const tagged = resolveReportTitle({
    subject: 'Daily Digest — 2026-08-02 [manual]',
    content: 'Title: Tagged run\nbody',
    output: '/data/job-out/2026-08-02.md',
  });
  assert.equal(tagged.subject, 'Daily Digest — 2026-08-02 [manual]: Tagged run');
});

test('TP-report-titles-007: a Title line deeper in the file is prose, not a marker', () => {
  const content = '# Daily Digest\n\nTitle: this is body text\n';
  const r = extractTitle(content);
  assert.equal(r.title, null);
  assert.equal(r.body, content);
});

test('TP-report-titles-008: delivery wiring — deliver path, stripped body, and a retry-stable dedupe ref', () => {
  const p = { subject: 'Daily Digest — 2026-08-02', content: 'Title: Quiet markets, loud agents\n\nbody\n', output: '/data/job-out/2026-08-02.md' };
  const titled = resolveReportTitle(p);
  assert.equal(titled.deliverPath, '/data/job-out/2026-08-02.body.md');
  assert.equal(titled.body, 'body\n');
  // A delivery-only retry re-reads the same archived file: identical subject →
  // identical email-out ref → the runner-tagged capture dedupes the resend.
  const retry = resolveReportTitle(p);
  assert.equal(slug(retry.subject), slug(titled.subject));
  // Untitled output delivers the original file, unmodified.
  const plain = resolveReportTitle({ subject: 'Weekly Report — 2026-08-03', content: 'no marker\n', output: '/data/job-out/2026-08-03-report.md' });
  assert.equal(plain.deliverPath, '/data/job-out/2026-08-03-report.md');
  assert.equal(plain.body, 'no marker\n');
  assert.equal(plain.title, null);
});
