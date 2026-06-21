/**
 * darwin evolve <agent>
 *
 * Manage evolution settings for an agent.
 *
 * Usage:
 *   darwin evolve researcher --enable
 *   darwin evolve researcher --disable
 *   darwin evolve researcher --reset
 *   darwin evolve researcher --force   (force optimization now)
 */

import { createMemory } from '../memory/index.js';
import { loadConfig } from '../core/agent.js';
import { builtinAgents } from '../agents/index.js';
import { resolveEvolutionEnabled, setEvolutionEnabled } from '../evolution/enabled-state.js';
import { buildEvolutionLoop } from '../evolution/build-loop.js';

export async function evolveCommand(args: string[]): Promise<void> {
  const agentName = args[0];
  if (!agentName) {
    throw new Error('Usage: darwin evolve <agent> [--enable|--disable|--reset|--force]');
  }

  const agent = builtinAgents[agentName];
  if (!agent) {
    throw new Error(`Unknown agent: "${agentName}". Available: ${Object.keys(builtinAgents).join(', ')}`);
  }

  const flags = args.slice(1);
  const config = await loadConfig();
  const memory = createMemory(config);
  await memory.init();

  if (flags.includes('--enable')) {
    // Persist the override into DarwinState so it survives process exit.
    // (Mutating the in-memory singleton alone was the v0.7.1 bug — the flag
    // was gone the moment the CLI process ended and `darwin run` read the
    // static source default again.)
    if (agent.evolution) {
      agent.evolution.enabled = true;
    }
    await setEvolutionEnabled(memory, agentName, true);
    console.log(`[darwin] Evolution ENABLED for ${agentName}`);
    console.log(`[darwin] The critic will evaluate runs and Darwin will optimize prompts automatically.`);
  } else if (flags.includes('--disable')) {
    if (agent.evolution) {
      agent.evolution.enabled = false;
    }
    await setEvolutionEnabled(memory, agentName, false);
    console.log(`[darwin] Evolution DISABLED for ${agentName}`);
  } else if (flags.includes('--reset')) {
    const state = await memory.getState();
    state.activeVersions[agentName] = 'v1';
    state.abTests[agentName] = null;
    state.consecutiveFailures[agentName] = 0;
    await memory.saveState(state);
    console.log(`[darwin] Evolution RESET for ${agentName}. Back to v1.`);
  } else if (flags.includes('--force')) {
    // On-demand manual trigger: run the loop's variant-generation + A/B-start
    // path ONCE, bypassing the "enough runs / actionable patterns / data
    // quality" gates of the automatic loop. Uses the experiments collected so
    // far. Refuses cleanly when there is nothing to mutate from (no active
    // prompt / no experiments) or a test is already running.
    console.log(`[darwin] Forcing evolution for ${agentName}...`);
    const loop = buildEvolutionLoop(agent, config, memory);
    const evoResult = await loop.forceEvolve(agentName);
    if (evoResult.abTestStarted) {
      console.log(`[darwin] EVOLVED: ${evoResult.message}`);
    } else {
      console.log(`[darwin] ${evoResult.message}`);
    }
    if (evoResult.patternsFound.length > 0) {
      console.log(`[darwin] Patterns detected:`);
      for (const p of evoResult.patternsFound.slice(0, 5)) {
        console.log(`  ${p.type}: ${p.description}`);
      }
    }
  } else {
    // Show current status
    const state = await memory.getState();
    const version = state.activeVersions[agentName] ?? 'v1';
    const runs = state.experimentCounts[agentName] ?? 0;
    const abTest = state.abTests[agentName];
    // Reflect the PERSISTED override (set by --enable/--disable) so `darwin
    // evolve <agent>` reports the same enabled-state `darwin run` will act on.
    const enabled = resolveEvolutionEnabled(agent, state);

    console.log(`\n[darwin] Evolution for ${agentName}:`);
    console.log(`  Enabled:   ${enabled ? 'yes' : 'no'}`);
    console.log(`  Version:   ${version}`);
    console.log(`  Runs:      ${runs}`);
    console.log(`  A/B Test:  ${abTest ? `${abTest.versionA} vs ${abTest.versionB}` : 'none'}`);
    console.log(`  Min Runs:  ${agent.evolution?.minRuns ?? 5}`);
  }

  await memory.close();
}
