/**
 * Tests for the metrics sink (v0.14.0) — emitMetric's never-throw contract,
 * the JSONL sink, env wiring, and the loop actually emitting events.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  JsonlMetricsSink,
  emitMetric,
  metricsSinkFromEnv,
  type DarwinMetricEvent,
  type MetricsSink,
} from '../src/metrics/sink.js';
import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { createMockMemory, makeExperiment } from './helpers.js';

// ─── emitMetric contract ────────────────────────────

describe('emitMetric', () => {
  it('is a no-op without a sink', () => {
    assert.doesNotThrow(() => emitMetric(undefined, 'run_recorded', 'writer'));
  });

  it('stamps type, agent, ISO timestamp, and payload', () => {
    const events: DarwinMetricEvent[] = [];
    const sink: MetricsSink = { emit: (e) => void events.push(e) };

    emitMetric(sink, 'ab_test_started', 'writer', { versionA: 'v1', versionB: 'v2' });

    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.type, 'ab_test_started');
    assert.equal(e.agent, 'writer');
    assert.ok(!Number.isNaN(Date.parse(e.at)), 'at must be a parseable timestamp');
    assert.deepEqual(e.data, { versionA: 'v1', versionB: 'v2' });
  });

  it('swallows a synchronously throwing sink', () => {
    const sink: MetricsSink = {
      emit: () => {
        throw new Error('sink exploded');
      },
    };
    assert.doesNotThrow(() => emitMetric(sink, 'rollback', 'writer'));
  });

  it('swallows an async-rejecting sink (no unhandled rejection)', async () => {
    let rejected = false;
    const sink: MetricsSink = {
      emit: async () => {
        rejected = true;
        throw new Error('async sink exploded');
      },
    };
    assert.doesNotThrow(() => emitMetric(sink, 'rollback', 'writer'));
    // Let the rejection settle — an unhandled rejection would fail the runner.
    await new Promise((r) => setImmediate(r));
    assert.equal(rejected, true);
  });
});

// ─── JsonlMetricsSink ───────────────────────────────

describe('JsonlMetricsSink', () => {
  it('appends one JSON line per event and creates the parent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'darwin-metrics-'));
    const path = join(dir, 'nested', 'events.jsonl');

    const sink = new JsonlMetricsSink(path);
    assert.ok(existsSync(join(dir, 'nested')), 'parent dir created eagerly');

    emitMetric(sink, 'run_recorded', 'writer', { qualityScore: 7 });
    emitMetric(sink, 'rollback', 'writer', { toVersion: 'v1' });

    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!) as DarwinMetricEvent;
    assert.equal(first.type, 'run_recorded');
    assert.equal(first.data.qualityScore, 7);
    const second = JSON.parse(lines[1]!) as DarwinMetricEvent;
    assert.equal(second.type, 'rollback');
  });
});

// ─── metricsSinkFromEnv ─────────────────────────────

describe('metricsSinkFromEnv', () => {
  it('returns undefined when the variable is unset or blank', () => {
    assert.equal(metricsSinkFromEnv({}), undefined);
    assert.equal(metricsSinkFromEnv({ DARWIN_METRICS_JSONL: '  ' }), undefined);
  });

  it('builds a working JSONL sink from DARWIN_METRICS_JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'darwin-metrics-env-'));
    const path = join(dir, 'ev.jsonl');
    const sink = metricsSinkFromEnv({ DARWIN_METRICS_JSONL: path });
    assert.ok(sink, 'sink built');
    emitMetric(sink, 'ab_test_timeout', 'writer', { budgetDays: 7 });
    const line = JSON.parse(readFileSync(path, 'utf-8').trim()) as DarwinMetricEvent;
    assert.equal(line.type, 'ab_test_timeout');
  });
});

// ─── Loop integration ───────────────────────────────

describe('DarwinLoop metrics emission', () => {
  function createLoop(sink: MetricsSink) {
    const memory = createMockMemory();
    const tracker = new ExperimentTracker(memory);
    const loop = new DarwinLoop({
      memory,
      tracker,
      optimizer: new PromptOptimizer(async () => 'improved prompt text'),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      metrics: sink,
    });
    return { memory, loop };
  }

  it('emits run_recorded for a complete run', async () => {
    const events: DarwinMetricEvent[] = [];
    const { loop } = createLoop({ emit: (e) => void events.push(e) });

    await loop.afterRun(makeExperiment({ agentName: 'writer' }));

    const recorded = events.filter((e) => e.type === 'run_recorded');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.agent, 'writer');
    assert.equal(recorded[0]!.data.version, 'v1');
  });

  it('does not emit run_recorded for an incomplete run', async () => {
    const events: DarwinMetricEvent[] = [];
    const { loop } = createLoop({ emit: (e) => void events.push(e) });

    await loop.afterRun(
      makeExperiment({
        agentName: 'writer',
        metrics: { qualityScore: 7, sourceCount: 10, outputLength: 100, errorCount: 0, durationMs: 1000 },
      }),
    );

    assert.equal(events.filter((e) => e.type === 'run_recorded').length, 0);
  });

  it('a throwing sink never breaks afterRun', async () => {
    const { loop } = createLoop({
      emit: () => {
        throw new Error('sink down');
      },
    });
    const result = await loop.afterRun(makeExperiment({ agentName: 'writer' }));
    assert.equal(typeof result.message, 'string');
  });

  it('emits evolution_skipped with a reason while still collecting data', async () => {
    const events: DarwinMetricEvent[] = [];
    const { loop } = createLoop({ emit: (e) => void events.push(e) });

    // One good run against a fresh memory: far below minDataPoints → the
    // loop skips evolution, and that decision must be observable.
    await loop.afterRun(makeExperiment({ agentName: 'writer' }));

    const skipped = events.filter((e) => e.type === 'evolution_skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.data.reason, 'collecting_data');
  });
});
