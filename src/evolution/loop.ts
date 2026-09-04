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
  PendingApproval,
  PromptVersion,
  PromptVersionStats,
  RejectedChallenger,
} from '../types.js';
import type { ExperimentTracker } from './tracker.js';
import type { PromptOptimizer, AgentToolContext } from './optimizer.js';
import type { SafetyGate, ABTestSamples } from './safety.js';
import type { PatternDetector } from './patterns.js';
import type { NotificationConfig } from './notifications.js';
import {
  notifyABTestComplete,
  notifyABTestTimeout,
  notifyApprovalExpired,
  notifyApprovalRequired,
  notifyEvolutionStarted,
  notifyRollback,
} from './notifications.js';
import type { GepaOptimizer, ScoredVariant } from './optimizer-gepa.js';
import { epochShuffledMinibatch } from './optimizer-gepa.js';
import type { ReflectiveFeedback } from './reflector.js';
import { checkAlignmentPreservation, checkAlignmentPreservationSemantic, type EmbedFn } from './alignment.js';
import { dominatesEpsilon, paretoSelect, DARWIN_DEFAULT_OBJECTIVES, type ParetoObjective } from './pareto.js';
import { selectDemoCandidates, buildDemoSection, applyDemoSection } from './demos.js';
import { selectParentVariant } from './selection.js';
import { isPerfectScore, resolvePerfectFeedbackScore } from './feedback-filter.js';
import {
  fingerprintPromptText,
  findRejectedMatch,
  forgetRejections,
  formatRejectionNotes,
  rejectionNotes,
  rejectionsFor,
  rememberRejection,
  REJECTION_NOTES_LIMIT,
  type RejectionNote,
} from './rejections.js';
import { emitMetric, type MetricsSink } from '../metrics/sink.js';

// ─── Result Type ───────────────────────────────────────

export interface EvolutionResult {
  patternsFound: DarwinPattern[];
  promptEvolved: boolean;
  abTestStarted: boolean;
  abTestCompleted: boolean;
  rolledBack: boolean;
  newVersion?: string;
  message: string;
  /**
   * v0.17.0: a challenger was generated and persisted, but is waiting for a
   * human decision instead of entering an A/B test
   * ({@link EvolutionConfig.requireApproval}). When true, `promptEvolved` is
   * true and `abTestStarted` is FALSE: nothing is being measured yet.
   *
   * Optional so callers written against <=0.16 keep compiling; absent means
   * false.
   */
  awaitingApproval?: boolean;
  /**
   * v0.18.0: every generator produced text a human had already rejected, so
   * nothing was proposed. `promptEvolved` and `abTestStarted` are both false.
   *
   * Its own field rather than a shade of "nothing happened", because this one
   * RECURS: the same inputs produce the same text next cycle, so an agent in
   * this state stays there until someone acts. `message` names the way out.
   */
  rejectedRepeat?: boolean;
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
  /**
   * v0.7.0 — Optional batch embedder. When present, the GEPA mutation path
   * upgrades its alignment guard from keyword-count to the semantic
   * (embedding-distance) check: a safety constraint that was REWORDED (not
   * removed) is accepted instead of triggering a false-positive rejection.
   * When omitted, the guard stays keyword-only (fail-closed). Darwin keeps
   * zero hard deps — you inject the embedder.
   */
  embed?: EmbedFn;
  /**
   * v0.7.0 — Cosine-similarity threshold for the semantic alignment guard
   * (only used when `embed` is set). Default 0.82.
   */
  alignmentSimilarityThreshold?: number;
  /**
   * v0.10.0 — Random source in [0, 1) for the stochastic parent-selection
   * strategies (`candidateSelection: 'pareto' | 'epsilon-greedy'`). Injected
   * for deterministic tests; default `Math.random`. Never consulted on the
   * default `'active'` path.
   */
  rng?: () => number;
  /**
   * v0.14.0 — Optional metrics sink. Every evolution decision (run recorded,
   * A/B started/completed/timeout, rollback) is emitted as a typed event via
   * {@link emitMetric}, which swallows sink errors — observability must never
   * break the loop. Omit for zero overhead; `buildEvolutionLoop` wires the
   * JSONL sink from `DARWIN_METRICS_JSONL` automatically.
   */
  metrics?: MetricsSink;
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
  private embed?: EmbedFn;
  private alignmentSimilarityThreshold?: number;
  private rng?: () => number;
  private metrics?: MetricsSink;

  constructor(deps: DarwinLoopDeps) {
    this.memory = deps.memory;
    this.tracker = deps.tracker;
    this.optimizer = deps.optimizer;
    this.safety = deps.safety;
    this.patterns = deps.patterns;
    this.agent = deps.agent;
    this.notifications = deps.notifications ?? {};
    this.gepa = deps.gepa;
    this.embed = deps.embed;
    this.alignmentSimilarityThreshold = deps.alignmentSimilarityThreshold;
    this.rng = deps.rng;
    this.metrics = deps.metrics;
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
            // The version-agnostic failure counter belongs to the test era
            // that just ended — a streak filled by the LOSER must not tee up
            // a rollback against the confirmed winner (R5 review, P0).
            s.consecutiveFailures[agent] = 0;
            return s;
          });

          result.abTestCompleted = true;
          result.message = `A/B test auto-ended: ${loser} too unreliable. ${winner} wins.`;
          emitMetric(this.metrics, 'ab_test_completed', agent, {
            winner,
            loser,
            reason: 'unreliability',
          });
          return result;
        }

        // The wall-clock budget must also apply here. An agent whose runs are
        // consistently too short never reaches Step 3, so without this check
        // its test would stay open past the budget — and a low-throughput
        // agent is exactly the case the budget exists for.
        if (this.isTestExpired(currentTest)) {
          await this.concludeInconclusive(agent, currentTest);
          result.abTestCompleted = true;
          result.newVersion = currentTest.versionA;
          result.message =
            `A/B test timed out after ${this.effectiveTestBudget(currentTest)}d without reaching ` +
            `minRuns (${currentTest.runsA}/${currentTest.runsB} of ${currentTest.minRuns}). ` +
            `Keeping ${currentTest.versionA}; ${currentTest.versionB} was not promoted.`;
          return result;
        }
      }

      result.message = `Incomplete run detected (output: ${experiment.metrics.outputLength} chars). Skipping — not counted for evolution.`;
      return result;
    }

    // ── Step 1: Record ────────────────────────────────
    await this.tracker.recordExperiment(experiment);
    emitMetric(this.metrics, 'run_recorded', agent, {
      version: experiment.promptVersion,
      qualityScore: experiment.metrics.qualityScore,
      success: experiment.success,
      durationMs: experiment.metrics.durationMs,
    });

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
        emitMetric(this.metrics, 'rollback', agent, {
          toVersion: rolledBackState.activeVersions[agent] ?? 'unknown',
          consecutiveFailures: failures,
        });
        return result;
      }
    }

    // ── Step 3: A/B test management ───────────────────
    const activeTest = state.abTests[agent] ?? null;

    if (activeTest) {
      const testResult = await this.handleABTest(agent, experiment);
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

    // ── Step 3b: pending approval (v0.17.0) ───────────
    // Reached only when no A/B test is open, which is exactly when a proposal
    // can exist. A pending proposal blocks generation: without this the next
    // qualifying run would build a SECOND challenger and overwrite the first,
    // discarding the very thing a human was asked to look at (the same class
    // of bug v0.13.0 fixed for rejected challengers).
    //
    // Read from the state loaded in Step 2 is not good enough here: the
    // approval could have landed between then and now, so re-read.
    const approvalState = await this.memory.getState();
    const pendingApproval = approvalState.pendingApprovals?.[agent] ?? null;
    if (pendingApproval) {
      if (this.isApprovalExpired(pendingApproval)) {
        const expired = await this.expireApproval(agent, pendingApproval);
        result.message = expired
          ? `Proposal ${pendingApproval.versionB} expired after ` +
            `${this.effectiveApprovalBudget(pendingApproval)}d without a decision and was rejected. ` +
            `${pendingApproval.versionA} stays active; the next cycle can propose a new challenger.`
          : `Proposal ${pendingApproval.versionB} was resolved by another process while it was ` +
            `being expired. Nothing was discarded here. Check "darwin status ${agent}".`;
        emitMetric(this.metrics, 'evolution_skipped', agent, {
          reason: expired ? 'approval_expired' : 'approval_resolved_concurrently',
          ...(expired ? { rejected: pendingApproval.versionB } : {}),
        });
        return result;
      }
      result.awaitingApproval = true;
      result.newVersion = pendingApproval.versionB;
      result.message =
        `${pendingApproval.versionB} is waiting for approval (proposed ` +
        `${pendingApproval.proposedAt}). No A/B test is running and no new challenger will be ` +
        `generated until it is approved or rejected: "darwin approve ${agent}" / ` +
        `"darwin approve ${agent} --reject".`;
      emitMetric(this.metrics, 'evolution_skipped', agent, {
        reason: 'awaiting_approval',
        versionB: pendingApproval.versionB,
      });
      return result;
    }

    // ── Step 4: Check if we should evolve ─────────────
    const stats = await this.tracker.getStats(agent);

    if (!this.safety.canEvolve(agent, stats)) {
      result.message = `Collecting data: ${stats.totalRuns} runs so far, need more before evolving.`;
      emitMetric(this.metrics, 'evolution_skipped', agent, {
        reason: 'collecting_data',
        totalRuns: stats.totalRuns,
      });
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
      emitMetric(this.metrics, 'evolution_skipped', agent, {
        reason: 'no_actionable_patterns',
        patternsFound: detectedPatterns.length,
      });
      return result;
    }

    // ── Step 5: Input Validation (P0-1) ─────────────
    const validation = await this.validateDataQuality(agent);
    if (!validation.valid) {
      result.message = `Data quality check failed: ${validation.reason}. Skipping evolution.`;
      emitMetric(this.metrics, 'evolution_skipped', agent, {
        reason: 'data_quality',
        detail: validation.reason,
      });
      return result;
    }

    // Generate a new prompt variant
    const activePrompt = await this.memory.getActivePrompt(agent);
    if (!activePrompt) {
      result.message = 'No active prompt found — cannot evolve.';
      return result;
    }

    // Generate the challenger + start the A/B test (shared with forceEvolve()).
    return this.generateAndStartABTest(agent, activePrompt, detectedPatterns, stats, result);
  }

  /**
   * Manual / on-demand evolution trigger — the engine behind
   * `darwin evolve <agent> --force`.
   *
   * Runs the SAME variant-generation + A/B-start path as the automatic loop's
   * Step 5, but WITHOUT the "enough runs / actionable patterns / data-quality"
   * gates. Use it to deliberately kick off an optimisation from the current
   * best prompt using the experiments collected so far, instead of waiting for
   * the loop to decide on its own.
   *
   * It still refuses the cases where evolution is genuinely impossible or
   * unsafe:
   *   - no active prompt seeded yet (nothing to mutate from),
   *   - no recorded experiments (the optimizer has nothing to learn from),
   *   - an A/B test already running (can't start a second concurrent test).
   *
   * Patterns are still DETECTED (so the change reason and the GEPA/legacy
   * feedback are meaningful) — they are simply not used as a gate.
   */
  async forceEvolve(agentName: string): Promise<EvolutionResult> {
    const result: EvolutionResult = {
      patternsFound: [],
      promptEvolved: false,
      abTestStarted: false,
      abTestCompleted: false,
      rolledBack: false,
      message: '',
    };

    const state = await this.memory.getState();
    const runningTest = state.abTests[agentName];
    if (runningTest) {
      // "Let it finish" is bad advice for a test that is already past its
      // wall-clock budget — nothing will finish it until a run comes through
      // the loop and trips the expiry check, and a low-throughput agent may
      // not produce one for a while. Say what actually unblocks it, and name
      // the cost of the shortcut: `--reset` also points `activeVersions` back
      // at v1 (evolve.ts), which throws away an evolved incumbent.
      result.message = this.isTestExpired(runningTest)
        ? `An A/B test for "${agentName}" is past its ${this.effectiveTestBudget(runningTest)}d budget ` +
          `(${runningTest.runsA}/${runningTest.runsB} of ${runningTest.minRuns} per arm) but is still open. ` +
          // Deliberately stops at "closes it": a timeout keeps the incumbent,
          // but the same run could instead cross the unreliability threshold
          // and close the test conclusively. Promising the outcome here would
          // be wrong in that (narrow) case; promising the close is always true.
          `The next run through the loop closes it. ` +
          `("darwin evolve ${agentName} --reset" clears it immediately, but also resets the active version to v1.)`
        : `An A/B test is already running for "${agentName}" — let it finish before forcing another.`;
      return result;
    }

    // v0.17.0: a proposal blocks a forced cycle too. `--force` means "evolve
    // now even though the automatic gates say no"; it does not mean "throw
    // away the challenger a human is currently looking at". The way past a
    // proposal is to decide on it.
    const pendingForce = state.pendingApprovals?.[agentName] ?? null;
    if (pendingForce) {
      if (this.isApprovalExpired(pendingForce)) {
        const expired = await this.expireApproval(agentName, pendingForce);
        result.message = expired
          ? `Proposal ${pendingForce.versionB} for "${agentName}" was past its ` +
            `${this.effectiveApprovalBudget(pendingForce)}d approval budget and has been rejected. ` +
            `Run the same command again to generate a fresh challenger.`
          : `Proposal ${pendingForce.versionB} for "${agentName}" was resolved by another ` +
            `process while it was being expired. Nothing was discarded here. ` +
            `Check "darwin status ${agentName}".`;
        return result;
      }
      result.awaitingApproval = true;
      result.newVersion = pendingForce.versionB;
      result.message =
        `${pendingForce.versionB} is already awaiting approval for "${agentName}" ` +
        `(proposed ${pendingForce.proposedAt}). Decide on it first: ` +
        `"darwin approve ${agentName}" or "darwin approve ${agentName} --reject".`;
      return result;
    }

    const experiments = await this.memory.loadExperiments(agentName);
    if (experiments.length === 0) {
      result.message =
        `No recorded experiments for "${agentName}" yet — run it at least once before forcing evolution.`;
      return result;
    }

    const activePrompt = await this.memory.getActivePrompt(agentName);
    if (!activePrompt) {
      result.message = 'No active prompt found — cannot evolve.';
      return result;
    }

    const stats = await this.tracker.getStats(agentName);
    const detectedPatterns = await this.patterns.detectPatterns(agentName);
    result.patternsFound = detectedPatterns;

    return this.generateAndStartABTest(agentName, activePrompt, detectedPatterns, stats, result);
  }

  /**
   * Shared tail of the evolution cycle: generate one challenger prompt (GEPA
   * reflective path when opted in, else the legacy meta-prompt optimizer),
   * persist it as a new version, and start an A/B test against the incumbent.
   * Called by both the gated automatic loop ({@link afterRun}) and the
   * on-demand {@link forceEvolve}. Mutates and returns the passed `result`.
   */
  private async generateAndStartABTest(
    agent: string,
    activePrompt: PromptVersion,
    detectedPatterns: DarwinPattern[],
    stats: PromptVersionStats,
    result: EvolutionResult,
  ): Promise<EvolutionResult> {
    // Build tool context (P0-2) and category stats (P2-5) for optimizer
    const toolContext: AgentToolContext | undefined = this.agent
      ? { mcp: this.agent.mcp, tools: this.agent.tools }
      : undefined;

    const catStats = await this.tracker.getStatsByCategory(agent);

    // v0.18.0: what a human already turned down for this agent. Read ONCE per
    // cycle and threaded through both generators, so the legacy meta-prompt
    // and the GEPA reflector are told the same thing. Reading it later, per
    // generator, would let two paths in the same cycle see different memory.
    const rejected = rejectionsFor(await this.memory.getState(), agent);
    const notes = this.rejectionNotesFor(rejected);

    // Extract recent critic feedback reports for the optimizer.
    // The optimizer previously only saw aggregated stats but not WHY runs scored poorly.
    // v0.7.0: feedback window is configurable (default 15, was hard-coded 5).
    const recentFeedback = await this.getRecentFeedback(agent, this.feedbackWindow());

    // ── Variant generation: GEPA reflective path (opt-in) or legacy ──
    // v0.6.0: when `evolution.useGepa` is on AND a GepaOptimizer is wired in,
    // generate the challenger via the reflector (rich text feedback →
    // smallest-possible-edit). The GEPA path returns null on cold start
    // (no critic feedback yet) or when its mutation fails the alignment
    // guard — in either case we fall back to the legacy meta-prompt
    // optimizer so the loop never stalls.
    let newPromptText: string | null = null;
    let generatedBy: 'gepa' | 'merge' | 'demos' | 'legacy' = 'legacy';

    // ── v0.10.0: SIMBA-style demo injection (opt-in, zero LLM cost) ──
    // On every demoEveryK-th cycle, build a challenger by appending (or
    // refreshing) a "Demonstrations" section harvested from the agent's own
    // highest-scoring past runs. Independent of useGepa — no reflector is
    // involved. The demo prompt runs the same alignment guard and enters the
    // same A/B test as any mutation; when demos don't help, the incumbent
    // wins. When the demo set is unchanged since the last injection the path
    // yields no challenger (no-op) and falls through to GEPA/legacy.
    if (this.agent?.evolution?.useDemos === true) {
      const epoch = this.versionInt(activePrompt.version);
      if (epoch > 0 && epoch % this.demoEveryK() === 0) {
        const demoPrompt = await this.tryDemoVariant(agent, activePrompt.promptText);
        if (demoPrompt !== null) {
          const guarded = await this.runAlignmentGuard(activePrompt.promptText, demoPrompt);
          const repeat = guarded === null ? null : findRejectedMatch(rejected, guarded);
          if (guarded !== null && repeat === null) {
            newPromptText = guarded;
            generatedBy = 'demos';
          } else if (repeat !== null) {
            // v0.18.0: this is the case the whole release is about. The demo
            // section is built deterministically from the active prompt plus
            // the agent's best runs, and rejecting changes neither, so without
            // this the identical text comes back every demoEveryK cycles with
            // a new label. Falling through (rather than ending the cycle) is
            // what keeps the agent evolving: GEPA and the legacy optimizer are
            // both non-deterministic and both now know why this was turned
            // down.
            console.warn(
              `[darwin] demo variant for "${agent}" repeats rejected ${repeat.version}, ` +
                `falling through.`,
            );
            emitMetric(this.metrics, 'rejected_repeat', agent, {
              generator: 'demos',
              rejectedVersion: repeat.version,
              action: 'fell_through',
            });
          } else {
            // Mirrors the merge-path breadcrumb: a consistently guard-failing
            // demo section should be visible, not silently skipped forever.
            console.warn(
              `[darwin] demo variant for "${agent}" failed the alignment guard, falling through.`,
            );
          }
        }
      }
    }

    if (newPromptText === null && this.agent?.evolution?.useGepa === true && this.gepa) {
      // Epoch = the integer of the active prompt version (v1→1, v12→12). It
      // advances by one each evolution cycle, so the epoch-shuffled minibatch
      // rotates which feedback subset the reflector sees per cycle, and the
      // merge cadence fires every mergeEveryK-th cycle.
      const epoch = this.versionInt(activePrompt.version);
      const gen = await this.generateVariantGepa(agent, activePrompt.promptText, epoch, notes);
      if (gen !== null) {
        const repeat = findRejectedMatch(rejected, gen.prompt);
        if (repeat === null) {
          newPromptText = gen.prompt;
          generatedBy = gen.via;
        } else {
          // Falls through to the legacy optimizer, same as an alignment-guard
          // failure. A merge that got this far was already counted against
          // `maxMergeInvocations`, deliberately: the cap budgets the reflection
          // CALLS, and that call was paid before anyone knew the text was a
          // repeat.
          console.warn(
            `[darwin] GEPA ${gen.via} variant for "${agent}" repeats rejected ${repeat.version}, ` +
              `falling through to legacy.`,
          );
          emitMetric(this.metrics, 'rejected_repeat', agent, {
            generator: gen.via,
            rejectedVersion: repeat.version,
            action: 'fell_through',
          });
        }
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
        formatRejectionNotes(notes),
      );
    }

    // v0.18.0: every generator has now had its turn. A repeat that survives to
    // here is refused rather than proposed, and no version row is written: the
    // whole point of the memory is that a human is not asked the same question
    // twice.
    //
    // This deliberately fires with the approval gate OFF as well. Rejections
    // only ever come FROM the gate, but someone can reject a challenger and
    // then turn the gate off, and pushing a text that was explicitly turned
    // down straight onto half of live traffic is worse than asking again.
    const finalRepeat = findRejectedMatch(rejected, newPromptText);
    if (finalRepeat !== null) {
      result.promptEvolved = false;
      result.abTestStarted = false;
      result.rejectedRepeat = true;
      result.message =
        `Every generator for "${agent}" produced text that was already rejected ` +
        `(${finalRepeat.version}, ${finalRepeat.rejectedAt.slice(0, 10)}), so nothing was ` +
        `proposed. This usually means the agent's runs have not changed enough to suggest ` +
        `anything new. Let it collect more runs, or clear the memory with ` +
        `"darwin approve ${agent} --forget ${finalRepeat.version}".`;
      emitMetric(this.metrics, 'evolution_skipped', agent, {
        reason: 'rejected_repeat',
        rejectedVersion: finalRepeat.version,
      });
      return result;
    }

    // Create a new prompt version. The label must clear the WHOLE version
    // history, not just the active version — a rejected challenger keeps its
    // label, and reusing it would upsert over that record (see
    // `nextFreeVersion`).
    const existingVersions = await this.memory.getAllPromptVersions(agent);
    const newVersion = this.nextFreeVersion(activePrompt.version, existingVersions);
    const newPromptVersion: PromptVersion = {
      version: newVersion,
      agentName: agent,
      promptText: newPromptText,
      createdAt: new Date().toISOString(),
      parentVersion: activePrompt.version,
      // Only tag the change reason with the generator when a non-legacy
      // challenger source was opted in (GEPA v0.6.0 / demos v0.10.0) — keeps
      // the stored `changeReason` byte-for-byte identical for legacy-only
      // agents (v0.6.0 review Finding 8).
      changeReason: this.agent?.evolution?.useGepa || this.agent?.evolution?.useDemos
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

    // Start A/B test. The wall-clock budget is snapshotted onto the test —
    // a deadline belongs to the test, not to whichever invocation later
    // evaluates it (a one-off CLI `--max-test-days` would otherwise evaporate
    // on the next plain run).
    const budget = this.agent?.evolution?.maxTestDays;
    const newTest: ABTest = {
      versionA: activePrompt.version,
      versionB: newVersion,
      runsA: 0,
      runsB: 0,
      failsA: 0,
      failsB: 0,
      minRuns: dynamicMinRuns,
      startedAt: new Date().toISOString(),
      ...(typeof budget === 'number' && Number.isFinite(budget) && budget > 0
        ? { maxTestDays: budget }
        : {}),
    };

    // ── v0.17.0: human approval gate ───────────────────────────────────
    // When on, the challenger is already persisted above (readable, diffable)
    // but no test opens. Every parameter of the test that WOULD have started
    // is snapshotted onto the proposal, so `approveChallenger` opens exactly
    // the test described in the notification rather than recomputing a
    // different one from newer data.
    if (this.requireApproval()) {
      const pending: PendingApproval = {
        versionA: activePrompt.version,
        versionB: newVersion,
        minRuns: dynamicMinRuns,
        ...(newTest.maxTestDays !== undefined ? { maxTestDays: newTest.maxTestDays } : {}),
        proposedAt: new Date().toISOString(),
        // Always written, `0` meaning "no budget", so the proposal carries its
        // own answer and never has to ask a config that may have changed since.
        approvalTimeoutDays: this.configuredApprovalTimeout() ?? 0,
        changeReason: newPromptVersion.changeReason,
        generatedBy,
      };

      // The guard that got us here ran BEFORE the challenger was generated, and
      // generation is an LLM call: seconds to minutes, not microseconds. Two
      // concurrent cycles for the same agent both pass that guard, and an
      // unconditional write would let the second silently overwrite the first
      // proposal, so the human who got two notifications can only decide on
      // the later one and the earlier challenger stays behind as an orphaned
      // inactive version. Re-check inside the lock.
      //
      // v0.18.0: the rejection memory is re-checked here for the same reason.
      // It was read BEFORE generation, so a rejection landing during the model
      // call would otherwise put an already-refused text back in front of the
      // same person. The check is a hash comparison over a list capped at 100,
      // so it costs nothing inside the lock.
      let claimed = true;
      let racedRejection: RejectedChallenger | null = null;
      await this.memory.updateState((s) => {
        if (s.pendingApprovals?.[agent] || s.abTests[agent]) {
          claimed = false;
          return s;
        }
        racedRejection = findRejectedMatch(rejectionsFor(s, agent), newPromptText!);
        if (racedRejection !== null) {
          claimed = false;
          return s;
        }
        if (!s.pendingApprovals) s.pendingApprovals = {};
        s.pendingApprovals[agent] = pending;
        return s;
      });
      if (racedRejection !== null) {
        return this.refuseRacedRejection(agent, newVersion, racedRejection, result);
      }
      if (!claimed) {
        // The generated version row stays: it cost a model call, it is inert
        // (active: false, in no test), and `nextFreeVersion` will not reuse its
        // label. Losing the race is not a reason to lose the record.
        result.promptEvolved = false;
        result.message =
          `Generated ${newVersion} for "${agent}", but another cycle claimed the slot first ` +
          `(a proposal or an A/B test now exists). ${newVersion} was left inactive and unused. ` +
          `Check "darwin status ${agent}".`;
        emitMetric(this.metrics, 'evolution_skipped', agent, {
          reason: 'slot_claimed_concurrently',
          discarded: newVersion,
        });
        return result;
      }

      result.promptEvolved = true;
      result.abTestStarted = false;
      result.awaitingApproval = true;
      result.newVersion = newVersion;
      const genLabelP = this.agent?.evolution?.useGepa || this.agent?.evolution?.useDemos
        ? ` via ${generatedBy}`
        : '';
      result.message =
        `New prompt ${newVersion} generated${genLabelP}, awaiting approval. ` +
        `Nothing is being measured yet. ` +
        `Approve with "darwin approve ${agent}" to start ${activePrompt.version} vs ${newVersion} ` +
        `(minRuns: ${dynamicMinRuns}), or "darwin approve ${agent} --reject" to discard it.`;

      notifyApprovalRequired(
        this.notifications, agent, activePrompt.version, newVersion,
        newPromptVersion.changeReason, dynamicMinRuns,
      ).catch(() => {/* swallow */});

      emitMetric(this.metrics, 'approval_requested', agent, {
        versionA: activePrompt.version,
        versionB: newVersion,
        generatedBy,
        minRuns: dynamicMinRuns,
      });

      return result;
    }

    // Same check-then-act window as the gated branch above, and the same fix.
    // Unconditional before v0.17: two concurrent cycles would both open a test
    // and the second would overwrite the first, throwing away whatever runs
    // the first had already collected. Refusing also keeps `abTests` and
    // `pendingApprovals` from ever both being set, which is what the comment on
    // PendingApproval promises (a mixed fleet where one process has the gate on
    // and another does not is the way that happens).
    //
    // v0.18.0: and the rejection re-check, as in the gated branch. Here it
    // matters more, not less: without the gate the challenger would go
    // straight onto half the traffic.
    let started = true;
    let racedReject: RejectedChallenger | null = null;
    await this.memory.updateState((s) => {
      if (s.abTests[agent] || s.pendingApprovals?.[agent]) {
        started = false;
        return s;
      }
      racedReject = findRejectedMatch(rejectionsFor(s, agent), newPromptText!);
      if (racedReject !== null) {
        started = false;
        return s;
      }
      s.abTests[agent] = newTest;
      return s;
    });
    if (racedReject !== null) {
      return this.refuseRacedRejection(agent, newVersion, racedReject, result);
    }
    if (!started) {
      result.promptEvolved = false;
      result.message =
        `Generated ${newVersion} for "${agent}", but another cycle claimed the slot first ` +
        `(an A/B test or a pending proposal now exists). ${newVersion} was left inactive and ` +
        `unused. Check "darwin status ${agent}".`;
      emitMetric(this.metrics, 'evolution_skipped', agent, {
        reason: 'slot_claimed_concurrently',
        discarded: newVersion,
      });
      return result;
    }

    result.promptEvolved = true;
    result.abTestStarted = true;
    result.newVersion = newVersion;
    const genLabel = this.agent?.evolution?.useGepa || this.agent?.evolution?.useDemos
      ? ` via ${generatedBy}`
      : '';
    result.message = `New prompt ${newVersion} generated${genLabel}. A/B test started: ${activePrompt.version} vs ${newVersion} (minRuns: ${dynamicMinRuns}).`;

    // Notify via Telegram (non-blocking)
    notifyEvolutionStarted(
      this.notifications, agent, activePrompt.version, newVersion,
      this.buildChangeReason(detectedPatterns),
    ).catch(() => {/* swallow */});

    emitMetric(this.metrics, 'ab_test_started', agent, {
      versionA: activePrompt.version,
      versionB: newVersion,
      generatedBy,
      minRuns: dynamicMinRuns,
    });

    return result;
  }

  // ─── v0.17.0: Human approval gate ──────────────────

  /** Is the approval gate on for this agent? Absent config means off. */
  private requireApproval(): boolean {
    return this.agent?.evolution?.requireApproval === true;
  }

  /**
   * The agent's currently CONFIGURED approval budget in days, or undefined
   * when there is none. Only consulted when a proposal is written; evaluation
   * reads the snapshot on the proposal itself (see
   * {@link effectiveApprovalBudget}).
   */
  private configuredApprovalTimeout(): number | undefined {
    const configured = this.agent?.evolution?.approvalTimeoutDays;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return configured;
    }
    return undefined;
  }

  /**
   * Budget that governs a given proposal: the SNAPSHOT, and nothing else.
   *
   * Deliberately NOT mirroring {@link effectiveTestBudget}, which falls back to
   * the agent's current config. That fallback serves TWO purposes there, both
   * documented in its own docblock: tests written before v0.13.1 added the
   * field, AND budgets introduced after a test was already running. The second
   * is a feature, not a legacy gap, so the fallback stays there.
   *
   * It does not belong here, because the two cases are not alike. A running
   * A/B test burns live traffic every hour it stays open, so letting a
   * newly-configured budget reach it closes something that is actively costing
   * something. A waiting proposal is inert: nothing runs, nothing is measured,
   * nothing is spent. Applying a new budget to it destroys work at no saving.
   *
   * Round 3 of the adversarial review measured what the fallback did with it:
   * a proposal waiting 19 days under "no timeout" was auto-rejected the moment
   * an operator introduced `--approval-timeout-days 7` for future proposals,
   * with the message "was past its 7d approval budget". That contradicts the
   * documented promise in {@link EvolutionConfig.approvalTimeoutDays} and
   * destroys a challenger nobody agreed to discard. Reading only the snapshot
   * keeps the promise: a change applies to proposals made from then on.
   *
   * A snapshot of `0` (or absent, for a proposal written by a pre-release
   * build) means no budget, so it waits until someone decides. Fail-safe: the
   * unknown case never destroys work.
   */
  private effectiveApprovalBudget(pending: PendingApproval): number | undefined {
    const snapshot = pending.approvalTimeoutDays;
    if (typeof snapshot === 'number' && Number.isFinite(snapshot) && snapshot > 0) {
      return snapshot;
    }
    return undefined;
  }

  /**
   * Has this proposal outlived its budget? No budget → never (the default).
   * An unparsable `proposedAt` also never expires: a clock we cannot read is
   * no reason to throw away a challenger a human may still want.
   */
  private isApprovalExpired(pending: PendingApproval, now: number = Date.now()): boolean {
    const maxDays = this.effectiveApprovalBudget(pending);
    if (maxDays === undefined) return false;
    const proposed = Date.parse(pending.proposedAt);
    if (!Number.isFinite(proposed)) return false;
    return now - proposed > maxDays * 24 * 60 * 60 * 1000;
  }

  /**
   * Approve a pending challenger: open EXACTLY the A/B test that was proposed.
   *
   * Refuses, rather than guessing, in three cases:
   *  - nothing pending;
   *  - an A/B test is already open (the two are mutually exclusive; a test
   *    that appeared alongside a proposal means something else wrote state,
   *    and silently discarding either side would lose work);
   *  - the incumbent moved since the proposal (a rollback, a manual
   *    activation, or a concluded test). The measured comparison was
   *    `pending.versionA` vs the challenger; running it against a DIFFERENT
   *    incumbent answers a different question than the one approved.
   *    `force: true` overrides, and then tests against the live incumbent.
   */
  async approveChallenger(
    agentName: string,
    opts: { force?: boolean } = {},
  ): Promise<{ approved: boolean; message: string }> {
    const state = await this.memory.getState();
    const pending = state.pendingApprovals?.[agentName] ?? null;
    if (!pending) {
      return { approved: false, message: `No challenger is awaiting approval for "${agentName}".` };
    }
    if (state.abTests[agentName]) {
      return {
        approved: false,
        message:
          `An A/B test is already open for "${agentName}", so the pending proposal ` +
          `(${pending.versionA} vs ${pending.versionB}) cannot start. Let the test finish, ` +
          `then approve or reject the proposal.`,
      };
    }

    // Two sources say what is "active", and they can disagree: `activeVersions`
    // is what run.ts ROUTES on, while the `active` flag on the PromptVersion
    // rows is what `getActivePrompt` reads. `darwin evolve --reset` writes only
    // the first, so after a reset the state says v1 while the flag still says
    // v3. Judging staleness against one of them alone would then approve a test
    // against a version that serves no traffic, or refuse one that does.
    const activePrompt = await this.memory.getActivePrompt(agentName);
    const flagIncumbent = activePrompt?.version;
    // `?? 'v1'` and NOT a skip-when-undefined guard: run.ts routes on exactly
    // `activeVersions[agent] ?? 'v1'`, so an unset entry means v1 is being
    // served, not that there is nothing to compare. Skipping on undefined
    // would make this check vacuous for every fresh agent, which is the
    // failure mode round 1 found in a test assertion of the same shape.
    const routedIncumbent = state.activeVersions[agentName] ?? 'v1';
    if (!flagIncumbent) {
      return {
        approved: false,
        message: `No active prompt for "${agentName}", so the approved test cannot start.`,
      };
    }
    if (routedIncumbent !== flagIncumbent && opts.force !== true) {
      return {
        approved: false,
        message:
          `"${agentName}" disagrees with itself about the active prompt: routing serves ` +
          `${routedIncumbent} while the version flag says ${flagIncumbent}. Approving would open ` +
          `a test whose arms do not match what runs. Fix the state first ` +
          `("darwin evolve ${agentName} --reset" returns both to v1), or re-run with --force to ` +
          `test against ${routedIncumbent}, the version that actually serves traffic.`,
      };
    }
    // ROUTING, not the flag. Round 2 caught the two halves of the round-1 fix
    // reading different sources: the pre-check picked the flag version while
    // the in-lock pin below compares against `activeVersions`, so in exactly
    // the disagreement state the message advertised --force for, --force could
    // never succeed. It reported "changed while approving", which is a race
    // diagnosis for a state with no second process in it, and the only way out
    // was --reset, destroying both the proposal and the evolved incumbent that
    // --force exists to preserve.
    //
    // Routing is also the right source on the merits: `activeVersions` is what
    // run.ts serves, so testing against it means testing against what users
    // actually get. Arms resolve by version LABEL (resolveRunPrompt), not by
    // the active flag, and whoever wins the test gets the flag through
    // activateVersion, which repairs the disagreement as a side effect.
    //
    // Outside a disagreement the two are equal, so this changes nothing there.
    const liveIncumbent = routedIncumbent;
    if (liveIncumbent !== pending.versionA && opts.force !== true) {
      return {
        approved: false,
        message:
          `The proposal for "${agentName}" was measured against ${pending.versionA}, but the ` +
          `active prompt is now ${liveIncumbent}. Approving would test ${pending.versionB} against ` +
          `a different incumbent than the one it was generated from. Reject it and let the next ` +
          `cycle propose a fresh challenger, or re-run with --force to test against ` +
          `${liveIncumbent} anyway.`,
      };
    }

    const versionA = opts.force === true ? liveIncumbent : pending.versionA;
    const startedAt = new Date().toISOString();
    const newTest: ABTest = {
      versionA,
      versionB: pending.versionB,
      runsA: 0,
      runsB: 0,
      failsA: 0,
      failsB: 0,
      minRuns: pending.minRuns,
      // The A/B wall-clock budget starts when the TEST starts, not when the
      // challenger was proposed. Time spent waiting for a human is not time
      // spent collecting data.
      startedAt,
      ...(pending.maxTestDays !== undefined ? { maxTestDays: pending.maxTestDays } : {}),
    };

    // One callback: the proposal disappears and the test appears together, so
    // a concurrent reader never sees both or neither. Both real providers run
    // this callback under a write lock (SQLite `transaction.immediate()`,
    // Postgres `SELECT … FOR UPDATE`), so what it reads is live.
    //
    // The check is on IDENTITY, not just presence. Presence alone would accept
    // a DIFFERENT proposal: if another process rejected this one and the next
    // cycle proposed a fresh challenger between the getState above and this
    // callback, `pendingApprovals[agent]` is non-null again, and approving
    // would start the test for the challenger read earlier while silently
    // deleting the new one nobody has looked at. versionB plus proposedAt pins
    // it: version labels are never reused (nextFreeVersion clears the whole
    // history), so a match means the same proposal.
    let raced = false;
    await this.memory.updateState((s) => {
      const live = s.pendingApprovals?.[agentName];
      if (!live || live.versionB !== pending.versionB || live.proposedAt !== pending.proposedAt) {
        raced = true;
        return s;
      }
      if (s.abTests[agentName]) {
        raced = true;
        return s;
      }
      // The staleness decision above read the incumbent OUTSIDE this lock. A
      // rollback landing in that window would open the test against a version
      // that was just rolled away, and arm routing would serve it again. Same
      // TOCTOU class as the proposal identity, pinned the same way.
      if ((s.activeVersions[agentName] ?? 'v1') !== versionA) {
        raced = true;
        return s;
      }
      s.abTests[agentName] = newTest;
      s.pendingApprovals![agentName] = null;
      return s;
    });
    if (raced) {
      return {
        approved: false,
        message:
          `The state for "${agentName}" changed while approving (another process resolved the ` +
          `proposal, opened a test, or moved the active version). Nothing was started. ` +
          `Check "darwin status ${agentName}".`,
      };
    }

    notifyEvolutionStarted(
      this.notifications, agentName, versionA, pending.versionB, pending.changeReason,
    ).catch(() => {/* swallow */});

    emitMetric(this.metrics, 'approval_granted', agentName, {
      versionA,
      versionB: pending.versionB,
      minRuns: pending.minRuns,
      forced: opts.force === true,
    });
    emitMetric(this.metrics, 'ab_test_started', agentName, {
      versionA,
      versionB: pending.versionB,
      generatedBy: pending.generatedBy,
      minRuns: pending.minRuns,
    });

    return {
      approved: true,
      message:
        `Approved. A/B test started: ${versionA} vs ${pending.versionB} ` +
        `(minRuns: ${pending.minRuns}).`,
    };
  }

  /**
   * Reject a pending challenger and free the slot.
   *
   * The rejected {@link PromptVersion} deliberately STAYS in history with
   * `active: false`. `nextFreeVersion` clears the whole version history, not
   * just the active one, so its label is never reused (v0.13.0) and the record
   * of what was proposed and turned down survives.
   */
  async rejectChallenger(
    agentName: string,
    reason?: string,
  ): Promise<{ rejected: boolean; message: string }> {
    const state = await this.memory.getState();
    const pending = state.pendingApprovals?.[agentName] ?? null;
    if (!pending) {
      return { rejected: false, message: `No challenger is awaiting approval for "${agentName}".` };
    }

    // Identity-pinned for the same reason approveChallenger is: clearing
    // whatever happens to be pending would silently discard a NEWER proposal
    // that this caller never saw, and a rejection nobody read is worse than a
    // refusal.
    // v0.18.0: the fingerprint is read BEFORE the lock, because reading a
    // prompt row is a backend round-trip and the state callback must stay
    // short. A missing row yields no fingerprint, and an entry without one can
    // never match: the memory would rather forget than block the wrong text.
    const entry = await this.buildRejectionEntry(agentName, pending, 'human', reason);

    let raced = false;
    await this.memory.updateState((s) => {
      const live = s.pendingApprovals?.[agentName];
      if (!live || live.versionB !== pending.versionB || live.proposedAt !== pending.proposedAt) {
        raced = true;
        return s;
      }
      s.pendingApprovals![agentName] = null;
      // Written inside the SAME callback that clears the proposal. Two writes
      // would leave a window where the proposal is gone and the memory of it
      // does not exist yet, which is exactly when the next cycle would
      // re-propose the text nobody wanted.
      return rememberRejection(s, agentName, entry);
    });
    if (raced) {
      return {
        rejected: false,
        message:
          `The proposal for "${agentName}" changed while rejecting (another process resolved it, ` +
          `or a different challenger is now pending). Nothing was discarded. ` +
          `Check "darwin approve ${agentName}".`,
      };
    }

    emitMetric(this.metrics, 'approval_rejected', agentName, {
      versionA: pending.versionA,
      versionB: pending.versionB,
      ...(reason !== undefined ? { reason } : {}),
      expired: false,
    });

    return {
      rejected: true,
      message:
        `Rejected ${pending.versionB}. ${pending.versionA} stays active and the next evolution ` +
        `cycle can propose a different challenger.` +
        (reason !== undefined ? ` Reason recorded: ${reason}` : ''),
    };
  }

  /**
   * Refuse a challenger whose text was rejected WHILE it was being generated.
   *
   * Distinct from the pre-generation refusal only in when it was noticed. The
   * generated version row stays for the same reason a lost claim race keeps
   * its row: it cost a model call, it is inert, and its label is never reused.
   */
  private refuseRacedRejection(
    agent: string,
    newVersion: string,
    rejected: RejectedChallenger,
    result: EvolutionResult,
  ): EvolutionResult {
    result.promptEvolved = false;
    result.abTestStarted = false;
    result.rejectedRepeat = true;
    result.message =
      `Generated ${newVersion} for "${agent}", but that text was rejected ` +
      `(as ${rejected.version}) while it was being generated, so nothing was proposed. ` +
      `${newVersion} was left inactive and unused. Check "darwin status ${agent}".`;
    emitMetric(this.metrics, 'rejected_repeat', agent, {
      generator: 'unknown',
      rejectedVersion: rejected.version,
      action: 'refused',
      discarded: newVersion,
    });
    return result;
  }

  /**
   * Build the {@link RejectedChallenger} record for a proposal being turned
   * down. Reads the challenger's prompt row to fingerprint it; a row that
   * cannot be read yields an entry WITHOUT a fingerprint, which is a record
   * of the decision that can never match a future text. Deliberate: blocking
   * on a hash we could not compute would block the wrong thing.
   */
  private async buildRejectionEntry(
    agentName: string,
    pending: PendingApproval,
    rejectedBy: 'human' | 'timeout',
    reason?: string,
  ): Promise<RejectedChallenger> {
    let textHash: string | undefined;
    try {
      const versions = await this.memory.getAllPromptVersions(agentName);
      const challenger = versions.find((v) => v.version === pending.versionB);
      if (challenger?.promptText) textHash = fingerprintPromptText(challenger.promptText);
    } catch {
      // A backend hiccup must not stop a rejection: the human said no, and
      // that answer is what has to land.
    }
    return {
      version: pending.versionB,
      versionA: pending.versionA,
      ...(textHash !== undefined ? { textHash } : {}),
      rejectedAt: new Date().toISOString(),
      rejectedBy,
      ...(rejectedBy === 'human' && reason !== undefined && reason.trim() !== ''
        ? { reason: reason.trim() }
        : {}),
      generatedBy: pending.generatedBy,
    };
  }

  /**
   * The reviewer notes this agent's optimizers get, honouring
   * `evolution.rejectionNoteLimit`. `0` means "block repeats but quote
   * nothing"; unset means the default window.
   */
  private rejectionNotesFor(entries: ReadonlyArray<RejectedChallenger>): RejectionNote[] {
    const configured = this.agent?.evolution?.rejectionNoteLimit;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured <= 0) {
      return [];
    }
    const limit =
      typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
        ? Math.floor(configured)
        : REJECTION_NOTES_LIMIT;
    return rejectionNotes(entries, { limit });
  }

  /**
   * Append the reviewer notes to a reflective-feedback set as one extra entry.
   * Returns the input unchanged when there is nothing to add, so a run with no
   * rejections builds a byte-identical reflection prompt to v0.17.
   */
  private appendRejectionFeedback(
    feedbacks: ReadonlyArray<ReflectiveFeedback>,
    notes: ReadonlyArray<RejectionNote>,
  ): ReflectiveFeedback[] {
    const block = formatRejectionNotes(notes);
    if (block === '') return [...feedbacks];
    return [
      ...feedbacks,
      {
        variantId: notes.map((n) => n.version).join(', '),
        // Not a critic score. Zero is the lowest thing this field can say, and
        // "a human rejected it" is the strongest reason in the set to not go
        // back there. The reflector ranks by it; the text says what it is.
        score: 0,
        textFeedback: `REJECTED BY A HUMAN REVIEWER\n${block}`,
      },
    ];
  }

  /**
   * Forget remembered rejections for an agent: one version label, or `'all'`.
   *
   * The escape hatch for the one way this memory can hurt: a deterministic
   * generator that can only produce the rejected text stops proposing
   * anything, and without this the only way out would be `--reset`, which
   * throws the evolved incumbent back to v1.
   */
  async forgetRejection(
    agentName: string,
    which: string | 'all',
  ): Promise<{ forgotten: number; message: string }> {
    let forgotten = 0;
    await this.memory.updateState((s) => {
      forgotten = forgetRejections(s, agentName, which);
      return s;
    });
    if (forgotten === 0) {
      return {
        forgotten: 0,
        message:
          which === 'all'
            ? `Nothing remembered for "${agentName}"; nothing to forget.`
            : `"${agentName}" has no remembered rejection for ${which}.`,
      };
    }
    emitMetric(this.metrics, 'rejection_forgotten', agentName, {
      which,
      forgotten,
    });
    return {
      forgotten,
      message:
        which === 'all'
          ? `Forgot ${forgotten} remembered rejection(s) for "${agentName}". Any of those texts ` +
            `can be proposed again.`
          : `Forgot the rejection of ${which} for "${agentName}". That text can be proposed again.`,
    };
  }

  /**
   * Auto-reject a proposal that outlived its budget. Never auto-APPROVES, for
   * the same reason {@link concludeInconclusive} never promotes: an absent
   * decision is not a decision.
   */
  private async expireApproval(
    agentName: string,
    pending: PendingApproval,
  ): Promise<boolean> {
    // Identity-pinned like the other two writers: a proposal that appeared
    // after the expiry decision was made is not the one that expired.
    //
    // v0.18.0: a lapsed proposal is remembered too, so the same text does not
    // come straight back and lapse again. It is stored as `rejectedBy:
    // 'timeout'` and carries no reason, which keeps it out of the notes the
    // optimizers see: nobody read this text, so it has nothing to teach.
    const entry = await this.buildRejectionEntry(agentName, pending, 'timeout');

    let raced = false;
    await this.memory.updateState((s) => {
      const live = s.pendingApprovals?.[agentName];
      if (!live || live.versionB !== pending.versionB || live.proposedAt !== pending.proposedAt) {
        raced = true;
        return s;
      }
      s.pendingApprovals![agentName] = null;
      return rememberRejection(s, agentName, entry);
    });
    if (raced) {
      // Nothing was expired. Round 3: the callers announced the rejection and
      // emitted `evolution_skipped { reason: 'approval_expired' }` anyway, so a
      // metrics stream recorded a rejection that did not happen. Report the
      // miss instead and let them say something true.
      return false;
    }

    notifyApprovalExpired(
      this.notifications, agentName, pending.versionA, pending.versionB,
      this.effectiveApprovalBudget(pending) ?? 0,
    ).catch(() => {/* swallow: notification is best-effort */});

    emitMetric(this.metrics, 'approval_rejected', agentName, {
      versionA: pending.versionA,
      versionB: pending.versionB,
      reason: 'timeout',
      expired: true,
      budgetDays: this.effectiveApprovalBudget(pending) ?? 0,
    });
    return true;
  }

  // ─── A/B Test Handling ─────────────────────────────

  // No `test` snapshot parameter on purpose. Every read below goes through
  // `memory.updateState`, which re-reads the live A/B test inside the atomic
  // callback; a caller-supplied snapshot could already be stale by the time it
  // arrives and reintroduces the race that fix removed. The unused parameter
  // survived that change and was removed in v0.15 once the compiler was told
  // to report dead code.
  private async handleABTest(
    agentName: string,
    experiment: DarwinExperiment,
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

    // v0.7.0 — When the peeking guard runs a sequential test (mSPRT /
    // Hoeffding), it needs the RAW per-arm composite samples (and thus their
    // variance), not just the means. Load them only when that method is
    // configured — the default effect-size guard needs no extra data.
    let abSamples: ABTestSamples | undefined;
    if (this.safety.usesSequentialConfidence()) {
      const [samplesA, samplesB] = await Promise.all([
        this.tracker.getCompositeScores(agentName, currentTest.versionA, agentWeights, currentTest.startedAt),
        this.tracker.getCompositeScores(agentName, currentTest.versionB, agentWeights, currentTest.startedAt),
      ]);
      abSamples = { a: samplesA, b: samplesB };
    }

    // Evaluate the test (including reliability from failure counts)
    const outcome = this.safety.evaluateABTest(
      compositeA,
      compositeB,
      currentTest.runsA,
      currentTest.runsB,
      currentTest.failsA ?? 0,
      currentTest.failsB ?? 0,
      currentTest.minRuns,
      abSamples,
    );

    // v0.13.0 — wall-clock budget. `minRuns` is a sample budget and knows
    // nothing about throughput: a low-variance test correctly demands ~30 runs
    // per arm, which a twice-a-week agent cannot pay inside a year — and the
    // agent cannot evolve at all while its test is open. When the budget is
    // exhausted, close the test WITHOUT promoting: inconclusive evidence must
    // never activate a challenger (judge variance dwarfs the real lift), but
    // the slot is freed so a later cycle can try a different one. Off by
    // default, so the untimed path stays exactly as it was.
    const expired = this.isTestExpired(currentTest);
    if (outcome === 'continue' && !expired) {
      return { completed: false, message: 'A/B test continues.' };
    }

    if (outcome === 'continue' && expired) {
      await this.concludeInconclusive(agentName, currentTest);
      return {
        completed: true,
        winner: currentTest.versionA,
        message:
          `A/B test timed out after ${this.effectiveTestBudget(currentTest)}d without reaching ` +
          `minRuns (${currentTest.runsA}/${currentTest.runsB} of ${currentTest.minRuns}). ` +
          `Keeping ${currentTest.versionA}; ${currentTest.versionB} was not promoted.`,
      };
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
        // v0.7.0 — ε-relaxed Pareto dominance. With `paretoEpsilon` unset (0)
        // this is byte-for-byte the strict v0.6.0 gate; a positive epsilon
        // lets B win despite a marginal (≤ε) regression on some objective.
        const bDominatesA = dominatesEpsilon(
          metricsB,
          metricsA,
          DARWIN_DEFAULT_OBJECTIVES as ReadonlyArray<ParetoObjective<Record<string, number>>>,
          this.agent?.evolution?.paretoEpsilon ?? 0,
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

    // Update state atomically: clear test, set last-known-good, and reset
    // the failure streak — it is version-agnostic, so a streak accumulated
    // by the losing arm must not carry over into the winner's era and tee
    // up a bogus lineage rollback on its first hiccup (R5 review, P0).
    await this.memory.updateState((s) => {
      s.abTests[agentName] = null;
      s.lastKnownGood[agentName] = winner;
      s.activeVersions[agentName] = winner;
      s.consecutiveFailures[agentName] = 0;
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

    emitMetric(this.metrics, 'ab_test_completed', agentName, {
      winner,
      loser,
      winnerScore,
      loserScore,
      reason: 'decided',
    });

    return {
      completed: true,
      winner,
      message: `A/B test complete: ${winner} wins over ${loser} ${scoreMsg}.`,
    };
  }

  /**
   * The wall-clock budget (days) governing this test: the budget snapshotted
   * at test start when present (v0.13.1), else the agent's CURRENT config —
   * the fallback keeps two pre-snapshot behaviours working: tests started
   * before v0.13.1 under a persisted budget, and budgets added AFTER a test
   * was already running.
   */
  private effectiveTestBudget(test: ABTest): number | undefined {
    const snapshot = test.maxTestDays;
    if (typeof snapshot === 'number' && Number.isFinite(snapshot) && snapshot > 0) {
      return snapshot;
    }
    const configured = this.agent?.evolution?.maxTestDays;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return configured;
    }
    return undefined;
  }

  /**
   * Has this A/B test outlived its wall-clock budget?
   *
   * No effective budget → never expires (the default). An unparsable
   * `startedAt` also never expires: a clock we cannot read is no reason to
   * abandon a test that may be collecting good data.
   */
  private isTestExpired(test: ABTest, now: number = Date.now()): boolean {
    const maxDays = this.effectiveTestBudget(test);
    if (maxDays === undefined) {
      return false;
    }
    const started = Date.parse(test.startedAt);
    if (!Number.isFinite(started)) {
      return false;
    }
    return now - started > maxDays * 24 * 60 * 60 * 1000;
  }

  /**
   * Close a timed-out A/B test in favour of the incumbent.
   *
   * Deliberately NOT a `rollback()`: nothing failed, and the incumbent is
   * already the active version — re-activating it keeps the persisted state
   * self-consistent for callers that read `activeVersions` without re-deriving
   * it. `lastKnownGood` is left untouched, since a timeout produced no new
   * evidence about which version is good.
   */
  private async concludeInconclusive(agentName: string, test: ABTest): Promise<void> {
    await this.activateVersion(agentName, test.versionA);
    await this.memory.updateState((s) => {
      s.abTests[agentName] = null;
      s.activeVersions[agentName] = test.versionA;
      // Same failure-era reset as every other test-closing path (R5, P0).
      s.consecutiveFailures[agentName] = 0;
      return s;
    });

    // Best-effort, like every other notification on this path — a test that
    // disappears from `abTests` without a word is invisible to anyone watching
    // the alert channel.
    notifyABTestTimeout(
      this.notifications,
      agentName,
      test.versionA,
      test.versionB,
      test.runsA,
      test.runsB,
      test.minRuns,
      this.effectiveTestBudget(test) ?? 0,
    ).catch(() => {/* swallow — notification is best-effort */});

    emitMetric(this.metrics, 'ab_test_timeout', agentName, {
      kept: test.versionA,
      notPromoted: test.versionB,
      runsA: test.runsA,
      runsB: test.runsB,
      minRuns: test.minRuns,
      budgetDays: this.effectiveTestBudget(test) ?? 0,
    });
  }

  // ─── Rollback ──────────────────────────────────────

  /**
   * Roll back after consecutive failures. Returns true if a rollback was
   * performed.
   *
   * Two-stage target resolution (v0.14.0):
   *   1. `lastKnownGood` when it differs from the active version — divergent
   *      state WITHOUT an open test (manual state surgery, legacy blobs);
   *      with a test open, no rollback of any kind runs (guard below).
   *   2. Otherwise the ACTIVE version's parent in the version lineage. This
   *      closes a real gap (cross-model review): `handleABTest` promotes a
   *      winner by setting `activeVersions` AND `lastKnownGood` to the same
   *      label, so from that moment `current === lastGood` and stage 1 can
   *      never fire — the advertised failure rollback was dead exactly when
   *      a freshly-promoted prompt started degrading in real traffic (model
   *      update, tool drift). One step up the lineage per rollback, and
   *      `lastKnownGood` moves along, so repeated failure bursts can walk
   *      further back — v1 (no parent) is the floor.
   */
  private async rollback(agentName: string): Promise<boolean> {
    const state = await this.memory.getState();

    // No rollback of ANY kind while an A/B test is open (R3+R4 review, P0).
    // The consecutive-failure counter is version-agnostic, so a failing
    // CHALLENGER would otherwise roll the healthy incumbent back (stage 2:
    // to its parent; stage 1: to a divergent lastKnownGood) and destroy the
    // test. During a test the TEST decides: complete-but-failing runs sink
    // that arm's composite, incomplete runs feed the failsA/B auto-loss, and
    // maxTestDays bounds the wall clock. The failure counter takes over
    // again the moment the slot is free.
    if (state.abTests[agentName]) {
      return false;
    }

    const lastGood = state.lastKnownGood[agentName];
    if (!lastGood) {
      return false;
    }

    const currentVersion = state.activeVersions[agentName];
    const versions = await this.memory.getAllPromptVersions(agentName);
    let target = lastGood;

    if (currentVersion === lastGood) {
      // Stage 2 — the promoted winner itself is failing. Walk one step up
      // the version lineage instead of declaring "nothing to roll back".
      const current = versions.find((v) => v.version === currentVersion);
      const parentLabel = current?.parentVersion ?? null;
      const parent = parentLabel !== null
        ? versions.find((v) => v.version === parentLabel)
        : undefined;
      if (!parent || parent.version === currentVersion) {
        return false; // no lineage to fall back to (v1, or unknown state)
      }
      target = parent.version;
    } else if (!versions.some((v) => v.version === lastGood)) {
      // Stage 1 guard (R3 review, P1): a stale `lastKnownGood` pointing at a
      // label with no stored prompt must not be "activated" — activateVersion
      // would deactivate every real version and persist a phantom label. Try
      // the lineage walk from the CURRENT version instead; give up if that
      // has no stored parent either.
      const current = versions.find((v) => v.version === currentVersion);
      const parent = current?.parentVersion != null
        ? versions.find((v) => v.version === current.parentVersion)
        : undefined;
      if (!parent || parent.version === currentVersion) {
        return false;
      }
      target = parent.version;
    }

    // Commit the transition ATOMICALLY, state first (R5 review, P0 — TOCTOU):
    // the open-test guard above read a snapshot, and every awaited call since
    // is a window in which a concurrent process may have STARTED a test. The
    // re-check runs inside the same updateState callback as the transition,
    // so a test that appeared in the window survives and the rollback aborts
    // instead of destroying it. The prompt-version active flags are aligned
    // AFTER the state commit — state is the source of truth readers resolve
    // against, flag alignment is idempotent repair.
    let abortedByOpenTest = false;
    await this.memory.updateState((s) => {
      if (s.abTests[agentName]) {
        abortedByOpenTest = true;
        return s;
      }
      s.activeVersions[agentName] = target;
      s.lastKnownGood[agentName] = target;
      s.consecutiveFailures[agentName] = 0;
      return s;
    });
    if (abortedByOpenTest) {
      return false;
    }

    await this.activateVersion(agentName, target);

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
   * v0.7.0 — Configurable feedback window (default 15, was a hard-coded 5).
   * A larger window gives both the legacy optimizer and the GEPA reflector
   * more of the recent behaviour to learn from. Clamped to ≥ 1.
   */
  private feedbackWindow(): number {
    const w = this.agent?.evolution?.feedbackWindow;
    if (typeof w === 'number' && Number.isFinite(w) && w >= 1) return Math.floor(w);
    return 15;
  }

  /**
   * v0.7.0 — Parse the integer out of a "vN" version string for use as the
   * epoch-shuffled-minibatch epoch. "v1"→1, "v12"→12; non-parsable→0.
   */
  private versionInt(version: string): number {
    const m = /(\d+)/.exec(version ?? '');
    return m ? parseInt(m[1]!, 10) : 0;
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
    const skipPerfect = this.agent?.evolution?.skipPerfectFeedback === true;
    const perfectScore = this.perfectFeedbackScore();

    const feedback: string[] = [];
    for (const exp of experiments) {
      if (feedback.length >= limit) break;
      if (exp.feedback?.report) {
        // v0.11.0: skip already-perfect runs (GEPA skip_perfect_score) — a
        // 10/10 report gives the optimizer no gradient. Skipped items do NOT
        // count toward `limit`, so the window fills with actionable reports.
        if (skipPerfect && isPerfectScore(exp.feedback.score, perfectScore)) continue;
        const header = `Score: ${exp.feedback.score}/10 | Task: "${exp.task}" | Version: ${exp.promptVersion}`;
        feedback.push(`${header}\n${exp.feedback.report}`);
      }
    }

    return feedback;
  }

  /**
   * v0.11.0 — Resolved perfect-score threshold for {@link
   * EvolutionConfig.skipPerfectFeedback} (finite, within the critic 1–10
   * scale, else default 10).
   */
  private perfectFeedbackScore(): number {
    return resolvePerfectFeedbackScore(this.agent?.evolution?.perfectFeedbackScore);
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
    epoch: number = 0,
    notes: ReadonlyArray<RejectionNote> = [],
  ): Promise<{ prompt: string; via: 'gepa' | 'merge' } | null> {
    if (!this.gepa) {
      return null;
    }

    // v0.7.0: on every mergeEveryK-th cycle, try a GEPA system-aware MERGE of
    // the two best Pareto-front versions in this agent's history instead of a
    // reflective mutation (paper Appendix-D, ~+5% lift). Falls through to the
    // reflective path when there aren't two scored parents or the merge errors.
    // `epoch > 0` skips the cold-start cycle (epoch 0 = unparseable/initial
    // version, where there is never a merge pool yet) so the modulo gate is
    // correct-by-design rather than relying on tryMergeVariant's no-op.
    if (
      this.agent?.evolution?.useMerge === true &&
      epoch > 0 &&
      epoch % this.mergeEveryK() === 0 &&
      (await this.mergeBudgetAvailable(agentName))
    ) {
      const merged = await this.tryMergeVariant(agentName);
      if (merged !== null) {
        const guarded = await this.runAlignmentGuard(currentPrompt, merged);
        if (guarded !== null) {
          // v0.11.0: count this merge challenger against the lifetime cap
          // (GEPA max_merge_invocations). Only accepted merges are counted; one
          // that failed the guard below was never built. The counter is written
          // ONLY when a cap is configured, so an uncapped useMerge agent's
          // persisted state stays byte-for-byte v0.10 (no stray key).
          //
          // v0.17.0: the cap counts merge challengers CREATED, which under
          // `requireApproval` now includes ones a human rejects, ones that
          // expire, and ones that lose the claim race. That is deliberate: the
          // cap is a cost budget for the reflection calls, and those were paid
          // whatever happened afterwards. It does mean a cap of 5 plus five
          // rejections turns merge off for the agent's life. Raise the cap, or
          // leave it unset, if that is not the trade you want.
          await this.recordMergeInvocation(agentName);
          return { prompt: guarded, via: 'merge' };
        }
        // Merge produced a prompt that eroded a safety constraint — reject it
        // and fall through to the reflective path. Emit a breadcrumb (mirrors
        // the reflector-error log, v0.6.0 Finding F6) so a consistently
        // alignment-failing merge is visible instead of silently degrading.
        console.warn(
          `[darwin] GEPA merge for "${agentName}" failed the alignment guard, falling through to reflective.`,
        );
      }
    }

    // v0.7.0: GEPA Algorithm 2 instance-wise coverage selection (opt-in via
    // evolution.useCoverage). Pick the prompt VERSION to reflect from by
    // per-task-type coverage breadth — the version that wins on the most
    // DIFFERENT task types — instead of always reflecting from the single
    // currently-active prompt. Falls back to the active prompt when fewer than
    // two versions carry per-task-type data (selectCoverageParent → null).
    let parentPrompt = currentPrompt;
    let parentChosen = false;
    if (this.agent?.evolution?.useCoverage === true) {
      const coverageParent = await this.selectCoverageParent(agentName);
      if (coverageParent !== null) {
        parentPrompt = coverageParent;
        parentChosen = true;
      }
    }

    // v0.10.0: GEPA candidate_selection_strategy parity (opt-in via
    // evolution.candidateSelection). Pick the reflection parent from the
    // agent's SCORED version history — 'best' (current_best), 'pareto'
    // (uniform sample from the non-dominated front), or 'epsilon-greedy'
    // (explore/exploit). Coverage selection (the more specific GEPA
    // Algorithm 2 selector) takes precedence when it found a parent; this
    // strategy is the fallback for that cycle. 'active'/unset keeps the
    // historical reflect-from-active-prompt behaviour byte-for-byte.
    const strategy = this.agent?.evolution?.candidateSelection;
    if (!parentChosen && strategy !== undefined && strategy !== 'active') {
      const scored = await this.buildScoredHistory(agentName);
      const chosen = selectParentVariant(scored, strategy, {
        epsilon: this.agent?.evolution?.explorationEpsilon,
        rng: this.rng,
      });
      if (chosen !== null) {
        parentPrompt = chosen.prompt;
      }
    }

    // v0.7.0: pull the configurable feedback window (default 15, was 5).
    let feedbacks = await this.getReflectiveFeedback(agentName, this.feedbackWindow());
    // v0.7.0: optional epoch-shuffled minibatch — reflect on a focused, rotating
    // subset of the window so the reflection prompt stays tight while still
    // covering all recent feedback across cycles.
    const minibatchSize = this.agent?.evolution?.reflectionMinibatchSize;
    if (typeof minibatchSize === 'number' && minibatchSize > 0 && feedbacks.length > minibatchSize) {
      feedbacks = epochShuffledMinibatch(feedbacks, minibatchSize, epoch);
    }
    if (feedbacks.length === 0) {
      // Cold start: no critic feedback to reflect on. Let the legacy
      // meta-prompt optimizer (which works from aggregate stats + patterns)
      // handle the first mutation.
      return null;
    }

    // v0.18.0: the reviewer's reasons enter GEPA the way GEPA takes anything,
    // as feedback. A rejection is the strongest signal in the set (a human
    // looked at the text and said no), so it goes in as its own entry with
    // score 0 rather than being appended to somebody else's report, where the
    // reflector would read it as part of that run's critique. `variantId`
    // names the rejected version so the model can tell the two apart.
    const withNotes = this.appendRejectionFeedback(feedbacks, notes);

    let mutated: string;
    try {
      const variants = await this.gepa.generate(parentPrompt, withNotes, {
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

    const guarded = await this.runAlignmentGuard(currentPrompt, mutated);
    return guarded === null ? null : { prompt: guarded, via: 'gepa' };
  }

  /**
   * v0.7.0 — Shared alignment guard for every GEPA-path mutation (reflective
   * OR merge). Returns the candidate unchanged when it preserves the safety
   * keywords, or `null` when it erodes one (→ caller rejects / falls back).
   *
   * Uses the semantic (embedding-distance) guard when an embedder is injected
   * — a REWORDED safety constraint is accepted — and the strict keyword guard
   * otherwise. Fail-closed: no embedder ⇒ keyword-only.
   */
  private async runAlignmentGuard(
    currentPrompt: string,
    candidate: string,
  ): Promise<string | null> {
    const issue = this.embed
      ? await checkAlignmentPreservationSemantic(currentPrompt, candidate, {
          embed: this.embed,
          minSafetySimilarity: this.alignmentSimilarityThreshold,
        })
      : checkAlignmentPreservation(currentPrompt, candidate);
    return issue === null ? candidate : null;
  }

  /**
   * v0.7.0 — Merge cadence (every K-th cycle). Default 3, clamped ≥ 1.
   */
  private mergeEveryK(): number {
    const k = this.agent?.evolution?.mergeEveryK;
    if (typeof k === 'number' && Number.isFinite(k) && k >= 1) return Math.floor(k);
    return 3;
  }

  /**
   * v0.11.0 — Resolved lifetime merge cap (GEPA `max_merge_invocations`), or
   * `null` when uncapped. A non-finite / negative value is treated as "no cap"
   * rather than silently disabling merge; a non-integer cap is floored (mirrors
   * `mergeEveryK`) so a hand-edited `2.5` behaves as 2, not 3.
   */
  private mergeCap(): number | null {
    const cap = this.agent?.evolution?.maxMergeInvocations;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) return null;
    return Math.floor(cap);
  }

  /**
   * v0.11.0 — Lifetime merge budget check (GEPA `max_merge_invocations`).
   * Returns `true` (merge may fire) when no cap is configured, or when the
   * per-agent count of merge-derived challengers is still below the cap.
   */
  private async mergeBudgetAvailable(agentName: string): Promise<boolean> {
    const cap = this.mergeCap();
    if (cap === null) return true;
    const state = await this.memory.getState();
    const used = state.mergeInvocations?.[agentName] ?? 0;
    return used < cap;
  }

  /**
   * v0.11.0 — Increment this agent's lifetime merge-invocation count. Called
   * once per merge challenger that passes the alignment guard and is carried
   * into a challenger, and ONLY when a cap is configured. An uncapped useMerge
   * agent never writes the counter, so its persisted state is unchanged from
   * v0.10. Initialises the map lazily for state rows that predate the field.
   *
   * v0.17.0: said "carried into an A/B test", which stopped being true when
   * `requireApproval` put a human between the challenger and the test. The
   * counter has always incremented at CREATION; only the comment drifted.
   *
   * The check (`mergeBudgetAvailable`) and this increment are separate state
   * reads, so two cycles running concurrently for the SAME agent could each
   * observe `used = cap-1` and overshoot by one. The overshoot is bounded by
   * the concurrency and sits inside the pre-existing concurrent-A/B-start
   * envelope (afterRun's "an A/B test is already running" guard is likewise
   * check-then-act) — acceptable for a soft lifetime budget, not a hard limit.
   */
  private async recordMergeInvocation(agentName: string): Promise<void> {
    if (this.mergeCap() === null) return; // uncapped → leave state untouched
    await this.memory.updateState((s) => {
      if (!s.mergeInvocations) s.mergeInvocations = {};
      s.mergeInvocations[agentName] = (s.mergeInvocations[agentName] ?? 0) + 1;
      return s;
    });
  }

  /**
   * v0.10.0 — Demo-injection cadence (every K-th cycle). Default 4, clamped
   * ≥ 1. Deliberately offset from the merge default (3) so the two
   * non-reflective challenger sources don't collide on the same cycles.
   */
  private demoEveryK(): number {
    const k = this.agent?.evolution?.demoEveryK;
    if (typeof k === 'number' && Number.isFinite(k) && k >= 1) return Math.floor(k);
    return 4;
  }

  /**
   * v0.10.0 — Build a SIMBA-style demo challenger: current prompt + a
   * marker-delimited "Demonstrations" section harvested from this agent's
   * highest-scoring past runs. Pure selection + rendering — no LLM call.
   *
   * Returns `null` (→ caller falls through to GEPA/legacy generation) when
   * no run qualifies (score/threshold/length filters) or when the rendered
   * demo set is byte-identical to what the prompt already carries — an A/B
   * test of a version against itself would be pointless.
   */
  private async tryDemoVariant(agentName: string, currentPrompt: string): Promise<string | null> {
    const experiments = await this.memory.loadExperiments(agentName);
    const demos = selectDemoCandidates(experiments, {
      maxDemos: this.agent?.evolution?.maxDemos,
      scoreThreshold: this.agent?.evolution?.demoScoreThreshold,
    });
    if (demos.length === 0) return null;
    const section = buildDemoSection(demos);
    const withDemos = applyDemoSection(currentPrompt, section);
    if (withDemos === currentPrompt) return null;
    return withDemos;
  }

  /**
   * v0.10.0 — Scored version history for parent selection AND merge: every
   * prompt version that has text and at least one run's worth of averaged
   * metrics, as {@link ScoredVariant}s. One getAverageMetrics
   * (→ loadExperiments) call per version. O(N) backend round-trips, but N is
   * the agent's prompt-version count (≤ ~20 in practice) and this only runs
   * on selection/merge cadences, so it is cheap — same pattern handleABTest
   * already uses for the Pareto gate. (Extracted from tryMergeVariant,
   * behaviour unchanged.)
   */
  private async buildScoredHistory(agentName: string): Promise<ScoredVariant[]> {
    const versions = await this.memory.getAllPromptVersions(agentName);
    const scored: ScoredVariant[] = [];
    for (const v of versions) {
      if (!v.promptText) continue;
      const metrics = await this.tracker.getAverageMetrics(agentName, v.version);
      if (Object.keys(metrics).length === 0) continue; // no runs for this version
      scored.push({ id: v.version, prompt: v.promptText, metrics });
    }
    return scored;
  }

  /**
   * v0.7.0 — GEPA system-aware MERGE (paper Appendix-D). Builds scored
   * variants from this agent's prompt-version history (each version's prompt
   * text + its averaged objective vector), takes the two best Pareto-front
   * members, and asks the {@link GepaOptimizer} to combine their complementary
   * strengths into one challenger prompt.
   *
   * Returns the merged prompt, or `null` (→ caller falls back to reflective)
   * when: no optimizer is wired, fewer than two versions carry metric data,
   * the Pareto front has fewer than two members, or the merge call throws.
   * The returned prompt has NOT yet passed the alignment guard — the caller
   * runs {@link runAlignmentGuard} on it.
   */
  private async tryMergeVariant(agentName: string): Promise<string | null> {
    if (!this.gepa) return null;

    const scored = await this.buildScoredHistory(agentName);
    if (scored.length < 2) return null; // need two parents to merge

    // Two best Pareto-front members (distinct versions, scalarised tie-break).
    const metricsArr = scored.map((s) => s.metrics);
    const frontMetrics = paretoSelect(
      metricsArr,
      DARWIN_DEFAULT_OBJECTIVES as ReadonlyArray<ParetoObjective<Record<string, number>>>,
      2,
    );
    if (frontMetrics.length < 2) return null; // single dominant version → nothing to merge

    const indexOf = new Map<Record<string, number>, number>();
    metricsArr.forEach((m, i) => indexOf.set(m, i));
    const parents = frontMetrics
      .map((m) => scored[indexOf.get(m)!])
      .filter((s): s is ScoredVariant => s !== undefined);
    if (parents.length < 2 || parents[0]!.id === parents[1]!.id) return null;

    try {
      const merged = await this.gepa.merge([parents[0]!, parents[1]!]);
      return merged.prompt.length > 0 ? merged.prompt : null;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[darwin] GEPA merge failed for "${agentName}", falling back to reflective: ${reason}`);
      return null;
    }
  }

  /**
   * v0.7.0 — GEPA Algorithm 2 instance-wise coverage selection.
   *
   * Builds a {@link ScoredVariant} per RUN prompt-version (its averaged
   * objective vector + its per-task-type composite map from {@link
   * ExperimentTracker.getPerKeyScoresByCategory}), then asks the
   * {@link GepaOptimizer#nextGeneration} coverage path to pick the survivor
   * that wins on the MOST DIFFERENT task types. Returns that survivor's prompt
   * text — the version to reflect the next challenger from.
   *
   * Returns `null` (→ caller reflects from the active prompt as before) when no
   * optimizer is wired or fewer than two versions carry per-task-type data —
   * coverage selection is meaningless with a single covered version. This is
   * the ONLINE adaptation: it selects the reflection PARENT among already-run
   * versions by their real per-task-type scores. (Per-challenger coverage of
   * unrun candidates needs the offline scored-pool path and is out of scope.)
   */
  private async selectCoverageParent(agentName: string): Promise<string | null> {
    if (!this.gepa) return null;

    const versions = await this.memory.getAllPromptVersions(agentName);
    const scored: ScoredVariant[] = [];
    for (const v of versions) {
      if (!v.promptText) continue;
      const metrics = await this.tracker.getAverageMetrics(agentName, v.version);
      if (Object.keys(metrics).length === 0) continue; // no runs for this version
      const perKeyScores = await this.tracker.getPerKeyScoresByCategory(agentName, v.version);
      if (Object.keys(perKeyScores).length === 0) continue;
      scored.push({ id: v.version, prompt: v.promptText, metrics, perKeyScores });
    }
    // Coverage selection needs ≥2 covered versions to be meaningful.
    if (scored.length < 2) return null;

    const survivors = this.gepa.nextGeneration(scored, {
      objectives: DARWIN_DEFAULT_OBJECTIVES as ReadonlyArray<ParetoObjective<Record<string, number>>>,
      maxCarry: 1,
      useCoverage: true,
    });
    const winner = survivors[0];
    return winner && winner.prompt.length > 0 ? winner.prompt : null;
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
    const skipPerfect = this.agent?.evolution?.skipPerfectFeedback === true;
    const perfectScore = this.perfectFeedbackScore();

    const feedbacks: ReflectiveFeedback[] = [];
    for (const exp of experiments) {
      if (feedbacks.length >= limit) break;
      if (exp.feedback?.report) {
        // v0.11.0: skip already-perfect runs (GEPA skip_perfect_score) so the
        // reflector concentrates on runs with an actual improvement gradient.
        // Skipped items do NOT count toward `limit`.
        if (skipPerfect && isPerfectScore(exp.feedback.score, perfectScore)) continue;
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

  /**
   * Pick a label for a new challenger that collides with NOTHING already in
   * the agent's version history.
   *
   * `nextVersion(active)` on its own is unsafe. When a challenger LOSES its
   * A/B test the incumbent stays active, so the next evolution cycle derives
   * the very same label again ("v1" active -> "v2", twice).
   * `savePromptVersion` upserts on (agentName, version), so the second
   * challenger overwrites the first one's row: its prompt text is gone, and
   * `createdAt`/`parentVersion` are left describing a prompt that no longer
   * exists. Every reader of the archive — merge-parent selection, Pareto
   * candidate selection, `darwin status` — then works off a fabricated
   * history of two versions instead of the N challengers actually tried.
   *
   * Numbering therefore continues above the HIGHEST version in history rather
   * than above the active one. When the active version already IS the highest
   * (the healthy case, and the only case the pre-existing suite constructs)
   * this returns exactly what `nextVersion(active)` returned.
   */
  private nextFreeVersion(active: string, existing: readonly PromptVersion[]): string {
    const taken = new Set(existing.map((v) => v.version));

    // Anchor on the highest "vN" in history; fall back to the active label so
    // agents whose history is entirely non-numeric behave as before.
    let anchor = active;
    let anchorInt = /^v\d+$/.test(active) ? this.versionInt(active) : -1;
    for (const v of existing) {
      if (!/^v\d+$/.test(v.version)) continue;
      const n = this.versionInt(v.version);
      if (n > anchorInt) {
        anchorInt = n;
        anchor = v.version;
      }
    }

    // Non-numeric labels fall through nextVersion's `${current}-v2` branch,
    // which can itself collide — walk until free so the upsert never clobbers.
    //
    // The bound is the history size, not an arbitrary constant: the candidate
    // sequence is injective. Numeric "vN" either advances, or (above 2^53,
    // where parseInt loses precision and can even step down once, e.g.
    // v…93 → v…92) reaches a label whose next step self-maps and enters the
    // append path; appended labels strictly grow in length. A sequence that
    // never revisits a label means each collision consumes a distinct member
    // of `taken`, so after `taken.size` collisions the next candidate MUST be
    // free — unconditionally.
    let candidate = this.progressStep(anchor);
    for (let i = 0; taken.has(candidate) && i <= taken.size; i++) {
      candidate = this.progressStep(candidate);
    }
    return candidate;
  }

  /**
   * `nextVersion`, hardened to ALWAYS return a different label than its
   * input. `nextVersion` alone self-maps once `parseInt` saturates at 2^53
   * (`nextVersion("v9007199254740992") === "v9007199254740992"`), which would
   * pin the probe walk on one taken candidate forever and hand the upsert a
   * colliding label — found by the round-2 cross-model review. On a
   * non-progressing step we switch to the append strategy, which strictly
   * grows and restores the collision-freedom proof without a carve-out.
   */
  private progressStep(current: string): string {
    const next = this.nextVersion(current);
    return next === current ? `${current}-v2` : next;
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
