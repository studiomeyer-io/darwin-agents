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
  /** Minimum runs before first optimization */
  minRuns?: number;
  /** Minimum output length to save (default: 2000). Lower for short-form agents like marketing. */
  minOutputLength?: number;
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
