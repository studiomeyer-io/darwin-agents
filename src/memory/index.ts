/**
 * Darwin — Memory Factory
 *
 * Creates the appropriate MemoryProvider based on config.
 * Supports SQLite (free) and PostgreSQL (pro).
 */

import type { DarwinConfig, MemoryProvider } from '../types.js';
import { SqliteMemoryProvider } from './sqlite-memory.js';
import { PostgresMemoryProvider } from './postgres-memory.js';

/**
 * Create a MemoryProvider based on the Darwin config.
 *
 * @param config - Darwin configuration with memory backend selection
 * @returns An uninitialized MemoryProvider — call `init()` before use
 *
 * @example
 * ```ts
 * // SQLite (default, zero-config)
 * const memory = createMemory({ provider: 'claude-cli', memory: 'sqlite' });
 *
 * // PostgreSQL (production, concurrent agents)
 * const memory = createMemory({
 *   provider: 'claude-cli',
 *   memory: 'postgres',
 *   postgresUrl: 'postgresql://user:pass@localhost:5432/darwin',
 * });
 *
 * await memory.init();
 * ```
 */
export function createMemory(config: DarwinConfig): MemoryProvider {
  switch (config.memory) {
    case 'sqlite':
      return new SqliteMemoryProvider(config);

    case 'postgres':
      return new PostgresMemoryProvider(config);

    case 'custom':
      if (!config.memoryProvider) {
        throw new Error('Custom memory backend requires memoryProvider in config.');
      }
      return config.memoryProvider;

    default: {
      const exhaustive: never = config.memory;
      throw new Error(`Unknown memory backend: ${String(exhaustive)}`);
    }
  }
}

export { SqliteMemoryProvider } from './sqlite-memory.js';
export { PostgresMemoryProvider } from './postgres-memory.js';
