/**
 * Darwin — Evolution Loop
 *
 * The core evolution cycle. Called after every agent run, it:
 *   1. Records the experiment
 *   2. Checks for failure rollback
 *   3. Manages A/B tests between prompt versions
 *   4. Triggers prompt optimization when enough data exists
 *
 * This is the brain of Darwin's self-evolution.
 */

import type {
  ABTest,
  AgentDefinition,
  DarwinExperiment,
  DarwinPattern,
  MemoryProvider,
  PromptVersion,
} from '../types.js';
import type { ExperimentTracker } from './tracker.js';
import type { PromptOptimizer, AgentToolContext } from './optimizer.js';
import type { SafetyGate } from './safety.js';
import type { PatternDetector } from './patterns.js';
import type { NotificationConfig } from './notifications.js';
import { notifyABTestComplete, notifyEvolutionStarted, notifyRollback } from './notifications.js';
import type { GepaOptimizer } from './optimizer-gepa.js';
import type { ReflectiveFeedback } from './reflector.js';
import { checkAlignmentPreservation } from './alignment.js';
import { dominates, DARWIN_DEFAULT_OBJECTIVES, type ParetoObjective } from './pareto.js';

// ─── Result Type ───────────────────────────────────────

export interface EvolutionResult {
  patternsFound: DarwinPattern[];
  promptEvolved: boolean;
  abTestStarted: boolean;
  abTestCompleted: boolean;
  rolledBack: boolean;
  newVersion?: string;
  message: string;
}

// ─── Dependencies ──────────────────────────────────────

interface DarwinLoopDeps {
  memory: MemoryProvider;
  tracker: ExperimentTracker;
  optimizer: PromptOptimizer;
  safety: SafetyGate;
  patterns: PatternDetector;
  /** Agent definition — used to pass tool context to optimizer */
  agent?: AgentDefinition;
  /** Notification config (Telegram alerts) — auto-loaded from env if not set */
  notifications?: NotificationConfig;
  /**
   * v0.6.0 — Optional GEPA-style reflective optimizer. When present AND the
   * agent has `evolution.useGepa === true`, variant generation routes through
   * the reflector (rich text feedback → smallest-possible-edit) instead of
   * the legacy stats-meta-prompt optimizer. Omit it (or leave `useGepa`
   * false) to keep the legacy single-shot path — behaviour is unchanged.
   */
  gepa?: GepaOptimizer;
}

// ─── Validation Constants ─────────────────────────────

/** Default minimum output length (overridden by agent.evolution.minOutputLength) */
const DEFAULT_MIN_VALID_OUTPUT = 2000;

/** Minimum % of runs with sources needed before evolution triggers */
const MIN_SOURCE_COVERAGE = 0.5;

// ─── Loop ──────────────────────────────────────────────

export class DarwinLoop {
  private memory: MemoryProvider;
  private tracker: ExperimentTracker;
  private optimizer: PromptOptimizer;
  private safety: SafetyGate;
  private patterns: PatternDetector;
  private agent?: AgentDefinition;
  private notifications: NotificationConfig;
  private gepa?: GepaOptimizer;

  constructor(deps: DarwinLoopDeps) {
    this.memory = deps.memory;
    this.tracker = deps.tracker;
    this.optimizer = deps.optimizer;
    this.safety = deps.safety;
    this.patterns = deps.patterns;
    this.agent = deps.agent;
    this.notifications = deps.notifications ?? {};
    this.gepa = deps.gepa;
  }

  /**
   * Called AFTER every agent run. Drives the evolution cycle.
   *
   * Flow:
   *   0. Detect incomplete runs (skip them)
   *   1. Record experiment
   *   2. Rollback check (consecutive failures)
   *   3. A/B test management (if active)
   *   4. Validate data quality before evolving
   *   5. Evolution trigger (if enough data and no active test)
   */
  async afterRun(experiment: DarwinExperiment): Promise<EvolutionResult> {
    const result: EvolutionResult = {
      patternsFound: [],
      promptEvolved: false,
      abTestStarted: false,
      abTestCompleted: false,
      rolledBack: false,
      message: '',
    };

    const agent = experiment.agentName;

    // ── Step 0: Incomplete Run Detection (P1-3) ─────
    if (this.isIncompleteRun(experiment)) {
      // Track failure in A/B test if one is active
      const preState = await this.memory.getState();
      const activeTest = preState.abTests[agent] ?? null;
      if (activeTest) {
        // Atomically increment failure counts inside callback (prevents stale-read race)
        await this.memory.updateState((s) => {
          const test = s.abTests[agent];
          if (!test) return s;
          if (experiment.promptVersion === test.versionA) {
            test.failsA = (test.failsA ?? 0) + 1;
          } else if (experiment.promptVersion === test.versionB) {
            test.failsB = (test.failsB ?? 0) + 1;
          }
          return s;
        });

        // Re-read state after atomic update for evaluation
        const postState = await this.memory.getState();
        const currentTest = postState.abTests[agent];
        if (!currentTest) {
          result.message = `Incomplete run. A/B test cleared concurrently.`;
          return result;
        }

        // Check if this version should auto-lose due to unreliability
        const evalResult = this.safety.evaluateABTest(
          0, 0,
          currentTest.runsA, currentTest.runsB,
          currentTest.failsA ?? 0, currentTest.failsB ?? 0,
          currentTest.minRuns,
        );
        if (evalResult !== 'continue') {
          const winner = evalResult === 'a_wins' ? currentTest.versionA : currentTest.versionB;
          const loser = evalResult === 'a_wins' ? currentTest.versionB : currentTest.versionA;
          await this.activateVersion(agent, winner);

          await this.memory.updateState((s) => {
            s.abTests[agent] = null;
            s.lastKnownGood[agent] = winner;
            s.activeVersions[agent] = winner;
            return s;
          });

          result.abTestCompleted = true;
          result.message = `A/B test auto-ended: ${loser} too unreliable. ${winner} wins.`;
          return result;
        }
      }

      result.message = `Incomplete run detected (output: ${experiment.metrics.outputLength} chars). Skipping — not counted for evolution.`;
      return result;
    }

    // ── Step 1: Record ────────────────────────────────
    await this.tracker.recordExperiment(experiment);

    // ── Step 2: Rollback check ────────────────────────
    const state = await this.memory.getState();
    const failures = state.consecutiveFailures[agent] ?? 0;

    if (this.safety.shouldRollback(failures)) {
      const rolledBack = await this.rollback(agent);
      if (rolledBack) {
        result.rolledBack = true;
        result.message = `Rolled back to last known good version after ${failures} consecutive failures.`;
        const rolledBackState = await this.memory.getState();
        notifyRollback(
          this.notifications, agent, rolledBackState.activeVersions[agent] ?? 'unknown', failures,
        ).catch(() => {/* swallow */});
        return result;
      }
    }

    // ── Step 3: A/B test management ───────────────────
    const activeTest = state.abTests[agent] ?? null;

    if (activeTest) {
      const testResult = await this.handleABTest(agent, experiment, activeTest);
      result.abTestCompleted = testResult.completed;

      if (testResult.completed) {
        result.message = testResult.message;
        if (testResult.winner) {
          result.newVersion = testResult.winner;
          result.promptEvolved = testResult.winner !== activeTest.versionA;
        }
        return result;
      }

      // Test still running — just record which bucket this was in
      const failInfoA = (activeTest.failsA ?? 0) > 0 ? `, ${activeTest.failsA} fails` : '';
      const failInfoB = (activeTest.failsB ?? 0) > 0 ? `, ${activeTest.failsB} fails` : '';
      result.message = `A/B test in progress: ${activeTest.versionA} (${activeTest.runsA} runs${failInfoA}) vs ${activeTest.versionB} (${activeTest.runsB} runs${failInfoB}).`;
      return result;
    }

    // ── Step 4: Check if we should evolve ─────────────
    const stats = await this.tracker.getStats(agent);

    if (!this.safety.canEvolve(agent, stats)) {
      result.message = `Collecting data: ${stats.totalRuns} runs so far, need more before evolving.`;
      return result;
    }

    // Detect patterns
    const detectedPatterns = await this.patterns.detectPatterns(agent);
    result.patternsFound = detectedPatterns;

    // Only evolve if there are actionable patterns
    const hasWeaknesses = detectedPatterns.some((p) => p.type === 'weakness');
    const hasNegativeTrend = detectedPatterns.some(
      (p) => p.type === 'trend' && p.description.includes('declining'),
    );

    if (!hasWeaknesses && !hasNegativeTrend) {
      result.message = `${detectedPatterns.length} patterns found, but no weaknesses or negative trends — no evolution needed.`;
      return result;
    }

    // ── Step 5: Input Validation (P0-1) ─────────────
    const validation = await this.validateDataQuality(agent);
    if (!validation.valid) {
      result.message = `Data quality check failed: ${validation.reason}. Skipping evolution.`;
      return result;
    }

    // Generate a new prompt variant
    const activePrompt = await this.memory.getActivePrompt(agent);
    if (!activePrompt) {
      result.message = 'No active prompt found — cannot evolve.';
      return result;
    }

    // Build tool context (P0-2) and category stats (P2-5) for optimizer
    const toolContext: AgentToolContext | undefined = this.agent
      ? { mcp: this.agent.mcp, tools: this.agent.tools }
      : undefined;

    const catStats = await this.tracker.getStatsByCategory(agent);

    // Extract recent critic feedback reports for the optimizer.
    // The optimizer previously only saw aggregated stats but not WHY runs scored poorly.
    const recentFeedback = await this.getRecentFeedback(agent, 5);

    // ── Variant generation: GEPA reflective path (opt-in) or legacy ──
    // v0.6.0: when `evolution.useGepa` is on AND a GepaOptimizer is wired in,
    // generate the challenger via the reflector (rich text feedback →
    // smallest-possible-edit). The GEPA path returns null on cold start
    // (no critic feedback yet) or when its mutation fails the alignment
    // guard — in either case we fall back to the legacy meta-prompt
    // optimizer so the loop never stalls.
    let newPromptText: string | null = null;
    let generatedBy: 'gepa' | 'legacy' = 'legacy';
    if (this.agent?.evolution?.useGepa === true && this.gepa) {
      newPromptText = await this.generateVariantGepa(agent, activePrompt.promptText);
      if (newPromptText !== null) {
        generatedBy = 'gepa';
      }
    }
    if (newPromptText === null) {
      newPromptText = await this.optimizer.generateVariant(
        activePrompt.promptText,
        detectedPatterns,
        stats,
        toolContext,
        catStats,
        recentFeedback,
      );
    }

    // Create a new prompt version
    const newVersion = this.nextVersion(activePrompt.version);
    const newPromptVersion: PromptVersion = {
      version: newVersion,
      agentName: agent,
      promptText: newPromptText,
      createdAt: new Date().toISOString(),
      parentVersion: activePrompt.version,
      // Only tag the change reason with the generator when GEPA was opted in —
      // keeps the stored `changeReason` byte-for-byte identical for legacy-only
      // agents (v0.6.0 review Finding 8).
      changeReason: this.agent?.evolution?.useGepa
        ? `[${generatedBy}] ${this.buildChangeReason(detectedPatterns)}`
        : this.buildChangeReason(detectedPatterns),
      active: false, // Not active yet — going into A/B test
      stats: { totalRuns: 0, avgQuality: 0, avgDuration: 0, successRate: 0, avgSourceCount: 0 },
    };

    await this.memory.savePromptVersion(newPromptVersion);

    // Compute dynamic minRuns based on quality score variance
    const allExperiments = await this.memory.loadExperiments(agent);
    const agentMinRuns = this.agent?.evolution?.minRuns;
    const dynamicMinRuns = this.safety.computeDynamicMinRuns(allExperiments, agentMinRuns);

    // Start A/B test
    const newTest: ABTest = {
      versionA: activePrompt.version,
      versionB: newVersion,
      runsA: 0,
      runsB: 0,
      failsA: 0,
      failsB: 0,
      minRuns: dynamicMinRuns,
      startedAt: new Date().toISOString(),
    };

    await this.memory.updateState((s) => {
      s.abTests[agent] = newTest;
      return s;
    });

    result.promptEvolved = true;
    result.abTestStarted = true;
    result.newVersion = newVersion;
    const genLabel = this.agent?.evolution?.useGepa ? ` via ${generatedBy}` : '';
    result.message = `New prompt ${newVersion} generated${genLabel}. A/B test started: ${activePrompt.version} vs ${newVersion} (minRuns: ${dynamicMinRuns}).`;

    // Notify via Telegram (non-blocking)
    notifyEvolutionStarted(
      this.notifications, agent, activePrompt.version, newVersion,
      this.buildChangeReason(detectedPatterns),
    ).catch(() => {/* swallow */});

    return result;
  }

  // ─── A/B Test Handling ─────────────────────────────

  private async handleABTest(
    agentName: string,
    experiment: DarwinExperiment,
    test: ABTest,
  ): Promise<{ completed: boolean; winner?: string; message: string }> {
    // Atomically increment run counts inside callback (prevents stale-read race)
    await this.memory.updateState((s) => {
      const t = s.abTests[agentName];
      if (!t) return s;
      if (experiment.promptVersion === t.versionA) {
        t.runsA++;
      } else if (experiment.promptVersion === t.versionB) {
        t.runsB++;
      }
      return s;
    });

    // Re-read the updated test state for evaluation
    const postState = await this.memory.getState();
    const currentTest = postState.abTests[agentName];
    if (!currentTest) {
      return { completed: false, message: 'A/B test cleared concurrently.' };
    }

    // Get composite scores — only from A/B test period
    // Use agent-specific metric weights if configured.
    const agentWeights = this.agent?.evolution?.metrics;
    const compositeA = await this.tracker.getAverageComposite(
      agentName,
      currentTest.versionA,
      agentWeights,
      currentTest.startedAt,
    );
    const compositeB = await this.tracker.getAverageComposite(
      agentName,
      currentTest.versionB,
      agentWeights,
      currentTest.startedAt,
    );

    // Evaluate the test (including reliability from failure counts)
    const outcome = this.safety.evaluateABTest(
      compositeA,
      compositeB,
      currentTest.runsA,
      currentTest.runsB,
      currentTest.failsA ?? 0,
      currentTest.failsB ?? 0,
      currentTest.minRuns,
    );

    if (outcome === 'continue') {
      return { completed: false, message: 'A/B test continues.' };
    }

    // Test is complete — determine winner
    let winner = outcome === 'a_wins' ? currentTest.versionA : currentTest.versionB;
    let loser = outcome === 'a_wins' ? currentTest.versionB : currentTest.versionA;

    // Regression check: if the challenger (B) won, verify it doesn't regress below A
    if (outcome === 'b_wins') {
      const passesRegression = this.safety.checkRegression(compositeA, compositeB);
      if (!passesRegression) {
        // B won on score but regressed on safety threshold — revert to A
        winner = currentTest.versionA;
        loser = currentTest.versionB;
      }
    }

    // v0.6.0 — Multi-objective Pareto-dominance gate (opt-in).
    // The composite score is a weighted scalar — a challenger can win on it
    // while quietly REGRESSING on one objective (e.g. higher quality but 3×
    // slower). Note: if the incumbent A actually Pareto-dominated B, the
    // monotone composite would already have favoured A (outcome a_wins), so a
    // "does A dominate B" test could never fire here. The meaningful guard is
    // the inverse: when `evolution.paretoGate` is on, accept the challenger B
    // ONLY if it is a strict Pareto improvement (B dominates A across the full
    // objective vector). A scalar-win that is not a Pareto improvement means B
    // traded a regression on some objective for the win — keep the incumbent.
    if (outcome === 'b_wins' && this.agent?.evolution?.paretoGate && winner === currentTest.versionB) {
      const since = currentTest.startedAt;
      const metricsA = await this.tracker.getAverageMetrics(agentName, currentTest.versionA, since);
      const metricsB = await this.tracker.getAverageMetrics(agentName, currentTest.versionB, since);
      // Only gate when both sides have data for every objective — otherwise
      // `dominates` short-circuits to false on a missing key and we would
      // reject every challenger for lack of data. Skip the gate instead.
      if (Object.keys(metricsA).length > 0 && Object.keys(metricsB).length > 0) {
        const bDominatesA = dominates(
          metricsB,
          metricsA,
          DARWIN_DEFAULT_OBJECTIVES as ReadonlyArray<ParetoObjective<Record<string, number>>>,
        );
        if (!bDominatesA) {
          // Challenger won the scalar composite but is not a strict Pareto
          // improvement (it regressed on at least one objective) → keep A.
          winner = currentTest.versionA;
          loser = currentTest.versionB;
        }
      }
    }

    // Activate winner, deactivate loser
    await this.activateVersion(agentName, winner);

    // Update state atomically: clear test, set last-known-good
    await this.memory.updateState((s) => {
      s.abTests[agentName] = null;
      s.lastKnownGood[agentName] = winner;
      s.activeVersions[agentName] = winner;
      return s;
    });

    // Derive the reported scores from the FINAL `winner`, not the raw
    // `outcome` — the regression check and the Pareto gate can both flip
    // `winner` from B back to A while `outcome` stays 'b_wins'. Keying the
    // log/notification off `outcome` would report the loser's composite as
    // the winner score (observability bug, v0.6.0 review Finding 1/4).
    const winnerScore = winner === currentTest.versionA ? compositeA : compositeB;
    const loserScore = winner === currentTest.versionA ? compositeB : compositeA;
    const scoreMsg = `(composite: ${winnerScore.toFixed(3)} vs ${loserScore.toFixed(3)})`;

    // Notify via Telegram (non-blocking)
    notifyABTestComplete(this.notifications, agentName, winner, loser, winnerScore, loserScore)
      .catch(() => {/* swallow — notification is best-effort */});

    return {
      completed: true,
      winner,
      message: `A/B test complete: ${winner} wins over ${loser} ${scoreMsg}.`,
    };
  }

  // ─── Rollback ──────────────────────────────────────

  /**
   * Roll back to the last known good prompt version.
   * Returns true if a rollback was performed.
   */
  private async rollback(agentName: string): Promise<boolean> {
    const state = await this.memory.getState();
    const lastGood = state.lastKnownGood[agentName];

    if (!lastGood) {
      return false;
    }

    const currentVersion = state.activeVersions[agentName];
    if (currentVersion === lastGood) {
      // Already on last-known-good — nothing to roll back
      return false;
    }

    // Activate the last-known-good version
    await this.activateVersion(agentName, lastGood);

    // Atomically clear A/B test and reset failure counter
    await this.memory.updateState((s) => {
      s.abTests[agentName] = null;
      s.activeVersions[agentName] = lastGood;
      s.consecutiveFailures[agentName] = 0;
      return s;
    });

    return true;
  }

  // ─── Helpers ───────────────────────────────────────

  /**
   * Activate a specific prompt version and deactivate all others.
   */
  private async activateVersion(
    agentName: string,
    version: string,
  ): Promise<void> {
    const allVersions = await this.memory.getAllPromptVersions(agentName);

    for (const pv of allVersions) {
      const shouldBeActive = pv.version === version;
      if (pv.active !== shouldBeActive) {
        pv.active = shouldBeActive;
        await this.memory.savePromptVersion(pv);
      }
    }
  }

  /**
   * Extract recent critic feedback reports from experiments.
   *
   * Returns up to `limit` feedback report texts from the most recent experiments
   * that have critic feedback. Experiments are already ordered by started_at DESC
   * from loadExperiments(), so we just filter for ones with feedback.
   */
  private async getRecentFeedback(agentName: string, limit: number): Promise<string[]> {
    const experiments = await this.memory.loadExperiments(agentName);

    const feedback: string[] = [];
    for (const exp of experiments) {
      if (feedback.length >= limit) break;
      if (exp.feedback?.report) {
        const header = `Score: ${exp.feedback.score}/10 | Task: "${exp.task}" | Version: ${exp.promptVersion}`;
        feedback.push(`${header}\n${exp.feedback.report}`);
      }
    }

    return feedback;
  }

  /**
   * v0.6.0 — Generate the next prompt variant via the GEPA reflective path.
   *
   * Builds rich {@link ReflectiveFeedback} from recent critic reports +
   * execution trajectories and asks the {@link GepaOptimizer} for ONE
   * smallest-possible-edit mutation (the online loop carries a single
   * challenger into the A/B test; the N-variant + Pareto + merge surfaces
   * are for offline/batch optimisation). The mutation is then run through
   * the SHARED alignment guard — the same check the legacy optimizer uses —
   * so the GEPA path cannot ship a prompt that erodes safety keywords.
   *
   * Returns `null` (→ caller falls back to the legacy optimizer) when:
   *   - no GepaOptimizer is wired in,
   *   - there is no critic feedback yet (cold start — the reflector has
   *     nothing to reflect on),
   *   - the reflector throws or returns an empty mutation, or
   *   - the mutation fails the alignment guard.
   */
  private async generateVariantGepa(
    agentName: string,
    currentPrompt: string,
  ): Promise<string | null> {
    if (!this.gepa) {
      return null;
    }

    const feedbacks = await this.getReflectiveFeedback(agentName, 5);
    if (feedbacks.length === 0) {
      // Cold start: no critic feedback to reflect on. Let the legacy
      // meta-prompt optimizer (which works from aggregate stats + patterns)
      // handle the first mutation.
      return null;
    }

    let mutated: string;
    try {
      const variants = await this.gepa.generate(currentPrompt, feedbacks, {
        numVariants: 1,
        feedbackStrategy: 'single',
      });
      mutated = variants[0]?.prompt ?? '';
    } catch (err) {
      // Any reflector/provider error → fall back to the legacy path rather
      // than failing the whole evolution cycle. Emit a breadcrumb so a
      // persistently-failing reflector (which would silently run the loop in
      // legacy mode forever) is visible (v0.6.0 review Finding F6).
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[darwin] GEPA reflection failed for "${agentName}", falling back to legacy optimizer: ${reason}`);
      return null;
    }

    if (mutated.length === 0) {
      return null;
    }

    // Shared alignment guard (v0.6.0): the GEPA path runs the IDENTICAL
    // safety-keyword preservation check as PromptOptimizer.generateVariant.
    // A mutation that drops "never" / "do not" / "must not" / … is rejected.
    const alignmentIssue = checkAlignmentPreservation(currentPrompt, mutated);
    if (alignmentIssue) {
      return null;
    }

    return mutated;
  }

  /**
   * v0.6.0 — Build GEPA {@link ReflectiveFeedback} from the most recent
   * experiments that carry critic feedback. Each becomes a (variantId,
   * score, textFeedback, trace) tuple the reflector uses to synthesise the
   * mutation. `loadExperiments` returns newest-first, so we take the first
   * `limit` that have a feedback report.
   */
  private async getReflectiveFeedback(
    agentName: string,
    limit: number,
  ): Promise<ReflectiveFeedback[]> {
    const experiments = await this.memory.loadExperiments(agentName);

    const feedbacks: ReflectiveFeedback[] = [];
    for (const exp of experiments) {
      if (feedbacks.length >= limit) break;
      if (exp.feedback?.report) {
        feedbacks.push({
          variantId: exp.promptVersion,
          score: exp.feedback.score,
          textFeedback: `Task: "${exp.task}"\n${exp.feedback.report}`,
          trace: exp.trajectory,
        });
      }
    }

    return feedbacks;
  }

  /**
   * Increment version string: "v1" -> "v2", "v12" -> "v13".
   */
  private nextVersion(current: string): string {
    const match = current.match(/^v(\d+)$/);
    if (match) {
      return `v${parseInt(match[1], 10) + 1}`;
    }
    // Fallback: append a version number
    return `${current}-v2`;
  }

  // ─── Input Validation (P0-1) ─────────────────────

  /**
   * Check if a run is incomplete (agent ran out of turns or produced no real output).
   * Incomplete runs are NOT recorded as experiments to avoid poisoning the data.
   *
   * Checks output length regardless of success flag — a 300-char "successful" run
   * is still garbage data that shouldn't influence evolution.
   */
  private isIncompleteRun(experiment: DarwinExperiment): boolean {
    const minOutput = this.agent?.evolution?.minOutputLength ?? DEFAULT_MIN_VALID_OUTPUT;
    return experiment.metrics.outputLength < minOutput;
  }

  /**
   * Validate that experiment data is clean enough for evolution.
   * Prevents garbage-in-garbage-out (e.g., broken search backend producing 0 sources).
   */
  private async validateDataQuality(
    agentName: string,
  ): Promise<{ valid: boolean; reason: string }> {
    const experiments = await this.memory.loadExperiments(agentName);

    if (experiments.length === 0) {
      return { valid: false, reason: 'No experiments recorded' };
    }

    // Check: at least MIN_SOURCE_COVERAGE of runs have sources > 0
    // Only enforce for agents that rely on sources (sourceCount weight > 0.05)
    const sourceWeight = this.agent?.evolution?.metrics?.sourceCount ?? 0.15;
    if (sourceWeight > 0.05) {
      const withSources = experiments.filter((e) => e.metrics.sourceCount > 0);
      const sourceCoverage = withSources.length / experiments.length;

      if (sourceCoverage < MIN_SOURCE_COVERAGE) {
        return {
          valid: false,
          reason: `Only ${(sourceCoverage * 100).toFixed(0)}% of runs have sources (need ${(MIN_SOURCE_COVERAGE * 100).toFixed(0)}%). Possible tool/search outage.`,
        };
      }
    }

    // Check: at least half of runs have quality scores
    const withQuality = experiments.filter((e) => e.metrics.qualityScore !== null);
    if (withQuality.length < experiments.length * 0.5) {
      return {
        valid: false,
        reason: `Only ${withQuality.length}/${experiments.length} runs have quality scores. Critic may be failing.`,
      };
    }

    // Check: no sudden metric collapse (last 3 runs all 0 sources = tool outage).
    // loadExperiments() returns DESC order (newest first), so slice(0, 3) gets the latest.
    // Only enforce for agents that rely on sources.
    if (sourceWeight > 0.05) {
      const recent = experiments.slice(0, 3);
      if (recent.length >= 3 && recent.every((e) => e.metrics.sourceCount === 0)) {
        return {
          valid: false,
          reason: 'Last 3 runs have 0 sources — likely search backend outage.',
        };
      }
    }

    return { valid: true, reason: 'Data quality OK' };
  }

  /**
   * Build a human-readable change reason from detected patterns.
   */
  private buildChangeReason(patterns: DarwinPattern[]): string {
    const weaknesses = patterns.filter((p) => p.type === 'weakness');
    const trends = patterns.filter(
      (p) => p.type === 'trend' && p.description.includes('declining'),
    );

    const reasons: string[] = [];

    if (weaknesses.length > 0) {
      reasons.push(
        `Address ${weaknesses.length} weakness${weaknesses.length > 1 ? 'es' : ''}: ${weaknesses.map((w) => w.description).join('; ')}`,
      );
    }

    if (trends.length > 0) {
      reasons.push(`Counter declining trend`);
    }

    return reasons.length > 0
      ? reasons.join('. ')
      : 'Optimization based on detected patterns';
  }
}
