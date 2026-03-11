/**
 * Darwin — Agent Runner
 *
 * Executes agents via pluggable LLM providers.
 * Supports: Claude CLI (with MCP), Anthropic API, OpenAI, Ollama.
 *
 * The runner handles metrics, experiment records, and reports.
 * The provider handles the actual LLM call.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type {
  AgentDefinition,
  DarwinConfig,
  DarwinExperiment,
  DarwinMetrics,
  RunResult,
} from '../types.js';
import type { LLMProvider } from '../providers/types.js';
import { ClaudeCliProvider } from '../providers/claude-cli.js';
import { createProvider } from '../providers/index.js';

// ─── Run Options ─────────────────────────────────────

/** Options for a single agent run */
export interface RunOptions {
  /** Override the agent's model for this run */
  model?: string;
  /** Override max turns for this run */
  maxTurns?: number;
  /** Task category for experiment tracking */
  taskType?: string;
  /** Darwin config (for MCP servers, data dir, etc.) */
  config?: DarwinConfig;
  /** Prompt version identifier for experiment tracking */
  promptVersion?: string;
  /** Working directory for the Claude CLI process */
  cwd?: string;
  /** Timeout in milliseconds (default: 600_000 = 10 minutes) */
  timeout?: number;
  /** Run in autonomous mode with bypassed permissions */
  autonomous?: boolean;
  /** Explicit LLM provider (overrides config.provider) */
  provider?: LLMProvider;
}

// ─── Constants ───────────────────────────────────────

const DEFAULT_TIMEOUT = 600_000; // 10 minutes
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TURNS = 10;
const DEFAULT_DATA_DIR = '.darwin';
const DEFAULT_TASK_TYPE = 'general';

// Matches common URL patterns for source counting
const URL_PATTERN = /https?:\/\/[^\s)>\]"'`]+/g;

// ─── Metrics Parser ──────────────────────────────────

/**
 * Parse basic metrics from agent output.
 * - sourceCount: number of unique URLs found in output
 * - outputLength: character count of the output
 */
function parseMetrics(output: string, durationMs: number): DarwinMetrics {
  const urls = output.match(URL_PATTERN);
  const uniqueUrls = urls ? new Set(urls) : new Set<string>();

  return {
    qualityScore: null,       // Set later by evaluator
    sourceCount: uniqueUrls.size,
    outputLength: output.length,
    errorCount: 0,
    durationMs,
  };
}

// ─── Experiment Factory ──────────────────────────────

function generateExperimentId(agentName: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const random = Math.random().toString(36).slice(2, 10);
  return `exp-${agentName}-${date}-${random}`;
}

function createExperiment(
  agent: AgentDefinition,
  task: string,
  output: string,
  startedAt: string,
  completedAt: string,
  success: boolean,
  metrics: DarwinMetrics,
  opts: RunOptions,
): DarwinExperiment {
  return {
    id: generateExperimentId(agent.name),
    agentName: agent.name,
    promptVersion: opts.promptVersion ?? 'v1',
    task,
    taskType: opts.taskType ?? DEFAULT_TASK_TYPE,
    startedAt,
    completedAt,
    success,
    metrics,
    output,
  };
}

// ─── Report Writer ───────────────────────────────────

function saveReport(
  experiment: DarwinExperiment,
  dataDir: string,
): string {
  const reportsDir = resolve(join(dataDir, 'reports'));
  mkdirSync(reportsDir, { recursive: true });

  const filename = `${experiment.id}.md`;
  const filepath = join(reportsDir, filename);

  const durationSec = (experiment.metrics.durationMs / 1000).toFixed(1);

  const report = `# ${experiment.id}

## Meta
- **Agent:** ${experiment.agentName}
- **Task Type:** ${experiment.taskType}
- **Prompt Version:** ${experiment.promptVersion}
- **Started:** ${experiment.startedAt}
- **Completed:** ${experiment.completedAt}
- **Duration:** ${durationSec}s
- **Success:** ${experiment.success ? 'Yes' : 'No'}

## Metrics
| Metric | Value |
|--------|-------|
| Quality Score | ${experiment.metrics.qualityScore ?? 'pending'} |
| Source Count | ${experiment.metrics.sourceCount} |
| Output Length | ${experiment.metrics.outputLength} chars |
| Error Count | ${experiment.metrics.errorCount} |
| Duration | ${durationSec}s |

## Task
${experiment.task}

## Output
${experiment.output ?? 'No output captured'}
`;

  writeFileSync(filepath, report, 'utf-8');
  return filepath;
}

// ─── Provider Resolution ─────────────────────────────

/**
 * Resolve which LLM provider to use for a given agent and options.
 *
 * Priority: opts.provider > config.provider > 'claude-cli' (default)
 *
 * Auto-fallback: If agent uses MCP tools and provider doesn't support MCP,
 * automatically falls back to Claude CLI with a warning.
 */
function resolveProvider(
  agent: AgentDefinition,
  opts: RunOptions,
): LLMProvider {
  // Explicit provider passed in options
  if (opts.provider) {
    return opts.provider;
  }

  // Determine provider type from config
  const providerType = opts.config?.provider ?? 'claude-cli';

  const provider = createProvider({ type: providerType });

  // Auto-fallback: if agent needs MCP but provider doesn't support it
  const needsMcp = agent.mcp && agent.mcp.length > 0;
  if (needsMcp && !provider.supportsMcp) {
    console.warn(
      `⚠ Agent "${agent.name}" uses MCP tools but provider "${provider.name}" doesn't support MCP. Falling back to claude-cli.`,
    );
    return createProvider({ type: 'claude-cli' });
  }

  return provider;
}

// ─── Runner ──────────────────────────────────────────

/**
 * Run an agent using the configured LLM provider.
 *
 * For Claude CLI: spawns a child process with MCP support.
 * For API providers: makes a direct HTTP call (10-100x faster).
 *
 * @example
 * ```ts
 * // Default: uses Claude CLI
 * const result = await runAgent(writer, 'Write a landing page', {
 *   taskType: 'market',
 *   config: darwinConfig,
 * });
 *
 * // Explicit provider: Anthropic API (faster, no MCP)
 * import { createProvider } from '../providers/index.js';
 * const result = await runAgent(critic, 'Evaluate this output', {
 *   provider: createProvider({ type: 'anthropic-api' }),
 * });
 * ```
 */
export async function runAgent(
  agent: AgentDefinition,
  task: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  // System agents don't use LLM providers
  if (agent.type === 'system') {
    throw new Error(
      `Agent "${agent.name}" is a system agent. ` +
      `System agents must be run through their handler, not the CLI runner.`,
    );
  }

  const startedAt = new Date().toISOString();
  const dataDir = opts.config?.dataDir ?? DEFAULT_DATA_DIR;
  const model = opts.model ?? agent.model ?? DEFAULT_MODEL;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;

  // Resolve provider
  const provider = resolveProvider(agent, opts);

  // Configure Claude CLI-specific options
  if (provider instanceof ClaudeCliProvider) {
    provider.setRunOptions({
      agent,
      darwinConfig: opts.config,
      maxTurns: opts.maxTurns ?? agent.maxTurns ?? DEFAULT_MAX_TURNS,
      cwd: opts.cwd,
      autonomous: opts.autonomous,
    });
  }

  // Execute via provider
  const result = await provider.run({
    model,
    systemPrompt: agent.systemPrompt,
    userMessage: task,
    timeout,
  });

  const output = result.output;
  const completedAt = new Date().toISOString();

  // Parse metrics from output
  const metrics = parseMetrics(output, result.durationMs);

  // Detect truncated runs (max turns reached = not a real success)
  const isMaxTurns = output.startsWith('Error: Reached max turns');
  const success = !isMaxTurns && output.length > 50;

  // Create experiment record
  const experiment = createExperiment(
    agent,
    task,
    output,
    startedAt,
    completedAt,
    success,
    metrics,
    opts,
  );

  // Save report to disk
  const reportPath = saveReport(experiment, dataDir);

  return {
    experiment,
    output,
    reportPath,
  };
}

// ─── Error Type ──────────────────────────────────────

/**
 * Error thrown when an LLM provider fails.
 * Preserves the exit code (CLI) and any partial output for debugging.
 */
export class RunnerError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly partialOutput: string,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}
