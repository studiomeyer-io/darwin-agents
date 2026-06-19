/**
 * Darwin — Always-Valid Sequential Testing (v0.7.0)
 *
 * Pure statistical primitives for peeking-resistant A/B decisions during
 * prompt evolution. This module exists because Darwin's safety gate calls
 * `evaluateABTest` after EVERY run — continuous monitoring with a fixed
 * relative-improvement threshold inflates the false-positive rate (the
 * classic "peeking problem"). v0.6.0 shipped a first-step effect-size
 * heuristic (`SafetyGate.calculateConfidence`, |Δ| / pooled-mean ≥ 0.2);
 * this module is the rigorous upgrade promised in the v0.6 roadmap notes.
 *
 * Two methods, both **always-valid** (the decision stays statistically
 * sound no matter how many times you peek):
 *
 *   1. {@link msprtTwoSample} — Mixture Sequential Probability Ratio Test
 *      (Johari, Pekelis & Walsh 2017, arXiv:1512.04922; the engine behind
 *      Optimizely/Statsig's "stats engine"). Gaussian mixture prior over
 *      the effect size; uses the observed (pooled) variance. Most powerful
 *      when the per-arm sample variance is meaningful — i.e. once each arm
 *      has accumulated a handful of runs (see {@link MsprtOptions.minSamplesPerArm}).
 *
 *   2. {@link hoeffdingTwoSample} — a σ-free time-uniform confidence
 *      sequence for variables bounded to a known range (Darwin composite
 *      scores live in [0, 1]). Valid at ANY sample size with no variance
 *      estimate, so it is the honest choice when only a few runs exist.
 *      More conservative than mSPRT (wider intervals) by design.
 *
 * **Pure** — no LLM calls, no I/O, no `Date.now()`, no `Math.random()`.
 * Fully deterministic, so tests pin exact statistic values.
 *
 * Caveat on warmup (documented, not hidden): mSPRT with an *estimated*
 * variance is only asymptotically always-valid; with very few samples the
 * variance estimate is noisy. Darwin's A/B sample sizes (minRuns 10–30) sit
 * below the ~100-sample comfort zone for tight σ-estimation, so we expose
 * `minSamplesPerArm` (default 5) below which mSPRT abstains (`decisive:false`)
 * rather than fire on noise, and we offer Hoeffding as the σ-free fallback.
 */

/** Which confidence method the safety gate uses for the peeking guard. */
export type ConfidenceMethod = "effect-size" | "msprt" | "hoeffding";

/** Verdict from a sequential test. `decisive` answers "is the gap real?". */
export interface SequentialVerdict {
  /** True iff the test crossed its always-valid threshold (reject H0: equal means). */
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
 */
export function meanVar(samples: ReadonlyArray<number>): MeanVar {
  let n = 0;
  let sum = 0;
  for (const s of samples) {
    if (typeof s === "number" && Number.isFinite(s)) {
      n++;
      sum += s;
    }
  }
  if (n === 0) return { mean: 0, variance: 0, n: 0 };
  const mean = sum / n;
  if (n < 2) return { mean, variance: 0, n };
  let sse = 0;
  for (const s of samples) {
    if (typeof s === "number" && Number.isFinite(s)) {
      sse += (s - mean) ** 2;
    }
  }
  return { mean, variance: sse / (n - 1), n };
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
 * Two-sample mixture SPRT for a difference in means with always-valid
 * inference. Models H0: μ_A = μ_B against a Gaussian mixture alternative on
 * the effect (prior δ ~ N(0, τ²) on the true mean difference). Returns
 * `decisive:true` when the mixture likelihood ratio Λ crosses 1/alpha — a
 * threshold valid at every n (no peeking penalty).
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
 * Defensive: empty/below-warmup arms ⇒ abstain; zero variance on either arm
 * with a non-zero gap AND ≥2 samples per arm ⇒ decisive (deterministic arms
 * differ); <2 samples ⇒ abstain (cannot estimate variance); NaN-free.
 */
export function msprtTwoSample(
  samplesA: ReadonlyArray<number>,
  samplesB: ReadonlyArray<number>,
  opts: MsprtOptions = {},
): SequentialVerdict {
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

  // Degenerate branch: (near-)zero observed variance on the difference. With
  // ≥2 samples per arm a non-zero gap between two deterministic arms is fully
  // decisive; with <2 samples we cannot estimate variance at all → abstain.
  if (!(varDelta > 0)) {
    if (delta === 0 || a.n < 2 || b.n < 2) {
      return {
        ...base,
        decisive: false,
        direction: 0,
        statistic: 0,
        reason:
          a.n < 2 || b.n < 2
            ? "insufficient samples to estimate variance"
            : "identical constant arms",
      };
    }
    return {
      ...base,
      decisive: true,
      direction,
      statistic: Number.POSITIVE_INFINITY,
      reason: "deterministic arms differ (zero variance)",
    };
  }

  // Mixture SPRT closed form (estimator coordinates, prior δ ~ N(0, τ²)):
  //   Λ = √(v/(v+τ²)) · exp( τ²·δ̂² / (2·v·(v+τ²)) ),  v = Var(δ̂)
  const denom = varDelta + tau * tau;
  const logLambda =
    0.5 * Math.log(varDelta / denom) +
    (tau * tau * delta * delta) / (2 * varDelta * denom);
  const lambda = Math.exp(logLambda);

  // Compare in log-space against log(1/alpha) for numerical robustness when Λ
  // is astronomically large (exp overflow → Infinity is still > threshold).
  const decisive = logLambda >= Math.log(threshold);

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
 * Two-sample, variance-free, always-valid decision via per-arm time-uniform
 * Hoeffding confidence sequences for bounded variables.
 *
 * Each arm's mean is bracketed by a half-width that shrinks with n while
 * staying valid under continuous monitoring:
 *
 *   w(n) = (hi − lo) · sqrt( ln( (n+1)/alpha ) / (2n) )
 *
 * (a standard union-bound / Cramér–Chernoff time-uniform Hoeffding bound).
 * The arms are declared decisively different when their mean gap exceeds the
 * sum of the two half-widths — i.e. the confidence intervals no longer
 * overlap. No variance estimate needed, so this is the honest method when
 * only a handful of runs exist or the score distribution is skewed/bounded.
 *
 * Conservative by construction (wider than mSPRT) — prefer mSPRT once both
 * arms have enough runs for a stable variance estimate.
 */
export function hoeffdingTwoSample(
  samplesA: ReadonlyArray<number>,
  samplesB: ReadonlyArray<number>,
  opts: HoeffdingOptions = {},
): SequentialVerdict {
  const alpha = clampAlpha(opts.alpha);
  const lo = Number.isFinite(opts.lo) ? (opts.lo as number) : 0;
  const hiRaw = Number.isFinite(opts.hi) ? (opts.hi as number) : 1;
  const range = hiRaw > lo ? hiRaw - lo : 1; // guard inverted/zero range
  const minSamples =
    Number.isFinite(opts.minSamplesPerArm) && (opts.minSamplesPerArm as number) >= 1
      ? Math.floor(opts.minSamplesPerArm as number)
      : 2;

  const a = meanVar(samplesA);
  const b = meanVar(samplesB);
  const base = { method: "hoeffding" as const, nA: a.n, nB: b.n };

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

  const halfWidth = (n: number): number =>
    range * Math.sqrt(Math.log((n + 1) / alpha) / (2 * n));

  const wA = halfWidth(a.n);
  const wB = halfWidth(b.n);
  const gap = Math.abs(b.mean - a.mean);
  const threshold = wA + wB;
  const decisive = gap > threshold;
  const delta = b.mean - a.mean;
  const direction: -1 | 0 | 1 = decisive ? (delta > 0 ? 1 : -1) : 0;

  return {
    ...base,
    decisive,
    direction,
    statistic: gap,
    threshold,
    reason: decisive
      ? `|Δ|=${fmt(gap)} > CS half-widths ${fmt(threshold)} (non-overlap)`
      : `|Δ|=${fmt(gap)} ≤ CS half-widths ${fmt(threshold)} (overlap)`,
  };
}

function clampAlpha(alpha: number | undefined): number {
  if (!Number.isFinite(alpha)) return DEFAULT_ALPHA;
  const a = alpha as number;
  // Keep strictly inside (0,1); silly inputs fall back to the default.
  if (a <= 0 || a >= 1) return DEFAULT_ALPHA;
  return a;
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "∞" : "-∞";
  return x.toFixed(3);
}
