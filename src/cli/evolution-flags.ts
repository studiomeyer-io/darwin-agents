/**
 * Darwin CLI — shared parser for the advanced evolution-config flags.
 *
 * Both `darwin run` and `darwin evolve` accept the same knobs that toggle the
 * v0.6/v0.7 evolution config (GEPA reflective optimizer, system-aware merge,
 * Pareto activation gate, instance-wise coverage selection, and the reflection
 * model). This module centralises the flag spelling + parsing so the two
 * commands stay in sync.
 *
 *   --gepa / --no-gepa
 *   --merge / --no-merge
 *   --pareto-gate / --no-pareto-gate
 *   --coverage / --no-coverage
 *   --reflection-model <model-id>
 *   --demos / --no-demos                                       (v0.10.0)
 *   --candidate-selection <active|best|pareto|epsilon-greedy>  (v0.10.0)
 */

import type { EvolutionConfigOverride } from '../types.js';

/** Valid values for `--candidate-selection` (v0.10.0). */
const CANDIDATE_SELECTION_VALUES: ReadonlySet<string> = new Set([
  'active',
  'best',
  'pareto',
  'epsilon-greedy',
]);

/** True when `arg` is one of the evolution-config flags this module handles. */
export function isEvolutionConfigFlag(arg: string): boolean {
  switch (arg) {
    case '--gepa':
    case '--no-gepa':
    case '--merge':
    case '--no-merge':
    case '--pareto-gate':
    case '--no-pareto-gate':
    case '--coverage':
    case '--no-coverage':
    case '--reflection-model':
    case '--demos':
    case '--no-demos':
    case '--candidate-selection':
      return true;
    default:
      return false;
  }
}

/**
 * Apply a single recognised evolution flag to `target`, mutating it in place.
 *
 * Returns the number of EXTRA argv tokens consumed (1 for `--reflection-model`
 * which takes a value, 0 for the boolean flags). Callers that walk argv use the
 * return value to advance their index. Unknown flags are ignored (return 0) —
 * use {@link isEvolutionConfigFlag} to gate first.
 */
export function applyEvolutionFlag(
  arg: string,
  nextArg: string | undefined,
  target: EvolutionConfigOverride,
): number {
  switch (arg) {
    case '--gepa':
      target.useGepa = true;
      return 0;
    case '--no-gepa':
      target.useGepa = false;
      return 0;
    case '--merge':
      target.useMerge = true;
      return 0;
    case '--no-merge':
      target.useMerge = false;
      return 0;
    case '--pareto-gate':
      target.paretoGate = true;
      return 0;
    case '--no-pareto-gate':
      target.paretoGate = false;
      return 0;
    case '--coverage':
      target.useCoverage = true;
      return 0;
    case '--no-coverage':
      target.useCoverage = false;
      return 0;
    case '--reflection-model':
      if (nextArg !== undefined) {
        target.reflectionModel = nextArg;
        return 1;
      }
      return 0;
    case '--demos':
      target.useDemos = true;
      return 0;
    case '--no-demos':
      target.useDemos = false;
      return 0;
    case '--candidate-selection':
      // Value is consumed either way (it was clearly meant as this flag's
      // argument); it is only APPLIED when it names a known strategy — an
      // unknown value warns instead of silently persisting a config the loop
      // would then silently treat as 'active'.
      if (nextArg !== undefined) {
        if (CANDIDATE_SELECTION_VALUES.has(nextArg)) {
          target.candidateSelection = nextArg as EvolutionConfigOverride['candidateSelection'];
        } else {
          console.warn(
            `[darwin] --candidate-selection "${nextArg}" is not one of: ${[...CANDIDATE_SELECTION_VALUES].join(', ')} — ignored.`,
          );
        }
        return 1;
      }
      return 0;
    default:
      return 0;
  }
}

/**
 * Parse an argv slice into an {@link EvolutionConfigOverride}, returning the
 * override plus the tokens that were NOT consumed (so the caller can keep
 * parsing its own flags / positionals). Only the evolution-config flags above
 * are recognised; everything else is passed through untouched.
 */
export function parseEvolutionConfigFlags(args: string[]): {
  override: EvolutionConfigOverride;
  rest: string[];
} {
  const override: EvolutionConfigOverride = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (isEvolutionConfigFlag(arg)) {
      const consumed = applyEvolutionFlag(arg, args[i + 1], override);
      i += consumed;
    } else {
      rest.push(arg);
    }
  }
  return { override, rest };
}

/** True when the override carries at least one set flag. */
export function hasAnyEvolutionFlag(override: EvolutionConfigOverride): boolean {
  return (
    override.useGepa !== undefined ||
    override.useMerge !== undefined ||
    override.paretoGate !== undefined ||
    override.useCoverage !== undefined ||
    override.reflectionModel !== undefined ||
    override.useDemos !== undefined ||
    override.candidateSelection !== undefined
  );
}
