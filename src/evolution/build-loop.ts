/**
 * Darwin — Evolution-loop builder.
 *
 * Constructs a fully-wired {@link DarwinLoop} (tracker + patterns + safety +
 * legacy optimizer + opt-in GEPA reflective optimizer + notifications) for a
 * given agent. The optimizer/reflector closures route their LLM calls through
 * {@link runAgent} exactly the way `darwin run` does, so the on-demand
 * `darwin evolve --force` path produces the SAME challenger the automatic loop
 * would.
 */

import { runAgent } from '../core/runner.js';
import { DarwinLoop } from './loop.js';
import { ExperimentTracker } from './tracker.js';
import { PatternDetector } from './patterns.js';
import { PromptOptimizer } from './optimizer.js';
import { GepaOptimizer } from './optimizer-gepa.js';
import { SafetyGate } from './safety.js';
import { loadNotificationConfig } from './notifications.js';
import { metricsSinkFromEnv } from '../metrics/sink.js';
import type {
  AgentDefinition,
  DarwinConfig,
  DarwinState,
  EvolutionConfigOverride,
  MemoryProvider,
} from '../types.js';
import { DEFAULT_SAFETY } from '../types.js';
import { resolveEvolutionConfig } from './enabled-state.js';

/**
 * Build a DarwinLoop for `agent` against `memory`/`config`. Mirrors the wiring
 * in `cli/run.ts` so both the automatic (`afterRun`) and manual (`forceEvolve`)
 * entry points behave identically. GEPA is only wired when the agent opts in
 * via `evolution.useGepa`.
 */
export function buildEvolutionLoop(
  agent: AgentDefinition,
  config: DarwinConfig,
  memory: MemoryProvider,
): DarwinLoop {
  const tracker = new ExperimentTracker(memory);
  const patterns = new PatternDetector(memory);
  // v0.14.0 — per-agent safety thresholds. `evolution.safety` is a Partial
  // merged over DEFAULT_SAFETY, which finally makes the statistical-rigor
  // knobs (requireConfidence / confidenceMethod) reachable from agent
  // definitions and the CLI instead of only from hand-wired loops.
  const safety = agent.evolution?.safety
    ? new SafetyGate({ ...DEFAULT_SAFETY, ...agent.evolution.safety })
    : new SafetyGate();

  // The optimizer uses the configured provider to generate improved prompts.
  //
  // SECURITY (v0.12.2): optimizer + reflector are pure TEXT mutators — they
  // never need tools. Running them non-autonomously keeps the spawned CLI in
  // its deny-by-default permission mode instead of bypassPermissions, so a
  // prompt-injection smuggled in via critic feedback (which quotes untrusted
  // agent output, including scraped web content) cannot make the subprocess
  // execute tool calls. Legitimate runs are unaffected: the templates demand
  // "return ONLY the prompt text".
  const optimizer = new PromptOptimizer(async (metaPrompt: string) => {
    const optimizerResult = await runAgent(
      {
        name: 'optimizer',
        role: 'Prompt Optimizer',
        description: 'Generates improved prompt variants',
        type: 'llm',
        systemPrompt: 'You are a prompt optimization expert. Return ONLY the improved prompt text.',
        maxTurns: 3,
        model: 'claude-sonnet-4-6',
      },
      metaPrompt,
      { config, taskType: 'optimization', autonomous: false },
    );
    return optimizerResult.output;
  });

  // v0.6.0 — GEPA reflective optimizer (opt-in via agent.evolution.useGepa).
  let gepa: GepaOptimizer | undefined;
  if (agent.evolution?.useGepa) {
    const reflectionModel = agent.evolution.reflectionModel;
    if (!reflectionModel) {
      console.warn(
        '[darwin] evolution.useGepa is on but no evolution.reflectionModel is set — ' +
        'reflection will use the agent model. GEPA works best with a STRONGER reflection ' +
        'model (e.g. claude-opus-4-8); set agent.evolution.reflectionModel to silence this.',
      );
    }
    gepa = new GepaOptimizer(async (reflectionPrompt: string) => {
      const reflectionResult = await runAgent(
        {
          name: 'reflector',
          role: 'GEPA Reflector',
          description: 'Reflective prompt mutator (GEPA smallest-possible-edit)',
          type: 'llm',
          systemPrompt: 'You are a prompt-engineering reflector. Return ONLY the mutated prompt text.',
          maxTurns: 3,
          model: reflectionModel ?? agent.model ?? 'claude-sonnet-4-6',
        },
        reflectionPrompt,
        // Same deny-by-default posture as the optimizer above (v0.12.2).
        { config, taskType: 'reflection', autonomous: false },
      );
      return reflectionResult.output;
    });
  }

  const notifications = loadNotificationConfig();

  // v0.14.0 — env-wired metrics sink (DARWIN_METRICS_JSONL=<path> → JSONL
  // file). Programmatic consumers wiring DarwinLoop by hand pass their own
  // sink via deps.metrics instead.
  const metrics = metricsSinkFromEnv();

  return new DarwinLoop({ memory, tracker, optimizer, safety, patterns, agent, notifications, gepa, metrics });
}

/**
 * Resolve the effective evolution config for `agent` and build its loop.
 *
 * The one way a CLI command should get a loop. `darwin run`, `darwin evolve
 * --force` and `darwin approve` each used to spell this out themselves:
 *
 *     const resolved = resolveEvolutionConfig(agent, state, override);
 *     const evolutionAgent = resolved ? { ...agent, evolution: resolved } : agent;
 *     const loop = buildEvolutionLoop(evolutionAgent, config, memory);
 *
 * Three copies of a step that has exactly one way to be wrong: passing `agent`
 * instead of `evolutionAgent`. Round 3 of the adversarial review measured what
 * that costs. With the typo in place, `darwin evolve <agent>
 * --require-approval` confirms itself, every later run goes UNGATED, and all
 * 826 tests stay green, because the guard for that chain rebuilt the wiring in
 * a test helper instead of calling the thing the CLI calls.
 *
 * One function, one place to be wrong, and it is covered.
 */
export function buildResolvedEvolutionLoop(
  agent: AgentDefinition,
  state: Pick<DarwinState, 'evolutionConfigOverrides'>,
  config: DarwinConfig,
  memory: MemoryProvider,
  cliOverride?: EvolutionConfigOverride,
): DarwinLoop {
  const resolved = resolveEvolutionConfig(agent, state, cliOverride);
  const evolutionAgent: AgentDefinition = resolved
    ? { ...agent, evolution: resolved }
    : agent;
  return buildEvolutionLoop(evolutionAgent, config, memory);
}
