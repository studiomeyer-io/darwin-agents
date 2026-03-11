/**
 * darwin run <agent> "task"
 *
 * Runs an agent, optionally evaluates with critic, triggers Darwin evolution.
 */

import { builtinAgents } from '../agents/index.js';
import { createMemory } from '../memory/index.js';
import { runAgent } from '../core/runner.js';
import { loadConfig } from '../core/agent.js';
import { DarwinLoop } from '../evolution/loop.js';
import { ExperimentTracker } from '../evolution/tracker.js';
import { PatternDetector } from '../evolution/patterns.js';
import { PromptOptimizer } from '../evolution/optimizer.js';
import { SafetyGate } from '../evolution/safety.js';
import { runMultiCritic, getCriticPrompts } from '../evolution/multi-critic.js';
import { loadNotificationConfig } from '../evolution/notifications.js';
import { createProvider } from '../providers/index.js';
import type { LLMProvider, ProviderConfig } from '../providers/types.js';
import type { AgentDefinition, DarwinConfig, MemoryProvider, PromptVersion } from '../types.js';

// ─── Multi-Model Critic Provider Resolution ─────────

interface CriticProviderInfo {
  provider?: LLMProvider;
  model: string;
  label: string;
}

/**
 * Auto-detect available API keys and assign different providers to critics.
 * Reduces LLM-as-judge bias by using multiple model families.
 *
 * Uses the agent's critic prompt set to determine critic names, then distributes
 * providers across them by index position:
 *   - Critic[0] → GPT-5.4 (if OPENAI_API_KEY, different model family)
 *   - Critic[1] → Claude Sonnet API (if ANTHROPIC_API_KEY, faster than CLI)
 *   - Critic[2] → Claude CLI (always free in Max Plan)
 */
function resolveCriticProviders(agentName: string): Record<string, CriticProviderInfo> {
  const prompts = getCriticPrompts(agentName);
  const defaults: Record<string, CriticProviderInfo> = {};

  // Initialize all critics with CLI default
  for (const { name } of prompts) {
    defaults[name] = { model: 'claude-sonnet-4-20250514', label: 'claude-cli' };
  }

  const criticNames = prompts.map(p => p.name);

  // GPT-5.4 for first critic (model diversity — different training, different biases)
  if (process.env.OPENAI_API_KEY && criticNames[0]) {
    try {
      const openaiProvider = createProvider({ type: 'openai' });
      defaults[criticNames[0]] = {
        provider: openaiProvider,
        model: 'gpt-5.4',
        label: 'openai/gpt-5.4',
      };
    } catch {
      // No valid key — stay on Claude CLI
    }
  }

  // Anthropic API for second critic (same model family but 10-100x faster than CLI)
  if (process.env.ANTHROPIC_API_KEY && criticNames[1]) {
    try {
      const anthropicProvider = createProvider({ type: 'anthropic-api' });
      defaults[criticNames[1]] = {
        provider: anthropicProvider,
        model: 'claude-sonnet-4-20250514',
        label: 'anthropic-api',
      };
    } catch {
      // No valid key — stay on CLI
    }
  }

  return defaults;
}

interface RunFlags {
  agentName: string;
  task: string;
  taskType: string;
  noEvolve: boolean;
  noCritic: boolean;
  model?: string;
  path?: string;
  verbose: boolean;
  /** Provider override: anthropic-api, openai, ollama */
  provider?: ProviderConfig['type'];
  /** Base URL for OpenAI-compatible / Ollama endpoints */
  baseUrl?: string;
}

function parseRunArgs(args: string[]): RunFlags {
  const flags: RunFlags = {
    agentName: '',
    task: '',
    taskType: 'general',
    noEvolve: false,
    noCritic: false,
    verbose: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--task-type':
        flags.taskType = args[++i] ?? 'general';
        break;
      case '--no-evolve':
        flags.noEvolve = true;
        break;
      case '--no-critic':
        flags.noCritic = true;
        break;
      case '--model':
        flags.model = args[++i];
        break;
      case '--path':
        flags.path = args[++i];
        break;
      case '--provider':
        flags.provider = args[++i] as ProviderConfig['type'];
        break;
      case '--base-url':
        flags.baseUrl = args[++i];
        break;
      case '--verbose':
      case '-v':
        flags.verbose = true;
        break;
      default:
        positional.push(arg);
    }
  }

  flags.agentName = positional[0] ?? '';
  flags.task = positional.slice(1).join(' ');

  return flags;
}

function resolveAgent(name: string): AgentDefinition {
  const agent = builtinAgents[name];
  if (!agent) {
    const available = Object.keys(builtinAgents).join(', ');
    throw new Error(`Unknown agent: "${name}". Available: ${available}`);
  }
  return agent;
}

export async function runCommand(args: string[]): Promise<void> {
  const flags = parseRunArgs(args);

  if (!flags.agentName) {
    throw new Error('Usage: darwin run <agent> "task description"');
  }
  if (!flags.task && !flags.path) {
    throw new Error('Provide a task: darwin run writer "Explain async/await"');
  }

  const agent = resolveAgent(flags.agentName);
  const config = await loadConfig();
  const memory = createMemory(config);
  await memory.init();

  try {
  return await runCommandInner(flags, agent, config, memory);
  } finally {
    await memory.close();
  }
}

async function runCommandInner(
  flags: RunFlags,
  agent: AgentDefinition,
  config: DarwinConfig,
  memory: MemoryProvider,
): Promise<void> {

  // Build task string
  let task = flags.task;
  if (flags.path) {
    task = task
      ? `${task}\n\nAnalyze path: ${flags.path}`
      : `Analyze the codebase at: ${flags.path}`;
  }

  // Resolve provider (CLI flag > config > default)
  let provider: LLMProvider | undefined;
  if (flags.provider) {
    provider = createProvider({
      type: flags.provider,
      baseUrl: flags.baseUrl,
    });
  }

  console.log(`\n[darwin] Running ${agent.name} (${agent.role})`);
  console.log(`[darwin] Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);
  console.log(`[darwin] Type: ${flags.taskType}`);
  if (flags.model) console.log(`[darwin] Model: ${flags.model}`);
  if (provider) console.log(`[darwin] Provider: ${provider.name}`);
  console.log('');

  // A/B test routing: check if there's an active test and pick a version
  let activePromptVersion = 'v1';
  let agentToRun = agent;
  {
    const preState = await memory.getState();
    const abTest = preState.abTests[agent.name] ?? null;
    if (abTest) {
      // Round-robin: pick whichever version has fewer runs
      activePromptVersion = abTest.runsA <= abTest.runsB ? abTest.versionA : abTest.versionB;

      // If using a non-v1 prompt, load it from DB and override systemPrompt
      if (activePromptVersion !== 'v1') {
        const allVersions = await memory.getAllPromptVersions(agent.name);
        const targetVersion = allVersions.find(v => v.version === activePromptVersion);
        if (targetVersion) {
          agentToRun = { ...agent, systemPrompt: targetVersion.promptText };
          console.log(`[darwin] A/B test: Using prompt ${activePromptVersion}`);
        }
      } else {
        console.log(`[darwin] A/B test: Using prompt ${activePromptVersion}`);
      }
    }
  }

  const startTime = Date.now();

  // Run the agent (with potentially overridden prompt for A/B testing)
  const result = await runAgent(agentToRun, task, {
    config,
    taskType: flags.taskType,
    model: flags.model,
    promptVersion: activePromptVersion,
    autonomous: true,
    provider,
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Show result summary
  console.log(`\n[darwin] Run complete (${duration}s)`);
  console.log(`[darwin] Output: ${result.output.length} chars`);
  if (result.reportPath) {
    console.log(`[darwin] Report: ${result.reportPath}`);
  }

  // Seed v1 prompt version if it doesn't exist yet
  const existingVersions = await memory.getAllPromptVersions(agent.name);
  if (existingVersions.length === 0) {
    const v1: PromptVersion = {
      version: 'v1',
      agentName: agent.name,
      promptText: agent.systemPrompt,
      createdAt: new Date().toISOString(),
      parentVersion: null,
      changeReason: 'Initial prompt',
      active: true,
      stats: { totalRuns: 0, avgQuality: 0, avgDuration: 0, successRate: 0, avgSourceCount: 0 },
    };
    await memory.savePromptVersion(v1);
    console.log(`[darwin] Seeded v1 prompt for ${agent.name}`);
  }

  // Save experiment to DB + update state
  // Skip saving if output is too short (incomplete run — avoid poisoning data)
  // Use agent-specific threshold (e.g., marketing content is naturally shorter than research reports)
  const MIN_SAVE_OUTPUT = agent.evolution?.minOutputLength ?? 2000;
  if (result.experiment.metrics.outputLength < MIN_SAVE_OUTPUT) {
    console.log(`\n[darwin] Output too short (${result.experiment.metrics.outputLength} chars < ${MIN_SAVE_OUTPUT}). Skipping DB save.`);
    return;
  }

  // Save experiment — tracker.recordExperiment() handles this for evolution-enabled agents.
  // Only save here for non-evolution agents to avoid double-save.
  if (!agent.evolution?.enabled) {
    await memory.saveExperiment(result.experiment);
    await memory.updateState((state) => {
      state.experimentCounts[agent.name] = (state.experimentCounts[agent.name] ?? 0) + 1;
      if (!state.activeVersions[agent.name]) {
        state.activeVersions[agent.name] = 'v1';
      }
      return state;
    });
  }

  // Run critic evaluation (unless skipped)
  if (!flags.noCritic && agent.name !== 'critic' && agent.name !== 'investigator-critic' && agent.name !== 'multi-critic' && agent.evolution?.enabled) {
    const evaluatorName = agent.evolution.evaluator ?? 'critic';

    if (evaluatorName === 'multi-critic') {
      // ── Multi-Critic Mode — Multi-Model ───────────
      const criticProviders = resolveCriticProviders(agent.name);
      const providerLabels = Object.entries(criticProviders)
        .map(([name, info]) => `${name}→${info.label}`)
        .join(', ');
      console.log(`\n[darwin] Evaluating with 3 critics (${providerLabels})...`);

      const multiResult = await runMultiCritic(
        result.output,
        task,
        async (systemPrompt: string, criticTask: string, criticName: string) => {
          const criticInfo = criticProviders[criticName];
          const criticRun = await runAgent(
            {
              name: 'multi-critic',
              role: 'Specialized Critic',
              description: 'One of 3 specialized critics for multi-critic evaluation',
              type: 'llm',
              systemPrompt,
              maxTurns: 3,
              model: criticInfo?.model ?? 'claude-sonnet-4-20250514',
            },
            criticTask,
            {
              config,
              taskType: 'evaluation',
              autonomous: true,
              provider: criticInfo?.provider,
            },
          );
          return criticRun.output;
        },
        agent.name,
      );

      if (multiResult.medianScore > 0) {
        result.experiment.metrics.qualityScore = multiResult.medianScore;
        result.experiment.feedback = {
          score: multiResult.medianScore,
          report: multiResult.combinedReport,
          evaluator: 'multi-critic',
        };
        await memory.saveExperiment(result.experiment);

        console.log(`[darwin] Multi-Critic scores:`);
        for (const c of multiResult.critics) {
          console.log(`  ${c.critic}: ${c.score > 0 ? `${c.score}/10` : 'FAILED'}`);
        }
        console.log(`[darwin] Median score: ${multiResult.medianScore}/10`);
      }
    } else {
      // ── Single Critic Mode (legacy) ───────────────
      console.log(`\n[darwin] Evaluating with ${evaluatorName}...`);
      const criticAgent = resolveAgent(evaluatorName);
      const criticTask = `Evaluate the following ${agent.role} output for the task "${task}":\n\n${result.output}`;

      const criticResult = await runAgent(criticAgent, criticTask, {
        config,
        taskType: 'evaluation',
        autonomous: true,
      });

      // Parse critic score (primary: ===SCORE=== format, fallback: "X/10" pattern)
      const scoreMatch = criticResult.output.match(/===SCORE===\s*(\d+(?:\.\d+)?)/);
      let score = scoreMatch ? parseFloat(scoreMatch[1]) : null;
      if (score === null) {
        const fallback = criticResult.output.match(/\b(\d+(?:\.\d+)?)\s*\/\s*10\b/);
        if (fallback) {
          score = parseFloat(fallback[1]);
        }
      }
      if (score !== null) {
        score = Math.max(1, Math.min(10, score));
      }

      if (score !== null) {
        result.experiment.metrics.qualityScore = score;
        result.experiment.feedback = {
          score,
          report: criticResult.output,
          evaluator: evaluatorName,
        };
        await memory.saveExperiment(result.experiment);
        console.log(`[darwin] Critic score: ${score}/10`);
      }
    }
  }

  // Darwin evolution loop (unless skipped)
  if (!flags.noEvolve && agent.evolution?.enabled) {
    const tracker = new ExperimentTracker(memory);
    const patterns = new PatternDetector(memory);
    const safety = new SafetyGate();

    // The optimizer uses Claude CLI to generate improved prompts
    const optimizer = new PromptOptimizer(async (metaPrompt: string) => {
      const optimizerResult = await runAgent(
        {
          name: 'optimizer',
          role: 'Prompt Optimizer',
          description: 'Generates improved prompt variants',
          type: 'llm',
          systemPrompt: 'You are a prompt optimization expert. Return ONLY the improved prompt text.',
          maxTurns: 3,
          model: 'claude-sonnet-4-20250514',
        },
        metaPrompt,
        { config, taskType: 'optimization', autonomous: true },
      );
      return optimizerResult.output;
    });

    const notifications = loadNotificationConfig();
    const loop = new DarwinLoop({ memory, tracker, optimizer, safety, patterns, agent, notifications });

    console.log(`\n[darwin] Evolution: Running Darwin loop...`);
    const evoResult = await loop.afterRun(result.experiment);

    if (evoResult.rolledBack) {
      console.log(`[darwin] ROLLBACK: ${evoResult.message}`);
    } else if (evoResult.abTestStarted) {
      console.log(`[darwin] EVOLVED: ${evoResult.message}`);
    } else if (evoResult.abTestCompleted) {
      console.log(`[darwin] A/B TEST COMPLETE: ${evoResult.message}`);
    } else {
      console.log(`[darwin] ${evoResult.message}`);
    }

    if (evoResult.patternsFound.length > 0) {
      console.log(`[darwin] Patterns detected:`);
      for (const p of evoResult.patternsFound.slice(0, 5)) {
        console.log(`  ${p.type}: ${p.description}`);
      }
    }
  }

  // Print composite score
  const metrics = result.experiment.metrics;
  if (metrics.qualityScore !== null) {
    console.log(`\n╔═══════════════════════════════════════╗`);
    console.log(`║  ${agent.name.toUpperCase().padEnd(35)}  ║`);
    console.log(`╠═══════════════════════════════════════╣`);
    console.log(`║  Score:    ${String(metrics.qualityScore).padEnd(5)}/10                    ║`);
    console.log(`║  Sources:  ${String(metrics.sourceCount).padEnd(28)} ║`);
    console.log(`║  Length:   ${String(metrics.outputLength).padEnd(22)} chars ║`);
    console.log(`║  Duration: ${duration.padEnd(24)} s ║`);
    console.log(`╚═══════════════════════════════════════╝`);
  }

  // memory.close() handled by try/finally in runCommand()
}
