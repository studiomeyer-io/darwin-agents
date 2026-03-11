/**
 * Darwin — LLM Provider Interface
 *
 * Abstraction over different LLM backends.
 * All providers implement the same interface so Darwin can
 * swap models/providers without changing agent or evolution code.
 */

/** Options for a single LLM call */
export interface LLMCallOptions {
  /** Model identifier (provider-specific, e.g. "claude-sonnet-4-20250514") */
  model: string;
  /** System prompt (role/behavior instructions) */
  systemPrompt: string;
  /** User message (the task) */
  userMessage: string;
  /** Max output tokens (default: provider-dependent) */
  maxTokens?: number;
  /** Temperature (0-1, default: provider-dependent) */
  temperature?: number;
  /** Timeout in milliseconds */
  timeout?: number;
}

/** Result from an LLM call */
export interface LLMCallResult {
  /** The generated text output */
  output: string;
  /** Duration of the API call in milliseconds */
  durationMs: number;
  /** Input tokens used (if reported by provider) */
  inputTokens?: number;
  /** Output tokens used (if reported by provider) */
  outputTokens?: number;
  /** Model actually used (may differ from requested) */
  model?: string;
  /** Provider-specific metadata */
  meta?: Record<string, unknown>;
}

/** LLM Provider — implemented by each backend */
export interface LLMProvider {
  /** Provider name for logging */
  readonly name: string;
  /** Whether this provider supports MCP tool use */
  readonly supportsMcp: boolean;
  /** Run a single LLM call */
  run(options: LLMCallOptions): Promise<LLMCallResult>;
}

/** Provider configuration */
export interface ProviderConfig {
  /** Provider type */
  type: 'claude-cli' | 'anthropic-api' | 'openai' | 'ollama';
  /** API key (for anthropic, openai) */
  apiKey?: string;
  /** Base URL override (for openai-compatible, ollama) */
  baseUrl?: string;
  /** Default model for this provider */
  defaultModel?: string;
  /** Default max tokens */
  defaultMaxTokens?: number;
  /** Default temperature */
  defaultTemperature?: number;
}
