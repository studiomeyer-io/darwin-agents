/**
 * Tests for SafetyGate — guards against regressions during prompt evolution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SafetyGate } from '../src/evolution/safety.js';
import type { SafetyThresholds, PromptVersionStats } from '../src/types.js';
import { DEFAULT_SAFETY } from '../src/types.js';

// Use defaults: minDataPoints=10, maxRegression=0.20, failureRollbackThreshold=3
const gate = new SafetyGate();

// ─── canEvolve ──────────────────────────────────────

describe('SafetyGate.canEvolve', () => {
  it('returns false when totalRuns < minDataPoints', () => {
    const stats: PromptVersionStats = {
      totalRuns: 9,
      avgQuality: 8,
      avgDuration: 5000,
      successRate: 1,
      avgSourceCount: 10,
    };
    assert.equal(gate.canEvolve('researcher', stats), false);
  });

  it('returns true when totalRuns === minDataPoints', () => {
    const stats: PromptVersionStats = {
      totalRuns: 10,
      avgQuality: 8,
      avgDuration: 5000,
      successRate: 1,
      avgSourceCount: 10,
    };
    assert.equal(gate.canEvolve('researcher', stats), true);
  });

  it('returns true when totalRuns > minDataPoints', () => {
    const stats: PromptVersionStats = {
      totalRuns: 20,
      avgQuality: 6,
      avgDuration: 10000,
      successRate: 0.8,
      avgSourceCount: 5,
    };
    assert.equal(gate.canEvolve('researcher', stats), true);
  });

  it('respects custom minDataPoints threshold', () => {
    const customThresholds: SafetyThresholds = {
      ...DEFAULT_SAFETY,
      minDataPoints: 15,
    };
    const customGate = new SafetyGate(customThresholds);
    const stats: PromptVersionStats = {
      totalRuns: 12,
      avgQuality: 8,
      avgDuration: 5000,
      successRate: 1,
      avgSourceCount: 10,
    };
    assert.equal(customGate.canEvolve('researcher', stats), false);
  });
});

// ─── checkRegression ────────────────────────────────

describe('SafetyGate.checkRegression', () => {
  it('returns true when drop is within threshold (12.5% < 20%)', () => {
    // scoreA=0.80, scoreB=0.70 => drop = 0.125
    assert.equal(gate.checkRegression(0.80, 0.70), true);
  });

  it('returns false when drop exceeds threshold (25% > 20%)', () => {
    // scoreA=0.80, scoreB=0.60 => drop = 0.250
    assert.equal(gate.checkRegression(0.80, 0.60), false);
  });

  it('returns true when drop equals threshold exactly (20%)', () => {
    // scoreA=1.0, scoreB=0.80 => drop = 0.20
    assert.equal(gate.checkRegression(1.0, 0.80), true);
  });

  it('returns true when scoreB > scoreA (improvement, not regression)', () => {
    // scoreA=0.50, scoreB=0.90 => drop = negative
    assert.equal(gate.checkRegression(0.50, 0.90), true);
  });

  it('returns true when scoreA is 0 (no baseline)', () => {
    assert.equal(gate.checkRegression(0, 0.5), true);
  });

  it('returns true when scoreA is negative (no baseline)', () => {
    assert.equal(gate.checkRegression(-1, 0.5), true);
  });

  it('returns true when both scores are 0', () => {
    assert.equal(gate.checkRegression(0, 0), true);
  });

  it('returns true when scores are equal (0% drop)', () => {
    assert.equal(gate.checkRegression(0.80, 0.80), true);
  });
});

// ─── shouldRollback ─────────────────────────────────

describe('SafetyGate.shouldRollback', () => {
  it('returns false when consecutiveFailures is 0', () => {
    assert.equal(gate.shouldRollback(0), false);
  });

  it('returns false when below threshold (2 < 3)', () => {
    assert.equal(gate.shouldRollback(2), false);
  });

  it('returns true when at threshold (3 === 3)', () => {
    assert.equal(gate.shouldRollback(3), true);
  });

  it('returns true when above threshold (5 > 3)', () => {
    assert.equal(gate.shouldRollback(5), true);
  });
});

// ─── evaluateABTest ─────────────────────────────────

describe('SafetyGate.evaluateABTest', () => {
  it('returns "continue" when neither version has enough runs', () => {
    const result = gate.evaluateABTest(0.8, 0.9, 5, 5);
    assert.equal(result, 'continue');
  });

  it('returns "a_wins" when B has >50% failure rate with >=3 attempts', () => {
    // B: 1 successful run + 2 fails = 3 total, 66% failure rate
    const result = gate.evaluateABTest(0.8, 0.9, 10, 1, 0, 2);
    assert.equal(result, 'a_wins');
  });

  it('returns "b_wins" when A has >50% failure rate with >=3 attempts', () => {
    // A: 1 successful run + 2 fails = 3 total, 66% failure rate
    const result = gate.evaluateABTest(0.8, 0.9, 1, 10, 2, 0);
    assert.equal(result, 'b_wins');
  });

  it('does not auto-lose with <3 total attempts even with high failure rate', () => {
    // B: 0 runs + 2 fails = 2 total (under threshold of 3)
    // A also has insufficient runs so we get 'continue'
    const result = gate.evaluateABTest(0.8, 0.9, 5, 0, 0, 2);
    assert.equal(result, 'continue');
  });

  it('returns "b_wins" when B is >5% better with enough runs', () => {
    // B composite=0.90 vs A composite=0.80 => 12.5% improvement
    const result = gate.evaluateABTest(0.80, 0.90, 10, 10);
    assert.equal(result, 'b_wins');
  });

  it('returns "a_wins" when A is >5% better with enough runs', () => {
    // A composite=0.90 vs B composite=0.80 => 12.5% improvement for A
    const result = gate.evaluateABTest(0.90, 0.80, 10, 10);
    assert.equal(result, 'a_wins');
  });

  it('returns "continue" when neither clears the 5% threshold', () => {
    // 0.80 vs 0.82 => 2.5% improvement — not enough
    const result = gate.evaluateABTest(0.80, 0.82, 10, 10);
    assert.equal(result, 'continue');
  });

  it('returns "continue" when both adjusted scores are 0', () => {
    const result = gate.evaluateABTest(0, 0, 10, 10);
    assert.equal(result, 'continue');
  });

  it('reliability adjustment: version with failures gets penalized score', () => {
    // A: composite=0.80, 10 runs, 0 fails => reliability=1.0, adjusted=0.80
    // B: composite=0.90, 10 runs, 3 fails => reliability=10/13=0.769, adjusted=0.692
    // A should win because B's adjusted score (0.692) is lower
    const result = gate.evaluateABTest(0.80, 0.90, 10, 10, 0, 3);
    assert.equal(result, 'a_wins');
  });

  it('reliability check triggers before min-runs check', () => {
    // B: 2 runs + 2 fails = 4 total, 50% failure — NOT >50%, so no auto-lose
    // But runs < minDataPoints so 'continue'
    const result = gate.evaluateABTest(0.80, 0.90, 5, 2, 0, 2);
    assert.equal(result, 'continue');
  });

  it('returns "b_wins" when A adjusted is 0 but B adjusted is positive', () => {
    // A: composite=0, adjusted=0. B: composite=0.50, adjusted=0.50
    const result = gate.evaluateABTest(0, 0.50, 10, 10);
    assert.equal(result, 'b_wins');
  });

  it('returns "a_wins" when B adjusted is 0 but A adjusted is positive', () => {
    // A: composite=0.50, adjusted=0.50. B: composite=0, adjusted=0.
    const result = gate.evaluateABTest(0.50, 0, 10, 10);
    assert.equal(result, 'a_wins');
  });
});

// ─── calculateConfidence ────────────────────────────

describe('SafetyGate.calculateConfidence', () => {
  it('returns not confident when insufficient runs', () => {
    const result = gate.calculateConfidence(0.8, 0.9, 5, 5);
    assert.equal(result.confident, false);
  });

  it('returns confident with large effect size and enough samples', () => {
    const result = gate.calculateConfidence(0.60, 0.90, 10, 10);
    assert.equal(result.confident, true);
    assert.ok(result.effectSize > 0.2);
  });

  it('returns not confident when effect size is small', () => {
    const result = gate.calculateConfidence(0.80, 0.82, 10, 10);
    assert.equal(result.confident, false);
  });

  it('returns not confident when both scores are 0', () => {
    const result = gate.calculateConfidence(0, 0, 10, 10);
    assert.equal(result.confident, false);
  });
});

// ─── v0.7.0 — sequential confidence methods (mSPRT / Hoeffding) ──────

describe('SafetyGate.evaluateABTest — sequential confidence (v0.7.0)', () => {
  const minRuns = 10;

  it('mSPRT: confirms b_wins on a large, consistent gap', () => {
    const gate = new SafetyGate({
      ...DEFAULT_SAFETY,
      requireConfidence: true,
      confidenceMethod: 'msprt',
    });
    const samples = { a: Array(12).fill(0.6), b: Array(12).fill(0.85) };
    const outcome = gate.evaluateABTest(0.6, 0.85, 12, 12, 0, 0, minRuns, samples);
    assert.equal(outcome, 'b_wins');
  });

  it('mSPRT: a margin win that is NOT statistically decisive does not adopt B', () => {
    const gate = new SafetyGate({
      ...DEFAULT_SAFETY,
      requireConfidence: true,
      confidenceMethod: 'msprt',
    });
    // Margin > 5% on the means, but the per-sample arms overlap heavily
    // (same spread, tiny mean gap) → mSPRT abstains → not adopted yet.
    const a = [0.55, 0.7, 0.85, 0.6, 0.8, 0.65, 0.75, 0.7, 0.72, 0.68, 0.71, 0.69];
    const b = [0.58, 0.73, 0.88, 0.63, 0.83, 0.68, 0.78, 0.73, 0.75, 0.71, 0.74, 0.72];
    const meanA = a.reduce((s, x) => s + x, 0) / a.length;
    const meanB = b.reduce((s, x) => s + x, 0) / b.length;
    const outcome = gate.evaluateABTest(meanA, meanB, 12, 12, 0, 0, minRuns, { a, b });
    // Not enough confidence AND below 2×minRuns tie-break → keep testing.
    assert.equal(outcome, 'continue');
  });

  it('mSPRT: gracefully falls back to effect-size when no samples supplied', () => {
    const gate = new SafetyGate({
      ...DEFAULT_SAFETY,
      requireConfidence: true,
      confidenceMethod: 'msprt',
    });
    // No samples arg → effect-size path. Large effect + 2×minRuns → b_wins.
    const outcome = gate.evaluateABTest(0.6, 0.9, 20, 20, 0, 0, minRuns);
    assert.equal(outcome, 'b_wins');
  });

  it('Hoeffding: confirms a_wins when A is decisively higher', () => {
    const gate = new SafetyGate({
      ...DEFAULT_SAFETY,
      requireConfidence: true,
      confidenceMethod: 'hoeffding',
    });
    const samples = { a: Array(40).fill(0.9), b: Array(40).fill(0.3) };
    const outcome = gate.evaluateABTest(0.9, 0.3, 40, 40, 0, 0, minRuns, samples);
    assert.equal(outcome, 'a_wins');
  });

  it('effect-size method ignores samples and behaves like v0.6.0', () => {
    const gate = new SafetyGate({
      ...DEFAULT_SAFETY,
      requireConfidence: true,
      confidenceMethod: 'effect-size',
    });
    const samples = { a: Array(20).fill(0.6), b: Array(20).fill(0.9) };
    const outcome = gate.evaluateABTest(0.6, 0.9, 20, 20, 0, 0, minRuns, samples);
    assert.equal(outcome, 'b_wins');
  });
});
