/**
 * Darwin v0.15: the Hoeffding confidence sequence, checked rather than claimed.
 *
 * Through v0.14 `hoeffdingTwoSample` used the boundary
 *
 *   w(n) = R·√( ln((n+1)/α) / (2n) )
 *
 * and documented it as "a standard union-bound / Cramer-Chernoff time-uniform
 * Hoeffding bound". That boundary allows 2α/(n+1) of the error budget at every
 * look, and Σ 2α/(n+1) diverges, so no union bound closes over it and the
 * stated justification establishes nothing. (What is refuted is the argument,
 * not the boundary itself; see sequential.ts for why we replaced it anyway.)
 * On top of that both arms spent the full α instead of α/2, so the budget was
 * allocated twice over. That is an allocation error, not a proof that the old
 * procedure ran at 2α: the per-arm boundary had no established level either.
 *
 * This file does not take the new boundary on faith either. It re-derives the
 * α-spend from Hoeffding's inequality and checks the two things this
 * construction stands or falls on:
 *
 *   1. the per-look spends SUM to at most the budget (new: they do), which is
 *      what makes the union bound close, and
 *   2. the pre-0.15 spends do NOT (legacy: they diverge, shown explicitly),
 *      which is why its stated proof never worked.
 *
 * Summability is SUFFICIENT for this construction, not necessary in general:
 * a confidence sequence is defined by simultaneous coverage over time, and
 * other constructions reach it by other routes (Howard et al.,
 * arXiv:1810.08240). What the divergence below refutes is the argument the
 * code used, not every conceivable argument.
 *
 * Everything here is deterministic. The Monte Carlo section uses a seeded
 * mulberry32 so a red run is always reproducible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hoeffdingHalfWidth,
  hoeffdingTwoSample,
  meanVar,
  msprtTwoSample,
} from '../src/evolution/sequential.js';
import {
  SafetyGate,
  resetInertConfidenceWarningForTests,
} from '../src/evolution/safety.js';

const ALPHA = 0.05;
const RANGE = 1; // Darwin composite scores live in [0, 1]

/**
 * The error Hoeffding's inequality permits at a single look of size n for a
 * half-width w on a range-R variable: P(|X̄_n - μ| ≥ w) ≤ 2·exp(-2n·w²/R²).
 * This union-bound construction stands or falls on keeping this quantity
 * summable. Other confidence-sequence constructions do not (see the header).
 */
function spendAt(n: number, w: number, range = RANGE): number {
  return 2 * Math.exp((-2 * n * w * w) / (range * range));
}

/** The pre-0.15 boundary, kept here so the regression stays falsifiable. */
function legacyHalfWidth(n: number, range = RANGE, alpha = ALPHA): number {
  return range * Math.sqrt(Math.log((n + 1) / alpha) / (2 * n));
}

// ── 1. The new boundary really is a confidence sequence ────────────────────

describe('Hoeffding boundary: the α-spend converges (v0.15)', () => {
  it('one arm spends at most α/2 no matter how long you monitor', () => {
    // The whole guarantee in one assertion. If this sum ever exceeded α/2,
    // "time-uniform at level α" would be false and the gate would be lying.
    for (const horizon of [10, 100, 10_000, 1_000_000]) {
      let spent = 0;
      for (let n = 1; n <= horizon; n++) {
        spent += spendAt(n, hoeffdingHalfWidth(n, RANGE, ALPHA));
      }
      assert.ok(
        spent <= ALPHA / 2 + 1e-12,
        `arm budget blown at horizon ${horizon}: spent ${spent} > ${ALPHA / 2}`,
      );
    }
  });

  it('the spend converges to the budget instead of growing without bound', () => {
    // Σ (α/2)/(n(n+1)) telescopes to exactly α/2, so a long horizon should sit
    // just under the budget and the remaining tail should be negligible.
    let spent = 0;
    for (let n = 1; n <= 1_000_000; n++) {
      spent += spendAt(n, hoeffdingHalfWidth(n, RANGE, ALPHA));
    }
    assert.ok(spent > ALPHA / 2 - 1e-4, `converged too low: ${spent}`);
    assert.ok(spent <= ALPHA / 2 + 1e-12, `overspent: ${spent}`);
  });

  it('per-look spend matches the intended schedule α_n = (α/2)/(n(n+1))', () => {
    for (const n of [1, 2, 5, 20, 100, 5000]) {
      const actual = spendAt(n, hoeffdingHalfWidth(n, RANGE, ALPHA));
      const intended = ALPHA / 2 / (n * (n + 1));
      assert.ok(
        Math.abs(actual - intended) < 1e-15,
        `n=${n}: spend ${actual} != schedule ${intended}`,
      );
    }
  });

  it('both arms together stay inside the requested α', () => {
    // Two arms, each on its own α/2 schedule. A false "decisive" under H0
    // requires at least one sequence to fail, so the union bound returns α.
    let joint = 0;
    for (let n = 1; n <= 100_000; n++) {
      joint += 2 * spendAt(n, hoeffdingHalfWidth(n, RANGE, ALPHA));
    }
    assert.ok(joint <= ALPHA + 1e-12, `two-arm level ${joint} exceeds α=${ALPHA}`);
  });

  it('holds on a non-unit score range too (0 to 10 scale)', () => {
    let spent = 0;
    for (let n = 1; n <= 100_000; n++) {
      spent += spendAt(n, hoeffdingHalfWidth(n, 10, ALPHA), 10);
    }
    assert.ok(spent <= ALPHA / 2 + 1e-12, `range-10 arm overspent: ${spent}`);
  });

  it('holds for other α values', () => {
    for (const alpha of [0.01, 0.1, 0.2]) {
      let spent = 0;
      for (let n = 1; n <= 100_000; n++) {
        spent += spendAt(n, hoeffdingHalfWidth(n, RANGE, alpha));
      }
      assert.ok(
        spent <= alpha / 2 + 1e-12,
        `α=${alpha}: spent ${spent} > ${alpha / 2}`,
      );
    }
  });
});

// ── 2. The pre-0.15 boundary's own proof demonstrably did not close ────────

describe('Hoeffding boundary: the pre-0.15 spend diverges', () => {
  // Scope, stated because a cross-model review rightly called the old heading
  // ("regression guard") a promise this group does not keep: the first test
  // below evaluates `legacyHalfWidth`, a local reimplementation of the removed
  // formula. It is a DEMONSTRATION that the old justification fails, not a
  // guard on production code, and no change to src/ can turn it red. The two
  // tests after it DO call the production helper and are guards.
  it('demonstration: the old formula blows the α budget and keeps growing', () => {
    const spentBy = (horizon: number): number => {
      let s = 0;
      for (let n = 1; n <= horizon; n++) s += spendAt(n, legacyHalfWidth(n));
      return s;
    };

    // Already over budget after a handful of looks.
    assert.ok(spentBy(10) > ALPHA, `legacy stayed inside α at n=10: ${spentBy(10)}`);

    // And it never settles: harmonic growth, so every decade adds more.
    const a = spentBy(1_000);
    const b = spentBy(100_000);
    assert.ok(b > a, 'legacy spend should keep growing with the horizon');
    assert.ok(
      b > 20 * ALPHA,
      `legacy spend at 1e5 looks was only ${b}; expected far past α=${ALPHA}`,
    );
  });

  it('refuses degenerate inputs instead of returning NaN', () => {
    // `n >= 1` alone lets Infinity through, and Infinity/Infinity inside the
    // square root is NaN, which would propagate into `threshold` and make every
    // comparison silently false. Exported helper, so this is a public contract.
    for (const bad of [Infinity, NaN, 0, -5, 0.5]) {
      assert.equal(hoeffdingHalfWidth(bad, RANGE, ALPHA), Infinity, `n=${bad}`);
    }
    for (const badRange of [0, -1, Infinity, NaN]) {
      assert.equal(hoeffdingHalfWidth(10, badRange, ALPHA), Infinity, `range=${badRange}`);
    }
    // Absurd but finite n must still give a finite width, or refuse cleanly.
    for (const n of [1e6, 1e200]) {
      const w = hoeffdingHalfWidth(n, RANGE, ALPHA);
      assert.ok(Number.isFinite(w) || w === Infinity, `n=${n} produced ${w}`);
      assert.ok(!Number.isNaN(w), `n=${n} produced NaN`);
    }
    // An out-of-band α is REFUSED, not quietly replaced by the default. It used
    // to fall back to 0.05, so a caller asking for α=0 silently got a 5% test.
    // Defaulting an absent option is a convenience; defaulting an explicitly
    // wrong one runs a different test than the caller asked for.
    for (const badAlpha of [0, 1, -0.1, 1.5, NaN, Infinity]) {
      assert.equal(hoeffdingHalfWidth(10, RANGE, badAlpha), Infinity, `alpha=${badAlpha}`);
    }
    // Valid α still works, and a tighter α gives a wider interval.
    assert.ok(hoeffdingHalfWidth(10, RANGE, 0.01) > hoeffdingHalfWidth(10, RANGE, 0.05));
  });

  it('the corrected boundary is strictly wider at every sample size', () => {
    // Being provably valid costs width. Pin the direction so a future
    // "optimisation" cannot quietly reintroduce the invalid boundary.
    for (const n of [1, 2, 5, 10, 20, 50, 200, 1000]) {
      assert.ok(
        hoeffdingHalfWidth(n, RANGE, ALPHA) > legacyHalfWidth(n),
        `n=${n}: corrected boundary is not wider than the pre-0.15 one`,
      );
    }
  });

  it('the public verdict threshold IS twice the audited half-width', () => {
    // Without this, every assertion above could hold while the dispatcher in
    // hoeffdingTwoSample used some other width, and the audited schedule would
    // guarantee nothing about the verdicts Darwin actually acts on. Ties the
    // two together.
    for (const n of [2, 5, 20, 60, 500]) {
      const v = hoeffdingTwoSample(Array(n).fill(0.4), Array(n).fill(0.6));
      const expected = 2 * hoeffdingHalfWidth(n, RANGE, ALPHA);
      assert.ok(
        Math.abs(v.threshold - expected) < 1e-12,
        `n=${n}: verdict threshold ${v.threshold} != 2×helper ${expected}`,
      );
    }
    // And on a custom range, so the range is threaded through as well.
    const v10 = hoeffdingTwoSample(Array(40).fill(2), Array(40).fill(8), { lo: 0, hi: 10 });
    assert.ok(Math.abs(v10.threshold - 2 * hoeffdingHalfWidth(40, 10, ALPHA)) < 1e-12);
  });

  it('spends α/2 per arm, not α (the second pre-0.15 defect)', () => {
    // The same schedule on the full α would be measurably narrower. This
    // asserts the two-arm split is actually applied.
    const singleBudget = (n: number): number =>
      RANGE * Math.sqrt(Math.log((2 * n * (n + 1)) / ALPHA) / (2 * n));
    for (const n of [2, 10, 100]) {
      assert.ok(
        hoeffdingHalfWidth(n, RANGE, ALPHA) > singleBudget(n),
        `n=${n}: arms do not appear to split α`,
      );
    }
  });
});

// ── 3. Monte Carlo sanity under H0 (seeded, reproducible) ──────────────────

/** mulberry32: tiny, seeded, good enough for a coverage smoke test. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Hoeffding: continuous monitoring under H0 never fires (simulation)', () => {
  it('200 seeds, peeking after every run up to n=150, zero false positives', () => {
    // Honest about what this can and cannot show: at these horizons the bound
    // is so wide that the PRE-0.15 boundary also produces zero false positives
    // here, so this test does not discriminate between them. Falsifying the
    // old boundary empirically would need astronomically many looks, which is
    // exactly why the real check is the α-spend arithmetic above rather than a
    // simulation. What this does catch is an implementation that fires when it
    // should not.
    // Both arms drawn from the SAME Bernoulli(0.5) on {0,1}: the worst case
    // for a bounded-range bound, and H0 is true by construction. Note the
    // schedule: this one checks on balanced PAIRS, which is a weaker probe than
    // production's per-run looks. It is a sanity check that the bound does not
    // fire when it should not, not the primary evidence (that is the α-spend
    // arithmetic above). The mSPRT calibration test further down does use the
    // unbalanced per-run schedule, because there the schedule is the point.
    const SEEDS = 200;
    const HORIZON = 150;
    let falsePositives = 0;

    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = mulberry32(seed * 7919);
      const a: number[] = [];
      const b: number[] = [];
      for (let n = 1; n <= HORIZON; n++) {
        a.push(rnd() < 0.5 ? 0 : 1);
        b.push(rnd() < 0.5 ? 0 : 1);
        if (n < 2) continue;
        if (hoeffdingTwoSample(a, b, { alpha: ALPHA }).decisive) {
          falsePositives++;
          break;
        }
      }
    }

    // Asserted at zero, not at α. The title says zero, so the assertion has to
    // say zero: allowing 10 of 200 would have let a genuinely broken boundary
    // through while still reading green.
    assert.equal(
      falsePositives,
      0,
      `family-wise error ${falsePositives}/${SEEDS} (α=${ALPHA})`,
    );
  });

  it('still separates arms that genuinely differ, given enough runs', () => {
    // Power check. Without this, "never fires" would be trivially satisfiable
    // by a broken implementation that always returns decisive:false.
    const rnd = mulberry32(4242);
    const a: number[] = [];
    const b: number[] = [];
    for (let n = 1; n <= 400; n++) {
      a.push(rnd() < 0.15 ? 1 : 0); // mean ≈ 0.15
      b.push(rnd() < 0.85 ? 1 : 0); // mean ≈ 0.85
    }
    const v = hoeffdingTwoSample(a, b, { alpha: ALPHA });
    assert.equal(v.decisive, true);
    assert.equal(v.direction, 1);
  });
});

// ── 3a. The log-space Λ is the same function, just without the overflows ───

describe('mSPRT: log-space Λ matches the closed form on ordinary inputs', () => {
  it('agrees with the naive expression to floating-point noise', () => {
    // v0.15 rewrote Λ entirely in log space, because every direct form of it
    // overflowed somewhere: tau², then 1/ratio, then delta², then 2·varDelta,
    // each producing a confident WRONG verdict on some input. A rewrite that
    // fixes overflows by quietly computing a DIFFERENT function would be worse
    // than the bug, so this pins production against the closed form.
    //
    // It calls msprtTwoSample and derives (varDelta, delta) from meanVar, the
    // same way production does. An earlier version compared two local
    // reimplementations and therefore proved nothing about the shipped code;
    // cross-model review caught that.
    const naive = (v: number, tau: number, d: number): number => {
      const denom = v + tau * tau;
      return 0.5 * Math.log(v / denom) + (tau * tau * d * d) / (2 * v * denom);
    };

    let worst = 0;
    let worstAt = '';
    let compared = 0;
    // Arms with real spread across several magnitudes of variance and gap.
    for (const spread of [0.001, 0.01, 0.1, 1, 10]) {
      for (const gap of [0, 0.002, 0.05, 0.5, 5, 50]) {
        for (const tau of [0.001, 0.01, 0.1, 0.5, 2, 50]) {
          const a = [0, spread, -spread, spread / 2, -spread / 2];
          const b = a.map((x) => x + gap);
          const mv = meanVar(a);
          const mvB = meanVar(b);
          const varDelta = mv.variance / mv.n + mvB.variance / mvB.n;
          const delta = mvB.mean - mv.mean;
          const expected = naive(varDelta, tau, delta);
          if (!Number.isFinite(expected)) continue; // naive already broke
          const actual = Math.log(msprtTwoSample(a, b, { tau }).statistic);
          if (!Number.isFinite(actual)) continue; // Λ saturated; compared below
          compared++;
          const rel = Math.abs(expected - actual) / Math.max(1, Math.abs(expected));
          if (rel > worst) {
            worst = rel;
            worstAt = `spread=${spread} gap=${gap} tau=${tau}`;
          }
        }
      }
    }
    assert.ok(compared > 100, `grid compared only ${compared} cases; it may be vacuous`);
    assert.ok(worst < 1e-9, `production Λ diverges from the closed form at ${worstAt}: ${worst}`);
  });

  it('is seamless across the large-|L| shortcut at 700', () => {
    // The softplus/sigmoid shortcuts switch branch at |L| = 700, which is where
    // exp(L) leaves double range (overflow starts just above 709.78). The
    // cutoff was 30 until review showed that biased log Λ upward enough to flip
    // a correct non-decision into a false positive. A visible step here would
    // mean the shortcut is wrong rather than merely unrepresentable.
    const armA = [0.5, 0.6, 0.4, 0.55, 0.45];
    const armB = [1.5, 1.6, 1.4, 1.55, 1.45];
    // tau derived from the ACTUAL varDelta of these arms, not from an assumed
    // 1. An earlier version assumed varDelta ≈ 1 and landed at L ≈ 705 on both
    // sides, so it never crossed the seam it claimed to test.
    const mvA = meanVar(armA);
    const mvB = meanVar(armB);
    const varDelta = mvA.variance / mvA.n + mvB.variance / mvB.n;
    const at = (L: number): number =>
      msprtTwoSample(armA, armB, { tau: Math.exp((L + Math.log(varDelta)) / 2) }).statistic;
    const below = at(699.5);
    const above = at(700.5);
    assert.ok(Number.isFinite(Math.log(below)) && Number.isFinite(Math.log(above)));
    assert.ok(
      Math.abs(Math.log(above) - Math.log(below)) < 1,
      `discontinuity at the L=700 shortcut: ${below} -> ${above}`,
    );
  });

  it('identical multisets give bit-identical estimates whatever the order', () => {
    // Plain `sum += s` is order-dependent, and review turned that into a false
    // positive on BOTH shipped tests: 200 values within a few ULP of each
    // other, fed ascending and descending, gave means one ULP apart, which
    // mSPRT (variance then ~1e-32) read as Λ ≈ 1013 for arms that are literally
    // the same numbers. meanVar now uses Neumaier compensation.
    const u = Number.EPSILON;
    const xs = Array.from({ length: 200 }, (_, i) => 1 + (i % 3) * u);
    const asc = [...xs].sort((x, y) => x - y);
    const desc = [...asc].reverse();

    assert.equal(meanVar(asc).mean, meanVar(desc).mean, 'mean must not depend on order');
    assert.equal(
      meanVar(asc).variance,
      meanVar(desc).variance,
      'variance must not depend on order either',
    );

    // The two permutation pairs review produced after the first attempt at this
    // fix, where compensation alone was not enough and sorting is what closed it.
    const k = 2 ** -600;
    const p1 = [0, 2 ** -120 * k, k, 2 ** -53 * k, 2 ** -106 * k];
    const p2 = [0, k, 2 ** -106 * k, 2 ** -120 * k, 2 ** -53 * k];
    assert.equal(meanVar(p1).mean, meanVar(p2).mean);
    assert.equal(msprtTwoSample(p1, p2).decisive, false);
    const q1 = [2 ** -120, 1, 2 ** -53, 2 ** -106];
    const q2 = [1, 2 ** -106, 2 ** -120, 2 ** -53];
    assert.equal(meanVar(q1).mean, meanVar(q2).mean);

    // And overflow stays an honest Infinity rather than becoming NaN, which
    // would sail past a `> 0` guard that Infinity fails.
    const M = Number.MAX_VALUE;
    assert.equal(Number.isNaN(meanVar([M, M]).mean), false);
    assert.equal(Number.isNaN(meanVar([M, -M]).variance), false);
    assert.equal(msprtTwoSample(asc, desc).decisive, false);
    assert.equal(
      hoeffdingTwoSample(asc, desc, { lo: 1, hi: 1 + 2 * u }).decisive,
      false,
      'a tight declared range must not turn summation noise into a verdict',
    );
    // And the estimator still works: a real gap is still found.
    assert.equal(
      msprtTwoSample([0.54, 0.56, 0.54, 0.56, 0.55], [0.84, 0.86, 0.84, 0.86, 0.85]).decisive,
      true,
    );
  });

  it('every permutation of a multiset gives the identical estimate (exhaustive)', () => {
    // Stronger than the hand-picked pairs above: enumerate ALL orderings of a
    // few awkward multisets and require one distinct result each. Covers the
    // cases a sort-based guarantee could plausibly miss: -0 against +0, mixed
    // signs, duplicates, and terms whose magnitudes differ by 16 orders.
    const permutations = (xs: number[]): number[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) =>
            permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
          );

    for (const [label, xs] of [
      ['minus zero vs plus zero', [-0, 0, 1]],
      ['mixed signs', [-1e10, 1e-10, 5, -3.5]],
      ['duplicates', [0.1, 0.1, 0.2, 0.1]],
      ['catastrophic cancellation', [1e16, 1, -1e16, 1]],
      ['signed zeros only', [-0, 0, -0, 0]],
      ['cancelling extremes', [Number.MAX_VALUE, 1, -Number.MAX_VALUE, 1]],
      ['ordinary composites', [0.55, 0.62, 0.48, 0.71, 0.53]],
    ] as Array<[string, number[]]>) {
      const results = permutations(xs).map((p) => meanVar(p));
      // Object.is distinguishes -0 from 0; a mean of -0 and 0 is the same value
      // for every downstream purpose, so normalise before comparing.
      const means = new Set(results.map((r) => (Object.is(r.mean, -0) ? 0 : r.mean)));
      const variances = new Set(results.map((r) => r.variance));
      assert.equal(means.size, 1, `${label}: ${means.size} distinct means across permutations`);
      assert.equal(variances.size, 1, `${label}: ${variances.size} distinct variances`);
    }
  });

  it('the overflow cases the review found now return the right answer', () => {
    // All four were confident and wrong before v0.15.
    // delta² overflowed before a tiny shrink factor could damp it.
    const huge = msprtTwoSample([0, 2e150, 0, 2e150, 1e150], Array(5).fill(1e200));
    assert.equal(huge.decisive, false, 'overflowing delta must not read as evidence');
    assert.ok(Number.isFinite(huge.statistic), `statistic was ${huge.statistic}`);
    // 1/ratio overflowed, giving log Λ = -Infinity where the truth is ≈ -350.
    const bigTau = msprtTwoSample([-1, 1, -1, 1, 0], [1, 3, 1, 3, 2], { tau: 1e154 });
    assert.equal(bigTau.decisive, false);
    assert.ok(
      bigTau.statistic > 9e-153 && bigTau.statistic < 1e-152,
      `expected Λ ≈ 9.39e-153, got ${bigTau.statistic}`,
    );
    // 2·varDelta overflowed, collapsing the second term entirely.
    const bigVar = msprtTwoSample([-7e153, 7e153], [3.3e154, 4.7e154], {
      tau: 1e154,
      minSamplesPerArm: 2,
    });
    assert.equal(bigVar.decisive, true, 'this one IS decisive; the old code said otherwise');
    assert.ok(
      bigVar.statistic > 43.4 && bigVar.statistic < 43.5,
      `expected Λ ≈ 43.4327, got ${bigVar.statistic}`,
    );
    // The quotient inside the Hoeffding log overflowed for a tiny alpha.
    const tiny = hoeffdingTwoSample(Array(2000).fill(0), Array(2000).fill(1), {
      alpha: 1e-302,
    });
    assert.equal(tiny.decisive, true);
    assert.ok(Number.isFinite(tiny.threshold), `threshold was ${tiny.threshold}`);
  });
});

// ── 3b. mSPRT's ACTUAL type-I error, measured rather than assumed ──────────

describe('mSPRT: the plug-in variance overspends alpha at Darwin sample sizes', () => {
  /**
   * Type-I error under H0, measured the way production actually peeks: after
   * EVERY individual run, so the arms are unbalanced half the time. An earlier
   * version of this test appended one A and one B before checking, which only
   * ever produced balanced looks and understated the error. Cross-model review
   * caught that; the numbers below are the honest, unbalanced ones.
   */
  const typeIError = (horizon: number, seeds: number, alpha: number): number => {
    // Coarse judge: mostly two poles, so within-arm spread is often small by
    // chance, which is exactly when a plug-in variance understates the noise.
    const draw = (r: () => number): number => {
      const u = r();
      return u < 0.5 ? 0 : u < 0.55 ? 0.1 : 0.2;
    };
    let falsePositives = 0;
    for (let s = 1; s <= seeds; s++) {
      // Seeded WITHOUT the horizon, on purpose: the short run is then a strict
      // prefix of the long one, so "the error grows with the horizon" holds
      // pathwise instead of being an artefact of two different streams.
      const r = mulberry32(s * 2654435761 + Math.round(alpha * 1000));
      const a: number[] = [];
      const b: number[] = [];
      let fired = false;
      for (let n = 1; n <= horizon && !fired; n++) {
        a.push(draw(r));
        if (a.length >= 5 && b.length >= 5 && msprtTwoSample(a, b, { alpha }).decisive) fired = true;
        if (fired) break;
        b.push(draw(r));
        if (a.length >= 5 && b.length >= 5 && msprtTwoSample(a, b, { alpha }).decisive) fired = true;
      }
      if (fired) falsePositives++;
    }
    return falsePositives / seeds;
  };

  it('exceeds the configured alpha, and by more the longer you watch', () => {
    // Both arms come from the SAME distribution, so every rejection is a false
    // positive. These are the three figures the README, the CHANGELOG and the
    // mSPRT docstring print, re-derived here so the prose cannot drift.
    const at14 = typeIError(14, 20_000, 0.05);
    const at20 = typeIError(20, 20_000, 0.05);
    const at30 = typeIError(30, 20_000, 0.05);

    // The seeds are fixed, so these values are exactly reproducible:
    // 0.05905 / 0.06360 / 0.06880. Bands of ±0.0005 therefore pin what the
    // docs PRINT (0.059 / 0.064 / 0.069) against a change in the method.
    // What they do NOT do, since reproducible is not the same as accurate: at
    // 20,000 paths the Monte Carlo standard error on a rate near 0.06 is about
    // 0.0017, so the population type-I error is 0.059 ± 0.003ish, not 0.059
    // exactly. The qualitative finding (it exceeds α, and grows) is what
    // carries; the third decimal is this seed's.
    assert.ok(at14 > 0.0585 && at14 < 0.0595, `n=5..14 type-I was ${at14}`);
    assert.ok(at20 > 0.0631 && at20 < 0.0641, `n=5..20 type-I was ${at20}`);
    assert.ok(at30 > 0.0683 && at30 < 0.0693, `n=5..30 type-I was ${at30}`);
    // And the qualitative claim on top: all three exceed the configured alpha.
    for (const [label, v] of [['14', at14], ['20', at20], ['30', at30]] as const) {
      assert.ok(v > 0.05, `type-I through n=${label} did not exceed alpha: ${v}`);
    }
    assert.ok(at30 > at14, `error should grow with the horizon: ${at14} -> ${at30}`);
  });

  it('the alpha/2 split narrows the gap but does NOT restore calibration', () => {
    // What SafetyGate actually sends mSPRT under confidenceMethod 'msprt',
    // since the budget is shared with the Hoeffding fallback. Halving the
    // nominal level brings the real error near 0.045, which is closer to a
    // usable 0.05 but still nowhere near the 0.025 it was handed. Stated
    // because the CHANGELOG must not imply the split buys calibration.
    const at20 = typeIError(20, 20_000, 0.025);
    assert.ok(at20 > 0.025, `alpha/2 unexpectedly held its nominal level: ${at20}`);
    // Exact for the fixed seed: 0.04580, published as ~0.046.
    assert.ok(at20 > 0.0453 && at20 < 0.0463, `alpha/2 type-I was ${at20}`);
  });
});

// ── 4. The sample-size honesty flag ────────────────────────────────────────

describe('Hoeffding: inconclusiveByConstruction', () => {
  it('is true at Darwin default sample sizes, where nothing can fire', () => {
    // The most extreme data the [0,1] range allows: every A run scores 0,
    // every B run scores 1. Even THIS cannot clear the bar at n=20, which sits
    // inside computeDynamicMinRuns' 10-to-30 window.
    const a = Array(20).fill(0);
    const b = Array(20).fill(1);
    const v = hoeffdingTwoSample(a, b);
    assert.equal(v.decisive, false);
    assert.equal(v.inconclusiveByConstruction, true);
    assert.match(v.reason, /NO gap can clear this bar/);
    assert.match(v.reason, /msprt/);
  });

  it('mSPRT decides the same data, which is why it is the recommended gate', () => {
    // Near-extreme arms with a whisker of spread, because since v0.15 mSPRT
    // abstains on arms with NO spread at all (that shortcut ignored alpha).
    const a = Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.02 : 0.0));
    const b = Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.98 : 1.0));
    assert.equal(hoeffdingTwoSample(a, b).decisive, false);
    assert.equal(hoeffdingTwoSample(a, b).inconclusiveByConstruction, true);
    assert.equal(msprtTwoSample(a, b).decisive, true);
  });

  it('clears once the arms have enough runs for the bar to fit inside the range', () => {
    const a = Array(60).fill(0);
    const b = Array(60).fill(1);
    const v = hoeffdingTwoSample(a, b);
    assert.equal(v.inconclusiveByConstruction, false);
    assert.equal(v.decisive, true);
  });

  it('fails CLOSED on samples outside the declared range', () => {
    // The reachable path a cross-model review found: MetricWeights takes
    // arbitrary numbers and the composite is not clamped, so weights like
    // {quality: 2, sourceCount: -1} produce composites of 0.2 and 2.0. At 20
    // runs per arm the [0,1] bar is 1.021, and the 1.8 gap used to clear it
    // and promote B on a guarantee that does not hold outside [0,1].
    const v = hoeffdingTwoSample(Array(20).fill(0.2), Array(20).fill(2.0));
    assert.equal(v.decisive, false, 'out-of-range data must not produce a decision');
    assert.match(v.reason, /outside the declared score range/);
    assert.equal(v.threshold, Infinity);

    // Below lo as well, not just above hi.
    assert.equal(hoeffdingTwoSample(Array(20).fill(-0.5), Array(20).fill(0.9)).decisive, false);

    // And in range it still decides, so the guard is not just refusing everything.
    assert.equal(hoeffdingTwoSample(Array(60).fill(0), Array(60).fill(1)).decisive, true);

    // A declared range that actually covers the data works fine.
    const wide = hoeffdingTwoSample(Array(60).fill(0.2), Array(60).fill(2.0), { lo: 0, hi: 2 });
    assert.equal(wide.decisive, true);
  });

  it('fails CLOSED on an inverted or empty range instead of assuming 1', () => {
    // Until v0.15 `hi <= lo` silently became range 1, so a caller who passed
    // the bounds the wrong way round got a confident verdict computed against
    // a range nobody declared.
    for (const opts of [{ lo: 5, hi: 2 }, { lo: 1, hi: 1 }]) {
      const v = hoeffdingTwoSample(Array(60).fill(1.5), Array(60).fill(4.5), opts);
      assert.equal(v.decisive, false, `range ${JSON.stringify(opts)} must not decide`);
      assert.match(v.reason, /invalid score range/);
    }
  });

  it('never contradicts the verdict, even on out-of-range input', () => {
    // Samples outside [lo, hi] break the bounded-variable contract. The verdict
    // is then meaningless either way, but it must not be self-contradictory:
    // "decisive" and "inconclusive by construction" can never both be true.
    const cases: Array<[number[], number[], { lo?: number; hi?: number }]> = [
      [Array(20).fill(0), Array(20).fill(1), {}],
      [Array(20).fill(-5), Array(20).fill(5), {}], // way outside [0,1]
      [Array(60).fill(0), Array(60).fill(1), {}],
      [Array(5).fill(0.1), Array(5).fill(0.9), {}],
      [Array(30).fill(0), Array(30).fill(10), { lo: 0, hi: 1 }],
    ];
    for (const [a, b, opts] of cases) {
      const v = hoeffdingTwoSample(a, b, opts);
      assert.ok(
        !(v.decisive && v.inconclusiveByConstruction),
        `contradictory verdict for n=${v.nA}/${v.nB}: ${v.reason}`,
      );
    }
  });

  it('pins the exact sample sizes the README and the docstring quote', () => {
    // These four numbers are stated as fact in the README's statistical-scope
    // table, in the CHANGELOG and in sequential.ts. Pinning them here means
    // the prose cannot drift away from the implementation: change the
    // boundary and this test tells you which sentences to rewrite.
    const bar = (n: number): number => 2 * hoeffdingHalfWidth(n, RANGE, ALPHA);

    // "no data can fire at n ≤ 21, the bar first fits inside the range at 22"
    assert.ok(bar(21) >= RANGE, `n=21 bar ${bar(21)} should not fit in the range`);
    assert.ok(bar(22) < RANGE, `n=22 bar ${bar(22)} should fit in the range`);

    // "0.865 at the computeDynamicMinRuns ceiling of 30"
    assert.ok(Math.abs(bar(30) - 0.865) < 0.001, `n=30 bar was ${bar(30)}`);

    // "a +0.2 lift needs n=900 per arm"
    assert.ok(bar(899) >= 0.2, `n=899 bar ${bar(899)} should still exceed 0.2`);
    assert.ok(bar(900) < 0.2, `n=900 bar ${bar(900)} should be under 0.2`);
  });

  it('scales with the score range, not with a hardcoded number', () => {
    // On a 0-to-10 scale the same n behaves identically in relative terms.
    const a = Array(20).fill(0);
    const b = Array(20).fill(10);
    const v = hoeffdingTwoSample(a, b, { lo: 0, hi: 10 });
    assert.equal(v.inconclusiveByConstruction, true);
    assert.equal(v.decisive, false);
  });
});

// ── 5. The gate says so out loud instead of freezing silently ──────────────

describe('SafetyGate: warns when the Hoeffding gate cannot decide', () => {
  /** Runs `fn` with console.warn captured. */
  function captureWarnings(fn: () => void): string[] {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void seen.push(args.join(' '));
    try {
      fn();
    } finally {
      console.warn = original;
    }
    return seen;
  }

  const gateOptions = {
    minDataPoints: 20,
    maxRegression: 0.2,
    failureRollbackThreshold: 3,
    requireConfidence: true,
    confidenceMethod: 'hoeffding' as const,
  };
  // Slight spread: mSPRT abstains on perfectly constant arms since v0.15, and
  // the mSPRT comparison test below needs it to actually decide.
  const samples = {
    a: Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.39 : 0.41)),
    b: Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.89 : 0.91)),
  };

  it('warns once, not on every run, and keeps the test open', () => {
    resetInertConfidenceWarningForTests();
    const gate = new SafetyGate(gateOptions);
    const warnings = captureWarnings(() => {
      for (let i = 0; i < 5; i++) {
        // A clear 125% margin for B over 20 runs per arm. Without the
        // confidence gate this would be 'b_wins'; Hoeffding cannot confirm it
        // at n=20, so the test stays open and the operator gets told why.
        // Asserted as 'continue', not merely "not b_wins": the title promises
        // the test stays OPEN, and an erroneous early 'a_wins' would close it
        // while still passing a not-b_wins check.
        const outcome = gate.evaluateABTest(0.4, 0.9, 20, 20, 0, 0, 20, samples);
        assert.equal(outcome, 'continue');
      }
    });
    assert.equal(warnings.length, 1, `expected exactly one warning, got ${warnings.length}`);
    assert.match(warnings[0], /cannot confirm a score margin at this sample size/);
    assert.match(warnings[0], /msprt/);
  });

  it('the latch survives a NEW SafetyGate, because the CLI builds one per run', () => {
    // The regression this pins: `darwin run` goes through buildEvolutionLoop,
    // which constructs a fresh SafetyGate every single run. With a per-instance
    // latch the notice would reappear on every run rather than once, which is
    // how an operator hint turns into stderr noise. Cross-model review R1
    // caught exactly that.
    resetInertConfidenceWarningForTests();
    const warnings = captureWarnings(() => {
      for (let i = 0; i < 4; i++) {
        new SafetyGate(gateOptions).evaluateABTest(0.4, 0.9, 20, 20, 0, 0, 20, samples);
      }
    });
    assert.equal(warnings.length, 1, `four fresh gates warned ${warnings.length} times`);
  });

  it('does not claim more than it can: the reliability rule still promotes B', () => {
    // The warning says promotion is blocked "on quality". It must not say
    // promotion is impossible, because evaluateABTest runs the reliability
    // auto-loss BEFORE the confidence gate: an incumbent failing more than
    // half its attempts hands the test to B regardless of Hoeffding.
    resetInertConfidenceWarningForTests();
    const gate = new SafetyGate(gateOptions);
    // A: 1 success, 2 failures (3 attempts, >50% failure) => B wins on
    // reliability, without the sequential test ever being consulted.
    assert.equal(gate.evaluateABTest(0.9, 0.4, 1, 20, 2, 0, 20, samples), 'b_wins');
  });

  it('spread-free arms fall back to Hoeffding, which decides a large gap', () => {
    // v0.15 makes mSPRT abstain when neither arm shows spread, which is right
    // (the old branch fired regardless of alpha) but leaves a legitimate setup
    // stranded: a deterministic or rule-based evaluator returns the same score
    // every run, so its arms are exactly constant. The gate hands that case to
    // Hoeffding, which needs no variance estimate. With a large gap it decides.
    resetInertConfidenceWarningForTests();
    const gate = new SafetyGate({ ...gateOptions, confidenceMethod: 'msprt' });
    assert.equal(
      gate.evaluateABTest(0.1, 0.95, 60, 60, 0, 0, 30, {
        a: Array(60).fill(0.1),
        // gap 0.85. The gate runs the fallback at α/2, so the operative bar
        // at n=60 is 0.665 (0.648 is the primitive at full α).
        b: Array(60).fill(0.95),
      }),
      'b_wins',
    );
  });

  it('but a SMALL deterministic gap no longer promotes, and that is the trade', () => {
    // Stated as a test rather than buried in prose, because it is a real
    // behaviour change from v0.14: constant arms at 0.6 vs 0.8 used to promote
    // B through the zero-variance shortcut. The gap is 0.2, the Hoeffding bar
    // at n=60 is 0.648, and resolving 0.2 distribution-free would take n=900,
    // which the 2×minRuns cap never reaches.
    //
    // That is the honest answer: from constant observations alone you cannot
    // tell a deterministic scorer from a small sample that happened to come out
    // constant. Anyone who wants the old behaviour has the documented route:
    // leave requireConfidence off, or use the 'effect-size' method, which is a
    // heuristic and says so.
    resetInertConfidenceWarningForTests();
    const strict = new SafetyGate({ ...gateOptions, confidenceMethod: 'msprt' });
    const samplesSmallGap = { a: Array(60).fill(0.6), b: Array(60).fill(0.8) };
    assert.notEqual(
      strict.evaluateABTest(0.6, 0.8, 60, 60, 0, 0, 30, samplesSmallGap),
      'b_wins',
    );

    // The documented escape hatch actually works.
    const heuristic = new SafetyGate({ ...gateOptions, confidenceMethod: 'effect-size' });
    assert.equal(
      heuristic.evaluateABTest(0.6, 0.8, 60, 60, 0, 0, 30, samplesSmallGap),
      'b_wins',
    );
  });

  it('surfaces an invalid-input refusal instead of swallowing it', () => {
    // Without this the loop turns "your composites are outside the declared
    // range" into a plain false, drifts to the incumbent tie-break, and the
    // operator never learns why nothing ever gets promoted.
    resetInertConfidenceWarningForTests();
    const gate = new SafetyGate(gateOptions);
    const warnings = captureWarnings(() => {
      const outcome = gate.evaluateABTest(0.2, 2.0, 60, 60, 0, 0, 30, {
        a: Array(60).fill(0.2),
        b: Array(60).fill(2.0), // outside the default [0,1]
      });
      assert.notEqual(outcome, 'b_wins');
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /input is invalid/);
    assert.match(warnings[0], /outside the declared score range/);
  });

  it('stays quiet when mSPRT is used, because mSPRT can decide here', () => {
    resetInertConfidenceWarningForTests();
    const gate = new SafetyGate({ ...gateOptions, confidenceMethod: 'msprt' });
    const warnings = captureWarnings(() => {
      const outcome = gate.evaluateABTest(0.4, 0.9, 20, 20, 0, 0, 20, samples);
      assert.equal(outcome, 'b_wins');
    });
    assert.equal(warnings.length, 0);
  });
});
