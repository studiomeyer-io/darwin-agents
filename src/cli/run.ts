/**
 * darwin run <agent> "task"
 *
 * Runs an agent, optionally evaluates with critic, triggers Darwin evolution.
 */

import { builtinAgents } from '../agents/index.js';
import { createMemory } from '../memory/index.js';
import { runAgent } from '../core/runner.js';
import { loadConfig } from '../core/agent.js';
import { runMultiCritic, getCriticPrompts } from '../evolution/multi-critic.js';
import { createProvider } from '../providers/index.js';
import type { LLMProvider, ProviderConfig } from '../providers/types.js';
import type { AgentDefinition, DarwinConfig, MemoryProvider, PromptVersion } from '../types.js';
import { resolveEvolutionEnabled } from '../evolution/enabled-state.js';
import { parseCriticScore } from '../evolution/parse-score.js';
import { checkCriticFamilies, crossFamilyRequired, singleFamilyHint } from '../evolution/critic-families.js';
import { buildResolvedEvolutionLoop } from '../evolution/build-loop.js';
import { isEvolutionConfigFlag, applyEvolutionFlag } from './evolution-flags.js';
import type { ABTest, EvolutionConfigOverride } from '../types.js';

// ─── Multi-Model Critic Provider Resolution ─────────

interface CriticProviderInfo {
  provider?: LLMProvider;
  model: string;
  label: string;
  /** Model family (e.g. 'anthropic', 'openai') — drives the cross-family bias check. */
  family: string;
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
    defaults[name] = { model: 'claude-sonnet-4-6', label: 'claude-cli', family: 'anthropic' };
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
        family: 'openai',
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
        model: 'claude-sonnet-4-6',
        label: 'anthropic-api',
        family: 'anthropic',
      };
    } catch {
      // No valid key — stay on CLI
    }
  }

  return defaults;
}

export interface RunFlags {
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
  /** Advanced evolution-config toggles for this run (--gepa/--coverage/…) */
  evolutionOverride: EvolutionConfigOverride;
}

// Exported for tests (v0.14.0) — the CLI surface was the least-covered code
// in the repo while carrying real parsing bugs (the 0.13.2 single-dash `-v`
// regression lived exactly here).
export function parseRunArgs(args: string[]): RunFlags {
  const flags: RunFlags = {
    agentName: '',
    task: '',
    taskType: 'general',
    noEvolve: false,
    noCritic: false,
    verbose: false,
    evolutionOverride: {},
  };

  const positional: string[] = [];
  /**
   * The value of a value-taking flag, or undefined when the next token is a
   * FLAG rather than a value.
   *
   * v0.17.0 — these five flags took `args[++i]` unconditionally, so a missing
   * value swallowed whatever came next. Measured:
   *
   *     darwin run writer --task-type --no-evolve "Do X"
   *       -> taskType = "--no-evolve", noEvolve = FALSE
   *
   * The run then went ahead with A/B routing and the evolution loop, and
   * counted into the statistics the operator had just asked to be left alone.
   * Silent, exit 0, and the junk label went into the experiment record.
   * `--task-type --no-critic` likewise ran the critic, which is a real model
   * call and real money.
   *
   * The identical class was found and closed twice in this release, first for
   * `darwin approve` and then for `darwin evolve`'s two oldest value flags. It
   * was pre-existing here, and it is the last parser in src/cli that had it.
   * `tests/evolution-config-flags.test.ts` now guards the PATTERN across the
   * whole directory rather than one module's flag list, which is what the
   * previous two fixes should have done.
   *
   * Single-dash counts: `-v` is a real flag in this very parser.
   */
  const valueFor = (i: number, flag: string): string | undefined => {
    const next = args[i + 1];
    if (next === undefined || next.startsWith('-')) {
      console.warn(`[darwin] ${flag} needs a value; ignored.`);
      return undefined;
    }
    return next;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--task-type': {
        const v = valueFor(i, '--task-type');
        if (v !== undefined) { flags.taskType = v; i++; }
        break;
      }
      case '--no-evolve':
        flags.noEvolve = true;
        break;
      case '--no-critic':
        flags.noCritic = true;
        break;
      case '--model': {
        const v = valueFor(i, '--model');
        if (v !== undefined) { flags.model = v; i++; }
        break;
      }
      case '--path': {
        const v = valueFor(i, '--path');
        if (v !== undefined) { flags.path = v; i++; }
        break;
      }
      case '--provider': {
        const v = valueFor(i, '--provider');
        if (v !== undefined) { flags.provider = v as ProviderConfig['type']; i++; }
        break;
      }
      case '--base-url': {
        const v = valueFor(i, '--base-url');
        if (v !== undefined) { flags.baseUrl = v; i++; }
        break;
      }
      case '--verbose':
      case '-v':
        flags.verbose = true;
        break;
      default:
        if (isEvolutionConfigFlag(arg)) {
          i += applyEvolutionFlag(arg, args[i + 1], flags.evolutionOverride);
        } else {
          positional.push(arg);
        }
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

/**
 * Which prompt version should THIS run use? (v0.14.0 — exported for tests.)
 *
 * - Active A/B test AND evolution enabled → round-robin the arm with fewer
 *   runs (the pre-v0.14 behaviour).
 * - Otherwise → the agent's ACTIVE version. Two real bugs lived here
 *   (cross-model review, v0.14.0):
 *     1. Without a running test the CLI always ran the STATIC v1 prompt —
 *        a promoted winner (v3 active in state) never actually ran, and its
 *        runs were recorded against v1, corrupting the version stats.
 *     2. `darwin evolve --disable` did not stop the A/B routing, so a
 *        disabled agent kept sending ~50% of its traffic through the
 *        challenger — with the test counters frozen, forever.
 */
export function pickRunVersion(
  abTest: ABTest | null,
  evolutionEnabled: boolean,
  activeVersion: string,
): string {
  if (evolutionEnabled && abTest) {
    return abTest.runsA <= abTest.runsB ? abTest.versionA : abTest.versionB;
  }
  return activeVersion;
}

/**
 * Are both arms of an A/B test backed by a resolvable prompt? `v1` always
 * resolves (the agent definition is its floor); any other label needs a
 * stored prompt. (v0.14.0 — exported for tests.)
 *
 * Why this exists (R4 review, P0): when an open test references an arm whose
 * stored prompt has vanished (corrupted/foreign state), routing would fall
 * back to v1 and RELABEL the run as v1 — which `handleABTest` then counts
 * for whichever arm happens to be labeled v1, or for neither, so the test
 * either decides on wrong data or starves forever. An unresolvable test is
 * dead on arrival; the caller clears it and runs the active version.
 */
export function abTestArmsResolvable(
  abTest: ABTest,
  storedVersions: ReadonlyArray<Pick<PromptVersion, 'version'>>,
): boolean {
  const resolvable = (label: string): boolean =>
    label === 'v1' || storedVersions.some((v) => v.version === label);
  return resolvable(abTest.versionA) && resolvable(abTest.versionB);
}

/**
 * Resolve the prompt TEXT + the version label the experiment must be recorded
 * under. (v0.14.0 — exported for tests; R3 review closed two gaps here.)
 *
 * Invariant: the returned `version` always names the prompt that actually
 * RUNS. When state requests a label with no stored prompt (corrupted/foreign
 * state), we fall back to the static v1 prompt AND relabel the run as v1 —
 * recording a static-v1 output under the missing label would corrupt that
 * label's stats and could decide an A/B test with wrong data.
 *
 * v1 itself prefers the STORED v1 prompt when one exists (the seeded copy),
 * falling back to the agent definition. `darwin eval` resolves versions the
 * same way, so a built-in prompt edited after seeding no longer makes live
 * runs and offline evals score different texts under the same label.
 */
export function resolveRunPrompt(
  agent: AgentDefinition,
  storedVersions: ReadonlyArray<Pick<PromptVersion, 'version' | 'promptText'>>,
  requestedVersion: string,
): { version: string; promptText: string; missingStored: boolean } {
  const stored = storedVersions.find((v) => v.version === requestedVersion);
  if (stored) {
    return { version: requestedVersion, promptText: stored.promptText, missingStored: false };
  }
  if (requestedVersion === 'v1') {
    return { version: 'v1', promptText: agent.systemPrompt, missingStored: false };
  }
  // Requested label has no stored prompt — run static v1, AS v1.
  const storedV1 = storedVersions.find((v) => v.version === 'v1');
  return {
    version: 'v1',
    promptText: storedV1?.promptText ?? agent.systemPrompt,
    missingStored: true,
  };
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

  // Resolve the effective evolution-enabled flag ONCE from persisted state.
  // `darwin evolve --enable/--disable` records the override in DarwinState; a
  // persisted value wins over the agent definition's static default. Reading
  // the static `agent.evolution?.enabled` directly (the v0.7.1 behaviour) lost
  // the toggle across processes.
  const preState = await memory.getState();
  const evolutionEnabled = resolveEvolutionEnabled(agent, preState);

  // Prompt-version routing (v0.14.0 — see pickRunVersion for the two bugs
  // this replaces): with an active test and evolution enabled, round-robin
  // the arms; otherwise run the agent's ACTIVE version, which after a
  // promoted A/B win is the evolved prompt, not the static default.
  // `--no-evolve` counts as disabled for routing too (R3 review): the loop
  // is skipped after the run, so a challenger run would not even be counted —
  // pure waste of a live request on an arm nobody is measuring.
  const routingEnabled = evolutionEnabled && !flags.noEvolve;
  const allVersions = await memory.getAllPromptVersions(agent.name);
  let abTest = routingEnabled ? (preState.abTests[agent.name] ?? null) : null;

  // Orphaned-test repair (R4 review, P0): a test whose arm has no stored
  // prompt can never be measured correctly — routing would relabel its runs
  // to v1 and the test would decide on wrong data or starve forever. Clear
  // it loudly and continue on the active version; the freed slot lets the
  // next evolution cycle start a fresh, resolvable test.
  if (abTest && !abTestArmsResolvable(abTest, allVersions)) {
    console.warn(
      `[darwin] ⚠  A/B test ${abTest.versionA} vs ${abTest.versionB} references a version with no stored prompt — clearing the dead test.`,
    );
    // Clear ONLY the exact test we diagnosed (R5 review, P0 — TOCTOU): the
    // snapshot is from before this process's awaits, and a concurrent
    // process may have replaced the dead test with a fresh, valid one. The
    // identity check runs inside the atomic updateState callback.
    const dead = abTest;
    await memory.updateState((s) => {
      const cur = s.abTests[agent.name];
      if (
        cur &&
        cur.versionA === dead.versionA &&
        cur.versionB === dead.versionB &&
        cur.startedAt === dead.startedAt
      ) {
        s.abTests[agent.name] = null;
        // The dead test's failure era ends with it (same rule as every
        // test-closing path in the loop).
        s.consecutiveFailures[agent.name] = 0;
      }
      return s;
    });
    abTest = null;
  }

  const stateActiveVersion = preState.activeVersions[agent.name] ?? 'v1';
  const requestedVersion = pickRunVersion(abTest, routingEnabled, stateActiveVersion);
  const resolved = resolveRunPrompt(agent, allVersions, requestedVersion);
  const activePromptVersion = resolved.version;
  const agentToRun: AgentDefinition =
    resolved.promptText === agent.systemPrompt
      ? agent
      : { ...agent, systemPrompt: resolved.promptText };
  if (resolved.missingStored) {
    // A version label with no stored prompt means corrupted/foreign state.
    // resolveRunPrompt already relabeled the run to the prompt that actually
    // runs (v1) — say so loudly instead of silently mislabeling experiments.
    console.warn(
      `[darwin] ⚠  Active version ${requestedVersion} has no stored prompt — running (and recording) v1 instead.`,
    );
  }
  if (abTest) {
    console.log(`[darwin] A/B test: Using prompt ${activePromptVersion}`);
  } else if (activePromptVersion !== 'v1') {
    console.log(`[darwin] Active prompt: ${activePromptVersion}`);
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

  // Seed v1 prompt version if it doesn't exist yet (allVersions was loaded
  // before the run — one lookup serves routing AND the seed check, R3 review).
  if (allVersions.length === 0) {
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

  // Incomplete-run detection. Too-short output is never SAVED (it would
  // poison the stats) and never judged — but it MUST still reach the
  // evolution loop (R6 review, P0): `afterRun`'s step 0 is where an
  // incomplete run counts against its A/B arm (failsA/failsB → unreliability
  // auto-loss) and where an expired test gets closed. The old early-return
  // here made that entire path unreachable from the CLI, so an unreliable
  // challenger kept being routed live traffic forever.
  const MIN_SAVE_OUTPUT = agent.evolution?.minOutputLength ?? 2000;
  const incompleteRun = result.experiment.metrics.outputLength < MIN_SAVE_OUTPUT;
  if (incompleteRun) {
    // Say what will actually happen (R7 review): the loop only runs when
    // evolution is on and --no-evolve was not passed.
    const loopWillRun = evolutionEnabled && !flags.noEvolve;
    console.log(
      `\n[darwin] Output too short (${result.experiment.metrics.outputLength} chars < ${MIN_SAVE_OUTPUT}). ` +
        `Not saved${loopWillRun
          ? ' — still handed to the evolution loop for A/B reliability tracking.'
          : '; evolution is off for this run, so it is not counted anywhere.'}`,
    );
  }

  // Save experiment — tracker.recordExperiment() handles this for evolution-enabled agents.
  // Only save here for non-evolution agents to avoid double-save.
  if (!evolutionEnabled && !incompleteRun) {
    await memory.saveExperiment(result.experiment);
    await memory.updateState((state) => {
      state.experimentCounts[agent.name] = (state.experimentCounts[agent.name] ?? 0) + 1;
      if (!state.activeVersions[agent.name]) {
        state.activeVersions[agent.name] = 'v1';
      }
      return state;
    });
  }

  // Run critic evaluation (unless skipped; never on incomplete output —
  // judging a truncated run wastes an LLM call on data step 0 will discard)
  if (!incompleteRun && !flags.noCritic && agent.name !== 'critic' && agent.name !== 'investigator-critic' && agent.name !== 'multi-critic' && evolutionEnabled) {
    const evaluatorName = agent.evolution?.evaluator ?? 'critic';

    if (evaluatorName === 'multi-critic') {
      // ── Multi-Critic Mode — Multi-Model ───────────
      const criticProviders = resolveCriticProviders(agent.name);

      // Cross-family bias check: if every critic collapsed onto a single model
      // family (e.g. only a Claude key present, so claude-cli + anthropic-api),
      // the LLM-as-judge diversity guarantee is gone. Warn by default; hard-fail
      // when DARWIN_REQUIRE_CROSS_FAMILY is set (CI / strict setups).
      const familyCheck = checkCriticFamilies(criticProviders);
      if (familyCheck.singleFamily) {
        const hint = singleFamilyHint(familyCheck);
        if (crossFamilyRequired()) {
          throw new Error(`[darwin] DARWIN_REQUIRE_CROSS_FAMILY is set. ${hint}`);
        }
        console.warn(`[darwin] ⚠  ${hint}`);
      }

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
              model: criticInfo?.model ?? 'claude-sonnet-4-6',
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
        { normalizeForJudging: agent.evolution?.normalizeForJudging },
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

      // Parse critic score with the shared robust extractor (handles
      // ===SCORE===, N/10, "N out of 10", "rating: N", "I'd rate this N", …;
      // already clamped to 1–10). Previously only ===SCORE=== + a bare N/10
      // were handled, silently dropping every other phrasing from evolution.
      const score = parseCriticScore(criticResult.output);

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
  if (!flags.noEvolve && evolutionEnabled) {
    // Resolve the advanced evolution config: static definition < persisted
    // overrides (darwin evolve --gepa/…) < this run's CLI flags. The resulting
    // config drives both the GEPA wiring and the loop. With no overrides set,
    // resolvedEvolution === the static config, so the loop is wired exactly as
    // before (default path unchanged).
    const loop = buildResolvedEvolutionLoop(
      agent, preState, config, memory, flags.evolutionOverride,
    );

    console.log(`\n[darwin] Evolution: Running Darwin loop...`);
    const evoResult = await loop.afterRun(result.experiment);

    if (evoResult.rolledBack) {
      console.log(`[darwin] ROLLBACK: ${evoResult.message}`);
    } else if (evoResult.awaitingApproval) {
      // v0.17.0: its own branch, above the generic tail. A held proposal needs
      // a person, and the plain `[darwin] <message>` line reads like every
      // other "nothing to do here" status, which is exactly how an agent
      // quietly stops evolving.
      console.log(`[darwin] APPROVAL NEEDED: ${evoResult.message}`);
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
