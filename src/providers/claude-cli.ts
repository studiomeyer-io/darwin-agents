/**
 * Darwin — Claude CLI Provider
 *
 * Spawns `claude` CLI as a child process.
 * The only provider that supports MCP tool use (via --mcp-config).
 * Slower than direct API but enables full tool-augmented agents.
 */

import { spawn } from 'node:child_process';

import type { DarwinConfig, AgentDefinition, McpServerConfig } from '../types.js';
import type { LLMCallOptions, LLMCallResult, LLMProvider, ProviderConfig } from './types.js';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/** Extended options for Claude CLI (MCP, tools, etc.) */
export interface ClaudeCliRunOptions {
  /** Agent definition (needed for MCP config and tools) */
  agent?: AgentDefinition;
  /** Darwin config (for MCP server definitions) */
  darwinConfig?: DarwinConfig;
  /** Max conversation turns */
  maxTurns?: number;
  /** Working directory for the CLI process */
  cwd?: string;
  /** Run in autonomous mode (bypass permissions) */
  autonomous?: boolean;
}

export class ClaudeCliProvider implements LLMProvider {
  readonly name = 'claude-cli';
  readonly supportsMcp = true;

  private defaultModel: string;
  /** Stashed CLI-specific options — set before run() via setRunOptions() */
  private runOptions: ClaudeCliRunOptions = {};

  constructor(config: ProviderConfig) {
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  }

  /** Set CLI-specific options for the next run (MCP, tools, etc.) */
  setRunOptions(opts: ClaudeCliRunOptions): void {
    this.runOptions = opts;
  }

  async run(options: LLMCallOptions): Promise<LLMCallResult> {
    const MAX_RETRIES = 2;
    const MIN_VALID_CHARS = 50;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const result = await this.executeOnce(options);
      if (result.output.trim().length >= MIN_VALID_CHARS) {
        return result;
      }
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * (attempt + 1);
        console.warn(
          `[claude-cli] Attempt ${attempt + 1} produced ${result.output.length} chars. Retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        return result; // All retries exhausted
      }
    }

    // TypeScript: unreachable but needed for return type
    throw new Error('Unreachable');
  }

  private async executeOnce(options: LLMCallOptions): Promise<LLMCallResult> {
    const model = options.model ?? this.defaultModel;
    const timeout = options.timeout ?? 600_000;
    const opts = this.runOptions;

    // Build CLI args
    const args: string[] = [
      '-p',
      '--output-format', 'text',
      '--model', model,
      '--max-turns', String(opts.maxTurns ?? 10),
    ];

    // MCP config
    if (opts.agent && opts.darwinConfig) {
      const mcpConfig = buildMcpConfig(opts.agent, opts.darwinConfig);
      if (mcpConfig) {
        args.push('--mcp-config', mcpConfig);
      }

      const allowedTools = buildAllowedTools(opts.agent, opts.darwinConfig);
      if (allowedTools) {
        args.push('--allowedTools', allowedTools);
      }
    }

    if (opts.autonomous) {
      args.push('--permission-mode', 'bypassPermissions');
    }

    // Combine system prompt + task as stdin
    const stdin = `${options.systemPrompt}\n\n---\n\nTask: ${options.userMessage}`;

    const startTime = Date.now();

    // Spawn claude CLI
    const output = await new Promise<string>((resolve, reject) => {
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;

      const child = spawn('claude', args, {
        cwd: opts.cwd ?? process.cwd(),
        stdio: ['pipe', 'pipe', 'inherit'],
        timeout,
        env: cleanEnv,
      });

      const chunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      child.stdin.write(stdin);
      child.stdin.end();

      child.on('close', (code) => {
        const result = Buffer.concat(chunks).toString('utf-8');
        if (code === 0) {
          resolve(result);
        } else {
          reject(new Error(`Claude CLI exited with code ${String(code)}: ${result.slice(0, 500)}`));
        }
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
      });
    });

    const durationMs = Date.now() - startTime;

    return {
      output,
      durationMs,
      model,
    };
  }
}

// ─── Helpers (extracted from runner.ts) ───────────

function buildMcpConfig(
  agent: AgentDefinition,
  config: DarwinConfig,
): string | null {
  if (!agent.mcp || agent.mcp.length === 0 || !config.mcp) {
    return null;
  }

  const mcpServers: Record<string, { type: string; command: string; args: string[]; env?: Record<string, string> }> = {};
  let hasServers = false;

  for (const serverName of agent.mcp) {
    const serverConfig: McpServerConfig | undefined = config.mcp[serverName];
    if (serverConfig) {
      mcpServers[serverName] = {
        type: 'stdio',
        command: serverConfig.command,
        args: serverConfig.args,
        ...(serverConfig.env ? { env: serverConfig.env } : {}),
      };
      hasServers = true;
    }
  }

  return hasServers ? JSON.stringify({ mcpServers }) : null;
}

function buildAllowedTools(
  agent: AgentDefinition,
  config: DarwinConfig,
): string | null {
  const patterns: string[] = [];

  if (agent.mcp && agent.mcp.length > 0 && config.mcp) {
    for (const serverName of agent.mcp) {
      if (config.mcp[serverName]) {
        patterns.push(`mcp__${serverName}__*`);
      }
    }
  }

  if (agent.tools && agent.tools.length > 0) {
    patterns.push(...agent.tools);
  }

  return patterns.length > 0 ? patterns.join(',') : null;
}
