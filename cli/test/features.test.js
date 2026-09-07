// TP-features-registry (cli half): the declared feature registry — loader/validator
// (cli/util/features.js) and the pure cell-state derivation GET /feature builds on.
// Cases: `ws plan get features-registry-2026-08-27`. The endpoint's join behaviour
// is server/test/features.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseScope, scopeIncludes, validateFeatures, loadFeatures,
  checkState, combineStates, jobCellState,
} from '../util/features.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ENVS = {
  scheduleOwner: 'vm',
  environments: {
    vm: { kind: 'docker-container' },
    pc: { kind: 'interactive + rollback host' },
  },
};
const JOBS = { jobs: [{ name: 'daily-digest' }, { name: 'db-backup' }] };

/** A minimal valid feature. @param {Record<string, unknown>} [over] */
const feat = (over = {}) => ({
  id: 'daily-digest', title: 'Daily digest', kind: 'job', scope: 'schedule-owner',
  description: 'What this does for the operator, in plain words.',
  evidence: ['job:daily-digest'], ...over,
});

test('TP-features-registry-001: parseScope accepts the four forms and refuses unknown ones', () => {
  assert.deepEqual(parseScope('all'), { form: 'all', value: null });
  assert.deepEqual(parseScope('schedule-owner'), { form: 'schedule-owner', value: null });
  assert.deepEqual(parseScope('env:vm'), { form: 'env', value: 'vm' });
  assert.deepEqual(parseScope('kind:interactive + rollback host'), { form: 'kind', value: 'interactive + rollback host' });
  for (const bad of ['ALL', 'env:', 'kind:  ', 'station:pc', '', null, 42]) {
    assert.equal(parseScope(bad), null, `expected refusal for ${JSON.stringify(bad)}`);
  }
  // scopeIncludes follows the parsed form.
  assert.equal(scopeIncludes('all', 'pc', ENVS), true);
  assert.equal(scopeIncludes('schedule-owner', 'vm', ENVS), true);
  assert.equal(scopeIncludes('schedule-owner', 'pc', ENVS), false);
  assert.equal(scopeIncludes('env:vm', 'vm', ENVS), true);
  assert.equal(scopeIncludes('env:vm', 'pc', ENVS), false);
  assert.equal(scopeIncludes('kind:interactive + rollback host', 'pc', ENVS), true);
  assert.equal(scopeIncludes('kind:interactive + rollback host', 'vm', ENVS), false);
});

test('TP-features-registry-002: a well-formed registry validates with zero errors', () => {
  const registry = { features: [
    feat(),
    feat({ id: 'svc-x', kind: 'service', scope: 'env:vm', evidence: ['check:cp-env:x'], note: 'n' }),
    feat({ id: 'pull-task', kind: 'job', scope: 'kind:interactive + rollback host', evidence: ['check:pull-task'] }),
    feat({ id: 'declared-only', kind: 'page', scope: 'all', evidence: [] }),
    feat({ id: 'backup', evidence: ['job:db-backup', 'runner-log:backup'] }),
  ] };
  assert.deepEqual(validateFeatures(registry, ENVS, JOBS), []);
});

test('TP-features-registry-003: duplicate ids are refused', () => {
  const errors = validateFeatures({ features: [feat(), feat()] }, ENVS, JOBS);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicate id/);
});

test('TP-features-registry-004: unknown envs and station kinds in scope are refused', () => {
  const errors = validateFeatures({ features: [
    feat({ id: 'a', scope: 'env:nope' }),
    feat({ id: 'b', scope: 'kind:mainframe' }),
  ] }, ENVS, JOBS);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /unknown env 'nope'/);
  assert.match(errors[1], /unknown station kind 'mainframe'/);
});

test('TP-features-registry-005: unknown job names and malformed evidence are refused', () => {
  const errors = validateFeatures({ features: [feat({ evidence: [
    'job:not-a-job',      // not in jobs.json
    'daily-digest',       // no prefix
    'cron:daily-digest',  // unknown prefix
    'check:',             // empty value
  ] })] }, ENVS, JOBS);
  assert.equal(errors.length, 4);
  assert.match(errors[0], /unknown job 'not-a-job'/);
  for (const e of errors.slice(1)) assert.match(e, /malformed evidence/);
});

test('TP-features-registry-006: shape errors are refused (id, title, kind, evidence array)', () => {
  assert.deepEqual(validateFeatures({}, ENVS, JOBS), ['registry has no `features` array']);
  const errors = validateFeatures({ features: [
    feat({ id: 'Bad_Slug!' }),
    feat({ id: 'no-title', title: '  ' }),
    feat({ id: 'bad-kind', kind: 'daemon' }),
    feat({ id: 'bad-evidence', evidence: 'job:daily-digest' }),
    feat({ id: 'bad-note', note: 7 }),
  ] }, ENVS, JOBS);
  assert.equal(errors.length, 5);
  assert.match(errors[0], /id must be a lowercase slug/);
  assert.match(errors[1], /missing title/);
  assert.match(errors[2], /kind must be one of/);
  assert.match(errors[3], /evidence must be an array/);
  assert.match(errors[4], /note must be a string/);
});

test('TP-features-desc-001: absent, empty, whitespace-only, or non-string description is refused', () => {
  const { description: _absent, ...noDesc } = feat({ id: 'a' });
  const errors = validateFeatures({ features: [
    noDesc,
    feat({ id: 'b', description: '' }),
    feat({ id: 'c', description: '   ' }),
    feat({ id: 'd', description: 42 }),
  ] }, ENVS, JOBS);
  assert.equal(errors.length, 4);
  for (const e of errors) assert.match(e, /missing description/);
  assert.match(errors[0], /feature 'a'/);
});

test('TP-features-registry-007: checkState — cp-env data.state wins, level maps otherwise', () => {
  assert.equal(checkState({ level: 'FAIL', data: { state: 'ready' } }), 'ready');
  assert.equal(checkState({ level: 'INFO', data: { state: 'off' } }), 'off');
  assert.equal(checkState({ level: 'OK', data: { state: 'missing' } }), 'missing');
  assert.equal(checkState({ level: 'OK' }), 'ready');
  assert.equal(checkState({ level: 'WARN' }), 'warn');
  assert.equal(checkState({ level: 'FAIL' }), 'missing');
  assert.equal(checkState({ level: 'INFO' }), 'off');
});

test('TP-features-registry-008: combineStates is a worst-wins fold; empty is unmeasured', () => {
  assert.equal(combineStates([]), 'unmeasured');
  assert.equal(combineStates(['ready', 'ready']), 'ready');
  assert.equal(combineStates(['ready', 'off']), 'off');
  assert.equal(combineStates(['ready', 'unmeasured']), 'unmeasured');
  assert.equal(combineStates(['off', 'warn']), 'warn');
  assert.equal(combineStates(['warn', 'missing', 'ready']), 'missing');
  assert.equal(combineStates(['ready', 'stale', 'off']), 'stale');
});

test('TP-features-registry-009: jobCellState — disabled off, done/sent ready, failed missing, other warn, none unmeasured', () => {
  assert.equal(jobCellState({ disabled: true, lastRunStatus: 'done' }), 'off');
  assert.equal(jobCellState({ lastRunStatus: 'done' }), 'ready');
  assert.equal(jobCellState({ lastRunStatus: 'sent' }), 'ready');
  assert.equal(jobCellState({ lastRunStatus: 'failed' }), 'missing');
  assert.equal(jobCellState({ lastRunStatus: 'blocked' }), 'warn');
  assert.equal(jobCellState({}), 'unmeasured');
});

test('TP-features-registry-010: the SHIPPED registry validates against the real configs (drift guard)', () => {
  const { registry, errors } = loadFeatures({
    featuresPath: path.join(ROOT, 'configs', 'features.json'),
    envsPath: path.join(ROOT, 'configs', 'environments.json'),
    jobsPath: path.join(ROOT, 'configs', 'jobs', 'jobs.json'),
  });
  assert.deepEqual(errors, []);
  assert.ok(registry && registry.features.length > 0);
});

test('TP-features-registry-011: loadFeatures surfaces errors and never throws', () => {
  const missing = loadFeatures({ featuresPath: 'no/such.json', envsPath: 'no/envs.json', jobsPath: 'no/jobs.json' });
  assert.equal(missing.registry, null);
  assert.ok(missing.errors.length >= 1);
  const invalid = loadFeatures({
    featuresPath: 'f', envsPath: 'e', jobsPath: 'j',
    readFile: (f) => (f === 'f' ? '{ not json' : '{}'),
  });
  assert.equal(invalid.registry, null);
  assert.match(invalid.errors[0], /cannot read features registry/);
});
