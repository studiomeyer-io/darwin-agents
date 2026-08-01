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
   * throughput. `computeDynamicMinRuns` correctly raises the bar to 30 when
   * scores cluster tightly — but an agent that runs a few times per week needs
   * months of wall-clock to pay that, and the agent cannot evolve at all while
   * a test is open. Lowering `minRuns` instead would trade the deadlock for
   * promotions on noise, which is worse: measured judge variance (±1 on a
   * 10-point scale) dwarfs the real evolution lift (~+0.1–0.2).
   *
   * A timeout therefore NEVER promotes the challenger — inconclusive evidence
   * is not evidence. Unset (the default) means tests run until they conclude
   * on their own, exactly as before.
   */
  maxTestDays?: number;
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
   * v0.6.0 — Require a minimum statistical confidence (effect size) before
   * declaring an A/B winner on the score margin. Guards against the
   * "peeking problem": `evaluateABTest` is called after every run, and a
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
   *   - `'msprt'`: Mixture SPRT (Johari/Pekelis/Walsh 2017) — always-valid
   *     sequential test using the observed per-arm composite scores. The
   *     rigorous upgrade; needs the per-sample scores (the loop supplies
   *     them automatically). Abstains during warmup (see `confidenceMinSamples`).
   *   - `'hoeffding'`: σ-free time-uniform confidence sequence for the
   *     bounded composite score (range from `confidenceScoreRange`). Valid
   *     at any n, more conservative than mSPRT — the honest choice with few
   *     runs or skewed score distributions.
   *
   * Default `undefined` (= `'effect-size'`).
   */
  confidenceMethod?: 'effect-size' | 'msprt' | 'hoeffding';
  /** v0.7.0 — Significance level for `'msprt'`/`'hoeffding'`. Default 0.05. */
  confidenceAlpha?: number;
  /** v0.7.0 — mSPRT mixing-prior std-dev over the true mean difference (raw
   *  composite-score units). Default 0.1. */
  confidenceTau?: number;
  /** v0.7.0 — Per-arm warmup floor for `'msprt'`/`'hoeffding'`. Default 5. */
  confidenceMinSamples?: number;
  /** v0.7.0 — [lo,hi] bounds of the composite score for `'hoeffding'`. Default [0,1]. */
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
