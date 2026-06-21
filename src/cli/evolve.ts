/**
 * darwin evolve <agent>
 *
 * Manage evolution settings for an agent.
 *
 * Usage:
 *   darwin evolve researcher --enable
 *   darwin evolve researcher --disable
 *   darwin evolve researcher --reset
 *   darwin evolve researcher --force            (force one optimization now)
 *   darwin evolve researcher --gepa --coverage  (persist advanced config flags)
 *   darwin evolve researcher --reflection-model claude-opus-4-8
 *
 * Advanced flags (persisted, also accepted by `darwin run`):
 *   --gepa / --no-gepa            GEPA reflective optimizer
 *   --merge / --no-merge          GEPA system-aware merge
 *   --pareto-gate / --no-pareto-gate   multi-objective A/B activation gate
 *   --coverage / --no-coverage    instance-wise coverage selection
 *   --reflection-model <id>       stronger reflection model for GEPA
 */

import { createMemory } from '../memory/index.js';
import { loadConfig } from '../core/agent.js';
import { builtinAgents } from '../agents/index.js';
import {
  resolveEvolutionEnabled,
  resolveEvolutionConfig,
  setEvolutionEnabled,
  setEvolutionConfigOverrides,
} from '../evolution/enabled-state.js';
import { buildEvolutionLoop } from '../evolution/build-loop.js';
import { parseEvolutionConfigFlags, hasAnyEvolutionFlag } from './evolution-flags.js';
import type { AgentDefinition, EvolutionConfig } from '../types.js';

export async function evolveCommand(args: string[]): Promise<void> {
  const agentName = args[0];
  if (!agentName) {
    throw new Error('Usage: darwin evolve <agent> [--enable|--disable|--reset|--force|--gepa|--coverage|…]');
  }

  const agent = builtinAgents[agentName];
  if (!agent) {
    throw new Error(`Unknown agent: "${agentName}". Available: ${Object.keys(builtinAgents).join(', ')}`);
  }

  // Separate the advanced evolution-config flags from the action flags.
  const { override, rest: flags } = parseEvolutionConfigFlags(args.slice(1));
  const config = await loadConfig();
  const memory = createMemory(config);
  await memory.init();

  // Persist advanced-config flags FIRST (so e.g. `--force --gepa` forces with
  // GEPA on, and `--gepa --coverage` alone just records the config).
  if (hasAnyEvolutionFlag(override)) {
    await setEvolutionConfigOverrides(memory, agentName, override);
    console.log(`[darwin] Evolution config updated for ${agentName}: ${describeOverride(override)}`);
  }

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
    // Build the loop with the resolved advanced config (persisted overrides +
    // any flags passed on this command line) so `--force --gepa` etc. take
    // effect for the forced cycle.
    const state = await memory.getState();
    const resolvedEvolution = resolveEvolutionConfig(agent, state);
    const evolutionAgent: AgentDefinition = resolvedEvolution
      ? { ...agent, evolution: resolvedEvolution }
      : agent;
    const loop = buildEvolutionLoop(evolutionAgent, config, memory);
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
  } else if (!hasAnyEvolutionFlag(override)) {
    // Show current status (only when no config flag was the whole command —
    // a bare `--gepa` already printed its confirmation above).
    const state = await memory.getState();
    const version = state.activeVersions[agentName] ?? 'v1';
    const runs = state.experimentCounts[agentName] ?? 0;
    const abTest = state.abTests[agentName];
    // Reflect the PERSISTED override (set by --enable/--disable) so `darwin
    // evolve <agent>` reports the same enabled-state `darwin run` will act on.
    const enabled = resolveEvolutionEnabled(agent, state);
    const evo = resolveEvolutionConfig(agent, state);

    console.log(`\n[darwin] Evolution for ${agentName}:`);
    console.log(`  Enabled:   ${enabled ? 'yes' : 'no'}`);
    console.log(`  Version:   ${version}`);
    console.log(`  Runs:      ${runs}`);
    console.log(`  A/B Test:  ${abTest ? `${abTest.versionA} vs ${abTest.versionB}` : 'none'}`);
    console.log(`  Min Runs:  ${agent.evolution?.minRuns ?? 5}`);
    console.log(`  Advanced:  ${describeConfig(evo)}`);
  }

  await memory.close();
}

/** One-line summary of which advanced flags an override set (for confirmation). */
function describeOverride(o: { useGepa?: boolean; useMerge?: boolean; paretoGate?: boolean; useCoverage?: boolean; reflectionModel?: string }): string {
  const parts: string[] = [];
  if (o.useGepa !== undefined) parts.push(`gepa=${o.useGepa}`);
  if (o.useMerge !== undefined) parts.push(`merge=${o.useMerge}`);
  if (o.paretoGate !== undefined) parts.push(`paretoGate=${o.paretoGate}`);
  if (o.useCoverage !== undefined) parts.push(`coverage=${o.useCoverage}`);
  if (o.reflectionModel !== undefined) parts.push(`reflectionModel=${o.reflectionModel}`);
  return parts.length > 0 ? parts.join(', ') : '(none)';
}

/** One-line summary of the effective advanced config for the status view. */
function describeConfig(evo: EvolutionConfig | undefined): string {
  if (!evo) return '(no evolution config)';
  const parts = [
    `gepa=${evo.useGepa ?? false}`,
    `merge=${evo.useMerge ?? false}`,
    `paretoGate=${evo.paretoGate ?? false}`,
    `coverage=${evo.useCoverage ?? false}`,
  ];
  if (evo.reflectionModel) parts.push(`reflectionModel=${evo.reflectionModel}`);
  return parts.join(', ');
}
