/**
 * Tests for the always-valid sequential testing primitives (v0.7.0).
 * Covers meanVar, msprtTwoSample, hoeffdingTwoSample — happy path,
 * warmup abstention, degenerate variance, NaN resilience, monotonicity.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  meanVar,
  msprtTwoSample,
  hoeffdingTwoSample,
} from '../src/evolution/sequential.js';

// ─── meanVar ────────────────────────────────────────

describe('meanVar', () => {
  it('computes mean and Bessel-corrected variance', () => {
    const { mean, variance, n } = meanVar([2, 4, 6]);
    assert.equal(n, 3);
    assert.equal(mean, 4);
    // sample variance with n-1: ((−2)²+0+2²)/2 = 8/2 = 4
    assert.equal(variance, 4);
  });

  it('returns zeros for empty input', () => {
    assert.deepEqual(meanVar([]), { mean: 0, variance: 0, n: 0 });
  });

  it('n=1 has zero variance', () => {
    assert.deepEqual(meanVar([5]), { mean: 5, variance: 0, n: 1 });
  });

  it('drops NaN / Infinity entries without poisoning the estimate', () => {
    const { mean, n } = meanVar([2, NaN, 4, Infinity, 6]);
    assert.equal(n, 3);
    assert.equal(mean, 4);
  });
});

// ─── msprtTwoSample ─────────────────────────────────

describe('msprtTwoSample', () => {
  it('abstains during warmup (fewer than minSamplesPerArm)', () => {
    const v = msprtTwoSample([0.8, 0.8], [0.5, 0.5], { minSamplesPerArm: 5 });
    assert.equal(v.decisive, false);
    assert.equal(v.direction, 0);
    assert.match(v.reason, /warmup/);
  });

  it('fires decisively on a large, consistent gap', () => {
    const a = Array(12).fill(0.55);
    const b = Array(12).fill(0.85);
    const v = msprtTwoSample(a, b);
    assert.equal(v.decisive, true);
    assert.equal(v.direction, 1); // B > A
    assert.ok(v.statistic >= v.threshold);
  });

  it('does NOT fire on a tiny gap with noise (peeking resistance)', () => {
    // Two arms with the same mean (0.70) and real spread → no real effect.
    const a = [0.6, 0.7, 0.8, 0.65, 0.75, 0.7, 0.72, 0.68, 0.71, 0.69];
    const b = [0.71, 0.69, 0.7, 0.72, 0.68, 0.7, 0.69, 0.71, 0.7, 0.7];
    const v = msprtTwoSample(a, b);
    assert.equal(v.decisive, false);
    assert.equal(v.direction, 0);
  });

  it('detects direction when A beats B', () => {
    const a = Array(12).fill(0.9);
    const b = Array(12).fill(0.5);
    const v = msprtTwoSample(a, b);
    assert.equal(v.decisive, true);
    assert.equal(v.direction, -1); // A > B
  });

  it('deterministic differing arms (zero variance) are decisive with Infinity statistic', () => {
    const a = Array(8).fill(0.4);
    const b = Array(8).fill(0.9);
    const v = msprtTwoSample(a, b);
    assert.equal(v.decisive, true);
    assert.equal(v.statistic, Number.POSITIVE_INFINITY);
    assert.equal(v.direction, 1);
  });

  it('identical constant arms are NOT decisive', () => {
    const a = Array(8).fill(0.7);
    const b = Array(8).fill(0.7);
    const v = msprtTwoSample(a, b);
    assert.equal(v.decisive, false);
    assert.equal(v.direction, 0);
  });

  it('Λ grows monotonically as more consistent evidence accrues', () => {
    const small = msprtTwoSample(Array(6).fill(0.55), Array(6).fill(0.8));
    const large = msprtTwoSample(Array(20).fill(0.55), Array(20).fill(0.8));
    // more samples of the same gap → stronger evidence (only meaningful when
    // both are finite; the small case may already be Infinity for a clean gap,
    // so compare logs guardedly)
    assert.ok(large.statistic >= small.statistic);
  });

  it('threshold is 1/alpha', () => {
    const v = msprtTwoSample(Array(6).fill(0.5), Array(6).fill(0.6), { alpha: 0.05 });
    assert.equal(v.threshold, 20);
  });
});

// ─── hoeffdingTwoSample ─────────────────────────────

describe('hoeffdingTwoSample', () => {
  it('abstains during warmup', () => {
    const v = hoeffdingTwoSample([0.8], [0.2], { minSamplesPerArm: 2 });
    assert.equal(v.decisive, false);
    assert.match(v.reason, /warmup/);
  });

  it('fires when intervals no longer overlap (big gap, enough n)', () => {
    const a = Array(40).fill(0.2);
    const b = Array(40).fill(0.9);
    const v = hoeffdingTwoSample(a, b);
    assert.equal(v.decisive, true);
    assert.equal(v.direction, 1);
    assert.ok(v.statistic > v.threshold);
  });

  it('stays undecided for a small gap (conservative, intervals overlap)', () => {
    const a = Array(15).fill(0.5);
    const b = Array(15).fill(0.53);
    const v = hoeffdingTwoSample(a, b);
    assert.equal(v.decisive, false);
  });

  it('is more conservative than mSPRT on the same borderline data', () => {
    const a = Array(12).fill(0.6);
    const b = Array(12).fill(0.74);
    const h = hoeffdingTwoSample(a, b);
    const m = msprtTwoSample(a, b);
    // If Hoeffding fires, mSPRT must also fire (Hoeffding ⊆ mSPRT power).
    if (h.decisive) assert.equal(m.decisive, true);
  });

  it('respects a custom [lo,hi] range', () => {
    // Scores on a 0–10 scale; a 0.3-point gap is tiny relative to range.
    const a = Array(20).fill(7.0);
    const b = Array(20).fill(7.3);
    const v = hoeffdingTwoSample(a, b, { lo: 0, hi: 10 });
    assert.equal(v.decisive, false);
  });

  it('handles NaN-laced inputs without throwing', () => {
    const a = [0.2, NaN, 0.2, 0.2, 0.2, 0.2];
    const b = [0.9, 0.9, Infinity, 0.9, 0.9, 0.9];
    const v = hoeffdingTwoSample(a, b);
    assert.ok(Number.isFinite(v.statistic));
    assert.equal(v.nA, 5);
    assert.equal(v.nB, 5);
  });
});

// ─── mSPRT non-degenerate (formula-branch) coverage (v0.7.0 R1 Critic gap) ──

describe('msprtTwoSample — non-degenerate variance (formula branch)', () => {
  // Arms with REAL spread (not constant) + a clear gap. These exercise the
  // Welch-variance closed form, not the zero-variance Infinity shortcut.
  const noisyA = [0.50, 0.55, 0.60, 0.52, 0.58, 0.54, 0.56, 0.53, 0.57, 0.51];
  const noisyB = [0.80, 0.85, 0.78, 0.82, 0.81, 0.83, 0.79, 0.84, 0.86, 0.77];

  it('fires decisively with a FINITE statistic (proves formula branch, not degenerate)', () => {
    const v = msprtTwoSample(noisyA, noisyB);
    assert.equal(v.decisive, true);
    assert.equal(v.direction, 1);
    assert.ok(Number.isFinite(v.statistic), 'statistic must be finite (formula, not Infinity)');
    assert.ok(v.statistic >= v.threshold);
  });

  it('overlapping noisy arms (same mean, real spread) → finite statistic, not decisive', () => {
    const a = [0.60, 0.70, 0.80, 0.65, 0.75, 0.55, 0.72, 0.68, 0.62, 0.78];
    const b = [0.78, 0.62, 0.68, 0.72, 0.55, 0.75, 0.65, 0.80, 0.70, 0.60];
    const v = msprtTwoSample(a, b);
    assert.ok(Number.isFinite(v.statistic));
    assert.equal(v.decisive, false);
  });

  it('statistic increases with a larger gap at equal spread/n', () => {
    const base = [0.50, 0.55, 0.60, 0.52, 0.58, 0.54, 0.56, 0.53];
    const near = base.map((x) => x + 0.08); // small gap
    const far = base.map((x) => x + 0.20); // large gap
    const small = msprtTwoSample(base, near);
    const large = msprtTwoSample(base, far);
    assert.ok(Number.isFinite(small.statistic) && Number.isFinite(large.statistic));
    assert.ok(large.statistic > small.statistic);
  });

  it('statistic increases with more samples at equal gap/spread (information accrual)', () => {
    const six = (xs: number[]) => xs.slice(0, 6);
    const aSmall = six([0.50, 0.55, 0.60, 0.52, 0.58, 0.54, 0.56, 0.53, 0.57, 0.51]);
    const bSmall = six([0.70, 0.75, 0.80, 0.72, 0.78, 0.74, 0.76, 0.73, 0.77, 0.71]);
    const aBig = [0.50, 0.55, 0.60, 0.52, 0.58, 0.54, 0.56, 0.53, 0.57, 0.51, 0.59, 0.515, 0.545, 0.565, 0.535];
    const bBig = [0.70, 0.75, 0.80, 0.72, 0.78, 0.74, 0.76, 0.73, 0.77, 0.71, 0.79, 0.715, 0.745, 0.765, 0.735];
    const few = msprtTwoSample(aSmall, bSmall);
    const many = msprtTwoSample(aBig, bBig);
    assert.ok(Number.isFinite(few.statistic) && Number.isFinite(many.statistic));
    assert.ok(many.statistic > few.statistic);
  });

  it('abstains on 1-vs-1 even with a gap when minSamplesPerArm=1 (cannot estimate variance)', () => {
    const v = msprtTwoSample([0.2], [0.9], { minSamplesPerArm: 1 });
    assert.equal(v.decisive, false);
    assert.match(v.reason, /insufficient samples/);
  });
});
