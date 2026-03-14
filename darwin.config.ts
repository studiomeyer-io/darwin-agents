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

  mcp: {
    'tavily': {
      command: 'npx',
      args: ['-y', '@tavily/mcp'],
      env: { TAVILY_API_KEY: process.env.TAVILY_API_KEY ?? '' },
    },
    'code-pathfinder': {
      command: 'npx',
      args: ['-y', '@anthropic/code-pathfinder-mcp'],
    },
    'context7': {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    },
    'context': {
      command: 'npx',
      args: ['-y', '@nicholasarner/context-mcp'],
    },
  },
};

export default config;
