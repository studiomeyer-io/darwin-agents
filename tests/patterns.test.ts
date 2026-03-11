/**
 * Tests for PatternDetector — detects strengths, weaknesses, trends, anomalies.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PatternDetector } from '../src/evolution/patterns.js';
import { createMockMemory, makeExperiment } from './helpers.js';

let memory: ReturnType<typeof createMockMemory>;
let detector: PatternDetector;

// ─── detectPatterns: empty / minimal data ───────────

describe('PatternDetector — no data', () => {
  beforeEach(() => {
    memory = createMockMemory();
    detector = new PatternDetector(memory);
  });

  it('returns empty array when no experiments exist', async () => {
    const patterns = await detector.detectPatterns('researcher');
    assert.deepEqual(patterns, []);
  });

  it('returns empty array when only 1 experiment (below MIN_CATEGORY_SIZE)', async () => {
    memory._experiments.push(
      makeExperiment({ agentName: 'researcher', taskType: 'tech' }),
    );
    const patterns = await detector.detectPatterns('researcher');
    // 1 experiment per category = below MIN_CATEGORY_SIZE=2, and below MIN_TREND_LENGTH=3
    assert.deepEqual(patterns, []);
  });
});

// ─── Strength Detection ─────────────────────────────

describe('PatternDetector — strength detection', () => {
  beforeEach(() => {
    memory = createMockMemory();
    detector = new PatternDetector(memory);
  });

  it('detects strength when avgQuality >= 7.5', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        success: true,
        metrics: { qualityScore: 8.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        success: true,
        metrics: { qualityScore: 8.0, sourceCount: 12, outputLength: 6000, errorCount: 0, durationMs: 40000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const strengths = patterns.filter((p) => p.type === 'strength');
    assert.ok(strengths.length >= 1, 'Should detect at least one strength');

    const qualityStrength = strengths.find((p) => p.description.includes('High quality'));
    assert.ok(qualityStrength, 'Should detect high quality strength');
    assert.equal(qualityStrength!.taskType, 'tech');
  });

  it('does not detect quality strength when avgQuality < 7.5', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        success: true,
        metrics: { qualityScore: 7.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        success: true,
        metrics: { qualityScore: 7.0, sourceCount: 12, outputLength: 6000, errorCount: 0, durationMs: 40000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const qualityStrengths = patterns.filter(
      (p) => p.type === 'strength' && p.description.includes('High quality'),
    );
    assert.equal(qualityStrengths.length, 0, 'Should NOT detect quality strength at 7.0');
  });

  it('detects success rate strength when >= 90%', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        success: true,
        metrics: { qualityScore: 5, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        success: true,
        metrics: { qualityScore: 5, sourceCount: 12, outputLength: 6000, errorCount: 0, durationMs: 40000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const successStrengths = patterns.filter(
      (p) => p.type === 'strength' && p.description.includes('success rate'),
    );
    assert.ok(successStrengths.length >= 1, 'Should detect success rate strength');
  });
});

// ─── Weakness Detection ─────────────────────────────

describe('PatternDetector — weakness detection', () => {
  beforeEach(() => {
    memory = createMockMemory();
    detector = new PatternDetector(memory);
  });

  it('detects weakness when avgQuality <= 4.0', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'market',
        success: true,
        metrics: { qualityScore: 3.0, sourceCount: 5, outputLength: 3000, errorCount: 1, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'market',
        success: true,
        metrics: { qualityScore: 3.5, sourceCount: 4, outputLength: 2500, errorCount: 0, durationMs: 40000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const weaknesses = patterns.filter((p) => p.type === 'weakness');
    const qualityWeak = weaknesses.find((p) => p.description.includes('Low quality'));
    assert.ok(qualityWeak, 'Should detect low quality weakness');
    assert.equal(qualityWeak!.taskType, 'market');
  });

  it('does not detect quality weakness when avgQuality > 4.0', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'market',
        success: true,
        metrics: { qualityScore: 5.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'market',
        success: true,
        metrics: { qualityScore: 5.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 40000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const qualityWeaknesses = patterns.filter(
      (p) => p.type === 'weakness' && p.description.includes('Low quality'),
    );
    assert.equal(qualityWeaknesses.length, 0);
  });

  it('does not detect quality weakness when avgQuality is 0 (all null)', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'market',
        metrics: { qualityScore: null, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'market',
        metrics: { qualityScore: null, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 40000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const qualityWeaknesses = patterns.filter(
      (p) => p.type === 'weakness' && p.description.includes('Low quality'),
    );
    // avgQuality=0, but the code requires avgQuality > 0 for weakness
    assert.equal(qualityWeaknesses.length, 0);
  });

  it('detects low success rate weakness when < 50%', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'market',
        success: false,
        metrics: { qualityScore: 5, sourceCount: 5, outputLength: 3000, errorCount: 1, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'market',
        success: false,
        metrics: { qualityScore: 5, sourceCount: 4, outputLength: 2500, errorCount: 2, durationMs: 40000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const successWeaknesses = patterns.filter(
      (p) => p.type === 'weakness' && p.description.includes('success rate'),
    );
    assert.ok(successWeaknesses.length >= 1, 'Should detect low success rate weakness');
  });
});

// ─── Trend Detection ────────────────────────────────

describe('PatternDetector — trend detection', () => {
  beforeEach(() => {
    memory = createMockMemory();
    detector = new PatternDetector(memory);
  });

  it('detects improving trend when second half scores > first half by >= 1.0', async () => {
    const baseTime = Date.now();
    // First half: low scores
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 40000).toISOString(),
        metrics: { qualityScore: 4.0, sourceCount: 5, outputLength: 3000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 30000).toISOString(),
        metrics: { qualityScore: 4.0, sourceCount: 5, outputLength: 3000, errorCount: 0, durationMs: 30000 },
      }),
    );
    // Second half: higher scores (delta >= 1.0)
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 20000).toISOString(),
        metrics: { qualityScore: 6.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 10000).toISOString(),
        metrics: { qualityScore: 6.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const trends = patterns.filter((p) => p.type === 'trend');
    const improving = trends.find((p) => p.description.includes('improving'));
    assert.ok(improving, 'Should detect improving trend');
  });

  it('detects declining trend when second half scores < first half by >= 1.0', async () => {
    const baseTime = Date.now();
    // First half: high scores
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 40000).toISOString(),
        metrics: { qualityScore: 8.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 30000).toISOString(),
        metrics: { qualityScore: 8.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
    );
    // Second half: lower scores
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 20000).toISOString(),
        metrics: { qualityScore: 6.0, sourceCount: 5, outputLength: 3000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 10000).toISOString(),
        metrics: { qualityScore: 6.0, sourceCount: 5, outputLength: 3000, errorCount: 0, durationMs: 30000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const trends = patterns.filter((p) => p.type === 'trend');
    const declining = trends.find((p) => p.description.includes('declining'));
    assert.ok(declining, 'Should detect declining trend');
  });

  it('no trend when delta < 1.0', async () => {
    const baseTime = Date.now();
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 40000).toISOString(),
        metrics: { qualityScore: 7.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 30000).toISOString(),
        metrics: { qualityScore: 7.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 20000).toISOString(),
        metrics: { qualityScore: 7.5, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        startedAt: new Date(baseTime - 10000).toISOString(),
        metrics: { qualityScore: 7.5, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const trends = patterns.filter((p) => p.type === 'trend');
    assert.equal(trends.length, 0, 'Should not detect trend with delta < 1.0');
  });

  it('no trend when fewer than MIN_TREND_LENGTH (3) experiments', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        metrics: { qualityScore: 3.0, sourceCount: 5, outputLength: 3000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        metrics: { qualityScore: 9.0, sourceCount: 15, outputLength: 8000, errorCount: 0, durationMs: 30000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const trends = patterns.filter((p) => p.type === 'trend');
    assert.equal(trends.length, 0, 'Should not detect trend with only 2 experiments');
  });
});

// ─── Anomaly Detection ──────────────────────────────

describe('PatternDetector — anomaly detection', () => {
  beforeEach(() => {
    memory = createMockMemory();
    detector = new PatternDetector(memory);
  });

  it('detects anomaly when score is 2+ sigma from mean', async () => {
    // 5 experiments in same category: four tightly clustered, one far outlier
    // Scores: [7, 7, 7, 7, 0] => mean=5.6, stdDev~=2.8, z-score for 0 = 5.6/2.8 = 2.0
    // Need more separation: [8, 8, 8, 8, 8, 1] => mean=6.83, stdDev~=2.62, z for 1=(6.83-1)/2.62=2.23
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        metrics: { qualityScore: 8.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        metrics: { qualityScore: 8.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        metrics: { qualityScore: 8.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        metrics: { qualityScore: 8.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        metrics: { qualityScore: 8.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        metrics: { qualityScore: 1.0, sourceCount: 1, outputLength: 500, errorCount: 3, durationMs: 120000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const anomalies = patterns.filter((p) => p.type === 'anomaly');
    assert.ok(anomalies.length >= 1, 'Should detect at least one anomaly');
    const belowAnomaly = anomalies.find((p) => p.description.includes('below'));
    assert.ok(belowAnomaly, 'Should detect outlier below mean');
  });

  it('no anomalies when all scores are identical (stdDev = 0)', async () => {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        metrics: { qualityScore: 7.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        metrics: { qualityScore: 7.0, sourceCount: 10, outputLength: 5000, errorCount: 0, durationMs: 30000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const anomalies = patterns.filter((p) => p.type === 'anomaly');
    assert.equal(anomalies.length, 0, 'No anomalies when all scores identical');
  });
});

// ─── Relative Weakness Detection ────────────────────

describe('PatternDetector — relative weakness detection', () => {
  beforeEach(() => {
    memory = createMockMemory();
    detector = new PatternDetector(memory);
  });

  it('detects relative weakness when category is >1.0 below overall avg', async () => {
    // Tech: 8.0 avg (5 runs), Market: 5.5 avg (5 runs) => overall ~6.75
    // Market is 1.25 below overall => relative weakness
    for (let i = 0; i < 5; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'writer',
          taskType: 'tech',
          success: true,
          metrics: { qualityScore: 8.0, sourceCount: 0, outputLength: 5000, errorCount: 0, durationMs: 20000 },
        }),
      );
    }
    for (let i = 0; i < 5; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'writer',
          taskType: 'market',
          success: true,
          metrics: { qualityScore: 5.5, sourceCount: 0, outputLength: 3000, errorCount: 0, durationMs: 20000 },
        }),
      );
    }

    const patterns = await detector.detectPatterns('writer');
    const relWeaknesses = patterns.filter(
      (p) => p.type === 'weakness' && p.description.includes('underperforms'),
    );
    assert.ok(relWeaknesses.length >= 1, 'Should detect relative weakness');
    assert.equal(relWeaknesses[0].taskType, 'market');
  });

  it('detects below-good-threshold weakness with 10+ runs', async () => {
    // 10 market runs at 6.3 avg → below 7.0 "good" threshold
    for (let i = 0; i < 10; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'writer',
          taskType: 'market',
          success: true,
          metrics: { qualityScore: 6.3, sourceCount: 0, outputLength: 4000, errorCount: 0, durationMs: 20000 },
        }),
      );
    }

    const patterns = await detector.detectPatterns('writer');
    const goodThreshold = patterns.filter(
      (p) => p.type === 'weakness' && p.description.includes('below good threshold'),
    );
    assert.ok(goodThreshold.length >= 1, 'Should detect below-good-threshold weakness');
  });

  it('does NOT detect relative weakness with fewer than 5 runs', async () => {
    // 3 tech runs (high), 3 market runs (low) — too few for relative weakness
    for (let i = 0; i < 3; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'writer',
          taskType: 'tech',
          success: true,
          metrics: { qualityScore: 9.0, sourceCount: 0, outputLength: 5000, errorCount: 0, durationMs: 20000 },
        }),
        makeExperiment({
          agentName: 'writer',
          taskType: 'market',
          success: true,
          metrics: { qualityScore: 5.0, sourceCount: 0, outputLength: 3000, errorCount: 0, durationMs: 20000 },
        }),
      );
    }

    const patterns = await detector.detectPatterns('writer');
    const relWeaknesses = patterns.filter(
      (p) => p.type === 'weakness' && p.description.includes('underperforms'),
    );
    assert.equal(relWeaknesses.length, 0, 'Should NOT detect relative weakness with < 5 runs');
  });

  it('does NOT flag category already caught by absolute weakness threshold', async () => {
    // 5 runs at 3.5 → already caught by WEAKNESS_THRESHOLD (4.0)
    // Should NOT also be flagged by relative weakness
    for (let i = 0; i < 5; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'writer',
          taskType: 'market',
          success: true,
          metrics: { qualityScore: 3.5, sourceCount: 0, outputLength: 2000, errorCount: 0, durationMs: 20000 },
        }),
      );
    }

    const patterns = await detector.detectPatterns('writer');
    const relWeaknesses = patterns.filter(
      (p) => p.type === 'weakness' && p.description.includes('underperforms'),
    );
    assert.equal(relWeaknesses.length, 0, 'Absolute weakness should not double-count as relative');
  });

  it('real-world scenario: writer market 6.3, tech 7.1, webdesign 7.1', async () => {
    // Simulate actual Darwin data — this should trigger evolution
    for (let i = 0; i < 42; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'writer',
          taskType: 'market',
          success: true,
          metrics: { qualityScore: 6.3, sourceCount: 0, outputLength: 4000, errorCount: 0, durationMs: 20000 },
        }),
      );
    }
    for (let i = 0; i < 28; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'writer',
          taskType: 'tech',
          success: true,
          metrics: { qualityScore: 7.1, sourceCount: 0, outputLength: 5000, errorCount: 0, durationMs: 20000 },
        }),
      );
    }
    for (let i = 0; i < 31; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'writer',
          taskType: 'webdesign',
          success: true,
          metrics: { qualityScore: 7.1, sourceCount: 0, outputLength: 5000, errorCount: 0, durationMs: 20000 },
        }),
      );
    }

    const patterns = await detector.detectPatterns('writer');
    const weaknesses = patterns.filter((p) => p.type === 'weakness');
    assert.ok(weaknesses.length >= 1, 'Should detect at least one weakness for market tasks');

    const marketWeak = weaknesses.find((p) => p.taskType === 'market');
    assert.ok(marketWeak, 'Market should be flagged as weakness');
  });
});

// ─── Confidence calculation ─────────────────────────

describe('PatternDetector — confidence from evidence count', () => {
  beforeEach(() => {
    memory = createMockMemory();
    detector = new PatternDetector(memory);
  });

  it('confidence increases with more experiments (capped at 1.0)', async () => {
    // 2 experiments => confidence = 2/10 = 0.2
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        success: true,
        metrics: { qualityScore: 9.0, sourceCount: 15, outputLength: 7000, errorCount: 0, durationMs: 30000 },
      }),
      makeExperiment({
        agentName: 'researcher',
        taskType: 'tech',
        success: true,
        metrics: { qualityScore: 9.0, sourceCount: 15, outputLength: 7000, errorCount: 0, durationMs: 30000 },
      }),
    );

    const patterns = await detector.detectPatterns('researcher');
    const strengths = patterns.filter((p) => p.type === 'strength');
    assert.ok(strengths.length > 0);
    assert.equal(strengths[0].confidence, 0.2); // 2/10

    // Add 8 more to reach 10 => confidence = 1.0
    for (let i = 0; i < 8; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'researcher',
          taskType: 'tech',
          success: true,
          metrics: { qualityScore: 9.0, sourceCount: 15, outputLength: 7000, errorCount: 0, durationMs: 30000 },
        }),
      );
    }

    const patterns2 = await detector.detectPatterns('researcher');
    const strengths2 = patterns2.filter(
      (p) => p.type === 'strength' && p.description.includes('High quality'),
    );
    assert.ok(strengths2.length > 0);
    assert.equal(strengths2[0].confidence, 1.0); // 10/10 capped
  });
});
