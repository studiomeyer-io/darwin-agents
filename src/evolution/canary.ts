/**
 * Validate-by-Reproduce drift-detection canary (Phase 2 A5).
 *
 * The A/B safety gate guards prompt *quality* — it catches a new prompt version
 * that scores worse. But an agent can drift WITHOUT its quality score moving: a
 * model update, an MCP tool breaking, or a prompt evolution's side-effect can
 * change *how* the agent gets to the answer (different tools, more turns, more
 * errors) while the final score stays flat. Vadim Nicolai's production write-up
 * captures it: "the agent still sounds fluent, but the trajectory is longer and
 * the tool-calls more repetitive."
 *
 * This module compares an agent's recent execution *trajectories* against a
 * frozen baseline and flags behavioural drift. It is the read side of the
 * trajectory capture shipped in A1 (`ExecutionTrace`).
 *
 * ── Method (grounded in 2026 agent-eval practice) ──
 * Exact-hash equivalence is the wrong tool — LLM runs are non-deterministic, so
 * an exact trajectory hash drifts every single run. Instead we use the same
 * deterministic, tolerance-based metrics the field settled on (LangChain's
 * `agentevals`, Vertex AI trajectory metrics, Galileo):
 *
 *   1. **Unordered tool-set Jaccard** — `|A∩B| / |A∪B|` over tool *names*.
 *      Catches new/missing tools regardless of order. Primary signal.
 *   2. **Ordered tool-sequence similarity** — normalised Levenshtein over the
 *      tool-name sequence. Catches re-ordering / repetition.
 *   3. **Turn-count ratio** — `candidate.turns / baseline.turns`. A ratio > 1.5
 *      is the canonical "agent is grinding" symptom.
 *   4. **Error-rate delta** — error spikes are the most reliable tool-break tell.
 *
 * We deliberately do NOT compare tool *arguments* (LLM-variable → noise) or
 * output length (verbosity swings without drift). We keep zero hard deps: these
 * metrics are ~a dozen lines each, so `agentevals` stays an inspiration, not a
 * dependency — Darwin's whole point is a pure, injectable core.
 *
 * ── Sampling ──
 * A single failing run is noise, not drift. The canary needs a *pattern*:
 * evaluate several same-version runs and alert only when ≥ N of them drift
 * (default 2). Three candidate runs per week is the field's rule of thumb.
 *
 * ── Baseline staleness (the load-bearing footgun) ──
 * A baseline is only meaningful against runs of the SAME prompt version. When a
 * prompt evolves, the new version *should* behave differently — comparing it to
 * the old baseline would fire a false alarm on every intentional improvement.
 * `runCanaryOverExperiments` therefore baselines strictly within the active
 * prompt version: after an evolution the canary reports `insufficient-data`
 * (re-baseline in progress) rather than screaming drift.
 *
 * Everything here is pure and deterministic. Side-effects (loading experiments,
 * printing, alerting) live in the CLI command and in private cron wiring.
 */

import type { DarwinExperiment, ExecutionTrace } from '../types.js';

// ─── Trajectory signature extraction ───────────────────────

/** The ordered sequence of tool names exactly as they fired. */
export function toolSequence(trace: ExecutionTrace): string[] {
  // `?? []` is defensive against trajectories deserialised from older DB rows:
  // a NULL JSONB/TEXT column can yield null at runtime despite the non-optional
  // type, and a drift check must degrade gracefully rather than throw.
  return (trace.toolCalls ?? []).map((c) => c.tool);
}

/** The set of distinct tool names used (order-independent). */
export function toolSet(trace: ExecutionTrace): Set<string> {
  return new Set(toolSequence(trace));
}

/**
 * Error rate of a run: (tool-call errors + turn-level errors) normalised by the
 * turn count. Uses `max(1, turnCount)` so a zero-turn trace can't divide by zero.
 */
export function errorRate(trace: ExecutionTrace): number {
  const toolErrors = (trace.toolCalls ?? []).filter((c) => c.outcome === 'error').length;
  const turnErrors = (trace.errors ?? []).length;
  return (toolErrors + turnErrors) / Math.max(1, trace.turnCount ?? 0);
}

// ─── Pure similarity metrics ────────────────────────────────

/**
 * Jaccard similarity of two string sets: `|A∩B| / |A∪B|`.
 * 1 = identical, 0 = disjoint. Two empty sets are defined as 1 (both used no
 * tools → identical behaviour, not drift).
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Normalised Levenshtein similarity over two token sequences:
 * `1 - editDistance / max(len)`. 1 = identical order, 0 = fully different.
 * Two empty sequences are defined as 1.
 */
export function sequenceSimilarity(a: string[], b: string[]): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/** Iterative Levenshtein edit distance over token arrays. O(n·m) time, O(min) space. */
function levenshtein(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ─── Per-run comparison ─────────────────────────────────────

export interface CanaryThresholds {
  /** Min unordered tool-set Jaccard before flagging drift. Default 0.7. */
  minToolJaccard?: number;
  /** Min ordered tool-sequence similarity before flagging drift. Default 0.6. */
  minSequenceSimilarity?: number;
  /** Max turn-count ratio (candidate/baseline) before flagging drift. Default 1.5. */
  maxTurnRatio?: number;
  /** Max absolute increase in error rate before flagging drift. Default 0.2. */
  maxErrorRateIncrease?: number;
}

const DEFAULT_THRESHOLDS: Required<CanaryThresholds> = {
  minToolJaccard: 0.7,
  minSequenceSimilarity: 0.6,
  maxTurnRatio: 1.5,
  maxErrorRateIncrease: 0.2,
};

export interface TrajectoryComparison {
  /** Unordered tool-set Jaccard [0..1]. */
  toolJaccard: number;
  /** Ordered tool-sequence similarity [0..1]. */
  sequenceSimilarity: number;
  /** candidate.turnCount / max(1, baseline.turnCount). */
  turnRatio: number;
  /** candidate error-rate minus baseline error-rate. */
  errorRateDelta: number;
  /** True if any threshold tripped. */
  drifted: boolean;
  /** Human-readable list of the dimensions that tripped (empty when stable). */
  reasons: string[];
}

/**
 * Compare one candidate trajectory against a baseline across all four
 * dimensions. Pure. Missing thresholds fall back to {@link DEFAULT_THRESHOLDS}.
 */
export function compareTrajectory(
  candidate: ExecutionTrace,
  baseline: ExecutionTrace,
  thresholds: CanaryThresholds = {},
): TrajectoryComparison {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const toolJaccard = jaccard(toolSet(candidate), toolSet(baseline));
  const seqSim = sequenceSimilarity(toolSequence(candidate), toolSequence(baseline));
  const baseTurns = Math.max(1, baseline.turnCount ?? 0);
  const turnRatio = (candidate.turnCount ?? 0) / baseTurns;
  const errorRateDelta = errorRate(candidate) - errorRate(baseline);

  const reasons: string[] = [];
  if (toolJaccard < t.minToolJaccard) {
    reasons.push(`tool-set drift (Jaccard ${fmt(toolJaccard)} < ${t.minToolJaccard})`);
  }
  if (seqSim < t.minSequenceSimilarity) {
    reasons.push(`tool-order drift (similarity ${fmt(seqSim)} < ${t.minSequenceSimilarity})`);
  }
  if (turnRatio > t.maxTurnRatio) {
    reasons.push(`turn inflation (ratio ${fmt(turnRatio)} > ${t.maxTurnRatio})`);
  }
  if (errorRateDelta > t.maxErrorRateIncrease) {
    reasons.push(`error-rate spike (+${fmt(errorRateDelta)} > ${t.maxErrorRateIncrease})`);
  }

  return {
    toolJaccard,
    sequenceSimilarity: seqSim,
    turnRatio,
    errorRateDelta,
    drifted: reasons.length > 0,
    reasons,
  };
}

// ─── Canary-set evaluation (sampling) ───────────────────────

export interface CanaryOptions {
  thresholds?: CanaryThresholds;
  /**
   * How many drifted runs in the candidate set trigger an alert. Default 2 —
   * a single failing run is noise; drift is a pattern.
   */
  minDriftedToAlert?: number;
}

export interface CanaryResult {
  /** Number of candidate runs evaluated against the baseline. */
  total: number;
  /** How many candidates drifted on at least one dimension. */
  driftedCount: number;
  /** True when driftedCount >= minDriftedToAlert. */
  alert: boolean;
  /** Median tool-set Jaccard across candidates. */
  medianToolJaccard: number;
  /** Median turn ratio across candidates. */
  medianTurnRatio: number;
  /** Per-candidate comparisons, input order preserved. */
  comparisons: TrajectoryComparison[];
  /** De-duplicated union of every trip reason across drifted candidates. */
  reasons: string[];
}

/**
 * Evaluate a set of candidate trajectories against one baseline. Pure.
 * An empty candidate set yields `total: 0`, `alert: false`.
 */
export function evaluateCanary(
  candidates: ExecutionTrace[],
  baseline: ExecutionTrace,
  opts: CanaryOptions = {},
): CanaryResult {
  const minDriftedToAlert = clampPositiveInt(opts.minDriftedToAlert, 2);
  const comparisons = candidates.map((c) => compareTrajectory(c, baseline, opts.thresholds));

  const driftedCount = comparisons.filter((c) => c.drifted).length;
  const reasons = Array.from(
    new Set(comparisons.filter((c) => c.drifted).flatMap((c) => c.reasons)),
  );

  return {
    total: comparisons.length,
    driftedCount,
    alert: driftedCount >= minDriftedToAlert,
    medianToolJaccard: median(comparisons.map((c) => c.toolJaccard)),
    medianTurnRatio: median(comparisons.map((c) => c.turnRatio)),
    comparisons,
    reasons,
  };
}

// ─── Experiment-level orchestration ─────────────────────────

export type CanaryStatus = 'ok' | 'drift' | 'insufficient-data' | 'no-trajectory';

export interface CanaryReport {
  agentName: string;
  /** The prompt version the canary baselined against (the active one), or null. */
  promptVersion: string | null;
  /** Experiment id used as the frozen baseline, or null. */
  baselineId: string | null;
  /** Candidate runs evaluated (excludes the baseline). */
  evaluated: number;
  /** Detailed result, or null when there wasn't enough data to run. */
  result: CanaryResult | null;
  status: CanaryStatus;
  /** One-line operator-facing summary. */
  message: string;
}

export interface RunCanaryOptions extends CanaryOptions {
  /**
   * Minimum candidate runs (excluding the baseline) required before the canary
   * produces a verdict. Below this it reports `insufficient-data`. Default 3.
   */
  minCandidates?: number;
}

/**
 * Run a canary over an agent's stored experiments. Pure: takes the experiments
 * and the active prompt version, returns a report. The caller supplies the data
 * (e.g. `memory.loadExperiments` + `memory.getActivePrompt`).
 *
 * Baseline policy: among experiments carrying a trajectory for the ACTIVE prompt
 * version, the earliest (by `startedAt`) is the frozen reference; every later
 * same-version run is a candidate. Restricting to the active version is what
 * prevents false alarms right after an intentional prompt evolution.
 */
export function runCanaryOverExperiments(
  agentName: string,
  experiments: DarwinExperiment[],
  activeVersion: string | null,
  opts: RunCanaryOptions = {},
): CanaryReport {
  const minCandidates = clampPositiveInt(opts.minCandidates, 3);

  // Only v1 trajectories are comparable. The ExecutionTrace forward-compat
  // contract (types.ts) requires consumers to skip unknown schema versions
  // rather than mis-score them, so a future v2 trace is treated as not-capturable.
  const withTrace = experiments.filter(
    (e): e is DarwinExperiment & { trajectory: ExecutionTrace } =>
      e.trajectory != null && e.trajectory.version === 1,
  );

  if (withTrace.length === 0) {
    return report(agentName, activeVersion, null, 0, null, 'no-trajectory',
      'No comparable (v1) trajectories captured yet — enable trace capture to run the canary.');
  }

  if (!activeVersion) {
    return report(agentName, activeVersion, null, 0, null, 'insufficient-data',
      'No active prompt version resolved for this agent.');
  }

  // Baseline strictly within the active version (staleness guard).
  const sameVersion = withTrace
    .filter((e) => e.promptVersion === activeVersion)
    // Lexicographic order on ISO-8601 strings == chronological, without
    // locale-dependent collation surprises (assumes consistent UTC timestamps).
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));

  if (sameVersion.length === 0) {
    return report(agentName, activeVersion, null, 0, null, 'insufficient-data',
      `Active version ${activeVersion} has no trajectories yet (${withTrace.length} on older versions) — re-baseline in progress.`);
  }

  const [baseline, ...candidates] = sameVersion;

  if (candidates.length < minCandidates) {
    return report(agentName, activeVersion, baseline.id, candidates.length, null, 'insufficient-data',
      `Only ${candidates.length} candidate run(s) on ${activeVersion}; need ${minCandidates} for a verdict.`);
  }

  const result = evaluateCanary(
    candidates.map((c) => c.trajectory),
    baseline.trajectory,
    opts,
  );

  const status: CanaryStatus = result.alert ? 'drift' : 'ok';
  const message = result.alert
    ? `Behavioural drift on ${agentName}/${activeVersion}: ${result.driftedCount}/${result.total} runs drifted — ${result.reasons.join('; ')}`
    : `Stable: ${result.total} runs on ${activeVersion}, ${result.driftedCount} drifted (median tool-Jaccard ${fmt(result.medianToolJaccard)}).`;

  return report(agentName, activeVersion, baseline.id, candidates.length, result, status, message);
}

// ─── Small pure helpers ─────────────────────────────────────

function report(
  agentName: string,
  promptVersion: string | null,
  baselineId: string | null,
  evaluated: number,
  result: CanaryResult | null,
  status: CanaryStatus,
  message: string,
): CanaryReport {
  return { agentName, promptVersion, baselineId, evaluated, result, status, message };
}

/** Median of a numeric array. Empty array → 0. Does not mutate the input. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Coerce to a positive integer, falling back to `fallback` for NaN/≤0/non-finite. */
function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n > 0 ? n : fallback;
}

/** Format a ratio/score to 2 dp for messages. */
function fmt(n: number): string {
  return n.toFixed(2);
}
