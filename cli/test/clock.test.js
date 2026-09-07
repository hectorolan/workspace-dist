// TP-clock: schedule-timezone time source (cli/util/clock.js) — the fix for the
// 2026-07-20 digest incident (UTC date + local hour let an evening catch-up
// compose and email "tomorrow's" digest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { today, hourNow, dowNow, stamp, scheduleTimezone } from '../util/clock.js';

/** A temp workspace whose configs/jobs/jobs.json declares the given timezone. @param {string} timezone */
function fakeWorkspace(timezone) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-clock-'));
  mkdirSync(path.join(dir, 'configs', 'jobs'), { recursive: true });
  writeFileSync(path.join(dir, 'configs', 'jobs', 'jobs.json'), JSON.stringify({ timezone, jobs: [] }));
  return dir;
}

/** @param {string|undefined} dir @param {() => void} fn */
function withWorkspace(dir, fn) {
  const prev = process.env.WORKSPACE_DIR;
  if (dir === undefined) delete process.env.WORKSPACE_DIR;
  else process.env.WORKSPACE_DIR = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = prev;
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

test('TP-clock-001: today() follows the schedule timezone from jobs.json', () => {
  // UTC+14 and UTC-12 are 26h apart — their calendar dates are never equal, so a
  // clock stuck on UTC (the old bug) could not satisfy both expectations.
  let east = '', west = '';
  withWorkspace(fakeWorkspace('Pacific/Kiritimati'), () => {
    assert.equal(scheduleTimezone(), 'Pacific/Kiritimati');
    east = today();
  });
  withWorkspace(fakeWorkspace('Etc/GMT+12'), () => {
    west = today();
  });
  assert.match(east, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(west, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(east, west);
});

test('TP-clock-002: hourNow() is the hour of day in the schedule timezone', () => {
  withWorkspace(fakeWorkspace('America/Los_Angeles'), () => {
    const before = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const h = hourNow();
    const after = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 23);
    assert.ok(h === before || h === after, `hourNow ${h} not in [${before}, ${after}]`);
  });
});

test('TP-clock-003: stamp() is YYYY-MM-DD HH:mm:ss', () => {
  withWorkspace(fakeWorkspace('America/Los_Angeles'), () => {
    assert.match(stamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

test('TP-clock-005: dowNow() is the 0–6 day of week in the schedule timezone', () => {
  withWorkspace(fakeWorkspace('UTC'), () => {
    const before = new Date().getUTCDay();
    const d = dowNow();
    const after = new Date().getUTCDay();
    assert.ok(Number.isInteger(d) && d >= 0 && d <= 6);
    assert.ok(d === before || d === after, `dowNow ${d} not in [${before}, ${after}]`);
  });
});

test('TP-clock-004: without a jobs.json the clock falls back to the host timezone', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'ws-clock-empty-'));
  withWorkspace(empty, () => {
    assert.equal(scheduleTimezone(), undefined);
    assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
