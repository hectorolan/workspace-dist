// Control-plane check group (test plans `ws plan get test-plan-env-doctor-control-plane`
// and `ws plan get test-plan-cp-env-per-service`): read-only SSH probes of the
// VM host state git cannot see — deploy crontab line, hub prod compose
// wiring, and per-service env health (every service under ~/agent judged against
// ITS OWN repo's `.env.example`, three states per capability) — with the two hard
// rules pinned here: no secret VALUE ever rides the wire/results, and unreachable
// is INFO, not FAIL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REMOTE_SCRIPT,
  parseEnvExample,
  envSatisfied,
  envGroupState,
  parseReport,
  controlPlaneResults,
  shouldRefresh,
  collectControlPlane,
  localExampleResolver,
} from '../util/controlplane.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Marked-up workspace-style example (the comment convention in use). */
const WS_EXAMPLE = [
  '# comment',
  '# env-doctor: required — Agent sessions (Claude auth)',
  'CLAUDE_CODE_OAUTH_TOKEN=',
  '#ANTHROPIC_API_KEY=',
  '# env-doctor: required — GitHub sync, PRs & deploys',
  'GITHUB_TOKEN=',
  '',
  '# env-doctor: required — Owner & agent mail identity',
  'OWNER_EMAIL=you@example.com',
  '# env-doctor: required — Station identity',
  'WS_ENV=azure-vm',
  '  # indented comment',
  '# env-doctor: required — Central log API auth',
  'LOG_API_KEY=',
  '',
  '# env-doctor: optional — Schedule timezone',
  '# env-doctor-off: defaults apply',
  'TZ=America/Los_Angeles',
].join('\n');

/** Unlabelled hub-style example (what the degrade rules must handle TODAY). */
const HN_EXAMPLE = [
  '# hub environment variables — names only.',
  '',
  '# Google OAuth web client.',
  'GOOGLE_OAUTH_CLIENT_ID=',
  'GOOGLE_OAUTH_CLIENT_SECRET=',
  '',
  '# Public base URL.',
  'BASE_URL=http://localhost:8080',
  '',
  '# Workspace log API. Leave LOG_API_URL empty to disable those sections.',
  'LOG_API_URL=',
  'LOG_API_KEY=',
  '',
  'SESSION_SECRET=',
  '',
  '# DEV/TEST ONLY — auth bypass. Default: off.',
  'AUTH_BYPASS=false',
  'AUTH_BYPASS_EMAIL=owner@example.com',
].join('\n');

/** @type {(svc: string) => {text: string, source: string}|null} */
const EXAMPLES = (svc) => {
  if (svc === 'workspace') return { text: WS_EXAMPLE, source: 'workspace/.env.example' };
  if (svc === 'hub' || svc === 'hub-staging') return { text: HN_EXAMPLE, source: 'hub/.env.example' };
  return null;
};

/** A healthy multi-service remote report, with banner noise a real sshd might prepend. */
const HEALTHY = [
  'Welcome to Ubuntu 24.04 LTS',
  'WSCP cron=1',
  'WSCP compose=present',
  'WSCP clone=present',
  'WSCP service=workspace',
  'WSCP envloc=top',
  'WSCP envfile=present',
  'WSCP envname=CLAUDE_CODE_OAUTH_TOKEN',
  'WSCP envname=GITHUB_TOKEN',
  'WSCP envname=OWNER_EMAIL',
  'WSCP envname=WS_ENV',
  'WSCP envname=LOG_API_KEY',
  'WSCP envname=TZ',
  'WSCP service=hub',
  'WSCP envloc=repo',
  'WSCP envfile=present',
  'WSCP envname=GOOGLE_OAUTH_CLIENT_ID',
  'WSCP envname=GOOGLE_OAUTH_CLIENT_SECRET',
  'WSCP envname=BASE_URL',
  'WSCP envname=LOG_API_URL',
  'WSCP envname=LOG_API_KEY',
  'WSCP envname=SESSION_SECRET',
  'WSCP envname=AUTH_BYPASS',
  'WSCP envname=AUTH_BYPASS_EMAIL',
  'WSCP done',
].join('\n');

const CTX = { sshTarget: 'x@y', probedAt: '2026-08-01 10:00:00' };

// --- parsing the repo-declared desired state (.env.example) --------------------

test('TP-envdoctor-cp-001 parseEnvExample takes uncommented KEY= lines only', () => {
  const names = parseEnvExample(WS_EXAMPLE).flatMap((g) => g.vars.map((v) => v.name));
  assert.deepEqual(names, ['CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'OWNER_EMAIL', 'WS_ENV', 'LOG_API_KEY', 'TZ']);
  assert.ok(!names.includes('ANTHROPIC_API_KEY'), 'commented alternate stays out');
});

test('TP-envdoctor-cp-001b the real .env.example yields the known required set — and no GOOGLE vars', () => {
  const groups = parseEnvExample(readFileSync(path.join(ROOT, '.env.example'), 'utf8'));
  const required = groups.flatMap((g) => g.vars.filter((v) => v.required).map((v) => v.name));
  for (const must of ['GITHUB_TOKEN', 'OWNER_EMAIL', 'AGENT_EMAIL', 'WS_ENV', 'LOG_API_KEY']) {
    assert.ok(required.includes(must), `${must} expected required in .env.example`);
  }
  const all = groups.flatMap((g) => g.vars.map((v) => v.name));
  assert.ok(!all.includes('ANTHROPIC_API_KEY'), 'commented alternate stays out of the base set');
  // TP-cpsvc-011 (bug pin, workspace half): Google OAuth creds are hub's — the
  // workspace example must not declare them, so workspace health is judged without them.
  assert.ok(!all.includes('GOOGLE_OAUTH_CLIENT_ID'), 'GOOGLE_OAUTH_CLIENT_ID must not be a workspace var');
  assert.ok(!all.includes('GOOGLE_OAUTH_CLIENT_SECRET'), 'GOOGLE_OAUTH_CLIENT_SECRET must not be a workspace var');
  assert.ok(groups.every((g) => g.label), 'every workspace group carries an explicit capability label');
});

test('TP-cpsvc-001 grouping: blank lines and markers split, interleaved comments do not', () => {
  const groups = parseEnvExample(WS_EXAMPLE);
  assert.deepEqual(groups.map((g) => g.vars.map((v) => v.name)), [
    ['CLAUDE_CODE_OAUTH_TOKEN'],
    ['GITHUB_TOKEN'], // marker mid-block starts a new group
    ['OWNER_EMAIL'],
    ['WS_ENV'],
    ['LOG_API_KEY'], // comment between vars did not split OWNER/WS_ENV groups (markers did)
    ['TZ'],
  ]);
  const noMarkerSplit = parseEnvExample('A=\n# plain comment\nB=');
  assert.deepEqual(noMarkerSplit.map((g) => g.vars.map((v) => v.name)), [['A', 'B']], 'a plain comment does not split a group');
});

test('TP-cpsvc-002 marker grammar: leading required/optional word, separators stripped, label optional', () => {
  const [g1] = parseEnvExample('# env-doctor: optional — Digests, Conversations & Plans\nLOG_API_URL=');
  assert.equal(g1.marker, 'optional');
  assert.equal(g1.label, 'Digests, Conversations & Plans');
  const [g2] = parseEnvExample('# env-doctor: Google sign-in\nGOOGLE_OAUTH_CLIENT_ID=');
  assert.equal(g2.marker, null, 'label-only marker leaves marker unset (empty value ⇒ required by degrade)');
  assert.equal(g2.label, 'Google sign-in');
  assert.equal(g2.vars[0].required, true);
  const [g3] = parseEnvExample('# env-doctor: OPTIONAL\nAUTH_BYPASS=');
  assert.equal(g3.marker, 'optional');
  assert.equal(g3.label, null, 'no label ⇒ null (callers fall back to var names)');
  assert.equal(g3.vars[0].required, false, 'marker wins over the empty-value degrade');
});

test('TP-cpsvc-003 unmarked degrade: empty value ⇒ required, documented default ⇒ optional', () => {
  const groups = parseEnvExample(HN_EXAMPLE);
  /** @type {Record<string, boolean>} */
  const req = Object.fromEntries(groups.flatMap((g) => g.vars.map((v) => [v.name, v.required])));
  assert.equal(req.GOOGLE_OAUTH_CLIENT_ID, true);
  assert.equal(req.GOOGLE_OAUTH_CLIENT_SECRET, true);
  assert.equal(req.SESSION_SECRET, true);
  assert.equal(req.BASE_URL, false, 'a shipped default is the file\'s own optionality signal');
  assert.equal(req.AUTH_BYPASS, false);
  assert.equal(req.AUTH_BYPASS_EMAIL, false);
  const labelless = groups.find((g) => g.vars.some((v) => v.name === 'GOOGLE_OAUTH_CLIENT_ID'));
  assert.equal(labelless?.label, null, 'unlabelled group label is null — result rows fall back to var names');
});

test('TP-cpsvc-004 env-doctor-off note attaches to its group', () => {
  const groups = parseEnvExample(WS_EXAMPLE);
  const tz = groups.find((g) => g.vars.some((v) => v.name === 'TZ'));
  assert.equal(tz?.offNote, 'defaults apply');
  assert.equal(tz?.marker, 'optional');
  // note may also follow the vars inside the block
  const [g] = parseEnvExample('# env-doctor: optional — X\nA=\n# env-doctor-off: feature dark\nB=');
  assert.equal(g.offNote, 'feature dark');
  assert.deepEqual(g.vars.map((v) => v.name), ['A', 'B']);
});

test('TP-envdoctor-cp-002 either-of pair: ANTHROPIC_API_KEY satisfies CLAUDE_CODE_OAUTH_TOKEN', () => {
  assert.equal(envSatisfied('CLAUDE_CODE_OAUTH_TOKEN', ['ANTHROPIC_API_KEY', 'WS_ENV']), true);
  assert.equal(envSatisfied('CLAUDE_CODE_OAUTH_TOKEN', ['WS_ENV']), false);
  assert.equal(envSatisfied('WS_ENV', ['WS_ENV']), true);
});

// --- parsing the remote report ------------------------------------------------

test('TP-envdoctor-cp-003 parseReport reads only WSCP lines and finds the sentinel', () => {
  const r = parseReport(HEALTHY);
  assert.equal(r.done, true);
  assert.equal(r.cron, 1);
  assert.equal(r.compose, true);
  assert.equal(r.clone, true);
  assert.equal(r.services.length, 2);
});

test('TP-cpsvc-005 parseReport attributes env facts to the service line above them', () => {
  const r = parseReport(HEALTHY);
  const [ws, hn] = r.services;
  assert.equal(ws.name, 'workspace');
  assert.equal(ws.envloc, 'top');
  assert.equal(ws.envfile, true);
  assert.deepEqual(ws.envNames.slice(0, 2), ['CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN']);
  assert.equal(hn.name, 'hub');
  assert.equal(hn.envloc, 'repo');
  assert.equal(hn.envfile, true);
  assert.ok(hn.envNames.includes('GOOGLE_OAUTH_CLIENT_ID'));
  assert.ok(!ws.envNames.includes('GOOGLE_OAUTH_CLIENT_ID'), 'names never bleed across services');
});

test('TP-envdoctor-cp-003b banner noise and unknown WSCP keys are ignored', () => {
  const r = parseReport('motd junk\nWSCP mystery=42\nWSCP done');
  assert.equal(r.done, true);
  assert.equal(r.cron, null);
  assert.equal(r.compose, null);
  assert.deepEqual(r.services, []);
});

test('TP-envdoctor-cp-004 non-identifier env names are dropped by the parser', () => {
  const r = parseReport('WSCP service=svc\nWSCP envfile=present\nWSCP envname=GOOD_NAME\nWSCP envname=FOO=hunter2\nWSCP envname=has space\nWSCP done');
  assert.deepEqual(r.services[0].envNames, ['GOOD_NAME']);
});

test('TP-cpsvc-006 a bad service name drops its env lines; env lines before any service are dropped', () => {
  const r = parseReport([
    'WSCP envname=ORPHAN_BEFORE_ANY_SERVICE',
    'WSCP service=evil=$(cat /etc/passwd)',
    'WSCP envfile=present',
    'WSCP envname=SMUGGLED',
    'WSCP service=good-svc',
    'WSCP envfile=present',
    'WSCP envname=REAL_NAME',
    'WSCP done',
  ].join('\n'));
  assert.equal(r.services.length, 1);
  assert.equal(r.services[0].name, 'good-svc');
  assert.deepEqual(r.services[0].envNames, ['REAL_NAME']);
});

// --- results ------------------------------------------------------------------

test('TP-envdoctor-cp-005 healthy probe yields OK results each carrying probedAt', () => {
  const results = controlPlaneResults(parseReport(HEALTHY), EXAMPLES, CTX);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId['control-plane'].level, 'INFO');
  assert.match(byId['control-plane'].detail, /x@y/);
  for (const id of ['cp-cron', 'cp-compose', 'cp-clone', 'cp-env:workspace', 'cp-env:hub']) {
    assert.equal(byId[id].level, 'OK', `${id} should be OK`);
    assert.equal(byId[id].data?.probedAt, CTX.probedAt);
  }
});

test('TP-cpsvc-008 one row per capability regardless of state, under a per-service summary', () => {
  const results = controlPlaneResults(parseReport(HEALTHY), EXAMPLES, CTX);
  const hnRows = results.filter((r) => r.id.startsWith('cp-env:hub:'));
  assert.equal(hnRows.length, 5, 'a fully healthy service still lists every capability');
  for (const row of hnRows) {
    assert.equal(row.level, 'OK');
    assert.equal(row.data?.state, 'ready');
    assert.equal(row.data?.service, 'hub');
    assert.ok(Array.isArray(row.data?.vars) && /** @type {string[]} */ (row.data?.vars).length >= 1);
  }
  const wsRows = results.filter((r) => r.id.startsWith('cp-env:workspace:'));
  assert.equal(wsRows.length, 6);
  const labelled = wsRows.find((r) => r.id === 'cp-env:workspace:GITHUB_TOKEN');
  assert.match(String(labelled?.name), /GitHub sync, PRs & deploys/, 'capability label from the .env.example rides the row name');
  const unlabelled = hnRows.find((r) => r.id === 'cp-env:hub:GOOGLE_OAUTH_CLIENT_ID');
  assert.match(String(unlabelled?.name), /GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET/, 'no label ⇒ var names');
  const summaryIdx = results.findIndex((r) => r.id === 'cp-env:hub');
  const firstRowIdx = results.findIndex((r) => r.id.startsWith('cp-env:hub:'));
  assert.ok(summaryIdx !== -1 && summaryIdx < firstRowIdx, 'summary headline precedes its capability rows');
  assert.match(results[summaryIdx].detail, /5 ready, 0 off, 0 missing of 5 capabilities/);
});

test('TP-cpsvc-007 three states: ready→OK, off→INFO with the cost note, missing→FAIL naming missing vars only', () => {
  const report = parseReport([
    'WSCP cron=1', 'WSCP compose=present', 'WSCP clone=present',
    'WSCP service=workspace', 'WSCP envloc=top', 'WSCP envfile=present',
    'WSCP envname=CLAUDE_CODE_OAUTH_TOKEN', 'WSCP envname=GITHUB_TOKEN', 'WSCP envname=OWNER_EMAIL',
    'WSCP envname=WS_ENV', 'WSCP envname=LOG_API_KEY', // TZ absent → off
    'WSCP service=hub', 'WSCP envloc=repo', 'WSCP envfile=present',
    'WSCP envname=GOOGLE_OAUTH_CLIENT_ID', // CLIENT_SECRET absent → missing
    'WSCP envname=BASE_URL', 'WSCP envname=LOG_API_URL', 'WSCP envname=LOG_API_KEY',
    'WSCP envname=SESSION_SECRET', // AUTH_BYPASS group absent → off (optional defaults)
    'WSCP done',
  ].join('\n'));
  const results = controlPlaneResults(report, EXAMPLES, CTX);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  const tz = byId['cp-env:workspace:TZ'];
  assert.equal(tz.level, 'INFO');
  assert.equal(tz.data?.state, 'off');
  assert.match(tz.detail, /off — optional not set: TZ — defaults apply/);
  const google = byId['cp-env:hub:GOOGLE_OAUTH_CLIENT_ID'];
  assert.equal(google.level, 'FAIL');
  assert.equal(google.data?.state, 'missing');
  assert.match(google.detail, /GOOGLE_OAUTH_CLIENT_SECRET/);
  assert.ok(!/GOOGLE_OAUTH_CLIENT_ID,? (?:GOOGLE_OAUTH_CLIENT_SECRET )?absent/.test(google.detail), 'present vars are not named missing');
  const bypass = byId['cp-env:hub:AUTH_BYPASS'];
  assert.equal(bypass.level, 'INFO');
  assert.equal(bypass.data?.state, 'off');
  assert.match(bypass.detail, /switched off/);
  assert.equal(byId['cp-env:workspace'].level, 'OK', 'off never dirties the summary');
  assert.match(byId['cp-env:workspace'].detail, /5 ready, 1 off, 0 missing/);
  assert.equal(byId['cp-env:hub'].level, 'FAIL', 'missing does');
  assert.match(byId['cp-env:hub'].detail, /1 missing/);
});

test('TP-envdoctor-cp-006 each broken host fact FAILs with an actionable detail', () => {
  const broken = parseReport(['WSCP cron=0', 'WSCP compose=absent', 'WSCP clone=absent', 'WSCP service=workspace', 'WSCP envfile=absent', 'WSCP done'].join('\n'));
  const byId = Object.fromEntries(controlPlaneResults(broken, EXAMPLES, CTX).map((r) => [r.id, r]));
  assert.equal(byId['cp-cron'].level, 'FAIL');
  assert.match(byId['cp-cron'].detail, /deploy\.sh hub/);
  assert.equal(byId['cp-compose'].level, 'FAIL');
  assert.match(byId['cp-compose'].detail, /docker-compose\.prod\.yml/);
  assert.equal(byId['cp-clone'].level, 'FAIL');
  assert.equal(byId['cp-env:workspace'].level, 'FAIL');
  assert.match(byId['cp-env:workspace'].detail, /\.env/);
});

test('TP-cpsvc-010 a service with no env file: summary FAIL, required capabilities missing, optional off', () => {
  const report = parseReport(['WSCP cron=1', 'WSCP compose=present', 'WSCP clone=present', 'WSCP service=hub', 'WSCP envfile=absent', 'WSCP done'].join('\n'));
  const results = controlPlaneResults(report, EXAMPLES, CTX);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId['cp-env:hub'].level, 'FAIL');
  assert.match(byId['cp-env:hub'].detail, /no \.env for service hub/);
  assert.equal(byId['cp-env:hub:GOOGLE_OAUTH_CLIENT_ID'].level, 'FAIL');
  assert.equal(byId['cp-env:hub:AUTH_BYPASS'].level, 'INFO', 'optional groups read off, not missing, even with no env file');
});

test('TP-envdoctor-cp-007 missing required vars produce a FAIL listing names only', () => {
  const partial = parseReport(['WSCP cron=1', 'WSCP compose=present', 'WSCP clone=present', 'WSCP service=workspace', 'WSCP envloc=top', 'WSCP envfile=present', 'WSCP envname=WS_ENV', 'WSCP done'].join('\n'));
  const results = controlPlaneResults(partial, EXAMPLES, CTX);
  const summary = results.find((r) => r.id === 'cp-env:workspace');
  assert.ok(summary);
  assert.equal(summary.level, 'FAIL');
  const failRows = results.filter((r) => r.id.startsWith('cp-env:workspace:') && r.level === 'FAIL');
  const failText = failRows.map((r) => r.detail).join('\n');
  assert.match(failText, /GITHUB_TOKEN/);
  assert.match(failText, /OWNER_EMAIL/);
  assert.ok(!/WS_ENV[^_]*absent/.test(failText), 'present vars are not reported missing');
});

test('TP-cpsvc-009 a service with no station-side example is one INFO, never FAIL', () => {
  const report = parseReport(['WSCP cron=1', 'WSCP compose=present', 'WSCP clone=present', 'WSCP service=mystery-app', 'WSCP envloc=top', 'WSCP envfile=present', 'WSCP envname=SOME_VAR', 'WSCP done'].join('\n'));
  const results = controlPlaneResults(report, EXAMPLES, CTX);
  const rows = results.filter((r) => r.id.startsWith('cp-env:mystery-app'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 'INFO');
  assert.match(rows[0].detail, /no mystery-app\/\.env\.example/);
});

test('TP-cpsvc-009b localExampleResolver: workspace uses its own file, -staging falls back to the base repo', () => {
  const real = localExampleResolver(ROOT);
  assert.match(String(real('workspace')?.text), /GITHUB_TOKEN=/, 'workspace resolves to the repo\'s own .env.example');
  /** @type {Record<string, string>} */
  const files = {
    [path.join(path.dirname(path.join('/s', 'workspace')), 'hub', '.env.example')]: 'GOOGLE_OAUTH_CLIENT_ID=\n',
  };
  const fake = localExampleResolver(path.join('/s', 'workspace'), (f) => {
    if (files[f] === undefined) throw new Error('ENOENT');
    return files[f];
  });
  assert.equal(fake('hub-staging')?.source, 'hub/.env.example', 'staging resolves through the base repo');
  assert.equal(fake('hub')?.source, 'hub/.env.example');
  assert.equal(fake('unknown-svc'), null);
});

test('TP-cpsvc-011 bug pin: the GOOGLE false FAIL is structurally impossible now', () => {
  // The exact 2026-07-30 report shape: workspace .env WITHOUT google vars, hub
  // .env WITH them. Old code failed workspace for hub's credentials; now
  // workspace judges only its own file and hub reports them ready.
  const results = controlPlaneResults(parseReport(HEALTHY), EXAMPLES, CTX);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId['cp-env:workspace'].level, 'OK');
  assert.ok(!results.some((r) => r.id.startsWith('cp-env:workspace') && /GOOGLE_OAUTH/.test(r.detail)), 'workspace results never mention google vars');
  assert.equal(byId['cp-env:hub:GOOGLE_OAUTH_CLIENT_ID'].data?.state, 'ready');
});

test('TP-envdoctor-cp-010 a value-smuggling report leaves no value fragment in any detail', () => {
  const sneaky = parseReport([
    'WSCP cron=1', 'WSCP compose=present', 'WSCP clone=present',
    'WSCP service=workspace', 'WSCP envloc=top', 'WSCP envfile=present',
    'WSCP envname=FOO=hunter2',
    'WSCP service=pw=hunter2',
    'WSCP done',
  ].join('\n'));
  for (const r of controlPlaneResults(sneaky, EXAMPLES, CTX)) {
    assert.ok(!r.detail.includes('hunter2'), `${r.id} must not carry a value`);
    assert.ok(!r.id.includes('hunter2'), `${r.id} id must not carry a value`);
  }
});

test('TP-envdoctor-cp-010b the remote script only ever prints names, counts and flags', () => {
  // Structural pin: the one place a value could be read prints $1 (the NAME field)
  // and uses $2 only through length(); `cat`/`echo "$(...)"` of the .env never appears.
  assert.match(REMOTE_SCRIPT, /print "WSCP envname=" \$1/);
  assert.ok(!/cat[^\n]*\.env/.test(REMOTE_SCRIPT), 'no raw .env dump');
  assert.ok(!/crontab -l(?![^\n]*(grep|>\s*\/dev\/null))/.test(REMOTE_SCRIPT), 'crontab output is counted, never echoed');
});

test('TP-cpsvc-007b envGroupState: required absent beats optional absent', () => {
  const g = { label: null, marker: null, offNote: null, vars: [{ name: 'A', required: true }, { name: 'B', required: false }] };
  assert.deepEqual(envGroupState(g, ['A', 'B']), { state: 'ready', missing: [], unset: [] });
  assert.deepEqual(envGroupState(g, ['A']), { state: 'off', missing: [], unset: ['B'] });
  assert.deepEqual(envGroupState(g, ['B']), { state: 'missing', missing: ['A'], unset: ['A'] });
  assert.deepEqual(envGroupState(g, []).state, 'missing');
});

// --- gating -------------------------------------------------------------------

test('TP-envdoctor-cp-011 shouldRefresh: same-day cache holds, new day or force probes', () => {
  assert.equal(shouldRefresh({ day: '2026-07-30', results: [] }, '2026-07-30', false), false);
  assert.equal(shouldRefresh({ day: '2026-07-29', results: [] }, '2026-07-30', false), true);
  assert.equal(shouldRefresh({ day: '2026-07-30', results: [] }, '2026-07-30', true), true);
  assert.equal(shouldRefresh(null, '2026-07-30', false), true);
});

test('TP-envdoctor-cp-012 cached path never invokes the ssh runner', async () => {
  let calls = 0;
  const cached = { day: '2026-07-30', results: [{ id: 'control-plane', level: /** @type {const} */ ('INFO'), name: 'control-plane', detail: 'cached' }] };
  const out = await collectControlPlane({
    tunnel: { sshTarget: 'x@y' },
    force: false,
    todayStr: '2026-07-30',
    readCache: () => cached,
    writeCache: () => {},
    runSsh: () => { calls += 1; return { ok: true, out: HEALTHY }; },
    exampleFor: EXAMPLES,
    probedAt: 't',
  });
  assert.equal(calls, 0);
  assert.deepEqual(out, cached.results);
});

test('TP-envdoctor-cp-008 unreachable ssh (or missing sentinel) is a single INFO, never FAIL', async () => {
  for (const bad of [{ ok: false, out: 'Connection timed out' }, { ok: true, out: 'motd only, no sentinel' }]) {
    const out = await collectControlPlane({
      tunnel: { sshTarget: 'x@y' },
      force: true,
      todayStr: '2026-07-30',
      readCache: () => null,
      writeCache: () => {},
      runSsh: () => bad,
      exampleFor: EXAMPLES,
      probedAt: 't',
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'control-plane');
    assert.equal(out[0].level, 'INFO');
    assert.match(out[0].detail, /skipped/i);
  }
});

test('TP-envdoctor-cp-009 a station without an SSH path skips with one kind-aware INFO', async () => {
  const out = await collectControlPlane({
    tunnel: null,
    force: true,
    todayStr: '2026-07-30',
    readCache: () => null,
    writeCache: () => {},
    runSsh: () => { throw new Error('must not be called'); },
    exampleFor: EXAMPLES,
    probedAt: 't',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'INFO');
  assert.match(out[0].detail, /no SSH path/i);
});

test('TP-envdoctor-cp-011b a probe attempt stamps the cache even when unreachable (one attempt/day)', async () => {
  /** @type {any} */
  let written = null;
  await collectControlPlane({
    tunnel: { sshTarget: 'x@y' },
    force: false,
    todayStr: '2026-07-30',
    readCache: () => null,
    writeCache: (c) => { written = c; },
    runSsh: () => ({ ok: false, out: 'down' }),
    exampleFor: EXAMPLES,
    probedAt: 't',
  });
  assert.equal(written?.day, '2026-07-30');
  assert.equal(written?.results?.[0]?.level, 'INFO');
});
