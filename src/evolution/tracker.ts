/**
 * Darwin — Experiment Tracker
 *
 * Records experiments, aggregates stats, and computes composite scores
 * for prompt version evaluation.
 */

import type {
  DarwinExperiment,
  DarwinState,
  MemoryProvider,
  MetricWeights,
  PromptVersionStats,
} from '../types.js';
import type { CategoryStats } from './optimizer.js';
import { DEFAULT_WEIGHTS } from '../types.js';

export class ExperimentTracker {
  private memory: MemoryProvider;

  constructor(memory: MemoryProvider) {
    this.memory = memory;
  }

  /**
   * Record a completed experiment.
   * Saves it to memory, updates the prompt version stats, and adjusts
   * the consecutive-failure counter in Darwin state.
   */
  async recordExperiment(exp: DarwinExperiment): Promise<void> {
    // 1. Persist the raw experiment
    await this.memory.saveExperiment(exp);

    // 2. Refresh aggregated stats on the prompt version
    const versions = await this.memory.getAllPromptVersions(exp.agentName);
    const version = versions.find((v) => v.version === exp.promptVersion);
    if (version) {
      const updatedStats = await this.getStats(exp.agentName, exp.promptVersion);
      version.stats = updatedStats;
      await this.memory.savePromptVersion(version);
    }

    // 3. Atomically update Darwin state (experiment count + consecutive failures).
    // Uses updateState() to prevent race conditions when multiple agents
    // record experiments concurrently — getState()+saveState() would lose updates.
    await this.memory.updateState((state) => {
      state.experimentCounts[exp.agentName] =
        (state.experimentCounts[exp.agentName] ?? 0) + 1;

      if (exp.success) {
        state.consecutiveFailures[exp.agentName] = 0;
      } else {
        state.consecutiveFailures[exp.agentName] =
          (state.consecutiveFailures[exp.agentName] ?? 0) + 1;
      }

      return state;
    });
  }

  /**
   * Aggregate stats from all experiments for a given agent (optionally
   * filtered to a single prompt version).
   */
  async getStats(
    agentName: string,
    version?: string,
  ): Promise<PromptVersionStats> {
    const experiments = await this.memory.loadExperiments(agentName);

    const filtered = version
      ? experiments.filter((e) => e.promptVersion === version)
      : experiments;

    if (filtered.length === 0) {
      return {
        totalRuns: 0,
        avgQuality: 0,
        avgDuration: 0,
        successRate: 0,
        avgSourceCount: 0,
      };
    }

    const totalRuns = filtered.length;
    const successCount = filtered.filter((e) => e.success).length;

    // Quality: only count experiments that have a quality score
    const withQuality = filtered.filter(
      (e) => e.metrics.qualityScore !== null,
    );
    const avgQuality =
      withQuality.length > 0
        ? withQuality.reduce((sum, e) => sum + (e.metrics.qualityScore ?? 0), 0) /
          withQuality.length
        : 0;

    const avgDuration =
      filtered.reduce((sum, e) => sum + e.metrics.durationMs, 0) / totalRuns;

    const avgSourceCount =
      filtered.reduce((sum, e) => sum + e.metrics.sourceCount, 0) / totalRuns;

    return {
      totalRuns,
      avgQuality,
      avgDuration,
      successRate: successCount / totalRuns,
      avgSourceCount,
    };
  }

  /**
   * Calculate a composite score for a single experiment.
   *
   * Normalization ranges:
   *   quality      — score / 10          (0-10 scale)
   *   sourceCount  — min(count / 20, 1)  (20 sources = perfect)
   *   outputLength — min(len / 10000, 1) (10k chars = perfect)
   *   duration     — 1 - min(ms/300000, 1) (lower is better, 5 min cap)
   *   success      — 1 if true, 0 if false
   */
  getCompositeScore(
    exp: DarwinExperiment,
    weights: MetricWeights = DEFAULT_WEIGHTS,
  ): number {
    // NULL quality = critic failed, not agent failed. Exclude from quality component
    // instead of treating as 0 (which unfairly tanks the composite).
    const hasQuality = exp.metrics.qualityScore !== null;
    const qualityNorm = hasQuality ? (exp.metrics.qualityScore as number) / 10 : 0;

    // If no quality score, redistribute quality weight to other metrics
    const effectiveQualityWeight = hasQuality ? weights.quality : 0;
    const weightSum = effectiveQualityWeight + weights.sourceCount + weights.outputLength + weights.duration + weights.success;
    const scale = weightSum > 0 ? 1 / weightSum : 0;

    const normalized = {
      quality: qualityNorm,
      sourceCount: Math.min(exp.metrics.sourceCount / 20, 1),
      outputLength: Math.min(exp.metrics.outputLength / 10000, 1),
      duration: 1 - Math.min(exp.metrics.durationMs / 300000, 1),
      success: exp.success ? 1 : 0,
    };

    const score = (
      normalized.quality * effectiveQualityWeight +
      normalized.sourceCount * weights.sourceCount +
      normalized.outputLength * weights.outputLength +
      normalized.duration * weights.duration +
      normalized.success * weights.success
    ) * scale;

    return score;
  }

  /**
   * Get stats broken down by task category (P2-5).
   * Gives the optimizer visibility into which topic types perform well/poorly.
   */
  async getStatsByCategory(agentName: string): Promise<CategoryStats[]> {
    const experiments = await this.memory.loadExperiments(agentName);
    const byCategory = new Map<string, DarwinExperiment[]>();

    for (const exp of experiments) {
      const key = exp.taskType || 'general';
      const list = byCategory.get(key);
      if (list) {
        list.push(exp);
      } else {
        byCategory.set(key, [exp]);
      }
    }

    const result: CategoryStats[] = [];
    for (const [taskType, exps] of byCategory) {
      const withQuality = exps.filter((e) => e.metrics.qualityScore !== null);
      const avgQuality = withQuality.length > 0
        ? withQuality.reduce((s, e) => s + (e.metrics.qualityScore ?? 0), 0) / withQuality.length
        : 0;
      const avgSourceCount = exps.reduce((s, e) => s + e.metrics.sourceCount, 0) / exps.length;
      const successRate = exps.filter((e) => e.success).length / exps.length;

      result.push({ taskType, totalRuns: exps.length, avgQuality, avgSourceCount, successRate });
    }

    return result.sort((a, b) => b.totalRuns - a.totalRuns);
  }

  /**
   * Average composite score across experiments for a specific agent + prompt version.
   *
   * If `since` is provided, only experiments after that ISO timestamp are included.
   * This is critical for A/B tests: compare only the test period, not all-time data
   * (otherwise the incumbent version's historical data skews the comparison).
   */
  async getAverageComposite(
    agentName: string,
    version: string,
    weights: MetricWeights = DEFAULT_WEIGHTS,
    since?: string,
  ): Promise<number> {
    const experiments = await this.memory.loadExperiments(agentName);
    let filtered = experiments.filter((e) => e.promptVersion === version);

    if (since) {
      filtered = filtered.filter((e) => e.startedAt >= since);
    }

    if (filtered.length === 0) {
      return 0;
    }

    const total = filtered.reduce(
      (sum, exp) => sum + this.getCompositeScore(exp, weights),
      0,
    );

    return total / filtered.length;
  }
}
