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

// Types
export type {
  AgentDefinition,
  DarwinConfig,
  DarwinExperiment,
  DarwinMetrics,
  DarwinPattern,
  DarwinState,
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
