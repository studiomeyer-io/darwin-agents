/**
 * Darwin — Provider Factory
 *
 * Creates the appropriate LLM provider based on configuration.
 * Supports: claude-cli, anthropic-api, openai, ollama.
 */

export type { LLMProvider, LLMCallOptions, LLMCallResult, ProviderConfig } from './types.js';
export { ClaudeCliProvider } from './claude-cli.js';
export type { ClaudeCliRunOptions } from './claude-cli.js';
export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider } from './openai.js';
export { OllamaProvider } from './ollama.js';

import type { LLMProvider, ProviderConfig } from './types.js';
import { ClaudeCliProvider } from './claude-cli.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';

/**
 * Create an LLM provider from configuration.
 *
 * @example
 * ```ts
 * // Anthropic API (fastest for non-MCP agents)
 * const provider = createProvider({ type: 'anthropic-api' });
 *
 * // OpenAI-compatible (GPT-4o, Together AI, Groq, etc.)
 * const provider = createProvider({
 *   type: 'openai',
 *   baseUrl: 'https://api.together.xyz/v1',
 *   defaultModel: 'meta-llama/Llama-3.1-70B-Instruct-Turbo',
 * });
 *
 * // Ollama (local, free, offline)
 * const provider = createProvider({ type: 'ollama', defaultModel: 'llama3.1' });
 *
 * // Claude CLI (only option for MCP-enabled agents)
 * const provider = createProvider({ type: 'claude-cli' });
 * ```
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.type) {
    case 'claude-cli':
      return new ClaudeCliProvider(config);
    case 'anthropic-api':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    default:
      throw new Error(`Unknown provider type: ${String((config as ProviderConfig).type)}`);
  }
}

/** Default model names per provider */
export const DEFAULT_MODELS: Record<ProviderConfig['type'], string> = {
  'claude-cli': 'claude-sonnet-4-20250514',
  'anthropic-api': 'claude-sonnet-4-20250514',
  'openai': 'gpt-5.4',
  'ollama': 'llama3.1',
};
