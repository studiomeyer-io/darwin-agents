/**
 * Darwin — Pattern Detector
 *
 * Analyzes experiment history to detect performance patterns:
 * strengths, weaknesses, trends, and anomalies.
 *
 * These patterns drive prompt optimization decisions.
 */

import type {
  DarwinExperiment,
  DarwinPattern,
  MemoryProvider,
} from '../types.js';

/** Minimum experiments in a category before patterns are reported. */
const MIN_CATEGORY_SIZE = 2;

/** Score thresholds (on 0-10 quality scale). */
const STRENGTH_THRESHOLD = 7.5;
const WEAKNESS_THRESHOLD = 4.0;

/**
 * Relative weakness: a category scoring >1.0 below the agent's overall average.
 * This catches "mediocre" categories (e.g. 6.3 when others are 7.1).
 */
const RELATIVE_WEAKNESS_GAP = 1.0;

/** Minimum runs in a category before relative weakness is reported. */
const MIN_RELATIVE_WEAKNESS_RUNS = 5;

/** Anomaly detection: how many standard deviations away. */
const ANOMALY_SIGMA = 2.0;

/** Minimum experiments needed for trend detection. */
const MIN_TREND_LENGTH = 3;

export class PatternDetector {
  private memory: MemoryProvider;

  constructor(memory: MemoryProvider) {
    this.memory = memory;
  }

  /**
   * Detect patterns across all experiments for a given agent.
   *
   * Groups experiments by taskType, then looks for:
   *   - Strengths: categories where the agent consistently scores high
   *   - Weaknesses: categories where the agent consistently scores low
   *   - Trends: improving or declining performance over time
   *   - Anomalies: individual experiments far from the mean
   */
  async detectPatterns(agentName: string): Promise<DarwinPattern[]> {
    const experiments = await this.memory.loadExperiments(agentName);
    if (experiments.length === 0) {
      return [];
    }

    const patterns: DarwinPattern[] = [];

    // Group experiments by task type
    const byCategory = this.groupByTaskType(experiments);

    // Overall agent average (for relative weakness detection)
    const overallAvg = this.avgQuality(experiments);

    // Per-category analysis
    byCategory.forEach((exps, taskType) => {
      if (exps.length < MIN_CATEGORY_SIZE) {
        return;
      }

      patterns.push(...this.detectStrengths(taskType, exps));
      patterns.push(...this.detectWeaknesses(taskType, exps));
      patterns.push(...this.detectRelativeWeaknesses(taskType, exps, overallAvg));
      patterns.push(...this.detectAnomalies(taskType, exps));
    });

    // Cross-category trend detection (chronological across all experiments)
    patterns.push(...this.detectTrends(experiments));

    return patterns;
  }

  // ─── Strength Detection ──────────────────────────────

  private detectStrengths(
    taskType: string,
    experiments: DarwinExperiment[],
  ): DarwinPattern[] {
    const patterns: DarwinPattern[] = [];
    const avgQuality = this.avgQuality(experiments);
    const successRate = this.successRate(experiments);

    if (avgQuality >= STRENGTH_THRESHOLD) {
      patterns.push({
        type: 'strength',
        taskType,
        description: `High quality on "${taskType}" tasks (avg ${avgQuality.toFixed(1)}/10)`,
        confidence: this.confidenceFromCount(experiments.length),
        evidence: experiments.length,
        suggestion: `Leverage this strength. The agent excels at ${taskType} tasks.`,
      });
    }

    if (successRate >= 0.9 && experiments.length >= MIN_CATEGORY_SIZE) {
      patterns.push({
        type: 'strength',
        taskType,
        description: `${(successRate * 100).toFixed(0)}% success rate on "${taskType}" tasks`,
        confidence: this.confidenceFromCount(experiments.length),
        evidence: experiments.length,
        suggestion: `Reliability on ${taskType} is excellent. Maintain current approach.`,
      });
    }

    return patterns;
  }

  // ─── Weakness Detection ──────────────────────────────

  private detectWeaknesses(
    taskType: string,
    experiments: DarwinExperiment[],
  ): DarwinPattern[] {
    const patterns: DarwinPattern[] = [];
    const avgQuality = this.avgQuality(experiments);
    const successRate = this.successRate(experiments);

    if (avgQuality > 0 && avgQuality <= WEAKNESS_THRESHOLD) {
      patterns.push({
        type: 'weakness',
        taskType,
        description: `Low quality on "${taskType}" tasks (avg ${avgQuality.toFixed(1)}/10)`,
        confidence: this.confidenceFromCount(experiments.length),
        evidence: experiments.length,
        suggestion: `Improve instructions for ${taskType} tasks. Consider adding examples or constraints.`,
      });
    }

    if (successRate < 0.5 && experiments.length >= MIN_CATEGORY_SIZE) {
      patterns.push({
        type: 'weakness',
        taskType,
        description: `Only ${(successRate * 100).toFixed(0)}% success rate on "${taskType}" tasks`,
        confidence: this.confidenceFromCount(experiments.length),
        evidence: experiments.length,
        suggestion: `High failure rate on ${taskType}. Review error patterns and add guardrails.`,
      });
    }

    return patterns;
  }

  // ─── Relative Weakness Detection ────────────────────

  /**
   * Detect categories that underperform relative to the agent's overall average.
   * This catches the "mediocre zone" (4.0-7.5) that absolute thresholds miss.
   *
   * Example: Writer has market=6.3, tech=7.1, webdesign=7.1 → overall ~6.8
   * Market is 0.5 below average. With RELATIVE_WEAKNESS_GAP=1.0, it wouldn't trigger.
   * But if we also check against the BEST category, market is 0.8 below tech/webdesign.
   *
   * Strategy: flag if category is >RELATIVE_WEAKNESS_GAP below the best category
   * OR if category is below 7.0 with significant data (improvement opportunity).
   */
  private detectRelativeWeaknesses(
    taskType: string,
    experiments: DarwinExperiment[],
    overallAvg: number,
  ): DarwinPattern[] {
    const patterns: DarwinPattern[] = [];

    if (experiments.length < MIN_RELATIVE_WEAKNESS_RUNS) {
      return patterns;
    }

    const avgQuality = this.avgQuality(experiments);

    // Skip if already caught by absolute weakness threshold
    if (avgQuality <= WEAKNESS_THRESHOLD) {
      return patterns;
    }

    // Check 1: Category significantly below agent's overall average
    const gapFromAvg = overallAvg - avgQuality;
    if (gapFromAvg >= RELATIVE_WEAKNESS_GAP) {
      patterns.push({
        type: 'weakness',
        taskType,
        description: `"${taskType}" underperforms vs agent average: ${avgQuality.toFixed(1)}/10 vs ${overallAvg.toFixed(1)}/10 overall (gap: ${gapFromAvg.toFixed(1)})`,
        confidence: this.confidenceFromCount(experiments.length),
        evidence: experiments.length,
        suggestion: `Improve "${taskType}" instructions. This category scores ${gapFromAvg.toFixed(1)} points below the agent's average.`,
      });
    }

    // Check 2: Below "good" threshold with enough data → improvement opportunity
    // 8.0 (not 7.0) — agents scoring 7.4-7.9 should trigger evolution, not coast
    const GOOD_THRESHOLD = 8.0;
    if (avgQuality < GOOD_THRESHOLD && experiments.length >= 10) {
      patterns.push({
        type: 'weakness',
        taskType,
        description: `"${taskType}" below good threshold: ${avgQuality.toFixed(1)}/10 (target: ${GOOD_THRESHOLD}/10, ${experiments.length} runs)`,
        confidence: this.confidenceFromCount(experiments.length),
        evidence: experiments.length,
        suggestion: `"${taskType}" has enough data (${experiments.length} runs) to optimize. Target: raise from ${avgQuality.toFixed(1)} to ${GOOD_THRESHOLD}+.`,
      });
    }

    return patterns;
  }

  // ─── Trend Detection ─────────────────────────────────

  /**
   * Detect improving or declining quality trends across all experiments
   * (sorted chronologically).
   */
  private detectTrends(experiments: DarwinExperiment[]): DarwinPattern[] {
    const patterns: DarwinPattern[] = [];

    // Sort by start time
    const sorted = [...experiments].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
    );

    // Need enough data points for trend detection
    if (sorted.length < MIN_TREND_LENGTH) {
      return patterns;
    }

    // Only use experiments with quality scores
    const withQuality = sorted.filter((e) => e.metrics.qualityScore !== null);
    if (withQuality.length < MIN_TREND_LENGTH) {
      return patterns;
    }

    // Compare first half vs second half
    const mid = Math.floor(withQuality.length / 2);
    const firstHalf = withQuality.slice(0, mid);
    const secondHalf = withQuality.slice(mid);

    const avgFirst = this.avgQuality(firstHalf);
    const avgSecond = this.avgQuality(secondHalf);

    // Significant change threshold: 1.0 points on 10-point scale
    const delta = avgSecond - avgFirst;

    if (delta >= 1.0) {
      patterns.push({
        type: 'trend',
        description: `Quality improving: ${avgFirst.toFixed(1)} -> ${avgSecond.toFixed(1)} (recent half)`,
        confidence: this.confidenceFromCount(withQuality.length),
        evidence: withQuality.length,
        suggestion: 'Positive trend detected. Recent prompt changes are working well.',
      });
    } else if (delta <= -1.0) {
      patterns.push({
        type: 'trend',
        description: `Quality declining: ${avgFirst.toFixed(1)} -> ${avgSecond.toFixed(1)} (recent half)`,
        confidence: this.confidenceFromCount(withQuality.length),
        evidence: withQuality.length,
        suggestion: 'Negative trend detected. Consider rolling back recent prompt changes.',
      });
    }

    return patterns;
  }

  // ─── Anomaly Detection ───────────────────────────────

  /**
   * Detect outlier experiments within a task category using
   * standard deviation from the mean quality score.
   */
  private detectAnomalies(
    taskType: string,
    experiments: DarwinExperiment[],
  ): DarwinPattern[] {
    const patterns: DarwinPattern[] = [];

    const withQuality = experiments.filter(
      (e) => e.metrics.qualityScore !== null,
    );
    if (withQuality.length < MIN_CATEGORY_SIZE) {
      return patterns;
    }

    const scores = withQuality.map((e) => e.metrics.qualityScore as number);
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const stdDev = this.standardDeviation(scores, mean);

    // Skip if no variance (all scores identical)
    if (stdDev === 0) {
      return patterns;
    }

    for (const exp of withQuality) {
      const score = exp.metrics.qualityScore as number;
      const zScore = Math.abs(score - mean) / stdDev;

      if (zScore >= ANOMALY_SIGMA) {
        const direction = score > mean ? 'above' : 'below';
        patterns.push({
          type: 'anomaly',
          taskType,
          description: `Outlier in "${taskType}": score ${score.toFixed(1)} is ${zScore.toFixed(1)} sigma ${direction} mean (${mean.toFixed(1)})`,
          confidence: Math.min(zScore / 3, 1), // Higher z-score = higher confidence
          evidence: 1,
          suggestion:
            direction === 'below'
              ? `Investigate why experiment ${exp.id} scored unusually low.`
              : `Experiment ${exp.id} scored exceptionally well. Analyze what made it succeed.`,
        });
      }
    }

    return patterns;
  }

  // ─── Helpers ─────────────────────────────────────────

  private groupByTaskType(
    experiments: DarwinExperiment[],
  ): Map<string, DarwinExperiment[]> {
    const map = new Map<string, DarwinExperiment[]>();
    for (const exp of experiments) {
      const key = exp.taskType || 'unknown';
      const list = map.get(key);
      if (list) {
        list.push(exp);
      } else {
        map.set(key, [exp]);
      }
    }
    return map;
  }

  private avgQuality(experiments: DarwinExperiment[]): number {
    const withScore = experiments.filter(
      (e) => e.metrics.qualityScore !== null,
    );
    if (withScore.length === 0) return 0;
    return (
      withScore.reduce((sum, e) => sum + (e.metrics.qualityScore ?? 0), 0) /
      withScore.length
    );
  }

  private successRate(experiments: DarwinExperiment[]): number {
    if (experiments.length === 0) return 0;
    return experiments.filter((e) => e.success).length / experiments.length;
  }

  /**
   * Calculate confidence from evidence count.
   * More data points = higher confidence, capping at 1.0.
   * Formula: min(count / 10, 1.0) — so 10+ experiments = full confidence.
   */
  private confidenceFromCount(count: number): number {
    return Math.min(count / 10, 1.0);
  }

  /**
   * Sample standard deviation (Bessel's correction, n-1).
   * With small category sizes (MIN_CATEGORY_SIZE=2), population std
   * would underestimate variance and over-report anomalies.
   */
  private standardDeviation(values: number[], mean: number): number {
    if (values.length <= 1) return 0;
    const squaredDiffs = values.map((v) => (v - mean) ** 2);
    const avgSquaredDiff =
      squaredDiffs.reduce((s, v) => s + v, 0) / (values.length - 1);
    return Math.sqrt(avgSquaredDiff);
  }
}
