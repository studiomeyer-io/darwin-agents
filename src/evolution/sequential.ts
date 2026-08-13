/**
 * Darwin: sequential testing for continuous monitoring (v0.7.0, corrected v0.15)
 *
 * Pure statistical primitives for A/B decisions taken under repeated looks
 * during prompt evolution. This module exists because Darwin's safety gate calls
 * `evaluateABTest` after EVERY run — continuous monitoring with a fixed
 * relative-improvement threshold inflates the false-positive rate (the
 * classic "peeking problem"). v0.6.0 shipped a first-step effect-size
 * heuristic (`SafetyGate.calculateConfidence`, |Δ| / pooled-mean ≥ 0.2);
 * this module is the upgrade promised in the v0.6 roadmap notes.
 *
 * Two methods, both designed so that peeking after every run does not inflate
 * the false-positive rate the way a fixed-n threshold does. Read the caveats:
 * neither is unconditionally "always-valid", and saying so flatly is the
 * mistake v0.15 came out of.
 *
 *   1. {@link msprtTwoSample} — Mixture Sequential Probability Ratio Test
 *      (Johari, Pekelis & Walsh 2017, arXiv:1512.04922; the engine behind
 *      Optimizely/Statsig's "stats engine"). Gaussian mixture prior over
 *      the effect size; uses the observed (pooled) variance. Most powerful
 *      when the per-arm sample variance is meaningful — i.e. once each arm
 *      has accumulated a handful of runs (see {@link MsprtOptions.minSamplesPerArm}).
 *
 *   2. {@link hoeffdingTwoSample}: a σ-free time-uniform confidence sequence
 *      for variables bounded to a known range (Darwin composite scores live
 *      in [0, 1]). Distribution-free and non-asymptotic, with a four-line
 *      proof carried in its own docstring. The price is power. On a [0, 1]
 *      score it cannot fire at all at 21 or fewer runs per arm, and it needs
 *      n=900 per arm to resolve a +0.2 lift, so treat it as a conservative
 *      second opinion rather than the everyday gate.
 *
 * **v0.15 corrected the Hoeffding boundary.** Through v0.14 it allowed
 * 2α/(n+1) at every look, which is not a summable schedule, so the union
 * bound the comment invoked never closed and the time-uniform guarantee was
 * never established. Both arms also spent the full α instead of α/2. Details
 * and proof: {@link hoeffdingTwoSample}. mSPRT keeps its boundary, but its
 * zero-variance shortcut changed; see {@link msprtTwoSample}.
 *
 * **Pure** — no LLM calls, no I/O, no `Date.now()`, no `Math.random()`.
 * Fully deterministic, so tests pin exact statistic values.
 *
 * Caveat on warmup (documented, not hidden): mSPRT's guarantee is stated for
 * a KNOWN variance. Darwin plugs in an estimate, which makes it asymptotic
 * rather than exact, and with few samples that estimate is noisy. Darwin's A/B
 * sample sizes (minRuns 10 to 30) sit below the ~100-sample comfort zone for
 * tight σ-estimation, so `minSamplesPerArm` (default 5) makes mSPRT abstain
 * below that count rather than fire on noise.
 */

/** Which confidence method the safety gate uses for the peeking guard. */
export type ConfidenceMethod = "effect-size" | "msprt" | "hoeffding";

/** Verdict from a sequential test. `decisive` answers "is the gap real?". */
export interface SequentialVerdict {
  /** True iff the test crossed its threshold (reject H0: equal means). */
  decisive: boolean;
  /** Which method produced this verdict. */
  method: ConfidenceMethod;
  /** Sign of the effect (mean B − mean A): +1 if B>A, −1 if A>B, 0 if tie/undecided. */
  direction: -1 | 0 | 1;
  /**
   * The test statistic: for mSPRT the mixture likelihood ratio Λ (compare to
   * `threshold = 1/alpha`); for Hoeffding the absolute mean gap |Δ| (compare
   * to `threshold` = summed CS half-widths). NaN-free.
   */
  statistic: number;
  /** The threshold `statistic` must exceed for `decisive` to be true. */
  threshold: number;
  /** Effective per-arm sample counts after NaN filtering. */
  nA: number;
  nB: number;
  /**
   * Hoeffding only (v0.15+). True when `threshold` already exceeds the score
   * range, so NO data at this sample size could have produced `decisive:true`.
   * Distinguishes "the arms look similar" from "this test cannot answer yet",
   * which on Darwin's default 10 to 30 runs per arm is the usual case. See the
   * sample-size discussion on {@link hoeffdingTwoSample}.
   */
  inconclusiveByConstruction?: boolean;
  /**
   * v0.15+. True when the test refused to run because its INPUT was invalid
   * (a non-finite or inverted score range, an alpha outside (0,1), or samples
   * outside the declared range). Distinct from an ordinary "not decisive yet":
   * this one means a configuration is broken and someone has to fix it, so
   * callers should surface `reason` rather than treat it as a quiet no.
   */
  invalidInput?: boolean;
  /**
   * v0.15+. Machine-readable cause of an abstention, for callers that need to
   * branch on it. Currently only `'no-spread'` (mSPRT: neither arm shows any
   * spread, so there is no noise scale to test against). Exists so
   * `SafetyGate` does not have to pattern-match on `reason` prose, which would
   * silently break the next time the wording changes.
   */
  abstainCode?: "no-spread";
  /** Human-readable reason, e.g. "warmup: 3<5 samples on arm A". */
  reason: string;
}

export interface MeanVar {
  mean: number;
  /** Sample variance with Bessel's correction (n−1). 0 when n<2. */
  variance: number;
  n: number;
}

/**
 * Mean + Bessel-corrected sample variance over finite values. Non-finite
 * entries (NaN/Infinity) are dropped — a single bad score never poisons the
 * estimate. Returns `{mean:0, variance:0, n:0}` for an all-invalid/empty input.
 *
 * Sorted, then summed with Neumaier compensation (v0.15), not accumulated in
 * input order. Plain `sum += s` is ORDER-DEPENDENT, and cross-model review
 * turned that into a false positive on both shipped tests: take 200 values
 * within a few ULP of each other, feed the same multiset ascending and
 * descending, and the two means differ by one ULP. That is enough for mSPRT
 * (variance then ~1e-32) to report Λ ≈ 1013 for two arms that are literally the
 * same numbers.
 *
 * The SORT is what carries the guarantee, and it is worth being exact about
 * which guarantee: two inputs holding the same multiset produce bit-identical
 * estimates. That is not the same as an exact sum, and compensation alone does
 * NOT provide it (a first attempt at this fix claimed it did; review then
 * produced a permutation pair where compensated sums still diverged). Anyone
 * comparing two arms is entitled to the multiset property; nobody is promised
 * exactness.
 */
export function meanVar(samples: ReadonlyArray<number>): MeanVar {
  const finite: number[] = [];
  for (const s of samples) {
    if (typeof s === "number" && Number.isFinite(s)) finite.push(s);
  }
  const n = finite.length;
  if (n === 0) return { mean: 0, variance: 0, n: 0 };

  // SORT, then sum with compensation. The sort is what actually buys the
  // guarantee: two arrays holding the same multiset sort into the same
  // sequence, so the accumulation is bit-identical and the estimate cannot
  // depend on the order the caller happened to collect its runs in.
  // Compensation on its own reduces the error but does not deliver that (an
  // earlier v0.15 draft claimed it did, and review produced a permutation pair
  // where it still diverged).
  //
  // One footnote for exactness: signed zeros are the one case the sort does not
  // canonicalise, because the comparator reports -0 and +0 as equal and the
  // sort is stable, so [+0, -0] and [-0, +0] keep their input order. The
  // estimates come out bit-identical anyway (adding either zero to a running
  // total changes nothing, and squaring the deviation removes the sign), which
  // the exhaustive permutation test pins.
  //
  // Known limitation, abstention-grade rather than wrong: sorting groups the
  // large magnitudes together, so an input whose exact sum is finite only
  // because its terms cancel can overflow, e.g. [MAX, MAX, -MAX, -MAX] yields
  // -Infinity. Darwin's composites are bounded scores, and every caller guards
  // non-finite means and abstains.
  finite.sort((x, y) => x - y);

  const mean = compensatedSum(finite) / n;
  if (n < 2) return { mean, variance: 0, n };

  const deviations = finite.map((s) => (s - mean) ** 2);
  deviations.sort((x, y) => x - y);
  return { mean, variance: compensatedSum(deviations) / (n - 1), n };
}

/**
 * Neumaier-compensated sum. Falls back to the plain running total the moment an
 * intermediate leaves finite range: the compensation term is a difference of
 * partial sums, so on overflow it evaluates Infinity - Infinity and turns an
 * honest Infinity into a NaN. Callers guard non-finite means; NaN would sail
 * past a `> 0` check that Infinity fails.
 */
function compensatedSum(values: ReadonlyArray<number>): number {
  let sum = 0;
  let comp = 0;
  for (const v of values) {
    const next = sum + v;
    if (!Number.isFinite(next)) {
      // Overflowed. Finish plainly and drop the compensation.
      sum = next;
      comp = 0;
      continue;
    }
    comp += Math.abs(sum) >= Math.abs(v) ? sum - next + v : v - next + sum;
    sum = next;
  }
  return Number.isFinite(sum) ? sum + comp : sum;
}

export interface MsprtOptions {
  /** Significance level. Reject H0 when Λ ≥ 1/alpha. Default 0.05. */
  alpha?: number;
  /**
   * Mixing-prior standard deviation over the true mean DIFFERENCE δ (in raw
   * score units, since the test runs in estimator coordinates). Larger τ ⇒
   * optimised for bigger effects (fires faster on large gaps, slower on small
   * ones). Default 0.1 — tuned for composite scores in [0,1] where a
   * "meaningful" lift in the mean difference is on the order of ~0.1.
   */
  tau?: number;
  /**
   * Per-arm warmup floor. Below this many valid samples on EITHER arm the
   * test abstains (`decisive:false`) instead of firing on a noisy variance
   * estimate. Default 5.
   */
  minSamplesPerArm?: number;
}

const DEFAULT_ALPHA = 0.05;
const DEFAULT_TAU = 0.1;
const DEFAULT_MIN_SAMPLES = 5;

/**
 * Two-sample mixture SPRT for a difference in means. Its guarantee holds under
 * repeated looks GIVEN a known variance, a Gaussian (or suitably sub-Gaussian)
 * sampling model, AND an allocation across the two arms that is paired or fixed
 * in advance (Johari, Pekelis & Walsh 2017, §6.1). A known variance alone is
 * not enough on any of those counts. Darwin satisfies none of them exactly, and
 * the measured cost is below.
 * Models H0: μ_A = μ_B against a Gaussian mixture alternative on the effect
 * (prior δ ~ N(0, τ²) on the true mean difference). Returns `decisive:true`
 * when the mixture likelihood ratio Λ crosses 1/alpha, a threshold that does
 * not carry a peeking penalty at any n.
 *
 * Closed form in ESTIMATOR coordinates. Let δ̂ = x̄_B − x̄_A be the observed
 * mean difference and v = Var(δ̂) its variance. Integrating the per-θ Gaussian
 * likelihood ratio against the N(0, τ²) mixture prior (Johari, Pekelis &
 * Walsh 2017) gives:
 *
 *   Λ = sqrt( v / (v + τ²) ) · exp( τ²·δ̂² / (2·v·(v + τ²)) ),   Λ ≥ 1/α ⇒ reject H0
 *
 * We estimate v with the WELCH variance of the difference of means,
 * v = s²_A/n_A + s²_B/n_B (Bessel-corrected per-arm sample variances). Welch
 * (rather than a pooled within-arm variance) keeps the form unambiguous and
 * robust to unequal arm variances — it does not assume homoscedasticity. In
 * estimator coordinates no `nEff` factor appears: the sample sizes enter only
 * through v (a larger n shrinks v, which grows Λ), so the historical
 * "n² vs n" ambiguity of the sample-mean form is avoided entirely.
 *
 * Defensive: empty/below-warmup arms ⇒ abstain; zero observed variance ⇒
 * abstain (see below); non-finite aggregates ⇒ abstain; NaN-free.
 *
 * ## The zero-variance branch changed in v0.15 (behaviour change)
 *
 * It used to return `decisive: true` for two internally constant arms with a
 * gap, on the reasoning that deterministic arms obviously differ. That fired
 * REGARDLESS of `alpha`, and at small n two arms come out constant by chance
 * under H0 often enough to matter: with `minSamplesPerArm: 2` and both arms
 * drawn from the same Bernoulli(0.5), P(A=[0,0] and B=[1,1]) plus its mirror
 * is 0.125, a 12.5% type-I error against a configured α of 0.05. At the
 * default warmup of 5 the same event sits at 0.00195, which still beats a
 * configured α of 0.001.
 *
 * It now abstains. A promotion rule that ignores the significance level is not
 * a test, and the cost of abstaining is small: the margin path still sees the
 * gap, `SafetyGate` re-runs the pair through the σ-free Hoeffding bound (which
 * needs no variance estimate, so a deterministic evaluator with a large gap
 * still promotes), and the `2 × minRuns` tie-break still terminates the test.
 *
 * ## What abstaining on constancy does NOT fix
 *
 * Stated because the fix is narrower than it looks. The underlying issue is
 * that a PLUG-IN variance is anti-conservative at small n: whenever the
 * within-arm spread comes out small by chance, the estimate understates the
 * true noise and Λ overshoots. Constancy is only the extreme end of that.
 *
 * ### Measured, because a number beats a hedge
 *
 * Under H0 (both arms from the SAME distribution) with a coarse judge whose
 * scores land at {0, 0.1, 0.2} with probabilities {0.50, 0.05, 0.45}, at the
 * DEFAULT α = 0.05, τ and `minSamplesPerArm`, checking after every INDIVIDUAL
 * run (so the arms are unbalanced half the time, exactly as in production):
 *
 *   looks through n = 14 : type-I error 0.059
 *   looks through n = 20 : type-I error 0.064
 *   looks through n = 30 : type-I error 0.069
 *
 * The error is past α from the first horizon measured and keeps growing.
 * (Checking only on balanced pairs understates it by about a fifth, at
 * 0.050 / 0.055 / 0.059; the unbalanced figures are the honest ones.) `tests/sequential-coverage.test.ts` measures this
 * on every run, so the numbers cannot rot.
 *
 * **So mSPRT as implemented here is not a calibrated test at Darwin's sample
 * sizes.** It is a well-motivated stopping rule that behaves roughly like its
 * nominal α over short horizons and drifts past it over long ones. That is a
 * useful thing to have, and it is not the thing "always-valid" implies, which
 * is why v0.15 stopped calling it the rigorous option. Fixing it properly
 * means a test that accounts for the estimated variance rather than plugging
 * it in (an unknown-variance e-process or a t-mixture), which is a different
 * method, not a patch.
 *
 * `'hoeffding'` has no such regime: its guarantee is proved in its own
 * docstring below and does not
 * depend on a variance estimate. It pays for that with power. Pick by which
 * cost you would rather carry.
 */
export function msprtTwoSample(
  samplesA: ReadonlyArray<number>,
  samplesB: ReadonlyArray<number>,
  opts: MsprtOptions = {},
): SequentialVerdict {
  // Fail closed on an explicitly invalid `alpha` or `tau` (v0.15). Defaulting
  // an ABSENT option is a convenience; defaulting an explicitly wrong one
  // silently runs a different test than the caller asked for. Scope, so the
  // claim is not read wider than it is: `minSamplesPerArm` still floors
  // silently, and a `tau` so small that tau² underflows to zero is not caught. `alpha: 0` used to become a 5%
  // test, and `tau: Number.MAX_VALUE` used to overflow to Infinity and return
  // statistic: NaN despite the NaN-free contract on SequentialVerdict.
  const badOption =
    opts.alpha !== undefined && !isUsableAlpha(opts.alpha)
      ? `alpha ${fmt(opts.alpha)}: must be inside (0, 1)`
      : opts.tau !== undefined && !isUsableTau(opts.tau)
        ? `tau ${fmt(opts.tau)}: must be finite, positive, and small enough that tau² is finite`
        : null;
  if (badOption !== null) {
    return {
      method: "msprt",
      threshold: 1 / DEFAULT_ALPHA,
      nA: meanVar(samplesA).n,
      nB: meanVar(samplesB).n,
      decisive: false,
      direction: 0,
      statistic: 0,
      invalidInput: true,
      reason: `invalid ${badOption}. Refusing to decide.`,
    };
  }
  const alpha = clampAlpha(opts.alpha);
  const tau = Number.isFinite(opts.tau) && (opts.tau as number) > 0 ? (opts.tau as number) : DEFAULT_TAU;
  const minSamples =
    Number.isFinite(opts.minSamplesPerArm) && (opts.minSamplesPerArm as number) >= 1
      ? Math.floor(opts.minSamplesPerArm as number)
      : DEFAULT_MIN_SAMPLES;
  const threshold = 1 / alpha;

  const a = meanVar(samplesA);
  const b = meanVar(samplesB);
  const base = {
    method: "msprt" as const,
    threshold,
    nA: a.n,
    nB: b.n,
  };

  if (a.n < minSamples || b.n < minSamples) {
    return {
      ...base,
      decisive: false,
      direction: 0,
      statistic: 0,
      reason: `warmup: need ≥${minSamples} samples/arm, have A=${a.n} B=${b.n}`,
    };
  }

  const delta = b.mean - a.mean;
  const direction: -1 | 0 | 1 = delta > 0 ? 1 : delta < 0 ? -1 : 0;

  // Welch variance of the difference of means: v = Var(δ̂) = s²_A/n_A + s²_B/n_B.
  // This is the noise scale the mixture SPRT runs against; using it directly
  // (not a pooled within-arm variance) handles unequal arm variances and
  // removes the n-scaling ambiguity of the sample-mean form.
  const varDelta = a.variance / a.n + b.variance / b.n;

  // Non-finite aggregates (e.g. arms full of Number.MAX_VALUE, whose squared
  // deviations overflow) cannot produce a meaningful Λ, and letting them
  // through was how `statistic` could come back NaN despite being documented
  // NaN-free. Abstain rather than emit a verdict nobody can interpret.
  if (!Number.isFinite(varDelta) || !Number.isFinite(delta)) {
    return {
      ...base,
      decisive: false,
      direction: 0,
      statistic: 0,
      reason: "non-finite mean or variance (numeric overflow): refusing to decide",
    };
  }

  // Degenerate branch: (near-)zero observed variance on the difference.
  //
  // **This used to return `decisive: true` and it no longer does (v0.15).**
  // The old shortcut reasoned that two deterministic arms with a gap are
  // obviously different. The problem is that it fired regardless of `alpha`,
  // and at small n two arms are constant by CHANCE under H0 often enough to
  // matter: with `minSamplesPerArm: 2` and both arms drawn from the same
  // Bernoulli(0.5), P(A=[0,0] and B=[1,1]) plus its mirror is 0.125. That is a
  // 12.5% type-I error against a configured α of 0.05, and even at the default
  // warmup of 5 the same event has probability 0.00195, which still exceeds a
  // configured α of 0.001. A promotion rule that ignores the significance level
  // is not a test, and documenting it does not make it safe (the point was
  // pressed by the cross-model review, and it was right).
  //
  // Abstaining is the conservative answer: the margin path still sees the gap,
  // the `2 × minRuns` tie-break still terminates the experiment, and no
  // challenger gets promoted on evidence the configured α never sanctioned.
  //
  // Tested as "neither arm shows any spread" rather than "varDelta === 0",
  // because those differ in floating point and the difference was load-bearing:
  // eight samples of exactly 0.4 against eight of exactly 0.9 leave a residual
  // variance around 1e-33 (0.4 is not representable, so the mean is a hair off
  // every sample). That is not a variance estimate, it is representation
  // error, and feeding it to the closed form gives Λ = ∞, i.e. the same
  // alpha-independent decision through the front door. Constancy is exact and
  // says what is actually meant: no observed spread, so no noise scale.
  const constantA = hasNoSpread(samplesA);
  const constantB = hasNoSpread(samplesB);
  if (!(varDelta > 0) || (constantA && constantB)) {
    return {
      ...base,
      decisive: false,
      direction: 0,
      statistic: 0,
      abstainCode:
        a.n >= 2 && b.n >= 2 && delta !== 0 ? ("no-spread" as const) : undefined,
      reason:
        a.n < 2 || b.n < 2
          ? "insufficient samples to estimate variance"
          : delta === 0
            ? "identical constant arms"
            : "no observed spread on either arm: cannot separate a real gap " +
              "from a small sample that happened to be constant, so this " +
              "abstains rather than fire independently of alpha",
    };
  }

  // Mixture SPRT closed form (estimator coordinates, prior δ ~ N(0, τ²)):
  //   Λ = √(v/(v+τ²)) · exp( τ²·δ̂² / (2·v·(v+τ²)) ),  v = Var(δ̂)
  // Evaluated in a form that cannot overflow. The naive expression multiplies
  // by tau² and divides by (varDelta + tau²); with a large tau BOTH overflow to
  // Infinity and the ratio comes back Infinity or NaN. Cross-model review found
  // a case (tau = 1e154) where that produced decisive:true while the true
  // log Λ was -350, i.e. an outright false positive.
  //
  // Algebraically identical, numerically safe: write the shrinkage factor
  // tau²/(varDelta + tau²) as 1/(1 + varDelta/tau²), which is in (0, 1], and
  // the log term as -0.5·ln(1 + tau²/varDelta) via log1p on the reciprocal.
  // Everything below is done on logs of the two ingredients, because every
  // direct form of this expression overflows somewhere. Cross-model review
  // found three separate cases: tau² overflowing, 1/ratio overflowing (which
  // produced log Λ = -Infinity where the truth was -350), and delta² overflowing
  // before it could be damped by a tiny shrink factor (which produced a
  // decisive:true where the truth was log Λ ≈ 1e-201).
  //
  // Let L = ln(tau²) - ln(varDelta). Then
  //   shrink   = tau²/(varDelta + tau²) = sigmoid(L)
  //   ln(1 + tau²/varDelta) = softplus(L)
  // and both have stable large-|L| limits, so nothing has to be formed at full
  // magnitude first.
  const logL = 2 * Math.log(tau) - Math.log(varDelta);
  // softplus(L) = ln(1 + e^L), and ln(sigmoid(L)) = -softplus(-L).
  //
  // The shortcut branch is at 700, not 30. A cutoff of 30 looks harmless (the
  // discarded term is ~1e-13) but it biases log Λ UPWARD, and cross-model
  // review built an input sitting 4.6e-14 from the threshold where that flipped
  // a correct non-decision into a false positive. At 700, exp(L) is genuinely
  // close enough to where exp(L) leaves double range (overflow starts just
  // above 709.78) that the discarded term is below the last bit, so it is used
  // only where the exact form
  // cannot be represented at all, where the difference is below the last bit.
  const softplus = (x: number): number => (x > 700 ? x : Math.log1p(Math.exp(x)));
  const lnShrink = -softplus(-logL);

  // Second term as exp of its own log, so delta² never has to exist. Note
  // `Math.log(2) + Math.log(varDelta)` rather than `Math.log(2 * varDelta)`:
  // varDelta can be just under Number.MAX_VALUE, where doubling it overflows to
  // Infinity and the whole term collapses. Also found by review.
  const lnSecondTerm =
    delta === 0
      ? Number.NEGATIVE_INFINITY
      : 2 * Math.log(Math.abs(delta)) - (Math.LN2 + Math.log(varDelta)) + lnShrink;
  const secondTerm = Math.exp(lnSecondTerm);

  const logLambda = -0.5 * softplus(logL) + secondTerm;

  // NaN only. +Infinity is deliberately NOT refused: after the log-space
  // rewrite it means the evidence genuinely exceeds double range, which is a
  // decision, not a fault. NaN means the arithmetic produced nothing anyone can
  // interpret, and that must not read as one.
  if (Number.isNaN(logLambda)) {
    return {
      ...base,
      decisive: false,
      direction: 0,
      statistic: 0,
      invalidInput: true,
      reason: "numeric overflow while evaluating Λ: refusing to decide",
    };
  }
  const lambda = Math.exp(logLambda);

  // Compare in log-space against log(1/alpha) for numerical robustness when Λ
  // is astronomically large (exp overflow → Infinity is still > threshold).
  // Compared as log Λ ≥ -ln(α), not against ln(1/α): for a very small α the
  // reciprocal overflows to Infinity and the test could never fire at all.
  const decisive = logLambda >= -Math.log(alpha);

  return {
    ...base,
    decisive,
    direction: decisive ? direction : 0,
    statistic: lambda,
    reason: decisive
      ? `Λ=${fmt(lambda)} ≥ 1/α=${fmt(threshold)}`
      : `Λ=${fmt(lambda)} < 1/α=${fmt(threshold)} (keep testing)`,
  };
}

export interface HoeffdingOptions {
  /** Significance level for the confidence sequence. Default 0.05. */
  alpha?: number;
  /** Lower bound of the score range. Default 0 (Darwin composite scores). */
  lo?: number;
  /** Upper bound of the score range. Default 1 (Darwin composite scores). */
  hi?: number;
  /** Per-arm warmup floor (≥1). Default 2 — Hoeffding is valid at any n≥1
   *  but a 1-sample arm gives a useless [lo,hi]-wide interval. */
  minSamplesPerArm?: number;
}

/**
 * Two-sample, variance-free decision via per-arm time-uniform Hoeffding
 * confidence sequences for bounded variables.
 *
 * ## The boundary, and why it is this one
 *
 * Hoeffding's inequality bounds a FIXED sample size n. For a variable confined
 * to a range R = hi - lo:
 *
 *   P( |X̄_n - μ| ≥ w ) ≤ 2·exp( -2n·w² / R² )
 *
 * A confidence *sequence* asks for strictly more: P(∀n ≥ 1: μ ∈ C_n) ≥ 1 - α,
 * meaning coverage at every n at once. Spending the same α at every look does
 * not deliver that, because the per-look failure budgets have to be summable,
 * and a per-look spend of α/(n+1) is not (the harmonic series diverges).
 *
 * **Darwin shipped a boundary through v0.14 whose stated proof does not
 * work.** It was
 *   w(n) = R·√( ln((n+1)/α) / (2n) )
 * which allows 2α/(n+1) per look (invert Hoeffding at that half-width and the
 * leading 2 survives), and the comment called it "a standard union-bound /
 * Cramér-Chernoff time-uniform Hoeffding bound". No union bound closes over
 * Σ 2α/(n+1), which diverges, so that justification establishes nothing.
 *
 * Being precise about what this does and does not show, since not overclaiming
 * is the whole point of v0.15: what is refuted is the ARGUMENT, not the
 * boundary. A divergent chain of upper bounds does not prove the true joint
 * crossing probability diverges, and some other construction might yet cover
 * this boundary. Nobody has produced one, and Darwin will not gate production
 * promotions on an unproven bound, which is reason enough to replace it.
 * Compare Howard, Ramdas, McAuliffe and Sekhon (2021, arXiv:1810.08240), who
 * show that pointwise Hoeffding intervals are not confidence sequences and
 * that their cumulative miscoverage grows with the horizon.
 *
 * The repair is an α-spending schedule that sums to α. Darwin uses
 * α_n = α_arm / (n(n+1)), because Σ_{n≥1} 1/(n(n+1)) telescopes to exactly 1.
 * Inverting Hoeffding at that per-look budget gives the boundary below:
 *
 *   w(n) = R · √( ln( 2·n·(n+1) / α_arm ) / (2n) )
 *
 * The whole proof, since it is short enough to check by hand:
 *
 *   2·exp( -2n·w(n)²/R² )  =  2·exp( -ln( 2n(n+1)/α_arm ) )
 *                          =  α_arm / (n(n+1))  =  α_n
 *   Σ_{n≥1} α_n            =  α_arm · Σ_{n≥1} 1/(n(n+1))  =  α_arm
 *
 * so a union bound over n = 1, 2, 3, ... costs α_arm in total. It is
 * non-asymptotic and distribution-free. `tests/sequential-coverage.test.ts`
 * re-derives this numerically and shows the pre-0.15 boundary's spend
 * diverging past α instead of converging.
 *
 * What it DOES assume, which the pre-0.15 comment left unsaid: Hoeffding
 * needs the observations to be independent (or a martingale structure with a
 * stable target mean) as well as bounded. Darwin's runs are not guaranteed to
 * satisfy that. Correlated judge scores, task drift over the life of a test,
 * and any confounding between arm and task all break it. Boundedness is the
 * assumption this boundary adds nothing beyond; it is not the only one.
 *
 * Tighter boundaries exist: the curved/stitched and conjugate-mixture
 * constructions in the same paper. (Their growth rates differ from each other
 * and an earlier draft of this comment conflated them, so the rate claim is
 * left to the source rather than paraphrased here.) They are NOT implemented. This boundary was chosen precisely because a reader can
 * verify its validity in four lines, and Darwin would rather be checkable
 * than optimal. (See "Statistical scope" in the README.)
 *
 * ## Two arms cost two budgets
 *
 * A verdict needs BOTH arms' sequences to hold simultaneously, so each is run
 * at α/2 and the union bound over the two arms returns the requested α. Under
 * H0 a false "decisive" implies at least one sequence failed, so the level is
 * α/2 + α/2 = α. Through v0.14 both arms spent the full α, so the budget was
 * allocated twice over: a second, independent defect in the same function.
 * Stated no further than that, because the per-arm boundary had no established
 * level to begin with, this is an allocation error rather than a proof that the
 * old procedure ran at 2α.
 *
 * ## What this method can and cannot do at Darwin's sample sizes
 *
 * Being σ-free costs power, and the cost is larger than it looks. Exact
 * figures on the default [0, 1] composite score at α = 0.05, all reproducible
 * from `hoeffdingHalfWidth`:
 *
 *   n ≤ 21 per arm : the two half-widths sum to ≥ 1.0, and no gap between two
 *                    means inside [0, 1] can exceed 1.0. **The test is not
 *                    merely strict here, it is structurally incapable of
 *                    firing**, for any data whatsoever.
 *   n = 22         : the bar first fits inside the range, at 0.982. Clearing
 *                    it still needs a near-total separation of the arms.
 *   n = 30         : bar 0.865. This is the `computeDynamicMinRuns` ceiling.
 *   n = 111        : the first n at which a 0.5 gap could be resolved.
 *   n = 900        : the first n at which a 0.2 COMPOSITE gap could be
 *                    resolved. Not a realistic target: Darwin's own reported
 *                    lifts (+0.23 and +0.28 quality points on 1-to-10, which
 *                    tracker.ts normalises as score/10 and weights 0.40)
 *                    contribute 0.0092 and 0.0112 to the composite. That is
 *                    the quality COMPONENT, not the total delta (the other
 *                    objectives moved too, unrecorded), but it fixes the order
 *                    of magnitude: roughly a twentieth of 0.2, which would take
 *                    on the order of 742,000 runs per arm to resolve.
 *
 * `computeDynamicMinRuns` tops out at 30 unless a larger `minRuns` is
 * configured, and the `2 × minRuns` tie-break lets a
 * test reach 60 runs per arm, where the bar is 0.648. An EXTREME separation
 * does clear that (constant arms at 0.25 and 1.0 promote), so "never promotes"
 * would be false. What is true, and what matters in practice: a stock
 * configuration using `confidenceMethod: 'hoeffding'` will not promote on the
 * composite deltas prompt evolution actually produces, which measured on our
 * own fleet are around 0.009 to 0.011.
 *
 * That is not a bug. It is what a distribution-free guarantee honestly buys at
 * n = 20. But it used to be invisible, so the verdict now flags it:
 * {@link SequentialVerdict.inconclusiveByConstruction} is true whenever the
 * bar exceeds the score range, and the reason string says so. Use `'msprt'`
 * for a gate that can actually decide at these sample sizes, and keep
 * Hoeffding for what it is good at: a conservative, assumption-light second
 * opinion when the score distribution is skewed or heavy-tailed.
 */
export function hoeffdingTwoSample(
  samplesA: ReadonlyArray<number>,
  samplesB: ReadonlyArray<number>,
  opts: HoeffdingOptions = {},
): SequentialVerdict {
  // Fail closed on an explicitly invalid alpha too: silently running a 5% test
  // when the caller asked for alpha:0 is the same class of defect as guessing
  // a score range. Omitting the option keeps the default; passing rubbish does
  // not. (`clampAlpha` still defaults an ABSENT alpha, which is intended.)
  if (opts.alpha !== undefined && !isUsableAlpha(opts.alpha)) {
    return {
      method: "hoeffding",
      nA: meanVar(samplesA).n,
      nB: meanVar(samplesB).n,
      decisive: false,
      direction: 0,
      statistic: 0,
      threshold: Number.POSITIVE_INFINITY,
      invalidInput: true,
      reason: `invalid alpha ${fmt(opts.alpha)}: must be inside (0, 1). Refusing to decide.`,
    };
  }
  const alpha = clampAlpha(opts.alpha);

  // An explicitly passed NaN/Infinity bound must NOT quietly become 0 or 1.
  // Same reasoning as the inverted-range guard below: a declared bound that is
  // not a number is a broken declaration, not an invitation to pick one.
  if (
    (opts.lo !== undefined && !Number.isFinite(opts.lo)) ||
    (opts.hi !== undefined && !Number.isFinite(opts.hi))
  ) {
    return {
      method: "hoeffding",
      nA: meanVar(samplesA).n,
      nB: meanVar(samplesB).n,
      decisive: false,
      direction: 0,
      statistic: 0,
      threshold: Number.POSITIVE_INFINITY,
      invalidInput: true,
      reason:
        `non-finite score bound (lo=${fmt(opts.lo as number)}, hi=${fmt(opts.hi as number)}): ` +
        `the bounded-variable assumption needs real numbers. Refusing to decide.`,
    };
  }
  const lo = opts.lo !== undefined ? (opts.lo as number) : 0;
  const hiRaw = opts.hi !== undefined ? (opts.hi as number) : 1;
  const minSamples =
    Number.isFinite(opts.minSamplesPerArm) && (opts.minSamplesPerArm as number) >= 1
      ? Math.floor(opts.minSamplesPerArm as number)
      : 2;

  const a = meanVar(samplesA);
  const b = meanVar(samplesB);
  const base = { method: "hoeffding" as const, nA: a.n, nB: b.n };

  // Fail CLOSED on a broken bound (v0.15). Every line of the proof above rests
  // on the observations living inside [lo, hi]; outside it, Hoeffding's
  // inequality says nothing and the half-widths are decoration.
  //
  // Until v0.15 an inverted range silently became 1 and out-of-range samples
  // were accepted, which is a fail-OPEN safety gate: with a misconfigured
  // `metrics` weighting (`MetricWeights` takes arbitrary numbers, and the
  // composite is not clamped) an agent can produce composites like 0.2 and 2.0,
  // whose gap of 1.8 clears the [0,1] bar of 1.021 and promotes a challenger on
  // a guarantee that does not exist. A gate that cannot vouch for a decision
  // must decline to make one, so both cases now abstain and say why.
  if (!(hiRaw > lo)) {
    return {
      ...base,
      decisive: false,
      direction: 0,
      statistic: 0,
      threshold: Number.POSITIVE_INFINITY,
      invalidInput: true,
      reason:
        `invalid score range [${fmt(lo)}, ${fmt(hiRaw)}]: hi must exceed lo. ` +
        `Refusing to decide rather than guessing a range.`,
    };
  }
  const range = hiRaw - lo;

  const outOfRange = findOutOfRange(samplesA, samplesB, lo, hiRaw);
  if (outOfRange !== null) {
    return {
      ...base,
      decisive: false,
      direction: 0,
      statistic: 0,
      threshold: Number.POSITIVE_INFINITY,
      invalidInput: true,
      reason:
        `sample ${fmt(outOfRange)} lies outside the declared score range ` +
        `[${fmt(lo)}, ${fmt(hiRaw)}], so the bounded-variable assumption this ` +
        `method rests on does not hold. Refusing to decide. Check the agent's ` +
        `metric weights, or set confidenceScoreRange to the real bounds.`,
    };
  }

  if (a.n < minSamples || b.n < minSamples) {
    return {
      ...base,
      decisive: false,
      direction: 0,
      statistic: 0,
      threshold: range,
      reason: `warmup: need ≥${minSamples} samples/arm, have A=${a.n} B=${b.n}`,
    };
  }

  // Samples can be individually finite and still overflow their own sum (five
  // copies of Number.MAX_VALUE average to Infinity), which made `gap` NaN and
  // broke the NaN-free contract on the returned statistic. mSPRT guarded this;
  // Hoeffding did not.
  if (!Number.isFinite(a.mean) || !Number.isFinite(b.mean)) {
    return {
      ...base,
      decisive: false,
      direction: 0,
      statistic: 0,
      threshold: Number.POSITIVE_INFINITY,
      invalidInput: true,
      reason: "numeric overflow computing an arm mean: refusing to decide",
    };
  }

  const wA = hoeffdingHalfWidth(a.n, range, alpha);
  const wB = hoeffdingHalfWidth(b.n, range, alpha);
  const gap = Math.abs(b.mean - a.mean);
  const threshold = wA + wB;
  const decisive = gap > threshold;
  const delta = b.mean - a.mean;
  const direction: -1 | 0 | 1 = decisive ? (delta > 0 ? 1 : -1) : 0;

  // No two means inside [lo, hi] can differ by more than `range`. When the bar
  // exceeds that, this sample size cannot produce a decisive verdict for ANY
  // in-range data, so say it out loud instead of looking like a near miss.
  //
  // Guarded on `!decisive` so the flag can never contradict the verdict. The
  // two can only collide when the caller feeds samples outside [lo, hi], which
  // breaks the bounded-variable contract this whole method rests on; in that
  // case `decisive` is the answer that was actually produced, and claiming
  // "inconclusive by construction" next to it would be nonsense.
  const inconclusiveByConstruction = !decisive && threshold >= range;

  const overlapReason = inconclusiveByConstruction
    ? `|Δ|=${fmt(gap)} ≤ CS half-widths ${fmt(threshold)}, which exceeds the ` +
      `[${fmt(lo)}, ${fmt(lo + range)}] score range: at n=${a.n}/${b.n} NO gap can ` +
      `clear this bar. Hoeffding is σ-free and needs far more runs per arm; ` +
      `use confidenceMethod 'msprt' to decide at these sample sizes.`
    : `|Δ|=${fmt(gap)} ≤ CS half-widths ${fmt(threshold)} (overlap)`;

  return {
    ...base,
    decisive,
    direction,
    statistic: gap,
    threshold,
    inconclusiveByConstruction,
    reason: decisive
      ? `|Δ|=${fmt(gap)} > CS half-widths ${fmt(threshold)} (non-overlap)`
      : overlapReason,
  };
}

/**
 * Half-width of one arm's time-uniform Hoeffding confidence sequence at n
 * observations, exported so tests (and callers sizing an experiment) can
 * re-derive the α-spend rather than trust the claim.
 *
 * `alpha` is the budget for the WHOLE two-arm decision. Each arm therefore
 * spends α/2, and within an arm the schedule is α_n = (α/2)/(n(n+1)), which
 * sums to exactly α/2 over n = 1, 2, 3, ... See {@link hoeffdingTwoSample}
 * for the four-line proof.
 *
 * @param n     Observations on this arm (≥1).
 * @param range hi − lo of the bounded score.
 * @param alpha Total two-arm significance level.
 */
export function hoeffdingHalfWidth(n: number, range: number, alpha: number): number {
  // Infinity has to be rejected explicitly, not just `n >= 1`: it passes that
  // guard and then produces Infinity/Infinity = NaN inside the square root,
  // which would propagate silently into `threshold` and make every comparison
  // false. A non-finite input has no meaningful half-width, so refuse it the
  // same way an out-of-range one is refused.
  // n must be a whole number of observations: the proof indexes looks
  // n = 1, 2, 3, ..., so a fractional "sample count" has no meaning and must
  // not come back wearing a finite, authoritative-looking width.
  if (
    !Number.isFinite(n) ||
    !Number.isFinite(range) ||
    !Number.isInteger(n) ||
    n < 1 ||
    range <= 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  // Same rule as the two-sample entry points: an explicitly invalid alpha is a
  // caller error, not an invitation to run a 5% test. Refuse it.
  if (!isUsableAlpha(alpha)) return Number.POSITIVE_INFINITY;
  // ln(α/2) as ln(α) - ln(2), never as a division: for a denormal α the
  // quotient loses precision (and at Number.MIN_VALUE underflows to zero,
  // which produced an infinite width for a perfectly valid request).
  const logAlphaPerArm = Math.log(alpha) - Math.LN2;
  // ln(2n(n+1)/α_arm) as a SUM of logs, not the log of a quotient: with a very
  // small α the quotient overflows to Infinity, the width comes back Infinity,
  // and a genuinely decisive comparison reads as "cannot decide". Found by
  // review at α = 1e-302, where the correct two-arm bar at n=2000 is a perfectly
  // finite 0.844 and the old form refused.
  //
  // Divided as `/ 2 / n` rather than `/ (2 * n)`, because 2·n overflows for an
  // n near Number.MAX_VALUE and the width then collapses to 0, which is a
  // WRONG public answer rather than a clean refusal. Both found by review.
  const inner = Math.LN2 + Math.log(n) + Math.log(n + 1) - logAlphaPerArm;
  const w = range * Math.sqrt(inner / 2 / n);
  // n above ~1e154 overflows n*(n+1) to Infinity. Refusing beats returning NaN.
  return Number.isFinite(w) ? w : Number.POSITIVE_INFINITY;
}

/**
 * First finite observation on either arm that falls outside [lo, hi], or null
 * when every one is in range. Non-finite entries are ignored here because
 * {@link meanVar} already drops them.
 */
function findOutOfRange(
  samplesA: ReadonlyArray<number>,
  samplesB: ReadonlyArray<number>,
  lo: number,
  hi: number,
): number | null {
  for (const arm of [samplesA, samplesB]) {
    for (const s of arm) {
      if (typeof s === "number" && Number.isFinite(s) && (s < lo || s > hi)) return s;
    }
  }
  return null;
}

/**
 * True when every finite observation on the arm is the same value, i.e. the
 * arm shows no spread at all. Deliberately exact rather than an epsilon
 * comparison: see the degenerate branch in {@link msprtTwoSample}.
 */
function hasNoSpread(samples: ReadonlyArray<number>): boolean {
  let first: number | null = null;
  for (const s of samples) {
    if (typeof s !== "number" || !Number.isFinite(s)) continue;
    if (first === null) first = s;
    else if (s !== first) return false;
  }
  return true;
}

/** True for a tau a caller may actually pass: positive, and tau² still finite. */
function isUsableTau(tau: number | undefined): boolean {
  return (
    typeof tau === "number" && Number.isFinite(tau) && tau > 0 && Number.isFinite(tau * tau)
  );
}

/** True for an alpha a caller may actually pass: finite and inside (0, 1). */
function isUsableAlpha(alpha: number | undefined): boolean {
  return typeof alpha === "number" && Number.isFinite(alpha) && alpha > 0 && alpha < 1;
}

function clampAlpha(alpha: number | undefined): number {
  if (!Number.isFinite(alpha)) return DEFAULT_ALPHA;
  const a = alpha as number;
  // Keep strictly inside (0,1); silly inputs fall back to the default.
  if (a <= 0 || a >= 1) return DEFAULT_ALPHA;
  return a;
}

function fmt(x: number | undefined): string {
  // `undefined` and NaN both used to render as "-∞" (they fail every
  // comparison, so the ternary fell through), which turned "you omitted this"
  // and "this is a numeric fault" into a plausible-looking number. Name them.
  if (x === undefined) return "unset";
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "∞" : "-∞";
  return x.toFixed(3);
}
