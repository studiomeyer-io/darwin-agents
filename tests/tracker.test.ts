/**
 * Tests for ExperimentTracker — records experiments, aggregates stats,
 * computes composite scores.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ExperimentTracker } from '../src/evolution/tracker.js';
import { DEFAULT_WEIGHTS } from '../src/types.js';
import type { DarwinExperiment, MetricWeights } from '../src/types.js';
import { createMockMemory, makeExperiment } from './helpers.js';

let memory: ReturnType<typeof createMockMemory>;
let tracker: ExperimentTracker;

// ─── getCompositeScore ──────────────────────────────

describe('ExperimentTracker.getCompositeScore', () => {
  beforeEach(() => {
    memory = createMockMemory();
    tracker = new ExperimentTracker(memory);
  });

  it('computes a perfect score for an ideal experiment', () => {
    const exp = makeExperiment({
      success: true,
      metrics: {
        qualityScore: 10,
        sourceCount: 20,
        outputLength: 10000,
        errorCount: 0,
        durationMs: 0, // instant = 1.0 normalized duration
      },
    });

    const score = tracker.getCompositeScore(exp);
    // quality: 10/10=1.0 * 0.40 = 0.40
    // sourceCount: min(20/20,1)=1.0 * 0.15 = 0.15
    // outputLength: min(10000/10000,1)=1.0 * 0.10 = 0.10
    // duration: 1-min(0/300000,1)=1.0 * 0.10 = 0.10
    // success: 1 * 0.25 = 0.25
    // total = 1.0
    assert.equal(score, 1.0);
  });

  it('computes zero score for a failed experiment with no metrics', () => {
    const exp = makeExperiment({
      success: false,
      metrics: {
        qualityScore: 0,
        sourceCount: 0,
        outputLength: 0,
        errorCount: 5,
        durationMs: 300000, // 5 min = 0 normalized
      },
    });

    const score = tracker.getCompositeScore(exp);
    assert.equal(score, 0);
  });

  it('handles null qualityScore by redistributing weight', () => {
    const exp = makeExperiment({
      metrics: {
        qualityScore: null,
        sourceCount: 10,
        outputLength: 5000,
        errorCount: 0,
        durationMs: 60000,
      },
    });

    const score = tracker.getCompositeScore(exp);
    // NULL quality: quality weight (0.40) excluded, remaining weights renormalized
    // Remaining: 0.15 + 0.10 + 0.10 + 0.25 = 0.60, scale = 1/0.60
    const rawSum = 0.5 * 0.15 + 0.5 * 0.10 + 0.8 * 0.10 + 1 * 0.25;
    const expected = rawSum / 0.60;
    assert.ok(Math.abs(score - expected) < 0.001, `Expected ~${expected.toFixed(4)}, got ${score}`);
  });

  it('caps sourceCount normalization at 1.0 when >20 sources', () => {
    const exp = makeExperiment({
      metrics: {
        qualityScore: 5,
        sourceCount: 100, // way over 20
        outputLength: 5000,
        errorCount: 0,
        durationMs: 60000,
      },
    });

    const score = tracker.getCompositeScore(exp);
    // sourceCount: min(100/20,1)=1.0 (capped)
    const expNoSrcCap = makeExperiment({
      metrics: {
        qualityScore: 5,
        sourceCount: 20,
        outputLength: 5000,
        errorCount: 0,
        durationMs: 60000,
      },
    });
    const scoreCap = tracker.getCompositeScore(expNoSrcCap);
    assert.equal(score, scoreCap);
  });

  it('caps outputLength normalization at 1.0 when >10000 chars', () => {
    const exp = makeExperiment({
      metrics: {
        qualityScore: 5,
        sourceCount: 10,
        outputLength: 50000, // 5x the cap
        errorCount: 0,
        durationMs: 60000,
      },
    });

    const score = tracker.getCompositeScore(exp);
    const expAtCap = makeExperiment({
      metrics: {
        qualityScore: 5,
        sourceCount: 10,
        outputLength: 10000,
        errorCount: 0,
        durationMs: 60000,
      },
    });
    const scoreCap = tracker.getCompositeScore(expAtCap);
    assert.equal(score, scoreCap);
  });

  it('duration: faster is better (lower ms = higher score)', () => {
    const fast = makeExperiment({
      metrics: {
        qualityScore: 5,
        sourceCount: 10,
        outputLength: 5000,
        errorCount: 0,
        durationMs: 30000, // 30s
      },
    });

    const slow = makeExperiment({
      metrics: {
        qualityScore: 5,
        sourceCount: 10,
        outputLength: 5000,
        errorCount: 0,
        durationMs: 240000, // 4min
      },
    });

    assert.ok(
      tracker.getCompositeScore(fast) > tracker.getCompositeScore(slow),
      'Faster experiment should score higher',
    );
  });

  it('respects custom metric weights', () => {
    const exp = makeExperiment({
      success: true,
      metrics: {
        qualityScore: 10,
        sourceCount: 0,
        outputLength: 0,
        errorCount: 0,
        durationMs: 300000,
      },
    });

    // Only quality matters
    const qualityOnlyWeights: MetricWeights = {
      quality: 1.0,
      sourceCount: 0,
      outputLength: 0,
      duration: 0,
      success: 0,
    };

    const score = tracker.getCompositeScore(exp, qualityOnlyWeights);
    // quality: 10/10=1.0 * 1.0 = 1.0
    assert.equal(score, 1.0);
  });
});

// ─── getStats ───────────────────────────────────────

describe('ExperimentTracker.getStats', () => {
  beforeEach(() => {
    memory = createMockMemory();
    tracker = new ExperimentTracker(memory);
  });

  it('returns zeroed stats for empty experiment set', async () => {
    const stats = await tracker.getStats('researcher');
    assert.deepEqual(stats, {
      totalRuns: 0,
      avgQuality: 0,
      avgDuration: 0,
      successRate: 0,
      avgSourceCount: 0,
    });
  });

  it('computes correct stats for a single experiment', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        success: true,
        metrics: {
          qualityScore: 8,
          sourceCount: 12,
          outputLength: 7000,
          errorCount: 0,
          durationMs: 45000,
        },
      }),
    );

    const stats = await tracker.getStats('researcher');
    assert.equal(stats.totalRuns, 1);
    assert.equal(stats.avgQuality, 8);
    assert.equal(stats.avgDuration, 45000);
    assert.equal(stats.successRate, 1);
    assert.equal(stats.avgSourceCount, 12);
  });

  it('computes averages across multiple experiments', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        success: true,
        metrics: {
          qualityScore: 6,
          sourceCount: 10,
          outputLength: 5000,
          errorCount: 0,
          durationMs: 30000,
        },
      }),
      makeExperiment({
        agentName: 'researcher',
        success: false,
        metrics: {
          qualityScore: 4,
          sourceCount: 6,
          outputLength: 3000,
          errorCount: 2,
          durationMs: 90000,
        },
      }),
    );

    const stats = await tracker.getStats('researcher');
    assert.equal(stats.totalRuns, 2);
    assert.equal(stats.avgQuality, 5); // (6+4)/2
    assert.equal(stats.avgDuration, 60000); // (30000+90000)/2
    assert.equal(stats.successRate, 0.5); // 1/2
    assert.equal(stats.avgSourceCount, 8); // (10+6)/2
  });

  it('filters by version when specified', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        promptVersion: 'v1',
        metrics: { qualityScore: 8, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        promptVersion: 'v2',
        metrics: { qualityScore: 4, sourceCount: 5, outputLength: 3000, errorCount: 0, durationMs: 60000 },
      }),
    );

    const statsV1 = await tracker.getStats('researcher', 'v1');
    assert.equal(statsV1.totalRuns, 1);
    assert.equal(statsV1.avgQuality, 8);

    const statsV2 = await tracker.getStats('researcher', 'v2');
    assert.equal(statsV2.totalRuns, 1);
    assert.equal(statsV2.avgQuality, 4);
  });

  it('excludes null quality scores from avgQuality calculation', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        metrics: { qualityScore: 8, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        metrics: { qualityScore: null, sourceCount: 5, outputLength: 3000, errorCount: 0, durationMs: 60000 },
      }),
    );

    const stats = await tracker.getStats('researcher');
    assert.equal(stats.totalRuns, 2);
    // Only the experiment with qualityScore=8 is counted for avgQuality
    assert.equal(stats.avgQuality, 8);
  });

  it('filters by agent name (ignores other agents)', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        metrics: { qualityScore: 8, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'critic',
        metrics: { qualityScore: 3, sourceCount: 2, outputLength: 1000, errorCount: 0, durationMs: 20000 },
      }),
    );

    const stats = await tracker.getStats('researcher');
    assert.equal(stats.totalRuns, 1);
    assert.equal(stats.avgQuality, 8);
  });
});

// ─── recordExperiment ───────────────────────────────

describe('ExperimentTracker.recordExperiment', () => {
  beforeEach(() => {
    memory = createMockMemory();
    tracker = new ExperimentTracker(memory);
  });

  it('saves experiment and increments experiment count', async () => {
    const exp = makeExperiment({ agentName: 'researcher' });
    await tracker.recordExperiment(exp);

    assert.equal(memory._experiments.length, 1);
    const state = await memory.getState();
    assert.equal(state.experimentCounts['researcher'], 1);
  });

  it('resets consecutive failures on success', async () => {
    memory._state.consecutiveFailures['researcher'] = 2;

    const exp = makeExperiment({ agentName: 'researcher', success: true });
    await tracker.recordExperiment(exp);

    const state = await memory.getState();
    assert.equal(state.consecutiveFailures['researcher'], 0);
  });

  it('increments consecutive failures on failure', async () => {
    memory._state.consecutiveFailures['researcher'] = 1;

    const exp = makeExperiment({ agentName: 'researcher', success: false });
    await tracker.recordExperiment(exp);

    const state = await memory.getState();
    assert.equal(state.consecutiveFailures['researcher'], 2);
  });
});

// ─── getStatsByCategory ─────────────────────────────

describe('ExperimentTracker.getStatsByCategory', () => {
  beforeEach(() => {
    memory = createMockMemory();
    tracker = new ExperimentTracker(memory);
  });

  it('returns empty array when no experiments', async () => {
    const result = await tracker.getStatsByCategory('researcher');
    assert.deepEqual(result, []);
  });

  it('groups experiments by taskType', async () => {
    memory._experiments.push(
      makeExperiment({ agentName: 'researcher', taskType: 'tech', metrics: { qualityScore: 8, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 } }),
      makeExperiment({ agentName: 'researcher', taskType: 'tech', metrics: { qualityScore: 6, sourceCount: 8, outputLength: 4000, errorCount: 0, durationMs: 40000 } }),
      makeExperiment({ agentName: 'researcher', taskType: 'market', metrics: { qualityScore: 9, sourceCount: 15, outputLength: 7000, errorCount: 0, durationMs: 50000 } }),
    );

    const cats = await tracker.getStatsByCategory('researcher');
    assert.equal(cats.length, 2);

    // Sorted by totalRuns descending — tech has 2 runs, market has 1
    assert.equal(cats[0].taskType, 'tech');
    assert.equal(cats[0].totalRuns, 2);
    assert.equal(cats[0].avgQuality, 7); // (8+6)/2

    assert.equal(cats[1].taskType, 'market');
    assert.equal(cats[1].totalRuns, 1);
    assert.equal(cats[1].avgQuality, 9);
  });

  it('uses "general" as default taskType for empty taskType', async () => {
    memory._experiments.push(
      makeExperiment({ agentName: 'researcher', taskType: '', metrics: { qualityScore: 5, sourceCount: 5, outputLength: 3000, errorCount: 0, durationMs: 30000 } }),
    );

    const cats = await tracker.getStatsByCategory('researcher');
    assert.equal(cats.length, 1);
    assert.equal(cats[0].taskType, 'general');
  });
});

// ─── getAverageComposite ────────────────────────────

describe('ExperimentTracker.getAverageComposite', () => {
  beforeEach(() => {
    memory = createMockMemory();
    tracker = new ExperimentTracker(memory);
  });

  it('returns 0 for no experiments', async () => {
    const avg = await tracker.getAverageComposite('researcher', 'v1');
    assert.equal(avg, 0);
  });

  it('returns correct average of composite scores for a version', async () => {
    // Two identical experiments => average = same as individual
    const exp1 = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      success: true,
      metrics: {
        qualityScore: 10,
        sourceCount: 20,
        outputLength: 10000,
        errorCount: 0,
        durationMs: 0,
      },
    });
    const exp2 = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      success: false,
      metrics: {
        qualityScore: 0,
        sourceCount: 0,
        outputLength: 0,
        errorCount: 5,
        durationMs: 300000,
      },
    });

    memory._experiments.push(exp1, exp2);
    const avg = await tracker.getAverageComposite('researcher', 'v1');

    // exp1 = 1.0, exp2 = 0.0 => average = 0.5
    assert.equal(avg, 0.5);
  });

  it('filters by version (ignores other versions)', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        promptVersion: 'v1',
        success: true,
        metrics: { qualityScore: 10, sourceCount: 20, outputLength: 10000, errorCount: 0, durationMs: 0 },
      }),
      makeExperiment({
        agentName: 'researcher',
        promptVersion: 'v2',
        success: false,
        metrics: { qualityScore: 0, sourceCount: 0, outputLength: 0, errorCount: 5, durationMs: 300000 },
      }),
    );

    const avgV1 = await tracker.getAverageComposite('researcher', 'v1');
    assert.equal(avgV1, 1.0);

    const avgV2 = await tracker.getAverageComposite('researcher', 'v2');
    assert.equal(avgV2, 0);
  });

  it('filters by since timestamp (A/B test period only)', async () => {
    const oldDate = '2026-01-01T00:00:00.000Z';
    const abStart = '2026-03-01T00:00:00.000Z';
    const newDate = '2026-03-05T00:00:00.000Z';

    // Old v1 experiment (before A/B test) — should be excluded
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        promptVersion: 'v1',
        startedAt: oldDate,
        success: true,
        metrics: { qualityScore: 10, sourceCount: 20, outputLength: 10000, errorCount: 0, durationMs: 0 },
      }),
    );

    // New v1 experiment (during A/B test) — should be included
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        promptVersion: 'v1',
        startedAt: newDate,
        success: true,
        metrics: { qualityScore: 4, sourceCount: 0, outputLength: 2000, errorCount: 0, durationMs: 60000 },
      }),
    );

    // Without since: average of both (perfect + mediocre)
    const avgAll = await tracker.getAverageComposite('researcher', 'v1');
    assert.ok(avgAll > 0.5, 'All-time average should include the perfect old run');

    // With since: only the mediocre new run
    const avgSince = await tracker.getAverageComposite('researcher', 'v1', undefined, abStart);
    assert.ok(avgSince < avgAll, 'A/B period average should be lower (excludes perfect old run)');
  });
});
