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
    if (agent.evolution) {
      agent.evolution.enabled = true;
    }
    console.log(`[darwin] Evolution ENABLED for ${agentName}`);
    console.log(`[darwin] The critic will evaluate runs and Darwin will optimize prompts automatically.`);
  } else if (flags.includes('--disable')) {
    if (agent.evolution) {
      agent.evolution.enabled = false;
    }
    console.log(`[darwin] Evolution DISABLED for ${agentName}`);
  } else if (flags.includes('--reset')) {
    const state = await memory.getState();
    state.activeVersions[agentName] = 'v1';
    state.abTests[agentName] = null;
    state.consecutiveFailures[agentName] = 0;
    await memory.saveState(state);
    console.log(`[darwin] Evolution RESET for ${agentName}. Back to v1.`);
  } else if (flags.includes('--force')) {
    console.log(`[darwin] Force evolution is not yet available.`);
    console.log(`[darwin] Run the agent normally — Darwin will evolve automatically after enough runs.`);
  } else {
    // Show current status
    const state = await memory.getState();
    const version = state.activeVersions[agentName] ?? 'v1';
    const runs = state.experimentCounts[agentName] ?? 0;
    const abTest = state.abTests[agentName];
    const enabled = agent.evolution?.enabled ?? false;

    console.log(`\n[darwin] Evolution for ${agentName}:`);
    console.log(`  Enabled:   ${enabled ? 'yes' : 'no'}`);
    console.log(`  Version:   ${version}`);
    console.log(`  Runs:      ${runs}`);
    console.log(`  A/B Test:  ${abTest ? `${abTest.versionA} vs ${abTest.versionB}` : 'none'}`);
    console.log(`  Min Runs:  ${agent.evolution?.minRuns ?? 5}`);
  }

  await memory.close();
}
