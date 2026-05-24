/**
 * Darwin — AI agents that improve themselves.
 *
 * @example
 * ```typescript
 * import { defineAgent, defineConfig, runAgent } from 'darwin-agents';
 *
 * const myAgent = defineAgent({
 *   name: 'summarizer',
 *   role: 'Text Summarizer',
 *   systemPrompt: 'Summarize text in 3 bullet points.',
 *   evolution: { enabled: true, evaluator: 'critic' },
 * });
 *
 * const result = await runAgent(myAgent, 'Summarize this article...');
 * ```
 */

// Core API
export { defineAgent, defineConfig, loadConfig, loadConfigSync } from './core/agent.js';
export { runAgent } from './core/runner.js';

// V0.5.0-alpha.1 — Execution Trace Capture (S1184 Phase 2 A1)
export { createTraceCapture } from './core/trace-capture.js';
export type { TraceCapture, TraceCaptureOptions } from './core/trace-capture.js';

// Types
export type {
  AgentDefinition,
  DarwinConfig,
  DarwinExperiment,
  DarwinMetrics,
  DarwinPattern,
  DarwinState,
  ExecutionTrace,
  ExperimentFeedback,
  EvolutionConfig,
  Learning,
  McpServerConfig,
  MemoryProvider,
  MetricWeights,
  PromptVersion,
  PromptVersionStats,
  RunResult,
  SafetyThresholds,
  TraceToolCall,
  TraceTokenUsage,
  TraceTurnError,
} from './types.js';

// Constants
export { DEFAULT_WEIGHTS, DEFAULT_SAFETY } from './types.js';

// Built-in Agents
export { writer, researcher, critic, analyst, builtinAgents } from './agents/index.js';

// Providers
export { createProvider } from './providers/index.js';
export type { LLMProvider, LLMCallOptions, LLMCallResult, ProviderConfig } from './providers/types.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAIProvider } from './providers/openai.js';
export { OllamaProvider } from './providers/ollama.js';
export { ClaudeCliProvider } from './providers/claude-cli.js';

// Memory
export { createMemory, SqliteMemoryProvider, PostgresMemoryProvider } from './memory/index.js';

// Notifications
export { loadNotificationConfig } from './evolution/notifications.js';
export type { NotificationConfig } from './evolution/notifications.js';

// V0.5.0-alpha.2 — GEPA-Style Reflective Optimizer (S1185 Phase 2 A2)
export {
  dominates,
  nonDominatedFront,
  paretoSelect,
  scalarise,
  DARWIN_DEFAULT_OBJECTIVES,
  type ParetoObjective,
} from './evolution/pareto.js';
export {
  Reflector,
  type ReflectiveFeedback,
  type ReflectOptions,
} from './evolution/reflector.js';
export type { RunPromptFn } from './evolution/run-prompt-fn.js';
export {
  GepaOptimizer,
  type ScoredVariant,
  type GenerateOptions as GepaGenerateOptions,
  type NextGenerationOptions as GepaNextGenerationOptions,
} from './evolution/optimizer-gepa.js';
