/**
 * Darwin — Safety Gate
 *
 * Guards against regressions during prompt evolution.
 * Enforces minimum data requirements, regression checks,
 * rollback triggers, and A/B test evaluation rules.
 */

import type { PromptVersionStats, SafetyThresholds, DarwinExperiment } from '../types.js';
import { DEFAULT_SAFETY } from '../types.js';
import { msprtTwoSample, hoeffdingTwoSample, ebTwoSample } from './sequential.js';

export type ABTestOutcome = 'a_wins' | 'b_wins' | 'continue';

/**
 * v0.7.0 — Optional per-arm composite-score samples for the sequential
 * confidence methods (`'msprt'` / `'hoeffding'`). When omitted, the gate
 * falls back to the v0.6.0 effect-size heuristic so all existing callers are
 * byte-for-byte unaffected.
 */
export interface ABTestSamples {
  a: ReadonlyArray<number>;
  b: ReadonlyArray<number>;
}

export interface ABTestConfidence {
  /** Effect size (Cohen's d approximation) */
  effectSize: number;
  /** Whether the result meets minimum confidence threshold */
  confident: boolean;
}

/** Default minRuns range for dynamic sizing */
const DYNAMIC_MIN_RUNS_FLOOR = 10;
const DYNAMIC_MIN_RUNS_CEIL = 30;

/**
 * Mirrors `DEFAULT_ALPHA` in sequential.ts. Kept here because the gate has to
 * SPLIT the budget before handing it to a test (see `isConfident`), so it can
 * no longer just let the primitive apply its own default.
 */
const DEFAULT_CONFIDENCE_ALPHA = 0.05;

/**
 * Process-scoped latch for the "this Hoeffding gate cannot decide" notice.
 * Module level rather than per-instance on purpose: `buildEvolutionLoop`
 * constructs a fresh `SafetyGate` on every evolution cycle, so an instance
 * field would reset each time and turn a one-off configuration notice into
 * per-run stderr noise inside a long-lived process (an agent fleet, a server).
 *
 * What this does NOT do, stated so nobody reads more into it: each `darwin
 * run` is its own OS process, so a CLI user driving twenty runs still sees the
 * notice twenty times, once per invocation. That is inherent without
 * persisting state to disk, and one line per invocation is a reasonable price
 * for telling an operator that their gate can never promote anything.
 */
let warnedInertConfidence = false;

/**
 * Same idea, separate from the inert-Hoeffding latch because the two call for
 * different fixes: one is a method/sample-size mismatch, the other is a
 * misconfiguration producing data the method cannot vouch for.
 *
 * Keyed by CAUSE rather than a single boolean, so a broken score range cannot
 * silence a later out-of-range fault on a different agent.
 */
const warnedInvalidConfidenceCauses = new Set<string>();

/**
 * Clears the process-scoped warning latch. Exported for tests only, and
 * deliberately NOT re-exported from the package root: nothing in normal
 * operation should need to un-warn.
 */
export function resetInertConfidenceWarningForTests(): void {
  warnedInertConfidence = false;
  warnedInvalidConfidenceCauses.clear();
}

/**
 * Collapses a guard's reason string to a stable cause class, so the warning
 * latch deduplicates by KIND of fault rather than by the numbers embedded in
 * the message.
 */
function classifyInvalidInput(reason: string): string {
  if (reason.startsWith('invalid alpha')) return 'alpha';
  if (reason.startsWith('invalid tau')) return 'tau';
  if (reason.startsWith('invalid truncation')) return 'truncation';
  if (reason.startsWith('invalid score range')) return 'range';
  if (reason.startsWith('non-finite score bound')) return 'bound';
  if (reason.includes('outside the declared score range')) return 'out-of-range';
  if (reason.includes('numeric overflow')) return 'overflow';
  return 'other';
}

export class SafetyGate {
  private thresholds: SafetyThresholds;

  // The inert-Hoeffding warning latch is the module-level
  // `warnedInertConfidence` above, not an instance field. Its scope and the
  // trade-off that comes with it are documented at the declaration.

  constructor(thresholds: SafetyThresholds = DEFAULT_SAFETY) {
    this.thresholds = thresholds;
  }

  /**
   * Check whether an agent has accumulated enough data points
   * to proceed with evolution (prompt optimization).
   */
  canEvolve(_agentName: string, stats: PromptVersionStats): boolean {
    return stats.totalRuns >= this.thresholds.minDataPoints;
  }

  /**
   * v0.7.0 — True iff the peeking guard is configured to use a sequential
   * method (mSPRT / Hoeffding), which needs the per-arm composite samples.
   * The loop calls this to decide whether to load that (slightly more
   * expensive) per-sample data before calling {@link evaluateABTest}.
   */
  usesSequentialConfidence(): boolean {
    return (
      this.thresholds.requireConfidence === true &&
      (this.thresholds.confidenceMethod === 'msprt' ||
        this.thresholds.confidenceMethod === 'hoeffding' ||
        this.thresholds.confidenceMethod === 'eb')
    );
  }

  /**
   * Check whether score B is NOT a regression beyond the allowed threshold.
   *
   * Returns `true` if B is acceptable (no regression or within tolerance).
   * Returns `false` if B has regressed beyond `maxRegression` compared to A.
   *
   * Example: maxRegression = 0.20, scoreA = 0.80
   *   - scoreB = 0.70 => drop = 0.125 (12.5%) => acceptable
   *   - scoreB = 0.60 => drop = 0.250 (25.0%) => regression
   */
  checkRegression(scoreA: number, scoreB: number): boolean {
    // If A is zero or negative, any B is acceptable (no baseline)
    if (scoreA <= 0) {
      return true;
    }

    const drop = (scoreA - scoreB) / scoreA;
    return drop <= this.thresholds.maxRegression;
  }

  /**
   * Check if the agent should roll back to its last-known-good prompt
   * based on consecutive failure count.
   */
  shouldRollback(consecutiveFailures: number): boolean {
    return consecutiveFailures >= this.thresholds.failureRollbackThreshold;
  }

  /**
   * Evaluate the outcome of an A/B test between two prompt versions.
   *
   * Rules:
   *   1. Both versions need at least `minRuns` total attempts (success + fail).
   *   2. If a version has >50% failure rate with 3+ attempts, it auto-loses.
   *   3. The winner must show >5% improvement in composite score.
   *   4. If neither clears the bar, the test continues.
   *
   * @param overrideMinRuns — Per-test minimum runs (from ABTest.minRuns).
   *   Falls back to SafetyThresholds.minDataPoints if not provided.
   */
  evaluateABTest(
    compositeA: number,
    compositeB: number,
    runsA: number,
    runsB: number,
    failsA: number = 0,
    failsB: number = 0,
    overrideMinRuns?: number,
    samples?: ABTestSamples,
  ): ABTestOutcome {
    const minRuns = overrideMinRuns ?? this.thresholds.minDataPoints;
    const totalA = runsA + failsA;
    const totalB = runsB + failsB;

    // Reliability check: if a version fails >50% with 3+ total attempts, it auto-loses
    const minAttemptsForReliability = 3;
    if (totalB >= minAttemptsForReliability && failsB / totalB > 0.5) {
      return 'a_wins'; // B is unreliable
    }
    if (totalA >= minAttemptsForReliability && failsA / totalA > 0.5) {
      return 'b_wins'; // A is unreliable
    }

    // Not enough successful data on either side — keep testing
    if (runsA < minRuns || runsB < minRuns) {
      return 'continue';
    }

    const improvementThreshold = 0.05; // 5% relative improvement needed

    // Factor reliability into composite: penalize versions with failures
    const reliabilityA = totalA > 0 ? runsA / totalA : 1;
    const reliabilityB = totalB > 0 ? runsB / totalB : 1;
    const adjustedA = compositeA * reliabilityA;
    const adjustedB = compositeB * reliabilityB;

    // Avoid division by zero
    if (adjustedA === 0 && adjustedB === 0) {
      return 'continue';
    }

    // Determine which side (if any) cleared the 5% relative-improvement bar.
    let marginOutcome: ABTestOutcome | null = null;
    if (adjustedA > 0) {
      const bOverA = (adjustedB - adjustedA) / adjustedA;
      if (bOverA > improvementThreshold) {
        marginOutcome = 'b_wins';
      }
    } else if (adjustedB > 0) {
      marginOutcome = 'b_wins';
    }
    if (marginOutcome === null) {
      if (adjustedB > 0) {
        const aOverB = (adjustedA - adjustedB) / adjustedB;
        if (aOverB > improvementThreshold) {
          marginOutcome = 'a_wins';
        }
      } else if (adjustedA > 0) {
        marginOutcome = 'a_wins';
      }
    }

    if (marginOutcome !== null) {
      // v0.6.0 peeking-guard: only adopt the margin winner if it ALSO clears
      // the effect-size / sample-size bar when requireConfidence is on. If it
      // does not, we do NOT early-return 'continue' — we fall through to the
      // tie-break below so the test still terminates (an early 'continue' here
      // would loop forever on a persistent small-margin challenger).
      if (
        !this.thresholds.requireConfidence ||
        this.isConfident(adjustedA, adjustedB, runsA, runsB, minRuns, marginOutcome, samples)
      ) {
        return marginOutcome;
      }
    }

    // Neither version has a decisive (confident) advantage.
    // Prevent infinite tests: if both have 2x minRuns, declare incumbent (A) the
    // winner. Rationale: if B can't prove itself better after double the sample
    // (or can't clear the confidence bar), A keeps its position.
    const maxRunsPerSide = minRuns * 2;
    if (runsA >= maxRunsPerSide && runsB >= maxRunsPerSide) {
      return 'a_wins'; // Incumbent wins by default — challenger failed to prove superiority
    }

    return 'continue';
  }

  /**
   * Calculate a simple confidence metric for an A/B test result.
   * Uses effect size (difference / pooled estimate) as a proxy.
   * Minimum sample: both sides need >= minDataPoints runs.
   */
  calculateConfidence(
    compositeA: number,
    compositeB: number,
    runsA: number,
    runsB: number,
  ): ABTestConfidence {
    const minRuns = this.thresholds.minDataPoints;

    if (runsA < minRuns || runsB < minRuns) {
      return { effectSize: 0, confident: false };
    }

    // Pooled estimate (simple average as variance proxy)
    const pooled = (compositeA + compositeB) / 2;
    if (pooled === 0) {
      return { effectSize: 0, confident: false };
    }

    // Effect size: absolute difference normalized by pooled mean
    const effectSize = Math.abs(compositeA - compositeB) / pooled;

    // Require at least "small" effect size (0.2) and enough samples
    const totalSamples = runsA + runsB;
    const confident = effectSize >= 0.2 && totalSamples >= minRuns * 2;

    return { effectSize, confident };
  }

  /**
   * v0.6.0 — Peeking-resistant confidence check used by `evaluateABTest`
   * when `requireConfidence` is on. Same effect-size proxy as
   * {@link calculateConfidence} (|Δ| / pooled-mean), but keyed to the
   * test's *effective* minRuns rather than the global default so the gate
   * scales with per-test sample sizing. Requires a "small" effect (≥ 0.2)
   * and at least 2×minRuns total samples before a margin win counts.
   */
  private meetsConfidence(
    scoreA: number,
    scoreB: number,
    runsA: number,
    runsB: number,
    minRuns: number,
  ): boolean {
    const pooled = (scoreA + scoreB) / 2;
    if (pooled === 0) {
      return false;
    }
    const effectSize = Math.abs(scoreA - scoreB) / pooled;
    return effectSize >= 0.2 && runsA + runsB >= minRuns * 2;
  }

  /**
   * v0.7.0 — Dispatch the peeking-resistant confidence gate to the
   * configured {@link SafetyThresholds.confidenceMethod}.
   *
   *   - `'effect-size'` (default): the v0.6.0 heuristic ({@link meetsConfidence}).
   *     Byte-for-byte unchanged when no method is set.
   *   - `'msprt'` / `'hoeffding'`: a sequential test built for repeated
   *     looks (see each function for what it guarantees) over the
   *     RAW per-arm composite samples (reliability is already handled by the
   *     auto-loss rule upstream, so the statistical test uses the unadjusted
   *     scores). The verdict must be `decisive` AND point in the SAME
   *     direction as the score margin — a sequential test that fires for the
   *     opposite arm does not confirm this margin.
   *
   * Falls back to the effect-size heuristic when a sequential method is set
   * but no per-sample data was supplied (graceful — never throws).
   */
  private isConfident(
    adjustedA: number,
    adjustedB: number,
    runsA: number,
    runsB: number,
    minRuns: number,
    marginOutcome: ABTestOutcome,
    samples?: ABTestSamples,
  ): boolean {
    const method = this.thresholds.confidenceMethod ?? 'effect-size';

    if (method === 'effect-size' || !samples) {
      return this.meetsConfidence(adjustedA, adjustedB, runsA, runsB, minRuns);
    }

    const opts = {
      alpha: this.thresholds.confidenceAlpha,
      minSamplesPerArm: this.thresholds.confidenceMinSamples,
    };

    // Budget split (v0.15). Under `'msprt'` this gate can run TWO tests: mSPRT,
    // and Hoeffding as a fallback when mSPRT has no noise scale to work with.
    // Those two rejection events are disjoint but their error probabilities
    // ADD, so running both at the full alpha would give a composite level of up
    // to 2*alpha. Each therefore gets half. Under `'hoeffding'` and `'eb'`
    // (v0.16) there is only ever one test, so it keeps the whole budget: EB
    // needs no fallback because its regularised variance estimate exists from
    // the first observation, so it has no no-spread abstention to hand off.
    const configuredAlpha = this.thresholds.confidenceAlpha ?? DEFAULT_CONFIDENCE_ALPHA;
    const perTestAlpha = method === 'msprt' ? configuredAlpha / 2 : configuredAlpha;

    const hoeffdingOpts = {
      ...opts,
      alpha: perTestAlpha,
      lo: this.thresholds.confidenceScoreRange?.[0],
      hi: this.thresholds.confidenceScoreRange?.[1],
    };

    let verdict =
      method === 'hoeffding'
        ? hoeffdingTwoSample(samples.a, samples.b, hoeffdingOpts)
        : method === 'eb'
          ? ebTwoSample(samples.a, samples.b, hoeffdingOpts)
          : msprtTwoSample(samples.a, samples.b, {
            ...opts,
            alpha: perTestAlpha,
            tau: this.thresholds.confidenceTau,
          });

    // v0.15: mSPRT abstains when neither arm shows any spread, because its
    // variance estimate is then meaningless and the old shortcut fired
    // regardless of alpha. That abstention would otherwise freeze evolution for
    // a perfectly legitimate setup: a deterministic or rule-based evaluator
    // that returns the same score every run (say 6 for A and 8 for B) produces
    // exactly those constant arms, and v0.14 promoted B there.
    //
    // So hand that case to the method that does not need a variance estimate.
    // Hoeffding is distribution-free, and constant arms with a real gap are
    // precisely the large-effect situation it can resolve, given enough runs.
    // It is stricter (nothing fires under 22 runs per arm on a [0,1] score),
    // which is the honest answer rather than a regression: at eight runs you
    // genuinely cannot rule out that the constancy was luck.
    if (method === 'msprt' && verdict.abstainCode === 'no-spread') {
      // Only adopt the fallback when it actually decides. If it refuses (most
      // often because the scores live outside the default [0,1] and no
      // `confidenceScoreRange` was configured), keep mSPRT's abstention rather
      // than reporting an invalid-input fault the caller never asked for.
      const fallback = hoeffdingTwoSample(samples.a, samples.b, hoeffdingOpts);
      if (fallback.decisive) verdict = fallback;
    }

    if (!verdict.decisive) {
      // A refused-because-broken-input verdict is a configuration fault, not a
      // quiet "not yet". Without this the loop turns it into a plain false, the
      // test drifts to the incumbent tie-break, and nobody ever learns that the
      // composite scores were outside the declared range. Surfaced once per
      // process, same reasoning as the latch below.
      // Keyed by cause CLASS, not one global boolean and not by value: a
      // single flag would let the first fault silence every later one, while
      // keying on the full reason (which embeds the offending numbers) would
      // print a fresh warning for every distinct out-of-range sample and grow
      // the set without bound.
      const cause = `${verdict.method}:${classifyInvalidInput(verdict.reason)}`;
      if (verdict.invalidInput && !warnedInvalidConfidenceCauses.has(cause)) {
        warnedInvalidConfidenceCauses.add(cause);
        console.warn(
          `[darwin] the ${verdict.method} confidence gate refused to evaluate ` +
            `because its input is invalid, so no challenger can be promoted on ` +
            `quality until this is fixed. ${verdict.reason}`,
        );
      }
      // v0.15: a gate whose bar already exceeds the score range cannot confirm
      // a score margin, whatever the data. That is honest behaviour for a
      // distribution-free bound at 10 to 30 runs per arm, but freezing the
      // margin path in silence is not, so say it once per process. (v0.16: the
      // same structural blind zone exists for 'eb' below ~18 runs per arm, so
      // the message names the method that actually produced the verdict.)
      //
      // Careful with the wording: this does NOT mean nothing can ever be
      // promoted. `evaluateABTest` runs the reliability auto-loss BEFORE this
      // gate, so an incumbent that fails more than half its attempts still
      // hands the test to B. The claim is scoped to the margin path only.
      if (verdict.inconclusiveByConstruction && !warnedInertConfidence) {
        warnedInertConfidence = true;
        console.warn(
          `[darwin] confidenceMethod '${verdict.method}' cannot confirm a score margin ` +
            `at this sample size, so no challenger will be promoted on quality ` +
            `while that holds (the reliability auto-loss rule still applies). ` +
            `${verdict.reason}`,
        );
      }
      return false;
    }
    // The sequential test must confirm the SAME winner as the score margin.
    // direction +1 = B>A (b_wins), −1 = A>B (a_wins).
    const expected = marginOutcome === 'b_wins' ? 1 : -1;
    return verdict.direction === expected;
  }

  /**
   * Pick a per-arm run budget from the observed spread of quality scores.
   *
   *   - Wide spread (std >= 1.0): floor (10)
   *   - Tight spread (std < 0.5): ceil (30)
   *   - In between (0.5 to 1.0):  linear interpolation
   *
   * ## This is a throughput heuristic, not a power calculation
   *
   * Said plainly, because the pre-0.15 docstring did not say it and read like
   * a derivation: **the direction here is the opposite of the textbook sample
   * size formula, and that is deliberate.** Detecting a FIXED absolute
   * difference Δ at level α with power 1-β needs
   *
   *   n_per_arm ≈ 2σ²(z_{1-α/2} + z_{1-β})² / Δ²
   *
   * which grows WITH the variance. Read that way, a high-variance agent should
   * get MORE runs, not fewer, and this function would be backwards.
   *
   * What it actually encodes is a different premise: that the size of the
   * effect worth finding scales with the spread the agent already shows. When
   * every run lands between 6.5 and 7.0, the gap between two prompt versions
   * lives inside that same band, and Darwin's own benchmark puts LLM-judge
   * noise near ±1 against real lifts of +0.1 to +0.2. A tight band therefore
   * means small effects buried in judge noise, which needs a longer test. A
   * wide band usually means the agent is being handed genuinely different
   * tasks, where a floor of 10 runs already spreads the cost fairly.
   *
   * Note what this implies: if the effect scales exactly with σ (a fixed
   * standardised effect size, Cohen's d), n drops out of the formula entirely
   * and NEITHER direction is derivable from theory. So this is a product
   * decision about throughput versus patience, made explicit here rather than
   * dressed up as statistics.
   *
   * **If you want the statistics, turn on `requireConfidence` with
   * `confidenceMethod: 'msprt'`** rather than tuning this number. The
   * sequential test then decides whether the evidence supports the margin.
   *
   * One thing that does NOT follow, and an earlier draft of this docstring got
   * it wrong: `minRuns` does not become a mere floor. `evaluateABTest` also
   * uses it as a stopping cap. Once BOTH arms reach `2 × minRuns` without a
   * confirmed winner, the incumbent is declared the winner so the test cannot
   * run forever. So this number still sets the ceiling on how much evidence a
   * challenger is ever allowed to gather: at the default it is 60 runs per
   * arm, which is well short of what the Hoeffding method would need.
   *
   * @param experiments Recent experiments for both A and B versions
   * @param configMinRuns Agent-level minRuns override from EvolutionConfig
   * @returns Computed minRuns (never below floor, never above ceil)
   */
  computeDynamicMinRuns(
    experiments: DarwinExperiment[],
    configMinRuns?: number,
  ): number {
    const floor = configMinRuns ?? DYNAMIC_MIN_RUNS_FLOOR;
    const ceil = Math.max(floor, DYNAMIC_MIN_RUNS_CEIL);

    // Need at least 4 quality scores to estimate variance
    const qualityScores = experiments
      .map((e) => e.metrics.qualityScore)
      .filter((s): s is number => s !== null);

    if (qualityScores.length < 4) {
      return floor;
    }

    const mean = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
    // Bessel's correction (n-1): we are estimating population variance from a sample.
    // Without this, small samples (n=4-5) underestimate std by ~13%, inflating minRuns.
    const variance = qualityScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / (qualityScores.length - 1);
    const std = Math.sqrt(variance);

    // Wide spread: run the floor. Not because differences are "easy to spot"
    // (the old comment claimed that, and it is false for a fixed absolute
    // effect), but because a wide spread usually means heterogeneous tasks,
    // where more runs of the same test buy less than moving on.
    if (std >= 1.0) {
      return floor;
    }

    // Tight spread: run the ceiling, on the premise that the effect worth
    // finding is proportionally small. See the docstring for why this premise,
    // and not a power calculation, is what decides the direction.
    if (std < 0.5) {
      return ceil;
    }

    // Mid range: linear interpolation between ceil and floor
    // std=0.5 → ceil, std=1.0 → floor
    const t = (std - 0.5) / 0.5; // 0 at std=0.5, 1 at std=1.0
    return Math.round(ceil + t * (floor - ceil));
  }
}
