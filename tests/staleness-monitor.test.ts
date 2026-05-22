/**
 * Tests for examples/staleness-monitor.ts (v0.4.6).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStaleness,
  buildStalenessReport,
  formatReport,
  STALENESS_SQL,
} from '../examples/staleness-monitor.js';

describe('classifyStaleness', () => {
  it('classifies active / stale / dead / never-tracked', () => {
    assert.equal(classifyStaleness({ agent_name: 'a', total_runs: 1, last_run: 'x', days_since_last: 2 }, 7), 'active');
    assert.equal(classifyStaleness({ agent_name: 'b', total_runs: 1, last_run: 'x', days_since_last: 14 }, 7), 'stale');
    assert.equal(classifyStaleness({ agent_name: 'c', total_runs: 1, last_run: 'x', days_since_last: 60 }, 7), 'dead');
    assert.equal(classifyStaleness({ agent_name: 'd', total_runs: 0, last_run: null, days_since_last: null }, 7), 'never-tracked');
  });

  it('boundary: days = staleDays → active', () => {
    assert.equal(classifyStaleness({ agent_name: 'edge', total_runs: 1, last_run: 'x', days_since_last: 7 }, 7), 'active');
  });

  it('boundary: days = staleDays * 4 → still stale, +1 → dead', () => {
    assert.equal(classifyStaleness({ agent_name: 'edge', total_runs: 1, last_run: 'x', days_since_last: 28 }, 7), 'stale');
    assert.equal(classifyStaleness({ agent_name: 'edge', total_runs: 1, last_run: 'x', days_since_last: 29 }, 7), 'dead');
  });
});

describe('buildStalenessReport', () => {
  it('merges observed rows + expected list, sorts alphabetically', () => {
    const observed = [
      { agent_name: 'zebra', total_runs: 5, last_run: 'x', days_since_last: 1 },
      { agent_name: 'alpha', total_runs: 5, last_run: 'x', days_since_last: 14 },
    ];
    const expected = ['alpha', 'middle', 'zebra'];
    const report = buildStalenessReport(observed, expected, 7);

    assert.equal(report.length, 3);
    assert.deepStrictEqual(report.map((r) => r.agent_name), ['alpha', 'middle', 'zebra']);
    assert.equal(report.find((r) => r.agent_name === 'alpha')?.status, 'stale');
    assert.equal(report.find((r) => r.agent_name === 'middle')?.status, 'never-tracked');
    assert.equal(report.find((r) => r.agent_name === 'zebra')?.status, 'active');
  });

  it('does not duplicate observed agents that appear in expected list', () => {
    const observed = [{ agent_name: 'both', total_runs: 5, last_run: 'x', days_since_last: 1 }];
    const expected = ['both'];
    const report = buildStalenessReport(observed, expected, 7);
    assert.equal(report.length, 1);
    assert.equal(report[0].status, 'active');
  });

  it('handles empty observed + empty expected', () => {
    assert.deepStrictEqual(buildStalenessReport([], [], 7), []);
  });

  it('flags configured-but-never-fired (never-tracked) — the key v0.4.6 feature', () => {
    const observed = [{ agent_name: 'running', total_runs: 5, last_run: 'x', days_since_last: 1 }];
    const expected = ['running', 'missing'];
    const report = buildStalenessReport(observed, expected, 7);
    const missing = report.find((r) => r.agent_name === 'missing');
    assert.ok(missing);
    assert.equal(missing.status, 'never-tracked');
    assert.equal(missing.total_runs, 0);
    assert.equal(missing.last_run, null);
  });
});

describe('formatReport', () => {
  it('shows header with all four statuses', () => {
    const out = formatReport([
      { agent_name: 'a', total_runs: 5, last_run: 'x', days_since_last: 1, status: 'active' },
      { agent_name: 'b', total_runs: 5, last_run: 'x', days_since_last: 14, status: 'stale' },
      { agent_name: 'c', total_runs: 5, last_run: 'x', days_since_last: 60, status: 'dead' },
      { agent_name: 'd', total_runs: 0, last_run: null, days_since_last: null, status: 'never-tracked' },
    ], 7);
    assert.match(out, /Active: 1/);
    assert.match(out, /Stale \(>7d\): 1/);
    assert.match(out, /Dead \(>28d\): 1/);
    assert.match(out, /Never: 1/);
  });

  it('shows all-green message when nothing wrong', () => {
    const out = formatReport([
      { agent_name: 'ok', total_runs: 10, last_run: 'x', days_since_last: 1, status: 'active' },
    ], 7);
    assert.match(out, /All tracked agents are active/);
  });

  it('lists dead agents with days + run count', () => {
    const out = formatReport([
      { agent_name: 'gone', total_runs: 100, last_run: 'x', days_since_last: 60, status: 'dead' },
    ], 7);
    assert.match(out, /DEAD:/);
    assert.match(out, /gone/);
    assert.match(out, /60d ago/);
    assert.match(out, /100 runs total/);
  });

  it('lists never-tracked agents in their own section', () => {
    const out = formatReport([
      { agent_name: 'newbie', total_runs: 0, last_run: null, days_since_last: null, status: 'never-tracked' },
    ], 7);
    assert.match(out, /NEVER-TRACKED/);
    assert.match(out, /newbie/);
  });
});

describe('STALENESS_SQL constant', () => {
  it('is a valid SQL snippet referencing darwin_experiments + completed_at', () => {
    assert.match(STALENESS_SQL, /darwin_experiments/);
    assert.match(STALENESS_SQL, /completed_at/);
    assert.match(STALENESS_SQL, /GROUP BY agent_name/);
  });
});
