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
 *   --skip-perfect / --no-skip-perfect                         (v0.11.0)
 *   --max-merge <n>                                            (v0.11.0)
 *   --max-test-days <n>                                        (v0.13.0)
 *   --require-approval / --no-require-approval                 (v0.17.0)
 *   --approval-timeout-days <n>                                (v0.17.0)
 */

import type { EvolutionConfigOverride } from '../types.js';

/** Valid values for `--candidate-selection` (v0.10.0). */
const CANDIDATE_SELECTION_VALUES: ReadonlySet<string> = new Set([
  'active',
  'best',
  'pareto',
  'epsilon-greedy',
]);

/** Valid values for `--confidence-method` (v0.14.0; `'eb'` since v0.16.0). */
const CONFIDENCE_METHOD_VALUES: ReadonlySet<string> = new Set([
  'effect-size',
  'msprt',
  'hoeffding',
  'eb',
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
    case '--skip-perfect':
    case '--no-skip-perfect':
    case '--max-merge':
    case '--max-test-days':
    case '--require-confidence':
    case '--no-require-confidence':
    case '--confidence-method':
    case '--require-approval':
    case '--no-require-approval':
    case '--approval-timeout-days':
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
      // v0.17.0 — the dash guard, eleven versions late. `--max-merge` and
      // `--max-test-days` got it in v0.13.2 and every flag since was written
      // with it, but the two oldest value-takers never were. Measured at the
      // live CLI: `darwin evolve writer --reflection-model --disable` exited 0,
      // persisted "--disable" as the reflection MODEL ID, and swallowed the
      // disable, so an agent someone wanted stopped kept evolving. That is the
      // same arm the v0.17 refuse-unknown-arguments gate was added to close,
      // walking in through the door beside it: a value flag consumes its token
      // in the parser, BEFORE the gate ever sees it.
      if (nextArg === undefined || nextArg.startsWith('-')) {
        console.warn('[darwin] --reflection-model needs a model id; ignored.');
        return 0;
      }
      target.reflectionModel = nextArg;
      return 1;
    case '--demos':
      target.useDemos = true;
      return 0;
    case '--no-demos':
      target.useDemos = false;
      return 0;
    case '--candidate-selection':
      // v0.17.0 — same dash guard as --reflection-model above, and for the same
      // measured reason: `darwin evolve writer --candidate-selection --disable`
      // exited 0 with the agent still enabled, because this branch consumed
      // `--disable` as its value. "Consumed either way" was written about a
      // wrong VALUE ("actve"), not about a following FLAG.
      if (nextArg === undefined || nextArg.startsWith('-')) {
        console.warn(
          `[darwin] --candidate-selection needs one of: ${[...CANDIDATE_SELECTION_VALUES].join(', ')}; ignored.`,
        );
        return 0;
      }
      // A wrong value IS still consumed (it was clearly meant as this flag's
      // argument) and only APPLIED when it names a known strategy, so a typo
      // warns instead of silently persisting a config the loop would then
      // treat as 'active'.
      if (CANDIDATE_SELECTION_VALUES.has(nextArg)) {
        target.candidateSelection = nextArg as EvolutionConfigOverride['candidateSelection'];
      } else {
        console.warn(
          `[darwin] --candidate-selection "${nextArg}" is not one of: ${[...CANDIDATE_SELECTION_VALUES].join(', ')}; ignored.`,
        );
      }
      return 1;
    case '--skip-perfect':
      target.skipPerfectFeedback = true;
      return 0;
    case '--no-skip-perfect':
      target.skipPerfectFeedback = false;
      return 0;
    case '--max-merge': {
      // A missing value (end of argv) or a following FLAG (`--max-merge
      // --force`, `--max-merge -v`) is a missing value, not this flag's
      // argument — warn and do NOT consume the next token, so a following
      // action flag still runs. Single-dash matters: the CLI defines `-v`
      // (run.ts), and the old `--`-only guard swallowed it as an invalid
      // value, silently disabling verbose mode (round-2 review finding —
      // both value-taking flags shared the bug). `-3` is caught here too:
      // negative numbers were never valid values for either flag.
      if (nextArg === undefined || nextArg.startsWith('-')) {
        console.warn('[darwin] --max-merge needs a non-negative integer value — ignored.');
        return 0;
      }
      // Strict non-negative-integer match rejects '', ' ', '2.5', '0x10',
      // '1e3', 'abc' (Number() would coerce several of those, e.g. Number('')
      // === 0, silently disabling merge for the agent's life). Such a value
      // token is consumed — it was clearly meant as this flag's argument.
      // `-`-prefixed tokens (`-3`, `-v`) never reach this point: the guard
      // above treats them as a missing value and leaves them unconsumed
      // (v0.13.2 — `-v` is a real CLI flag).
      if (/^\d+$/.test(nextArg.trim())) {
        target.maxMergeInvocations = Number(nextArg.trim());
      } else {
        console.warn(
          `[darwin] --max-merge "${nextArg}" is not a non-negative integer — ignored.`,
        );
      }
      return 1;
    }
    case '--max-test-days': {
      // Same footguns as --max-merge: a missing value or a following flag
      // (double- OR single-dash — the CLI defines `-v`) is not this flag's
      // argument, and Number() would coerce '' to 0.
      if (nextArg === undefined || nextArg.startsWith('-')) {
        console.warn('[darwin] --max-test-days needs a non-negative integer value — ignored.');
        return 0;
      }
      // `0` is the OFF switch, mirroring `--max-merge 0`. Overrides are merged,
      // never deleted (`setEvolutionConfigOverrides`), and `--reset` does not
      // touch them — so without an in-band "no budget" value a once-persisted
      // budget could never be removed except by hand-editing the state blob.
      // `isTestExpired` already reads 0 as "no budget", so this needs no
      // special case downstream. Strict digits-only rejects '', '-3', '2.5',
      // '1e3', 'abc', which Number() would otherwise coerce.
      if (/^\d+$/.test(nextArg.trim())) {
        target.maxTestDays = Number(nextArg.trim());
      } else {
        console.warn(
          `[darwin] --max-test-days "${nextArg}" is not a non-negative integer — ignored.`,
        );
      }
      return 1;
    }
    case '--require-confidence':
      target.requireConfidence = true;
      return 0;
    case '--no-require-confidence':
      target.requireConfidence = false;
      return 0;
    case '--confidence-method':
      // Consume-but-validate: the value token was clearly meant for this flag,
      // but only a known method is persisted, so a typo warns instead of
      // silently gating on 'effect-size'. (This comment used to say "same
      // contract as --candidate-selection". Until v0.17 that was false in the
      // one place it mattered: this branch had the dash guard and that one did
      // not. They match now.)
      if (nextArg !== undefined && !nextArg.startsWith('-')) {
        if (CONFIDENCE_METHOD_VALUES.has(nextArg)) {
          target.confidenceMethod = nextArg as EvolutionConfigOverride['confidenceMethod'];
        } else {
          console.warn(
            `[darwin] --confidence-method "${nextArg}" is not one of: ${[...CONFIDENCE_METHOD_VALUES].join(', ')} — ignored.`,
          );
        }
        return 1;
      }
      console.warn('[darwin] --confidence-method needs a value (effect-size | msprt | hoeffding | eb); ignored.');
      return 0;
    case '--require-approval':
      target.requireApproval = true;
      return 0;
    case '--no-require-approval':
      target.requireApproval = false;
      return 0;
    case '--approval-timeout-days': {
      // Same footguns as --max-test-days: a missing value or a following flag
      // (double- or single-dash) is not this flag's argument, and Number()
      // would coerce '' to 0.
      if (nextArg === undefined || nextArg.startsWith('-')) {
        console.warn('[darwin] --approval-timeout-days needs a non-negative integer value; ignored.');
        return 0;
      }
      // `0` is the OFF switch, exactly as for --max-test-days: overrides are
      // merged and never deleted, so without an in-band "no budget" value a
      // once-persisted timeout could never be removed. `effectiveApprovalBudget`
      // already reads 0 as "no budget", so nothing downstream needs a case.
      if (/^\d+$/.test(nextArg.trim())) {
        target.approvalTimeoutDays = Number(nextArg.trim());
      } else {
        console.warn(
          `[darwin] --approval-timeout-days "${nextArg}" is not a non-negative integer; ignored.`,
        );
      }
      return 1;
    }
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

/**
 * True when the override carries at least one set flag.
 *
 * v0.17.0: derived from the object rather than from a hand-maintained
 * disjunction. The list version silently went stale the moment
 * `--require-approval` was added: the flag parsed, applied and persisted
 * correctly, but `hasAnyEvolutionFlag` returned false, so `darwin evolve
 * <agent> --require-approval` skipped its own confirmation line AND fell into
 * the status branch, printing `requireApproval=false` right after setting it.
 * Nothing threw; the command just quietly did half its job.
 *
 * `EvolutionConfigOverride` contains override keys and nothing else, so "has a
 * defined value" is exactly the question being asked. Adding a flag now needs
 * no edit here, which is the point.
 */
export function hasAnyEvolutionFlag(override: EvolutionConfigOverride): boolean {
  return Object.values(override).some((v) => v !== undefined);
}
