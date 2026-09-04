/**
 * Darwin — Core Types
 *
 * Self-Evolving AI Agent Framework.
 * Types for agents, experiments, memory, and evolution.
 */

// ─── Agent ──────────────────────────────────────────

export interface AgentDefinition {
  /** Unique agent name (lowercase, no spaces) */
  name: string;
  /** Human-readable role description */
  role: string;
  /** What this agent does */
  description: string;
  /** System prompt — the core of what Darwin evolves */
  systemPrompt: string;
  /** MCP servers this agent needs */
  mcp?: string[];
  /** Built-in tools to allow (Read, Glob, Grep, etc.) */
  tools?: string[];
  /** Max conversation turns per run */
  maxTurns?: number;
  /** LLM model to use */
  model?: string;
  /** Agent type: 'llm' (default) or 'system' (no LLM, pure code) */
  type?: 'llm' | 'system';
  /** System agent handler (only for type: 'system') */
  handler?: (ctx: SystemAgentContext) => Promise<Record<string, unknown>>;
  /** Darwin evolution config (opt-in) */
  evolution?: EvolutionConfig;
}

export interface SystemAgentContext {
  memory: MemoryProvider;
  config: DarwinConfig;
}

export interface EvolutionConfig {
  /** Enable evolution for this agent */
  enabled: boolean;
  /** Agent to use as evaluator (default: 'critic') */
  evaluator?: string;
  /** Custom metric weights */
  metrics?: MetricWeights;
  /**
   * v0.7.0 — Strip markdown from this agent's output before the multi-critic
   * judges it, so the score reflects CONTENT not FORMAT (LLM judges carry a
   * documented style bias toward markdown-formatted answers). Turn ON for
   * prose agents; leave OFF when the output format itself is the deliverable.
   * Default `false`.
   */
  normalizeForJudging?: boolean;
  /** Minimum runs before first optimization */
  minRuns?: number;
  /**
   * Wall-clock budget for a single A/B test, in days. When a test has been
   * running longer than this WITHOUT reaching `minRuns` on both arms, it is
   * closed as inconclusive: the incumbent (A) stays active and the slot is
   * freed so a later cycle can try a different challenger.
   *
   * This exists because `minRuns` is a SAMPLE budget with no notion of
   * throughput. `computeDynamicMinRuns` raises the bar to 30 when scores
   * cluster tightly (a throughput heuristic, not a power calculation: see its
   * docstring), and an agent that runs a few times per week needs months of
   * wall-clock to pay that, during which it cannot evolve at all. Lowering
   * `minRuns` instead would trade the deadlock for promotions on noise, which
   * is worse: measured judge variance (±1 on a 10-point scale) dwarfs the real
   * evolution lift (~+0.1 to +0.2).
   *
   * A timeout therefore NEVER promotes the challenger — inconclusive evidence
   * is not evidence. Unset (the default) means tests run until they conclude
   * on their own, exactly as before.
   */
  maxTestDays?: number;
  /**
   * v0.17.0: hold every generated challenger for a human decision before it
   * enters the A/B test.
   *
   * Off by default, which is the behaviour every release up to v0.16 had and
   * which the README listed under Known Limitations: "Prompt mutations go
   * directly to A/B testing. Telegram notifications inform you, but there's no
   * approval gate before testing starts."
   *
   * When on, {@link DarwinLoop} still generates the challenger and still
   * persists it as a real {@link PromptVersion} (so it can be read, diffed and
   * judged), but instead of opening an A/B test it records a
   * {@link PendingApproval} and stops. `darwin approve <agent>` opens exactly
   * the test that was planned; `darwin approve <agent> --reject` frees the
   * slot so the next cycle can try a different challenger.
   *
   * The gate sits BEFORE the test, not before activation: a challenger that
   * runs is a challenger that costs tokens and touches real traffic on half
   * the runs, so that is the point where a human veto is worth anything.
   */
  requireApproval?: boolean;
  /**
   * v0.17.0: wall-clock budget for a pending approval, in days. An untouched
   * proposal older than this is auto-REJECTED on the next cycle, freeing the
   * slot.
   *
   * Deliberately auto-reject and never auto-approve, for the same reason
   * {@link maxTestDays} never promotes on timeout: absence of a decision is
   * not a decision. Without a budget a forgotten proposal stops the agent
   * evolving forever and does it silently, which is the failure mode the
   * timeout exists to prevent, not a safety property.
   *
   * Unset (the default) means a proposal waits indefinitely, and `darwin status`
   * shows it either way.
   */
  approvalTimeoutDays?: number;
  /**
   * v0.18.0: how many past HUMAN rejections (with a reason) are shown to the
   * optimizer when it generates the next challenger, most recent first.
   *
   * The refusal to re-propose a rejected TEXT is unconditional and needs no
   * knob: it is a correctness property, not a preference. This number only
   * controls how much of the reviewer's reasoning is quoted back to the model,
   * because that costs context. `0` turns the quoting off and leaves the
   * refusal in place. Default 5.
   */
  rejectionNoteLimit?: number;
  /**
   * v0.14.0 — Per-agent safety-gate thresholds, merged over
   * {@link DEFAULT_SAFETY}. This is the config-level door to the v0.6/v0.7
   * statistical rigor knobs ({@link SafetyThresholds.requireConfidence},
   * `confidenceMethod: 'msprt' | 'hoeffding' | 'eb'`, `maxRegression`, …). Before
   * v0.14 they were reachable ONLY by constructing a `SafetyGate` by hand and
   * wiring your own `DarwinLoop`, so neither the CLI nor
   * {@link buildEvolutionLoop} consumers (agent fleets) could turn them on.
   * Unset fields keep their {@link DEFAULT_SAFETY} value; omit the block for
   * byte-for-byte pre-v0.14 behaviour.
   */
  safety?: Partial<SafetyThresholds>;
  /** Minimum output length to save (default: 2000). Lower for short-form agents like marketing. */
  minOutputLength?: number;
  /**
   * v0.7.0 — How many recent critic-feedback reports to feed the optimizer /
   * GEPA reflector per evolution cycle. Was hard-coded to 5; the v0.6 roadmap
   * raised the default to 15 so reflection sees more of the recent behaviour
   * (GEPA reflects better with a richer feedback window). Default 15.
   */
  feedbackWindow?: number;
  /**
   * v0.7.0 — When set (and smaller than `feedbackWindow`), the GEPA reflector
   * reflects on an epoch-shuffled MINIBATCH of this many feedbacks drawn from
   * the window, rotating which subset is used each cycle (GEPA's
   * `reflection_minibatch_size` + epoch-shuffled sampler, adapted to the
   * online loop). Keeps each reflection prompt focused while still covering
   * the whole window across cycles. Omit to reflect on the full window.
   */
  reflectionMinibatchSize?: number;
  /**
   * v0.6.0 — Opt into the GEPA-style reflective optimizer for variant
   * generation inside the evolution loop. When `true` AND a `GepaOptimizer`
   * is wired into the loop, the next-prompt mutation is produced by the
   * Reflector (rich text feedback → smallest-possible-edit) instead of the
   * legacy stats-meta-prompt optimizer. Falls back to the legacy optimizer
   * on cold start (no critic feedback yet) or if the reflective mutation
   * fails the alignment guard. Default `false` — legacy behaviour unchanged.
   */
  useGepa?: boolean;
  /**
   * v0.6.0 — Model id for the GEPA reflection LM (e.g. `claude-opus-4-8`).
   * GEPA's published guidance and the Decagon production ablation both find
   * the reflection model is the leverage point — a weak reflector can leave
   * the prompt unchanged. Set this to a STRONGER model than the task model.
   * When omitted, reflection falls back to the agent's own model and the
   * runner emits a warning. Only consulted when `useGepa` is `true`.
   */
  reflectionModel?: string;
  /**
   * v0.6.0 — Opt into a multi-objective Pareto-dominance guard at A/B
   * activation. When `true`, a challenger that wins on the scalar composite
   * is activated ONLY if it is a strict Pareto improvement over the incumbent
   * across the full objective vector (quality / sources / length / duration) —
   * better-or-equal on every objective, strictly better on at least one. A
   * scalar-composite win that is not a Pareto improvement means the challenger
   * traded a regression on some objective for its win, and is rejected.
   *
   * Deliberate design note: the gate evaluates the FIXED, unweighted
   * `DARWIN_DEFAULT_OBJECTIVES` vector — NOT the agent's custom
   * `evolution.metrics` weights. It is an independent, second multi-objective
   * opinion that sits alongside the weighted scalar composite, so an agent
   * with custom weights can still see a challenger rejected for regressing an
   * objective it had down-weighted. That is intentional (no silent regressions
   * on any raw objective); leave `paretoGate` off if you only care about the
   * weighted composite.
   *
   * Default `false` — single-objective composite gating unchanged.
   */
  paretoGate?: boolean;
  /**
   * v0.7.0 — Opt into GEPA system-aware MERGE as a challenger source (paper
   * Appendix-D, ~+5% lift). Only consulted when `useGepa` is also `true` AND a
   * `GepaOptimizer` is wired into the loop. On every `mergeEveryK`-th evolution
   * cycle, instead of a reflective mutation the loop merges the two best
   * Pareto-front prompt versions from this agent's history into one challenger
   * (combining their complementary strengths), then A/B-tests it like any other
   * variant. Falls back to reflective generation when fewer than two scored
   * versions exist, when the Pareto front has fewer than two members, or on any
   * merge error. The merged prompt runs the SAME alignment guard. Default
   * `false` — merge never fires unless opted in.
   */
  useMerge?: boolean;
  /**
   * v0.7.0 — Merge cadence: attempt a system-aware merge on every K-th
   * evolution cycle (the cycle index is the active prompt version number).
   * GEPA runs merge roughly every 3–5 generations. Only consulted when
   * `useMerge` is `true`. Default 3, clamped to ≥ 1.
   */
  mergeEveryK?: number;
  /**
   * v0.7.0 — Relative tolerance for the {@link paretoGate} (only consulted
   * when `paretoGate` is `true`). With strict Pareto dominance (ε = 0, the
   * default) a challenger is rejected if it regresses on ANY objective by
   * even a microscopic amount — so a "+12% quality, 0.3% slower" challenger
   * loses. A small `paretoEpsilon` (e.g. `0.02` = 2%) lets a challenger
   * regress by up to that fraction of an objective's magnitude and still be
   * accepted, provided it is strictly better on at least one objective. The
   * tolerance is per-objective-relative, so it stays scale-safe across mixed
   * units. Default `0` (strict, byte-for-byte the v0.6.0 gate).
   */
  paretoEpsilon?: number;
  /**
   * v0.7.0 — Opt into GEPA Algorithm 2 instance-wise coverage selection in the
   * evolution loop. Only consulted when `useGepa` is also `true` AND a
   * `GepaOptimizer` is wired in. When `true`, the loop selects the prompt
   * version it reflects the next challenger from by per-task-type coverage
   * breadth (`GepaOptimizer.nextGeneration` with `useCoverage`), preferring the
   * version that performs best across the MOST DIFFERENT task types rather than
   * the single highest-average version — preserving the diversity GEPA's
   * reflection loop depends on. Falls back to the plain reflective path when
   * fewer than two prompt versions have per-task-type data. Default `false` —
   * the single-challenger reflective path is unchanged.
   */
  useCoverage?: boolean;
  /**
   * v0.10.0 — Strategy for picking WHICH prompt version the next challenger
   * is derived from (GEPA `candidate_selection_strategy` parity). Only
   * consulted when `useGepa` is `true` AND a `GepaOptimizer` is wired in:
   *
   *   - `'active'` (default): reflect from the currently-active prompt —
   *     byte-for-byte the historical behaviour.
   *   - `'best'`: reflect from the highest scalarised-composite version in
   *     the history (GEPA `current_best`).
   *   - `'pareto'`: reflect from a uniformly-sampled member of the version
   *     history's Pareto front (GEPA default) — keeps lineages alive that
   *     win on different objectives instead of hill-climbing one line.
   *   - `'epsilon-greedy'`: with probability {@link explorationEpsilon} pick
   *     a random version (explore), otherwise the best (exploit).
   *
   * Precedence: `useCoverage` (GEPA Algorithm 2, the more specific
   * selector) wins when it finds a coverage parent; `candidateSelection`
   * is the fallback selector for that cycle. Versions without any run
   * metrics are never candidates. Default `'active'`.
   */
  candidateSelection?: 'active' | 'best' | 'pareto' | 'epsilon-greedy';
  /**
   * v0.10.0 — Exploration probability for
   * `candidateSelection: 'epsilon-greedy'` (clamped to [0, 1], non-finite
   * → default). Default `0.1`.
   */
  explorationEpsilon?: number;
  /**
   * v0.10.0 — Opt into SIMBA-style DEMO INJECTION as a challenger source.
   * On every {@link demoEveryK}-th evolution cycle, instead of an LLM
   * mutation the loop appends (or refreshes) a marker-delimited
   * "Demonstrations" section built from the agent's own highest-scoring
   * past runs (DSPy SIMBA's `append_a_demo` strategy, adapted to the
   * online loop). The demo-augmented prompt is a normal challenger: same
   * alignment guard, same A/B test, same safety gate — if demos don't
   * help, the incumbent wins. Zero LLM cost (pure selection + rendering).
   *
   * Works WITHOUT `useGepa` (no reflector involved). When both `useDemos`
   * and `useMerge` would fire on the same cycle, demos win — staggering
   * `demoEveryK` / `mergeEveryK` (e.g. 4 / 3) reduces the overlap to the
   * LCM cycles (every 12th with 4/3), where the demos-win precedence
   * resolves the collision. Default `false`.
   */
  useDemos?: boolean;
  /**
   * v0.10.0 — Demo-injection cadence: attempt a demo challenger on every
   * K-th evolution cycle (cycle index = active prompt version integer).
   * Only consulted when `useDemos` is `true`. Default 4, clamped ≥ 1.
   */
  demoEveryK?: number;
  /**
   * v0.10.0 — Maximum demonstrations to inject (default 2). Kept
   * deliberately below SIMBA's per-predictor 4 because the online loop
   * appends demos to one system prompt and prompt length correlates
   * negatively with reliability (documented v2-prompt incident).
   */
  maxDemos?: number;
  /**
   * v0.10.0 — Minimum critic score (1-10) for a past run to qualify as a
   * demonstration. Default 8 — mirrors the closed-loop feedback convention
   * where ≥ 8 marks a high-quality pattern.
   */
  demoScoreThreshold?: number;
  /**
   * v0.11.0 — Skip already-PERFECT past runs when assembling the critic
   * feedback the optimizer / GEPA reflector learns from. Adapted from GEPA's
   * `skip_perfect_score`: upstream skips the whole reflection iteration when an
   * entire sampled minibatch is perfect; Darwin generalizes it to per-report
   * filtering because the critic scores on real runs are already paid for (no
   * eval-budget reason to keep "nothing to fix" reports in the pool). A run
   * scored at or above {@link perfectFeedbackScore} carries no improvement
   * gradient, so dropping it concentrates the feedback on runs that went wrong.
   * When `true`, such reports are dropped from BOTH the reflective feedback and
   * the legacy optimizer feedback. If EVERY recent report is perfect the filter
   * yields an empty feedback set — the reflective path then falls back to the
   * legacy stats optimizer and the legacy path proceeds on aggregate stats as
   * it did before feedback reports existed (so the loop keeps exploring; it
   * does not, like upstream, leave a perfect candidate untouched). Default
   * `false` — every report is included, byte-for-byte the historical behaviour.
   */
  skipPerfectFeedback?: boolean;
  /**
   * v0.11.0 — Critic score (1-10) at or above which a run counts as PERFECT
   * for {@link skipPerfectFeedback}. Only consulted when `skipPerfectFeedback`
   * is `true`. Default 10 (only a literal top score is skipped); lower it
   * (e.g. 9) to also skip near-perfect runs. Non-finite / out-of-range values
   * fall back to the default.
   */
  perfectFeedbackScore?: number;
  /**
   * v0.11.0 — Lifetime cap on how many merge-derived challengers this agent
   * may produce. Adapted from GEPA's `max_merge_invocations` (default 5
   * upstream, per-`optimize()`-run); Darwin mirrors the value but makes the cap
   * a per-agent LIFETIME budget persisted in {@link
   * DarwinState.mergeInvocations}, because a process-scoped counter would reset
   * every cron tick and never trigger. Only consulted when `useMerge` is
   * `true`. The GEPA paper leaves merge-budget allocation as open research; the
   * reason Darwin needs a cap is its own: an uncapped `mergeEveryK` cadence
   * would merge forever, so late in an agent's life merges would crowd out the
   * reflective exploration that finds genuinely new strategies. Once the cap is
   * reached the merge branch is skipped and the loop falls back to the
   * reflective path for the rest of the agent's life (unlike upstream, the
   * budget does not re-arm — a future `--reset`-clears-it option is a candidate).
   * The count is the number of merge challengers actually CREATED (a merge that
   * failed the alignment guard is not counted — it consumed no A/B slot), and
   * it is written ONLY when a cap is set, so an uncapped `useMerge` agent's
   * state is unchanged from v0.10. Default `undefined` — uncapped, byte-for-byte
   * the v0.10 behaviour; set it to 5 to match GEPA's protective default.
   */
  maxMergeInvocations?: number;
}

// ─── Config ─────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface DarwinConfig {
  /** LLM provider */
  provider: 'claude-cli' | 'anthropic-api' | 'openai' | 'ollama';
  /** Memory backend */
  memory: 'sqlite' | 'postgres' | 'custom';
  /** Postgres connection string (only for memory: 'postgres') */
  postgresUrl?: string;
  /** Custom memory provider (only for memory: 'custom') */
  memoryProvider?: MemoryProvider;
  /** MCP server configurations */
  mcp?: Record<string, McpServerConfig>;
  /** Global evolution settings */
  evolution?: {
    enabled: boolean;
    minRuns?: number;
    safetyGate?: boolean;
  };
  /** Working directory for .darwin/ data */
  dataDir?: string;
}

// ─── Experiment ─────────────────────────────────────

export interface DarwinMetrics {
  /** Quality score from evaluator (1-10) */
  qualityScore: number | null;
  /** Number of sources cited */
  sourceCount: number;
  /** Character length of output */
  outputLength: number;
  /** Errors encountered */
  errorCount: number;
  /** Duration in milliseconds */
  durationMs: number;
}

export interface DarwinExperiment {
  /** Unique ID: exp-{agent}-{YYYY-MM-DD}-{NNN} */
  id: string;
  /** Agent name */
  agentName: string;
  /** Prompt version used */
  promptVersion: string;
  /** The task given */
  task: string;
  /** Task category (tech, webdesign, market, etc.) */
  taskType: string;
  /** ISO timestamp of start */
  startedAt: string;
  /** ISO timestamp of completion */
  completedAt: string;
  /** Whether the agent completed successfully */
  success: boolean;
  /** Measured metrics */
  metrics: DarwinMetrics;
  /** Critic feedback */
  feedback?: ExperimentFeedback;
  /** Raw agent output */
  output?: string;
  /**
   * Optional execution trajectory captured during the run.
   * Backward-compatible: existing rows have `trajectory: undefined`.
   * Consumed by GEPA-style reflective optimizers (Phase 2 A2) and
   * by failure-diagnostic tooling (Phase 2 A5).
   */
  trajectory?: ExecutionTrace;
}

// ─── Execution Trace (v0.5 — A1 Phase 2) ────────────

/**
 * Token-usage aggregate for a single LLM invocation.
 *
 * Aligned with OTEL GenAI semantic conventions 2026:
 *   - `gen_ai.usage.input_tokens`
 *   - `gen_ai.usage.output_tokens`
 *   - `gen_ai.usage.cache_read.input_tokens`
 *
 * Fields are optional — providers that don't surface tokens (e.g. local
 * Ollama runs) leave them undefined. Downstream cost-attribution code
 * MUST handle undefined as "unknown", not zero.
 */
export interface TraceTokenUsage {
  /** Tokens consumed for prompt (input). OTEL: `gen_ai.usage.input_tokens` */
  inputTokens?: number;
  /** Tokens emitted as completion (output). OTEL: `gen_ai.usage.output_tokens` */
  outputTokens?: number;
  /** Cache-read tokens (e.g. Anthropic prompt-caching hits). OTEL: `gen_ai.usage.cache_read.input_tokens` */
  cacheReadTokens?: number;
  /** Cache-creation tokens (Anthropic prompt-caching write). No standard OTEL name yet. */
  cacheCreationTokens?: number;
}

/**
 * Single tool invocation captured during agent execution.
 * Maps cleanly to OTEL `tool` spans (name/attributes/duration/status).
 *
 * Industry-aligned shape (Braintrust + Langfuse + Strands SDK + OTEL GenAI 2026):
 * captures enough to diagnose hallucinated args, silent retry loops,
 * and tool-error patterns without leaking full payloads (privacy via
 * `resultSummary` truncation).
 */
export interface TraceToolCall {
  /**
   * SDK-issued correlation id (Anthropic SDK `tool_use.id`, OpenAI
   * `tool_call.id`). OTEL: `gen_ai.tool.call.id`. Optional because
   * pre-A1.1 captures don't have it; populate from the SDK whenever
   * available so parallel tool calls in the same turn are distinguishable.
   */
  id?: string;
  /** Tool name (e.g. 'mcp__mcp-nex__nex_search', 'Read', 'Bash') */
  tool: string;
  /** Tool arguments (may be truncated by capturer for privacy/size) */
  args?: Record<string, unknown>;
  /** Truncated tool output (max ~2000 chars by default). null if not captured. */
  resultSummary?: string | null;
  /** Did the call succeed or error? */
  outcome: 'success' | 'error';
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Retries on this call (e.g. transient MCP failures) */
  retryCount?: number;
  /** Error classification if outcome === 'error' (e.g. 'timeout', 'protocol', 'transport') */
  errorClass?: string;
  /** Short human-readable error message if outcome === 'error' (max ~200 chars) */
  errorMessage?: string;
  /** Which agent turn this call fired in (1-indexed) */
  turn: number;
}

/**
 * Per-turn aggregate of agent reasoning.
 * Pure counter — no PII, no payloads. Used for plan-drift detection.
 */
export interface TraceTurnError {
  /** Error classification (e.g. 'spawn_failed', 'timeout', 'parse_error') */
  class: string;
  /** Short error message (max ~200 chars) */
  message: string;
  /** Which agent turn (1-indexed) */
  turn: number;
}

/**
 * Execution trajectory of a single agent run.
 *
 * Captured opt-in via capturer hook; stored as JSONB (Postgres) or TEXT (SQLite).
 * Schema is versioned (`version: 1`) so future trajectory upgrades can coexist
 * with old rows. Consumers MUST handle `version !== 1` by ignoring unknown fields.
 *
 * Designed for three downstream consumers:
 *   - GEPA-style reflective optimizer (A2): reasoning + tool calls + outputs + token cost
 *   - Held-out eval-set diff (A3): trajectory shape comparison
 *   - Drift-detection canary (A5): trajectory hash equivalence over time
 */
export interface ExecutionTrace {
  /** Schema version for forward-compat. Always 1 in this release. */
  version: 1;
  /** All tool invocations in the order they fired */
  toolCalls: TraceToolCall[];
  /**
   * Count of substantial assistant text blocks (>50 chars). Surfaces
   * how often the model emitted prose vs went straight to tool calls.
   * NOTE: this is NOT a thinking-block counter — it counts ANY text
   * output. A 3000-word report split across 10 blocks reports 10, not 1.
   * Renamed from `reasoningSteps` after R1 review for accuracy.
   * V2 will add a proper `reasoningBlocks: ReasoningBlock[]` typed sequence
   * for GEPA per-decision reasoning attribution.
   */
  textBlockCount: number;
  /** Total agent turns (LLM round-trips) */
  turnCount: number;
  /** Subset of toolCalls that hit MCP servers (vs built-in tools like Read/Bash) */
  mcpInvocations: number;
  /** Turn-level errors not captured per tool call (e.g. parse errors, child-process crashes) */
  errors: TraceTurnError[];
  /**
   * Aggregated token usage across the whole run. Sum of per-turn usage
   * reported by the LLM provider. Fields are optional — providers without
   * usage reporting leave them undefined. OTEL: `gen_ai.aggregated_usage.*`.
   */
  tokenUsage?: TraceTokenUsage;
  /** ISO timestamp when capture started (start of run) */
  capturedAt: string;
}

export interface ExperimentFeedback {
  /** Critic score (1-10) */
  score: number;
  /** Critic report text */
  report: string;
  /** Who evaluated (agent name or 'user') */
  evaluator: string;
}

// ─── Prompt Version ─────────────────────────────────

export interface PromptVersion {
  /** Version identifier: v1, v2, ... */
  version: string;
  /** Agent name */
  agentName: string;
  /** The full prompt text */
  promptText: string;
  /** ISO timestamp of creation */
  createdAt: string;
  /** Parent version (null for initial) */
  parentVersion: string | null;
  /** Why this version was created */
  changeReason: string;
  /** Whether this is the active version */
  active: boolean;
  /** Aggregated stats */
  stats: PromptVersionStats;
}

export interface PromptVersionStats {
  totalRuns: number;
  avgQuality: number;
  avgDuration: number;
  successRate: number;
  avgSourceCount: number;
}

// ─── Evolution State ────────────────────────────────

export interface ABTest {
  versionA: string;
  versionB: string;
  runsA: number;
  runsB: number;
  /** Incomplete/failed runs per version (not counted in runsA/runsB) */
  failsA: number;
  failsB: number;
  minRuns: number;
  startedAt: string;
  /**
   * v0.13.1 — the wall-clock budget (days) SNAPSHOTTED when the test started.
   * A deadline is a property of the test, not of whoever happens to evaluate
   * it: without the snapshot, a test started via a one-off
   * `darwin run … --max-test-days 7` silently lost its budget on the next
   * plain invocation (expiry read the transient per-invocation config).
   * Absent on tests started before v0.13.1 or without a budget — evaluation
   * falls back to the agent's current `evolution.maxTestDays`.
   */
  maxTestDays?: number;
}

/**
 * v0.17.0: a challenger that has been generated and persisted but is waiting
 * for a human decision before its A/B test starts. Written only when
 * {@link EvolutionConfig.requireApproval} is on.
 *
 * Every field the test would have carried is SNAPSHOTTED here rather than
 * recomputed at approval time, for the same reason `ABTest.maxTestDays` is
 * snapshotted (v0.13.1): the human approves the test that was described to
 * them. `minRuns` in particular comes from `computeDynamicMinRuns` over the
 * experiment history AT PROPOSAL TIME; recomputing it on approval would open
 * a test with a different bar than the one shown in the notification.
 */
export interface PendingApproval {
  /** The incumbent this challenger was generated against. */
  versionA: string;
  /** The generated challenger, already saved as an inactive PromptVersion. */
  versionB: string;
  /** Sample budget per arm, snapshotted at proposal time. */
  minRuns: number;
  /** Wall-clock budget for the A/B test itself, snapshotted at proposal time. */
  maxTestDays?: number;
  /** ISO timestamp of the proposal: the clock the approval timeout runs on. */
  proposedAt: string;
  /**
   * Wall-clock budget for THIS proposal in days, snapshotted the same way
   * `ABTest.maxTestDays` is, so a one-off CLI value does not evaporate on the
   * next plain invocation.
   */
  approvalTimeoutDays?: number;
  /** Same human-readable reason the A/B test would have carried. */
  changeReason: string;
  /** Which generator produced the challenger. */
  generatedBy: 'gepa' | 'merge' | 'demos' | 'legacy';
}

/**
 * v0.18.0: one challenger a human (or a lapsed approval budget) turned down,
 * remembered by its TEXT so the same proposal is not put in front of the same
 * person twice.
 *
 * Up to v0.17 Darwin remembered rejected version LABELS only. The demo path
 * builds its challenger deterministically from the active prompt plus the
 * agent's best runs, and rejecting does not change the active prompt, so a
 * rejected demo challenger returned on the next cadence cycle with a new label
 * and identical text.
 */
export interface RejectedChallenger {
  /** Label of the rejected version, e.g. "v4". Labels are never reused. */
  version: string;
  /** The incumbent the rejected challenger was measured against. */
  versionA: string;
  /**
   * SHA-256 of the whitespace-normalised prompt text (see
   * `evolution/rejections.ts`). Absent when the prompt row could not be read
   * at rejection time: such an entry still carries a reason but can never
   * match, because a fingerprint that is not there must not block anything.
   */
  textHash?: string;
  /** ISO timestamp of the rejection. */
  rejectedAt: string;
  /** Who said no. `timeout` means the approval budget lapsed. */
  rejectedBy: 'human' | 'timeout';
  /**
   * The reviewer's `--reason`, when they gave one. Only human reasons reach
   * the optimizers: a timeout says nothing about the text.
   */
  reason?: string;
  /** Which generator produced the rejected challenger. */
  generatedBy: 'gepa' | 'merge' | 'demos' | 'legacy';
}

export interface DarwinState {
  /** Active prompt version per agent */
  activeVersions: Record<string, string>;
  /** Active A/B test per agent */
  abTests: Record<string, ABTest | null>;
  /** Last known-good version per agent */
  lastKnownGood: Record<string, string>;
  /** Consecutive failure count per agent */
  consecutiveFailures: Record<string, number>;
  /** Total experiment count per agent */
  experimentCounts: Record<string, number>;
  /**
   * v0.11.0 — Lifetime count of merge-derived challengers created per agent,
   * used to enforce {@link EvolutionConfig.maxMergeInvocations} (GEPA's
   * `max_merge_invocations`). Optional + read defensively (`?? 0`): state
   * rows written before this field existed simply lack the key.
   */
  mergeInvocations?: Record<string, number>;
  /**
   * Persisted enable/disable override per agent, set by `darwin evolve
   * <agent> --enable|--disable`. When an entry exists it WINS over the
   * agent definition's static `evolution.enabled` default, so the flag
   * survives across processes (the in-memory agent singleton does not).
   * Optional + read defensively: state rows written before this field
   * existed simply lack the key, in which case the static default applies.
   */
  evolutionEnabled?: Record<string, boolean>;
  /**
   * Persisted overrides for the advanced evolution-config flags (the keys in
   * `OVERRIDE_KEYS`, enabled-state.ts — kept as the single list so this comment
   * never drifts as new flags are added), set by `darwin evolve <agent>
   * --gepa|--merge|…`. Merged OVER the agent definition's static `evolution`
   * block when resolving the effective config, so these knobs are reachable
   * from the CLI and survive process exit. Optional + read defensively (older
   * state rows lack it).
   */
  evolutionConfigOverrides?: Record<string, EvolutionConfigOverride>;
  /**
   * v0.17.0: challenger awaiting a human decision, per agent. `null` or a
   * missing key both mean "nothing pending"; state rows written before this
   * field existed simply lack it, so old installs behave exactly as before.
   *
   * Mutually exclusive with `abTests[agent]` by construction: a proposal is
   * only ever written when no test is open, and approving swaps one for the
   * other inside a single `updateState` callback.
   */
  pendingApprovals?: Record<string, PendingApproval | null>;
  /**
   * v0.18.0: challengers a human turned down, per agent, oldest first and
   * capped at `REJECTION_MEMORY_CAP` (evolution/rejections.ts). Used for two
   * things: refusing to re-propose a text that was already rejected, and
   * passing the reviewer's reasons into the next generation so the optimizer
   * knows WHY. Optional and read defensively: state rows written before this
   * field existed simply lack it.
   */
  rejectedChallengers?: Record<string, RejectedChallenger[]>;
  /**
   * v0.18.0: the brake on a refused cycle, per agent.
   *
   * A refused repeat writes no A/B test and no proposal, so nothing about the
   * state changed and `SafetyGate.canEvolve` (runs >= threshold) is monotonic:
   * without this marker the NEXT qualifying run pays the whole generator chain
   * again, and the one after that, forever. With a deterministic generator
   * that is a model call per run for an answer already known, and under
   * `useMerge` it also burns the persisted lifetime merge budget on
   * challengers nobody ever sees.
   *
   * It is a COOL-DOWN, not a lock, and it clears itself: after `minRuns` more
   * recorded runs the loop tries again, because by then the optimizer is
   * looking at meaningfully different evidence. No human action needed and
   * nothing to forget. `darwin evolve <agent> --force` ignores it, because a
   * human asking for a cycle should get a real attempt.
   *
   * "One new run" would NOT do as the key: `afterRun` records the run before
   * it evaluates, so the count has always moved by the time the marker is
   * read, and a brake keyed that way never fires. Measured, not reasoned.
   */
  rejectionStalls?: Record<string, RejectionStall | null>;
}

/**
 * v0.18.0: the record of a cycle that ended in a refused repeat, and the
 * experiment count at which the loop may try again.
 * See {@link DarwinState.rejectionStalls}.
 */
export interface RejectionStall {
  /**
   * The value `experimentCounts[agent]` has to REACH before the automatic loop
   * generates again. Snapshotted as `count at refusal + minRuns`, so a later
   * config change cannot move a cool-down already running.
   */
  retryAtExperimentCount: number;
  /** ISO timestamp of the refusal. */
  at: string;
  /** The remembered rejection whose text came back. */
  version: string;
}

/**
 * The subset of {@link EvolutionConfig} that the CLI can toggle + persist via
 * `darwin evolve <agent>` / `darwin run … --gepa …`. Stored per agent in
 * {@link DarwinState.evolutionConfigOverrides} and merged over the static
 * config. Every field is optional — only the flags the user actually set are
 * recorded, so unset flags keep the agent definition's default.
 */
export interface EvolutionConfigOverride {
  useGepa?: boolean;
  useMerge?: boolean;
  paretoGate?: boolean;
  useCoverage?: boolean;
  reflectionModel?: string;
  /** v0.10.0 — SIMBA-style demo injection (`--demos` / `--no-demos`). */
  useDemos?: boolean;
  /** v0.10.0 — parent-selection strategy (`--candidate-selection <s>`). */
  candidateSelection?: 'active' | 'best' | 'pareto' | 'epsilon-greedy';
  /** v0.11.0 — skip perfect-score feedback (`--skip-perfect` / `--no-skip-perfect`). */
  skipPerfectFeedback?: boolean;
  /** v0.11.0 — lifetime merge cap (`--max-merge <n>`). */
  maxMergeInvocations?: number;
  /** v0.13.0 — wall-clock budget per A/B test in days (`--max-test-days <n>`). */
  maxTestDays?: number;
  /** v0.14.0 — confidence gate on the A/B margin. How much it is worth depends
   *  on `confidenceMethod`; see {@link SafetyThresholds.requireConfidence}. */
  requireConfidence?: boolean;
  /** v0.14.0: statistic backing the confidence gate (`--confidence-method <m>`).
   *  v0.16.0 adds `'eb'`; see {@link SafetyThresholds.confidenceMethod}. */
  confidenceMethod?: 'effect-size' | 'msprt' | 'hoeffding' | 'eb';
  /** v0.17.0: human approval gate before the A/B test (`--require-approval`). */
  requireApproval?: boolean;
  /** v0.17.0: auto-reject an untouched proposal after n days (`--approval-timeout-days <n>`). */
  approvalTimeoutDays?: number;
  /** v0.18.0 - how many rejection reasons reach the optimizer (`--rejection-notes <n>`). */
  rejectionNoteLimit?: number;
}

// ─── Patterns ───────────────────────────────────────

export interface DarwinPattern {
  description: string;
  confidence: number;
  evidence: number;
  type: 'strength' | 'weakness' | 'trend' | 'anomaly';
  suggestion: string;
  taskType?: string;
}

// ─── Metric Weights ─────────────────────────────────

export interface MetricWeights {
  quality: number;
  sourceCount: number;
  outputLength: number;
  duration: number;
  success: number;
}

export const DEFAULT_WEIGHTS: MetricWeights = {
  quality: 0.40,
  sourceCount: 0.15,
  outputLength: 0.10,
  duration: 0.10,
  success: 0.25,
};

// ─── Safety ─────────────────────────────────────────

export interface SafetyThresholds {
  minDataPoints: number;
  maxRegression: number;
  failureRollbackThreshold: number;
  /**
   * v0.6.0 — Require a confidence check before declaring an A/B winner on the
   * score margin. How much that is worth depends entirely on
   * `confidenceMethod`: the default `'effect-size'` is a heuristic with no
   * calibrated α and is NOT peeking-resistant in any formal sense; `'msprt'`
   * and `'hoeffding'` are the methods designed for repeated looks. Aimed at
   * the "peeking problem": `evaluateABTest` is called after every run, and a
   * fixed relative-improvement threshold with continuous monitoring inflates
   * the false-positive rate (winners declared by chance). When `true`, a
   * margin-based win must ALSO clear the effect-size / sample-size bar from
   * `calculateConfidence` — otherwise the test continues. Reliability
   * auto-loss and the anti-infinite-loop incumbent tie-break are unaffected.
   *
   * Consequence to be aware of: a challenger with a genuine but SMALL effect
   * (effect size < 0.2) never clears the confidence bar, so the test keeps
   * running until the 2×minRuns tie-break fires and the incumbent wins by
   * default. With `requireConfidence` on, sub-threshold improvements are
   * therefore intentionally NOT adopted — that is the peeking-resistance
   * trade-off, not a stall.
   *
   * Default `undefined` (= `false`) — winner logic unchanged byte-for-byte.
   */
  requireConfidence?: boolean;
  /**
   * v0.7.0 — Which statistic backs the {@link requireConfidence} peeking
   * guard. Only consulted when `requireConfidence` is `true`.
   *
   *   - `'effect-size'` (default): the v0.6.0 heuristic — |Δ| / pooled-mean
   *     ≥ 0.2 with 2×minRuns samples. No per-sample data needed. Cheap,
   *     approximate. Byte-for-byte the v0.6.0 behaviour.
   *   - `'msprt'`: Mixture SPRT (Johari/Pekelis/Walsh 2017), a sequential
   *     test over the observed per-arm composite scores. **The recommended
   *     method**: at Darwin's run counts it is the one that can resolve the
   *     small lifts evolution actually produces. (Hoeffding can decide an
   *     extreme gap from n=22, it just cannot resolve a realistic one.)
   *     Its guarantee assumes a known variance; Darwin estimates it, so the
   *     validity is asymptotic rather than exact at n=10 to 30. Needs the
   *     per-sample scores (the loop supplies them automatically). Abstains
   *     during warmup (see `confidenceMinSamples`).
   *   - `'hoeffding'`: σ-free time-uniform confidence sequence for the
   *     bounded composite score (range from `confidenceScoreRange`).
   *     Distribution-free and non-asymptotic, and far more conservative than
   *     mSPRT. **Cannot fire at all at 21 or fewer runs per arm on a [0,1]
   *     score**, and needs n=900 per arm for a +0.2 lift. An extreme
   *     separation still promotes from n=22, but at Darwin's default run
   *     counts a realistic lift will not. Corrected in v0.15; see the README's
   *     "Statistical scope" section before choosing it.
   *   - `'eb'` (v0.16.0): predictable plug-in empirical Bernstein confidence
   *     sequence (Waudby-Smith & Ramdas 2024). Time-uniform with a proof of
   *     the same supermartingale kind as `'hoeffding'`, but its width adapts
   *     to the OBSERVED spread, so on tight judge-score distributions it
   *     resolves gaps Hoeffding structurally cannot (measured figures on
   *     `ebTwoSample`). Unlike mSPRT its guarantee does not lean on a
   *     plugged-in variance estimate, so it is the method to pick when you
   *     want both calibration and usable power. Structural blind zone below
   *     ~18 runs per arm on a [0,1] score; uses `confidenceScoreRange`.
   *
   * Default `undefined` (= `'effect-size'`).
   */
  confidenceMethod?: 'effect-size' | 'msprt' | 'hoeffding' | 'eb';
  /** v0.7.0: significance level for `'msprt'`/`'hoeffding'`/`'eb'`. Default 0.05. */
  confidenceAlpha?: number;
  // NOTE (v0.15): this is the TOTAL budget for the confidence gate, not
  // necessarily the level handed to one test. Under `'msprt'` the gate may run
  // two tests (mSPRT, plus Hoeffding as a fallback when mSPRT has no spread to
  // work with), whose error probabilities add, so each receives alpha/2. Under
  // `'hoeffding'` and `'eb'` there is one test and it receives the whole budget.
  /** v0.7.0 — mSPRT mixing-prior std-dev over the true mean difference (raw
   *  composite-score units). Default 0.1. */
  confidenceTau?: number;
  /** v0.7.0: per-arm warmup floor for the sequential methods. Defaults when
   *  unset differ per method: 5 for `'msprt'` (noisy variance estimates below
   *  that), 2 for `'hoeffding'` and `'eb'` (valid from n=1, but a 1-sample arm
   *  yields a range-wide interval). */
  confidenceMinSamples?: number;
  /**
   * v0.7.0: [lo,hi] bounds of the composite score. Default [0,1].
   *
   * v0.15 makes this matter in two more places, so set it whenever your
   * composites are not on a 0-to-1 scale:
   *   - the Hoeffding gate now REFUSES samples outside the declared range
   *     rather than deciding on a guarantee that does not apply there, so a
   *     wrong range means no promotions plus a warning;
   *   - `'msprt'` consults it too, because when mSPRT abstains for lack of
   *     spread (a deterministic evaluator) the gate falls back to Hoeffding,
   *     which needs the bounds. Omitting it does NOT disable that fallback:
   *     Hoeffding then uses its own [0,1] default, which decides normally for
   *     composites already on that scale and refuses (leaving mSPRT's
   *     abstention to stand) for anything outside it. Set it whenever your
   *     scores are not 0-to-1.
   *
   * `'eb'` (v0.16) reads it the same way `'hoeffding'` does: these bounds ARE
   * its boundedness assumption, and out-of-range samples are refused
   * fail-closed.
   */
  confidenceScoreRange?: readonly [number, number];
}

export const DEFAULT_SAFETY: SafetyThresholds = {
  minDataPoints: 10,
  maxRegression: 0.20,
  failureRollbackThreshold: 3,
};

// ─── Memory Provider ────────────────────────────────

export interface MemoryProvider {
  // Core (free tier)
  /**
   * Persist an experiment record. Behaviour for the optional `trajectory`
   * field is backend-specific and asymmetric (A1 / v0.5):
   *
   *  - Postgres: `ON CONFLICT (id) DO UPDATE` uses
   *    `COALESCE(EXCLUDED.trajectory, darwin_experiments.trajectory)` so a
   *    feedback-only re-save (where the second call omits trajectory)
   *    preserves the trajectory from the first call.
   *
   *  - SQLite: `INSERT OR REPLACE` drops + re-inserts the row, so a re-save
   *    that omits trajectory writes NULL into the column. Callers that want
   *    to preserve a prior trajectory MUST include it in the second-save
   *    payload (load via loadExperiments, copy `experiment.trajectory`,
   *    pass it back).
   *
   * Pre-A1 callers (no trajectory field) are unaffected by the asymmetry.
   */
  saveExperiment(exp: DarwinExperiment): Promise<void>;
  loadExperiments(agentName: string, limit?: number): Promise<DarwinExperiment[]>;
  savePromptVersion(pv: PromptVersion): Promise<void>;
  getActivePrompt(agentName: string): Promise<PromptVersion | null>;
  getAllPromptVersions(agentName: string): Promise<PromptVersion[]>;
  saveLearning(learning: Learning): Promise<void>;
  searchLearnings(query: string, limit?: number): Promise<Learning[]>;
  getState(): Promise<DarwinState>;
  saveState(state: DarwinState): Promise<void>;
  /** Atomically read-modify-write the state (prevents race conditions) */
  updateState(fn: (state: DarwinState) => DarwinState): Promise<DarwinState>;

  // Lifecycle
  init(): Promise<void>;
  close(): Promise<void>;
}

// ─── Learning ───────────────────────────────────────

export interface Learning {
  id?: string;
  agentName: string;
  content: string;
  category: 'pattern' | 'mistake' | 'insight' | 'optimization';
  tags: string[];
  createdAt?: string;
  confidence?: number;
}

// ─── Run Result ─────────────────────────────────────

export interface RunResult {
  experiment: DarwinExperiment;
  output: string;
  reportPath?: string;
  evolution?: {
    patternsFound: DarwinPattern[];
    promptEvolved: boolean;
    abTestStarted: boolean;
    newVersion?: string;
  };
}
