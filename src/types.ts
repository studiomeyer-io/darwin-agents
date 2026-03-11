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
