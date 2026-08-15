/**
 * Darwin v0.16: the empirical Bernstein confidence sequence, checked rather
 * than claimed.
 *
 * `ebTwoSample` implements the predictable plug-in empirical Bernstein CS of
 * Waudby-Smith & Ramdas (JRSS-B 2024, Theorem 2). Its docstring imports the
 * supermartingale inequality from the paper instead of re-deriving it, so
 * this file holds the code to the same standard v0.15 set for Hoeffding and
 * mSPRT: measure, do not believe.
 *
 *   1. The imported inequality itself is checked numerically: for discrete
 *      distributions the expectation E[exp{λ(Y−μ) − 4(Y−m̂)²ψ_E(λ)}] is an
 *      EXACT finite sum, evaluated over a grid of distributions, bets λ and
 *      predictable means m̂. If it exceeded 1 anywhere, the whole guarantee
 *      would be void.
 *   2. The empirical type-I error under continuous peeking (the production
 *      access pattern: a look after every single observation, arms unbalanced
 *      half the time) is measured under H0 and must stay at or below α, and
 *      must NOT grow with the horizon the way the same suite measures mSPRT's
 *      error growing.
 *   3. The production implementation is pinned against an independent
 *      reference implementation written from the paper's formulas, plus a
 *      hand-checkable constant.
 *   4. Every number in the docstring's power table is re-measured here.
 *
 * Five mutation probes ran during development (each reverted before commit):
 * dropping the α split (L = ln(2/α) instead of ln(4/α)) fails the reference
 * pin and the power pins; dropping the /4 in ψ_E fails the supermartingale
 * grid and the pins; sorting the samples before accumulating fails the
 * order-sensitivity pin; removing the structural floor fails the boundary
 * test at n=17; removing the SafetyGate 'eb' dispatch (silently falling to
 * mSPRT) fails the gate-wiring tests. None of these tests is vacuous.
 *
 * Everything here is deterministic. The Monte Carlo sections use a seeded
 * mulberry32 so a red run is always reproducible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ebTwoSample,
  ebIntervalForArm,
  hoeffdingHalfWidth,
  meanVar,
} from '../src/evolution/sequential.js';
import {
  SafetyGate,
  resetInertConfidenceWarningForTests,
} from '../src/evolution/safety.js';

const ALPHA = 0.05;

/** Same PRNG the coverage suite uses; seeded, fully reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal, clamped into [0, 1] (a bounded judge score). */
function boundedNormal(rng: () => number, mean: number, sd: number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(1, Math.max(0, mean + sd * z));
}

// ── 1. The imported supermartingale inequality, checked exactly ────────────

describe('EB supermartingale inequality (WSR Theorem 2, checked numerically)', () => {
  // ψ_E exactly as the paper defines it. Written out here independently so a
  // typo in the production ψ_E cannot hide behind this test using it.
  const psiE = (lambda: number): number => (-Math.log(1 - lambda) - lambda) / 4;

  it('E[exp{λ(Y−μ) − 4(Y−m̂)²ψ_E(λ)}] ≤ 1 on an exact grid of discrete laws', () => {
    // Discrete distributions on [0, 1]: support points + probabilities.
    // Expectations over these are EXACT finite sums, no simulation error.
    const laws: Array<{ ys: number[]; ps: number[] }> = [
      { ys: [0, 1], ps: [0.5, 0.5] }, // Bernoulli(0.5), max variance
      { ys: [0, 1], ps: [0.9, 0.1] }, // skewed Bernoulli
      { ys: [0, 0.1, 0.2], ps: [0.5, 0.05, 0.45] }, // the coarse judge from the mSPRT suite
      { ys: [0.65], ps: [1] }, // constant arm (zero variance)
      { ys: [0.2, 0.5, 0.8], ps: [1 / 3, 1 / 3, 1 / 3] },
      { ys: [0, 0.25, 0.5, 0.75, 1], ps: [0.2, 0.2, 0.2, 0.2, 0.2] },
    ];
    const lambdas = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99];
    const mHats = [0, 0.25, 0.5, 0.75, 1]; // any predictable estimate is allowed

    for (const { ys, ps } of laws) {
      const mu = ys.reduce((s, y, i) => s + y * ps[i], 0);
      for (const lambda of lambdas) {
        for (const mHat of mHats) {
          let expectation = 0;
          for (let i = 0; i < ys.length; i++) {
            const y = ys[i];
            const v = 4 * (y - mHat) ** 2;
            expectation += ps[i] * Math.exp(lambda * (y - mu) - v * psiE(lambda));
          }
          assert.ok(
            expectation <= 1 + 1e-12,
            `inequality violated: law=[${ys}] λ=${lambda} m̂=${mHat} E=${expectation}`,
          );
        }
      }
    }
  });
});

// ── 2. Type-I error under continuous peeking stays at or below α ───────────

describe('EB type-I error under continuous peeking (H0, measured)', () => {
  /**
   * Under H0 both arms draw from the SAME law. A look happens after every
   * single observation (arms unbalanced half the time), which is exactly how
   * the safety gate consumes this in production. The guarantee promises the
   * probability that ANY look comes back decisive is at most α; the same
   * suite measures mSPRT exceeding its α under this access pattern, so this
   * is the discriminating comparison, not a formality.
   */
  function typeIError(
    draw: (rng: () => number) => number,
    horizon: number,
    runs: number,
    seedBase: number,
  ): number {
    let falsePositives = 0;
    for (let run = 0; run < runs; run++) {
      const rng = mulberry32(seedBase + run);
      const a: number[] = [];
      const b: number[] = [];
      let fired = false;
      for (let n = 0; n < horizon && !fired; n++) {
        a.push(draw(rng));
        if (ebTwoSample(a, b).decisive) fired = true;
        b.push(draw(rng));
        if (ebTwoSample(a, b).decisive) fired = true;
      }
      if (fired) falsePositives++;
    }
    return falsePositives / runs;
  }

  it('coarse judge law: error ≤ α at every horizon, and does not grow past it', () => {
    const coarseJudge = (rng: () => number): number => {
      const u = rng();
      return u < 0.5 ? 0 : u < 0.55 ? 0.1 : 0.2;
    };
    // The horizons the mSPRT suite documents its 0.059 / 0.064 / 0.069 at.
    for (const horizon of [14, 20, 30]) {
      const err = typeIError(coarseJudge, horizon, 4000, 7000);
      assert.ok(
        err <= ALPHA,
        `type-I error ${err} exceeds α=${ALPHA} at horizon ${horizon}`,
      );
    }
  });

  it('Bernoulli(0.5), the max-variance law: error ≤ α through n=60', () => {
    const bern = (rng: () => number): number => (rng() < 0.5 ? 0 : 1);
    const err = typeIError(bern, 60, 3000, 9100);
    assert.ok(err <= ALPHA, `type-I error ${err} exceeds α=${ALPHA}`);
  });

  it('uniform[0,1]: error ≤ α through n=60', () => {
    const uni = (rng: () => number): number => rng();
    const err = typeIError(uni, 60, 3000, 9300);
    assert.ok(err <= ALPHA, `type-I error ${err} exceeds α=${ALPHA}`);
  });
});

// ── 3. The implementation matches the paper's formulas ─────────────────────

describe('EB implementation pinned against an independent reference', () => {
  /**
   * Reference implementation transcribed directly from WSR Theorem 2,
   * structured differently from production (arrays of intermediates instead
   * of running accumulators) so a shared structural bug is unlikely.
   */
  function referenceEb(
    samples: number[],
    alpha: number,
    c: number,
  ): { center: number; halfWidth: number } {
    const L = Math.log(2 / (alpha / 2)); // ln(2/α_arm), α_arm = α/2
    const t = samples.length;
    // μ̂_i for i = 0..t and σ̂²_i for i = 0..t, exactly per the paper.
    const muHat: number[] = [0.5];
    const sigmaSq: number[] = [0.25];
    for (let i = 1; i <= t; i++) {
      const sumY = samples.slice(0, i).reduce((s, y) => s + y, 0);
      muHat.push((0.5 + sumY) / (i + 1));
    }
    for (let i = 1; i <= t; i++) {
      let s = 0.25;
      for (let j = 1; j <= i; j++) s += (samples[j - 1] - muHat[j]) ** 2;
      sigmaSq.push(s / (i + 1));
    }
    let sumLambda = 0;
    let sumLambdaY = 0;
    let sumPenalty = 0;
    for (let i = 1; i <= t; i++) {
      const raw = Math.sqrt((2 * L) / (sigmaSq[i - 1] * i * Math.log(i + 1)));
      const lambda = Math.min(Number.isFinite(raw) ? raw : Infinity, c);
      const v = 4 * (samples[i - 1] - muHat[i - 1]) ** 2;
      const psi = (-Math.log(1 - lambda) - lambda) / 4;
      sumLambda += lambda;
      sumLambdaY += lambda * samples[i - 1];
      sumPenalty += v * psi;
    }
    return {
      center: sumLambdaY / sumLambda,
      halfWidth: (L + sumPenalty) / sumLambda,
    };
  }

  it('agrees with the reference to 1e-12 across seeded random sequences', () => {
    for (const seed of [11, 222, 3333]) {
      const rng = mulberry32(seed);
      const samples = Array.from({ length: 120 }, () => rng());
      const ref = referenceEb(samples, ALPHA, 0.5);
      const got = ebIntervalForArm(samples);
      assert.ok(Math.abs(got.center - ref.center) < 1e-12, `center ${got.center} vs ${ref.center}`);
      assert.ok(
        Math.abs(got.halfWidth - ref.halfWidth) < 1e-12,
        `width ${got.halfWidth} vs ${ref.halfWidth}`,
      );
    }
  });

  it('pins the hand sequence [0.2, 0.8, 0.5] exactly', () => {
    const iv = ebIntervalForArm([0.2, 0.8, 0.5]);
    // The λ-weighted center of a symmetric sequence around 0.5 is 0.5, and
    // the half-width is pinned to the digit so ANY formula drift shows up.
    assert.equal(iv.center, 0.5);
    assert.equal(iv.halfWidth, 2.9590147899917767);
    assert.equal(iv.n, 3);
  });

  it('respects lo/hi scaling: a [0,10] sequence matches the scaled [0,1] one', () => {
    const scaled = ebIntervalForArm([2, 8, 5], { lo: 0, hi: 10 });
    assert.ok(Math.abs(scaled.center - 5) < 1e-12);
    assert.ok(Math.abs(scaled.halfWidth - 10 * 2.9590147899917767) < 1e-9);
  });
});

// ── 4. The docstring's power table, re-measured ────────────────────────────

describe('EB power table (every docstring number re-measured)', () => {
  function firstDecisiveEb(gen: (rng: () => number, arm: 'a' | 'b') => number, maxN: number, seed: number): number {
    const rng = mulberry32(seed);
    const a: number[] = [];
    const b: number[] = [];
    for (let n = 1; n <= maxN; n++) {
      a.push(gen(rng, 'a'));
      b.push(gen(rng, 'b'));
      if (ebTwoSample(a, b).decisive) return n;
    }
    return -1;
  }

  function medianFirstDecisive(gen: (rng: () => number, arm: 'a' | 'b') => number, maxN: number): number {
    const seeds = Array.from({ length: 21 }, (_, i) => 1000 + i * 37);
    const results = seeds.map((s) => firstDecisiveEb(gen, maxN, s)).filter((n) => n > 0);
    assert.equal(results.length, 21, 'every seeded run must reach a decision');
    results.sort((x, y) => x - y);
    return results[10];
  }

  /** Exact first n at which Hoeffding's data-independent two-arm bar drops below `gap`. */
  function hoeffdingFirstPossible(gap: number): number {
    let n = 1;
    while (2 * hoeffdingHalfWidth(n, 1, ALPHA) >= gap && n < 1_000_000) n++;
    return n;
  }

  it('constant arms decide exactly where the docstring says', () => {
    // 0 vs 1: first decisive at n=18, one observation past the structural
    // blind zone (through n=17). 0.1 vs 0.95: n=21.
    const firstN = (a: number, b: number): number => {
      for (let n = 1; n <= 100; n++) {
        if (ebTwoSample(Array(n).fill(a), Array(n).fill(b)).decisive) return n;
      }
      return -1;
    };
    assert.equal(firstN(0, 1), 18);
    assert.equal(firstN(0.1, 0.95), 21);
    // Hoeffding's exact columns for the same rows.
    assert.equal(hoeffdingFirstPossible(1.0), 22);
    assert.equal(hoeffdingFirstPossible(0.85), 32);
  });

  it('σ≈0.05 gap 0.30: median n ≈ 59 vs Hoeffding exact 359', () => {
    const med = medianFirstDecisive(
      (rng, arm) => boundedNormal(rng, arm === 'a' ? 0.3 : 0.6, 0.05),
      300,
    );
    assert.ok(med >= 50 && med <= 70, `median ${med} left the pinned band [50, 70]`);
    assert.equal(hoeffdingFirstPossible(0.3), 359);
    assert.ok(med < 359 / 4, 'EB must beat Hoeffding by more than 4x here');
  });

  it('σ≈0.05 gap 0.20: median n ≈ 89 vs Hoeffding exact 900', () => {
    const med = medianFirstDecisive(
      (rng, arm) => boundedNormal(rng, arm === 'a' ? 0.4 : 0.6, 0.05),
      400,
    );
    assert.ok(med >= 75 && med <= 105, `median ${med} left the pinned band [75, 105]`);
    assert.equal(hoeffdingFirstPossible(0.2), 900);
    assert.ok(med < 900 / 4, 'EB must beat Hoeffding by more than 4x here');
  });

  it('σ≈0.10 gap 0.10 (judge noise): median n ≈ 188 vs Hoeffding exact 4216', () => {
    const med = medianFirstDecisive(
      (rng, arm) => boundedNormal(rng, arm === 'a' ? 0.6 : 0.7, 0.1),
      800,
    );
    assert.ok(med >= 120 && med <= 240, `median ${med} left the pinned band [120, 240]`);
    assert.equal(hoeffdingFirstPossible(0.1), 4216);
    assert.ok(med < 4216 / 10, 'EB must beat Hoeffding by more than 10x here');
  });
});

// ── 5. Structural floor and the inconclusive flag ──────────────────────────

describe('EB structural blind zone (flag and boundary)', () => {
  it('n=17 with a full-range gap: not decisive, flagged inconclusiveByConstruction', () => {
    const v = ebTwoSample(Array(17).fill(0), Array(17).fill(1));
    assert.equal(v.decisive, false);
    assert.equal(v.inconclusiveByConstruction, true);
    assert.match(v.reason, /NO gap can clear this bar/);
  });

  it('n=18 with a full-range gap: decisive, so the flag never overstates', () => {
    const v = ebTwoSample(Array(18).fill(0), Array(18).fill(1));
    assert.equal(v.decisive, true);
    assert.equal(v.direction, 1);
    assert.equal(v.inconclusiveByConstruction, false);
  });

  it('the flag keys on the data-free floor, so it asserts impossibility only', () => {
    // Small arms with a tiny gap: not decisive, and since n ≤ 17 the flag
    // must be on regardless of what the data look like.
    const v = ebTwoSample([0.5, 0.5, 0.5, 0.5], [0.52, 0.52, 0.52, 0.52]);
    assert.equal(v.decisive, false);
    assert.equal(v.inconclusiveByConstruction, true);
  });
});

// ── 6. Fail-closed guards (same contract as the other two entry points) ────

describe('EB fail-closed guards', () => {
  const okA = [0.4, 0.5, 0.6];
  const okB = [0.5, 0.6, 0.7];

  it('explicitly invalid alpha refuses instead of running a 5% test', () => {
    for (const alpha of [0, 1, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = ebTwoSample(okA, okB, { alpha });
      assert.equal(v.decisive, false);
      assert.equal(v.invalidInput, true);
      assert.match(v.reason, /invalid alpha/);
    }
  });

  it('explicitly invalid truncation refuses (0 and 1 break the construction)', () => {
    for (const truncation of [0, 1, -0.5, 1.5, Number.NaN]) {
      const v = ebTwoSample(okA, okB, { truncation });
      assert.equal(v.invalidInput, true);
      assert.match(v.reason, /invalid truncation/);
    }
  });

  it('inverted or non-finite score bounds refuse', () => {
    assert.equal(ebTwoSample(okA, okB, { lo: 1, hi: 0 }).invalidInput, true);
    assert.equal(ebTwoSample(okA, okB, { lo: 0.5, hi: 0.5 }).invalidInput, true);
    assert.equal(ebTwoSample(okA, okB, { lo: Number.NaN }).invalidInput, true);
    assert.equal(ebTwoSample(okA, okB, { hi: Number.POSITIVE_INFINITY }).invalidInput, true);
  });

  it('ebIntervalForArm refuses everything ebTwoSample refuses (verify round 1)', () => {
    // Verify round 1 found the helper silently defaulting an explicitly
    // non-finite lo/hi to [0, 1] while the entry point refused the same input,
    // so an experiment sized via the helper could rest on a configuration the
    // gate would reject. The helper must mirror every entry-point guard.
    const bad: Array<Parameters<typeof ebIntervalForArm>[1]> = [
      { alpha: 0 },
      { truncation: 1 },
      { lo: Number.NaN, hi: 5 },
      { hi: Number.POSITIVE_INFINITY },
      { lo: 1, hi: 0 },
    ];
    for (const opts of bad) {
      const iv = ebIntervalForArm(okA, opts);
      assert.ok(Number.isNaN(iv.center), `center must be NaN for ${JSON.stringify(opts)}`);
      assert.equal(iv.halfWidth, Number.POSITIVE_INFINITY);
    }
  });

  it('samples outside the declared range refuse (the fail-open lesson)', () => {
    const v = ebTwoSample([0.2, 2.0], [0.5, 0.6]);
    assert.equal(v.decisive, false);
    assert.equal(v.invalidInput, true);
    assert.match(v.reason, /outside the declared score range/);
  });

  it('an overflowing range (lo=-MAX, hi=+MAX) is refused, not decided', () => {
    const v = ebTwoSample([0.1, 0.2], [0.8, 0.9], {
      lo: -Number.MAX_VALUE,
      hi: Number.MAX_VALUE,
    });
    assert.equal(v.decisive, false);
    assert.equal(v.invalidInput, true);
    assert.match(v.reason, /numeric overflow/);
  });

  it('extreme but valid alphas produce finite, NaN-free verdicts', () => {
    for (const alpha of [Number.MIN_VALUE, 1 - 1e-16]) {
      const v = ebTwoSample(okA, okB, { alpha });
      assert.equal(v.invalidInput ?? false, false);
      assert.ok(Number.isFinite(v.statistic));
      assert.ok(Number.isFinite(v.threshold));
    }
  });

  it('warmup abstains below minSamplesPerArm, and non-finite entries are dropped', () => {
    const v = ebTwoSample([0.5], [0.6, 0.7]);
    assert.equal(v.decisive, false);
    assert.match(v.reason, /warmup/);
    // NaN entries do not count toward n and do not poison the estimate.
    const w = ebTwoSample([0.5, Number.NaN, 0.6], [0.6, 0.7]);
    assert.equal(w.nA, 2);
    assert.equal(meanVar([0.5, Number.NaN, 0.6]).n, 2);
  });
});

// ── 7. Order sensitivity is real, documented, and bounded ──────────────────

describe('EB order sensitivity (documented contract, not a bug)', () => {
  it('the same multiset in a different order may produce a different interval', () => {
    const fwd = ebIntervalForArm([0.1, 0.2, 0.9, 0.8, 0.5]);
    const rev = ebIntervalForArm([0.5, 0.8, 0.9, 0.2, 0.1]);
    // Pinned as a DOCUMENTED behaviour: the bet λ_i is predictable from the
    // prefix, so order is semantic (the docstring says why, and why both
    // results are valid at level α). If someone "fixes" this by sorting,
    // this test goes red and points them to the docstring.
    assert.notEqual(fwd.halfWidth, rev.halfWidth);
    // Both are computed, finite, and cover the same territory.
    assert.ok(Number.isFinite(fwd.halfWidth) && Number.isFinite(rev.halfWidth));
    assert.ok(Math.abs(fwd.center - rev.center) < 0.05);
  });
});

// ── 8. SafetyGate wiring ───────────────────────────────────────────────────

describe("SafetyGate confidenceMethod 'eb'", () => {
  const thresholds = {
    minDataPoints: 10,
    maxRegression: 0.2,
    failureRollbackThreshold: 3,
    requireConfidence: true,
    confidenceMethod: 'eb' as const,
  };

  it('usesSequentialConfidence() is true, so the loop loads per-arm samples', () => {
    assert.equal(new SafetyGate(thresholds).usesSequentialConfidence(), true);
  });

  it('promotes a challenger only when the EB verdict is decisive in its favour', () => {
    resetInertConfidenceWarningForTests();
    const gate = new SafetyGate(thresholds);
    // 30 runs per arm, constant scores with a huge gap: decisive for B.
    const a = Array(30).fill(0.1);
    const b = Array(30).fill(0.95);
    const outcome = gate.evaluateABTest(0.1, 0.95, 30, 30, 0, 0, 10, { a, b });
    assert.equal(outcome, 'b_wins');
  });

  it('blocks the margin path while EB is structurally inconclusive, then ties out', () => {
    resetInertConfidenceWarningForTests();
    const gate = new SafetyGate(thresholds);
    // 12 runs per arm: inside the blind zone (n ≤ 17), so a wide margin must
    // NOT promote. Below 2×minRuns the test continues; at 2×minRuns the
    // incumbent tie-break fires, exactly like the Hoeffding path.
    const a = Array(12).fill(0.2);
    const b = Array(12).fill(0.9);
    assert.equal(gate.evaluateABTest(0.2, 0.9, 12, 12, 0, 0, 10, { a, b }), 'continue');
    const a20 = Array(20).fill(0.2);
    const b20 = Array(20).fill(0.9);
    assert.equal(gate.evaluateABTest(0.2, 0.9, 20, 20, 0, 0, 10, { a: a20, b: b20 }), 'a_wins');
  });

  it('a decisive EB verdict for the WRONG side does not confirm the margin', () => {
    resetInertConfidenceWarningForTests();
    const gate = new SafetyGate(thresholds);
    // Composite args claim B leads on the margin, but the SAMPLES say A
    // leads decisively. The gate must refuse the confirmation (falls through
    // to continue below 2×minRuns).
    const a = Array(30).fill(0.95);
    const b = Array(30).fill(0.1);
    const outcome = gate.evaluateABTest(0.5, 0.6, 30, 30, 0, 0, 20, { a, b });
    assert.notEqual(outcome, 'b_wins');
  });

  it('invalid input surfaces the eb method name in the once-per-cause warning', () => {
    resetInertConfidenceWarningForTests();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => {
      warnings.push(String(msg));
    };
    try {
      const gate = new SafetyGate(thresholds);
      const a = Array(30).fill(0.5);
      const b = Array(30).fill(2.5); // outside [0,1]: EB refuses
      // Margin says B leads; the refused verdict must warn, once.
      gate.evaluateABTest(0.5, 2.5, 30, 30, 0, 0, 10, { a, b });
      gate.evaluateABTest(0.5, 2.5, 30, 30, 0, 0, 10, { a, b });
    } finally {
      console.warn = original;
    }
    const relevant = warnings.filter((w) => w.includes('eb confidence gate refused'));
    assert.equal(relevant.length, 1, `expected exactly one warning, got: ${warnings.join(' | ')}`);
  });
});
