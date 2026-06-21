/**
 * Darwin — Persisted Evolution Enable/Disable State
 *
 * `darwin evolve <agent> --enable|--disable` used to mutate the in-memory
 * agent singleton (`agent.evolution.enabled = true`) and never persist it,
 * so the flag was lost the moment the process exited — and `darwin run`
 * then read the STATIC source default again. This module makes the toggle
 * durable by recording it in {@link DarwinState.evolutionEnabled} (the same
 * JSON state blob every backend already round-trips) and resolving the
 * effective value with the persisted override winning over the static
 * default.
 */

import type { AgentDefinition, DarwinState, MemoryProvider } from '../types.js';

/**
 * The effective "is evolution enabled for this agent" decision.
 *
 * Resolution order:
 *   1. A persisted override in `state.evolutionEnabled[agentName]` (set by
 *      `darwin evolve --enable/--disable`) — wins when present.
 *   2. The agent definition's static `evolution.enabled` default.
 *   3. `false` when the agent has no `evolution` block at all.
 *
 * Read defensively: state written before the `evolutionEnabled` field
 * existed simply lacks the key, in which case rule 1 is skipped and the
 * static default applies — so old installs keep their previous behaviour.
 */
export function resolveEvolutionEnabled(
  agent: AgentDefinition,
  state: Pick<DarwinState, 'evolutionEnabled'>,
): boolean {
  const persisted = state.evolutionEnabled?.[agent.name];
  if (typeof persisted === 'boolean') {
    // A persisted `true` only takes effect when the agent actually carries an
    // `evolution` config block — the run/critic loop needs an evaluator and
    // metrics to act on. Enabling an agent that has no evolution config is a
    // no-op (returns false), not a crash. A persisted `false` always disables.
    return persisted && agent.evolution !== undefined;
  }
  return agent.evolution?.enabled ?? false;
}

/**
 * Persist the enable/disable override for an agent atomically.
 *
 * Uses {@link MemoryProvider.updateState} so a concurrent writer cannot lose
 * the update, and initialises the `evolutionEnabled` map lazily for state
 * rows that predate the field.
 */
export async function setEvolutionEnabled(
  memory: MemoryProvider,
  agentName: string,
  enabled: boolean,
): Promise<void> {
  await memory.updateState((state) => {
    if (!state.evolutionEnabled) {
      state.evolutionEnabled = {};
    }
    state.evolutionEnabled[agentName] = enabled;
    return state;
  });
}
