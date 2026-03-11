/**
 * Tests for LLM Providers — createProvider factory + provider behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createProvider, DEFAULT_MODELS } from '../src/providers/index.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { ClaudeCliProvider } from '../src/providers/claude-cli.js';

// ─── createProvider factory ─────────────────────────

describe('createProvider', () => {
  it('creates ClaudeCliProvider for type "claude-cli"', () => {
    const provider = createProvider({ type: 'claude-cli' });
    assert.ok(provider instanceof ClaudeCliProvider);
    assert.equal(provider.name, 'claude-cli');
    assert.equal(provider.supportsMcp, true);
  });

  it('creates AnthropicProvider for type "anthropic-api"', () => {
    // Set env var for test (provider requires API key)
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    try {
      const provider = createProvider({ type: 'anthropic-api' });
      assert.ok(provider instanceof AnthropicProvider);
      assert.equal(provider.name, 'anthropic-api');
      assert.equal(provider.supportsMcp, false);
    } finally {
      if (origKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = origKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it('creates OpenAIProvider for type "openai"', () => {
    const origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key-456';
    try {
      const provider = createProvider({ type: 'openai' });
      assert.ok(provider instanceof OpenAIProvider);
      assert.equal(provider.name, 'openai');
      assert.equal(provider.supportsMcp, false);
    } finally {
      if (origKey !== undefined) {
        process.env.OPENAI_API_KEY = origKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });

  it('creates OllamaProvider for type "ollama"', () => {
    const provider = createProvider({ type: 'ollama' });
    assert.ok(provider instanceof OllamaProvider);
    assert.equal(provider.name, 'ollama');
    assert.equal(provider.supportsMcp, false);
  });

  it('throws for unknown provider type', () => {
    assert.throws(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => createProvider({ type: 'unknown' as any }),
      /Unknown provider type/,
    );
  });
});

// ─── Provider config validation ─────────────────────

describe('Provider config validation', () => {
  it('AnthropicProvider throws without API key', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.throws(
        () => new AnthropicProvider({ type: 'anthropic-api' }),
        /Anthropic API key required/,
      );
    } finally {
      if (origKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = origKey;
      }
    }
  });

  it('AnthropicProvider accepts apiKey in config', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const provider = new AnthropicProvider({
        type: 'anthropic-api',
        apiKey: 'sk-test-direct',
      });
      assert.equal(provider.name, 'anthropic-api');
    } finally {
      if (origKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = origKey;
      }
    }
  });

  it('OpenAIProvider throws without API key', () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      assert.throws(
        () => new OpenAIProvider({ type: 'openai' }),
        /OpenAI API key required/,
      );
    } finally {
      if (origKey !== undefined) {
        process.env.OPENAI_API_KEY = origKey;
      }
    }
  });

  it('OpenAIProvider accepts custom baseUrl for compatible APIs', () => {
    const provider = new OpenAIProvider({
      type: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://api.together.xyz/v1',
      defaultModel: 'meta-llama/Llama-3.1-70B-Instruct-Turbo',
    });
    assert.equal(provider.name, 'openai');
  });

  it('OllamaProvider works without any config (no API key needed)', () => {
    const provider = new OllamaProvider({ type: 'ollama' });
    assert.equal(provider.name, 'ollama');
  });

  it('OllamaProvider accepts custom baseUrl', () => {
    const provider = new OllamaProvider({
      type: 'ollama',
      baseUrl: 'http://gpu-server:11434',
      defaultModel: 'codellama:34b',
    });
    assert.equal(provider.name, 'ollama');
  });
});

// ─── MCP support flags ──────────────────────────────

describe('Provider MCP support', () => {
  it('only ClaudeCliProvider supports MCP', () => {
    const cliProvider = new ClaudeCliProvider({ type: 'claude-cli' });
    assert.equal(cliProvider.supportsMcp, true);

    const anthropic = new AnthropicProvider({ type: 'anthropic-api', apiKey: 'k' });
    assert.equal(anthropic.supportsMcp, false);

    const openai = new OpenAIProvider({ type: 'openai', apiKey: 'k' });
    assert.equal(openai.supportsMcp, false);

    const ollama = new OllamaProvider({ type: 'ollama' });
    assert.equal(ollama.supportsMcp, false);
  });
});

// ─── DEFAULT_MODELS ─────────────────────────────────

describe('DEFAULT_MODELS', () => {
  it('has defaults for all provider types', () => {
    assert.ok(DEFAULT_MODELS['claude-cli']);
    assert.ok(DEFAULT_MODELS['anthropic-api']);
    assert.ok(DEFAULT_MODELS['openai']);
    assert.ok(DEFAULT_MODELS['ollama']);
  });

  it('Claude providers default to sonnet', () => {
    assert.ok(DEFAULT_MODELS['claude-cli'].includes('claude-sonnet'));
    assert.ok(DEFAULT_MODELS['anthropic-api'].includes('claude-sonnet'));
  });
});
