/**
 * Darwin — Anthropic API Provider
 *
 * Direct API calls to Anthropic's Messages API.
 * No SDK dependency — uses native fetch (Node 20+).
 *
 * 10-100x faster than Claude CLI for non-MCP tasks.
 */

import type { LLMCallOptions, LLMCallResult, LLMProvider, ProviderConfig } from './types.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 8192;
const API_VERSION = '2023-06-01';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text: string }>;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic-api';
  readonly supportsMcp = false;

  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private defaultMaxTokens: number;

  constructor(config: ProviderConfig) {
    const key = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error('Anthropic API key required. Set ANTHROPIC_API_KEY or pass apiKey in config.');
    }
    this.apiKey = key;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async run(options: LLMCallOptions): Promise<LLMCallResult> {
    const model = options.model ?? this.defaultModel;
    const maxTokens = options.maxTokens ?? this.defaultMaxTokens;
    const timeout = options.timeout ?? 300_000; // 5 min default

    const messages: AnthropicMessage[] = [
      { role: 'user', content: options.userMessage },
    ];

    const body = {
      model,
      max_tokens: maxTokens,
      system: options.systemPrompt,
      messages,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    };

    const startTime = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error ${String(response.status)}: ${errorText}`);
      }

      const data = (await response.json()) as AnthropicResponse;
      const durationMs = Date.now() - startTime;

      // Extract text from content blocks
      const output = data.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      return {
        output,
        durationMs,
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        model: data.model,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
