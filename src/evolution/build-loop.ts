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
import type { AgentDefinition, DarwinConfig, MemoryProvider } from '../types.js';

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
  const safety = new SafetyGate();

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
  return new DarwinLoop({ memory, tracker, optimizer, safety, patterns, agent, notifications, gepa });
}
