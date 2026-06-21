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

import type {
  AgentDefinition,
  DarwinState,
  EvolutionConfig,
  EvolutionConfigOverride,
  MemoryProvider,
} from '../types.js';

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

// ─── Advanced evolution-config overrides (useGepa / useMerge / …) ───

/** The keys the CLI is allowed to override + persist. */
const OVERRIDE_KEYS = [
  'useGepa',
  'useMerge',
  'paretoGate',
  'useCoverage',
  'reflectionModel',
] as const;

/**
 * Resolve the effective {@link EvolutionConfig} for an agent: the static
 * definition's `evolution` block with any persisted override
 * ({@link DarwinState.evolutionConfigOverrides}) merged ON TOP, then any
 * in-this-process CLI override merged last (e.g. `darwin run … --gepa`).
 *
 * Only the five advanced flags are overridable; every other field
 * (`enabled`, `metrics`, `minRuns`, …) is taken verbatim from the static
 * config. Returns `undefined` when the agent has no `evolution` block AND no
 * persisted/CLI override would create one — overriding a flag on an agent that
 * never opted into evolution is meaningless.
 *
 * Read defensively: undefined override values are skipped so they never clobber
 * a static default with `undefined`.
 */
export function resolveEvolutionConfig(
  agent: AgentDefinition,
  state: Pick<DarwinState, 'evolutionConfigOverrides'>,
  cliOverride?: EvolutionConfigOverride,
): EvolutionConfig | undefined {
  const persisted = state.evolutionConfigOverrides?.[agent.name];
  const base = agent.evolution;

  if (!base && !persisted && !cliOverride) {
    return undefined;
  }

  // Start from the static config (or a disabled stub when the only reason we
  // are here is an override — the loop still gates on `enabled`, which stays
  // false unless the static config or the separate enable-toggle turns it on).
  const resolved: EvolutionConfig = base ? { ...base } : { enabled: false };

  for (const layer of [persisted, cliOverride]) {
    if (!layer) continue;
    for (const key of OVERRIDE_KEYS) {
      const value = layer[key];
      if (value !== undefined) {
        // Each key is assigned to its own matching field — typed per-key to
        // keep `any` out of the codebase.
        if (key === 'reflectionModel') {
          resolved.reflectionModel = value as string;
        } else {
          resolved[key] = value as boolean;
        }
      }
    }
  }

  return resolved;
}

/**
 * Persist advanced-config overrides for an agent atomically, merging the given
 * partial into any existing override map (so toggling `--gepa` does not wipe a
 * previously-set `--reflection-model`). Initialises the map lazily for state
 * rows that predate the field.
 */
export async function setEvolutionConfigOverrides(
  memory: MemoryProvider,
  agentName: string,
  partial: EvolutionConfigOverride,
): Promise<void> {
  await memory.updateState((state) => {
    if (!state.evolutionConfigOverrides) {
      state.evolutionConfigOverrides = {};
    }
    const existing = state.evolutionConfigOverrides[agentName] ?? {};
    state.evolutionConfigOverrides[agentName] = { ...existing, ...partial };
    return state;
  });
}
