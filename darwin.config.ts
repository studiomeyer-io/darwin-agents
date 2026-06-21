/**
 * Darwin Config — Example
 *
 * Customize MCP server paths and evolution settings for your setup.
 * See README.md for full configuration reference.
 */

import type { DarwinConfig } from './src/types.js';

const config: Partial<DarwinConfig> = {
  provider: 'claude-cli',
  memory: 'postgres',
  postgresUrl: process.env.DARWIN_POSTGRES_URL,

  evolution: {
    enabled: true,
    minRuns: 5,
    safetyGate: true,
  },

  // Every entry here must be a real, npx-resolvable MCP server. Code analysis
  // (symbols, callers) is handled by Claude Code's built-in Read/Glob/Grep
  // tools, so no extra server is needed for it — add your own below as required.
  mcp: {
    'tavily': {
      command: 'npx',
      args: ['-y', 'tavily-mcp@latest'],
      env: { TAVILY_API_KEY: process.env.TAVILY_API_KEY ?? '' },
    },
    'context7': {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    },
  },
};

export default config;
