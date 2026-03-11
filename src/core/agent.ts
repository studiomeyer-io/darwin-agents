/**
 * Darwin — Agent Definition & Config
 *
 * Factory functions for creating validated agent definitions
 * and merging config with sensible defaults.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentDefinition, DarwinConfig } from '../types.js';

// ─── Defaults ────────────────────────────────────────

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Auto-detect the best available provider.
 * Priority: ANTHROPIC_API_KEY > OPENAI_API_KEY > claude-cli
 */
function detectDefaultProvider(): DarwinConfig['provider'] {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic-api';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'claude-cli';
}

const DEFAULT_CONFIG: DarwinConfig = {
  provider: detectDefaultProvider(),
  memory: 'sqlite',
  evolution: {
    enabled: false,
    minRuns: 5,
    safetyGate: true,
  },
  dataDir: undefined,
};

// ─── Validation Helpers ──────────────────────────────

function validateAgentName(name: string): void {
  if (!name || name.length === 0) {
    throw new Error('Agent name is required');
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Agent name "${name}" is invalid. Must be lowercase, start with a letter, ` +
      `and contain only letters, digits, and hyphens.`
    );
  }
  if (name.length > 64) {
    throw new Error(`Agent name "${name}" exceeds 64 character limit`);
  }
}

function validateSystemPrompt(prompt: string, agentName: string): void {
  if (!prompt || prompt.trim().length === 0) {
    throw new Error(`Agent "${agentName}" requires a non-empty systemPrompt`);
  }
}

function validateSystemAgent(def: AgentDefinition): void {
  if (def.type === 'system' && typeof def.handler !== 'function') {
    throw new Error(
      `System agent "${def.name}" requires a handler function`
    );
  }
  if (def.type !== 'system' && def.handler) {
    throw new Error(
      `Agent "${def.name}" has a handler but type is "${def.type ?? 'llm'}". ` +
      `Set type: 'system' to use a handler.`
    );
  }
}

// ─── Public API ──────────────────────────────────────

/**
 * Define and validate an agent definition.
 * Returns the definition with defaults applied for optional fields.
 *
 * @example
 * ```ts
 * const researcher = defineAgent({
 *   name: 'researcher',
 *   role: 'Deep Research Agent',
 *   description: 'Researches topics with web sources',
 *   systemPrompt: 'You are a research agent...',
 *   mcp: ['tavily', 'memory'],
 *   tools: ['Read', 'Glob', 'Grep'],
 * });
 * ```
 */
export function defineAgent(def: AgentDefinition): AgentDefinition {
  // Validate required fields
  validateAgentName(def.name);
  validateSystemPrompt(def.systemPrompt, def.name);
  validateSystemAgent(def);

  if (!def.role || def.role.trim().length === 0) {
    throw new Error(`Agent "${def.name}" requires a non-empty role`);
  }
  if (!def.description || def.description.trim().length === 0) {
    throw new Error(`Agent "${def.name}" requires a non-empty description`);
  }

  // Return with defaults applied
  return {
    ...def,
    type: def.type ?? 'llm',
    maxTurns: def.maxTurns ?? DEFAULT_MAX_TURNS,
    model: def.model ?? DEFAULT_MODEL,
    mcp: def.mcp ?? [],
    tools: def.tools ?? [],
  };
}

/**
 * Define a Darwin configuration by merging partial overrides with defaults.
 *
 * @example
 * ```ts
 * const config = defineConfig({
 *   memory: 'postgres',
 *   postgresUrl: 'postgresql://...',
 *   evolution: { enabled: true },
 * });
 * ```
 */
export function defineConfig(config: Partial<DarwinConfig>): DarwinConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    // Deep-merge evolution settings so partial overrides don't wipe defaults
    evolution: {
      enabled: config.evolution?.enabled ?? DEFAULT_CONFIG.evolution?.enabled ?? false,
      minRuns: config.evolution?.minRuns ?? DEFAULT_CONFIG.evolution?.minRuns,
      safetyGate: config.evolution?.safetyGate ?? DEFAULT_CONFIG.evolution?.safetyGate,
    },
  };
}

/**
 * Load config from darwin.config.ts in the current working directory.
 * Falls back to defaults if no config file is found.
 *
 * Also checks for DARWIN_POSTGRES_URL env var and auto-sets
 * memory: 'postgres' + postgresUrl when present.
 */
export async function loadConfig(): Promise<DarwinConfig> {
  let config: DarwinConfig = { ...DEFAULT_CONFIG };

  // Try loading darwin.config.ts from cwd
  const configPath = join(process.cwd(), 'darwin.config.ts');
  if (existsSync(configPath)) {
    try {
      const configUrl = pathToFileURL(configPath).href;
      const imported = await import(configUrl) as { default?: Partial<DarwinConfig> };
      if (imported.default) {
        config = defineConfig(imported.default);
      }
    } catch {
      // Config file exists but failed to load — use defaults
      console.warn(`[darwin] Warning: Failed to load ${configPath}, using defaults`);
    }
  }

  // Auto-detect postgres from env var
  const postgresUrl = process.env['DARWIN_POSTGRES_URL'];
  if (postgresUrl) {
    config.memory = 'postgres';
    config.postgresUrl = postgresUrl;
  }

  return config;
}

/**
 * Synchronous config loader — returns defaults only.
 * Used by callers that cannot await (kept for backward compatibility).
 *
 * @deprecated Use loadConfig() (async) instead.
 */
export function loadConfigSync(): DarwinConfig {
  const config: DarwinConfig = { ...DEFAULT_CONFIG };

  // Auto-detect postgres from env var
  const postgresUrl = process.env['DARWIN_POSTGRES_URL'];
  if (postgresUrl) {
    config.memory = 'postgres';
    config.postgresUrl = postgresUrl;
  }

  return config;
}
