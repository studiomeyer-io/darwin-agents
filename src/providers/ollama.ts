/**
 * Darwin — Ollama Provider
 *
 * Local LLM inference via Ollama's API.
 * Perfect for development, testing, and cost-free experimentation.
 * No API key needed — runs locally.
 */

import type { LLMCallOptions, LLMCallResult, LLMProvider, ProviderConfig } from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.1';

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly supportsMcp = false;

  private baseUrl: string;
  private defaultModel: string;

  constructor(config: ProviderConfig) {
    this.baseUrl = (config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  }

  async run(options: LLMCallOptions): Promise<LLMCallResult> {
    const model = options.model ?? this.defaultModel;
    const timeout = options.timeout ?? 600_000; // 10 min for local models (slower)

    const messages: OllamaChatMessage[] = [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: options.userMessage },
    ];

    const body = {
      model,
      messages,
      stream: false,
      ...(options.temperature !== undefined ? { options: { temperature: options.temperature } } : {}),
    };

    const startTime = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error ${String(response.status)}: ${errorText}`);
      }

      const data = (await response.json()) as OllamaChatResponse;
      const durationMs = Date.now() - startTime;

      return {
        output: data.message?.content ?? '',
        durationMs,
        inputTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
        model: data.model,
        meta: data.total_duration ? { totalDurationNs: data.total_duration } : undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
