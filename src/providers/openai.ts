/**
 * Darwin — OpenAI-Compatible Provider
 *
 * Works with OpenAI, Azure OpenAI, Together AI, Groq,
 * and any other OpenAI-compatible API endpoint.
 * No SDK dependency — uses native fetch (Node 20+).
 */

import type { LLMCallOptions, LLMCallResult, LLMProvider, ProviderConfig } from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_MAX_TOKENS = 8192;

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly supportsMcp = false;

  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private defaultMaxTokens: number;

  constructor(config: ProviderConfig) {
    const key = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OpenAI API key required. Set OPENAI_API_KEY or pass apiKey in config.');
    }
    this.apiKey = key;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async run(options: LLMCallOptions): Promise<LLMCallResult> {
    const model = options.model ?? this.defaultModel;
    const maxTokens = options.maxTokens ?? this.defaultMaxTokens;
    const timeout = options.timeout ?? 300_000;

    const messages: OpenAIMessage[] = [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: options.userMessage },
    ];

    const body = {
      model,
      max_tokens: maxTokens,
      messages,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    };

    const startTime = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error ${String(response.status)}: ${errorText}`);
      }

      const data = (await response.json()) as OpenAIResponse;
      const durationMs = Date.now() - startTime;

      const output = data.choices[0]?.message?.content ?? '';

      return {
        output,
        durationMs,
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
        model: data.model,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
