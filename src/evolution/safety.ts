/**
 * Darwin — Safety Gate
 *
 * Guards against regressions during prompt evolution.
 * Enforces minimum data requirements, regression checks,
 * rollback triggers, and A/B test evaluation rules.
 */

import type { PromptVersionStats, SafetyThresholds, DarwinExperiment } from '../types.js';
import { DEFAULT_SAFETY } from '../types.js';

export type ABTestOutcome = 'a_wins' | 'b_wins' | 'continue';

export interface ABTestConfidence {
  /** Effect size (Cohen's d approximation) */
  effectSize: number;
  /** Whether the result meets minimum confidence threshold */
  confident: boolean;
}

/** Default minRuns range for dynamic sizing */
const DYNAMIC_MIN_RUNS_FLOOR = 10;
const DYNAMIC_MIN_RUNS_CEIL = 30;

export class SafetyGate {
  private thresholds: SafetyThresholds;

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

    // Check if B beats A by >5%
    if (adjustedA > 0) {
      const bOverA = (adjustedB - adjustedA) / adjustedA;
      if (bOverA > improvementThreshold) {
        return 'b_wins';
      }
    } else if (adjustedB > 0) {
      return 'b_wins';
    }

    // Check if A beats B by >5%
    if (adjustedB > 0) {
      const aOverB = (adjustedA - adjustedB) / adjustedB;
      if (aOverB > improvementThreshold) {
        return 'a_wins';
      }
    } else if (adjustedA > 0) {
      return 'a_wins';
    }

    // Neither version has a decisive advantage.
    // But prevent infinite tests: if both have 2x minRuns, declare incumbent (A) the winner.
    // Rationale: if B can't prove itself better after double the sample, A keeps its position.
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
   * Compute dynamic minRuns based on observed quality score variance.
   *
   * When scores cluster tightly (e.g., 6.5-7.0, std < 0.5), a small
   * sample cannot distinguish between versions. This method increases
   * minRuns proportionally to the inverse of variance:
   *
   *   - High variance (std >= 1.0): floor (10) — easy to detect differences
   *   - Low variance  (std < 0.5):  ceil (30) — need more samples
   *   - Mid variance  (0.5 - 1.0):  linear interpolation
   *
   * @param experiments — Recent experiments for both A and B versions
   * @param configMinRuns — Agent-level minRuns override from EvolutionConfig
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

    // High variance (std >= 1.0): floor — differences are easy to spot
    if (std >= 1.0) {
      return floor;
    }

    // Low variance (std < 0.5): ceil — need many samples
    if (std < 0.5) {
      return ceil;
    }

    // Mid range: linear interpolation between ceil and floor
    // std=0.5 → ceil, std=1.0 → floor
    const t = (std - 0.5) / 0.5; // 0 at std=0.5, 1 at std=1.0
    return Math.round(ceil + t * (floor - ceil));
  }
}
