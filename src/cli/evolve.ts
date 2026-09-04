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
 *   --demos / --no-demos          SIMBA-style demo injection (v0.10)
 *   --candidate-selection <s>     reflection parent: active|best|pareto|epsilon-greedy
 *   --skip-perfect / --no-skip-perfect   drop perfect-score runs from optimizer feedback (v0.11)
 *   --max-merge <n>               lifetime cap on merge-derived challengers (v0.11)
 *   --max-test-days <n>           wall-clock budget per A/B test in days (v0.13)
 *   --require-confidence / --no-require-confidence   confidence gate on the A/B margin (v0.14)
 *   --confidence-method <m>       effect-size | msprt | hoeffding | eb (v0.14; eb v0.16)
 *   --require-approval / --no-require-approval   hold challengers for a human (v0.17)
 *   --approval-timeout-days <n>   auto-reject an untouched proposal after n days (v0.17)
 *   --rejection-notes <n>         how many rejection reasons reach the optimizer (v0.18)
 *
 * This list is checked: `tests/evolution-config-flags.test.ts` walks
 * OVERRIDE_KEYS against it. The two v0.14 lines were missing for three
 * releases, in a file that already had two other hand-maintained lists with
 * the same hole.
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
import { buildResolvedEvolutionLoop } from '../evolution/build-loop.js';
import { parseEvolutionConfigFlags, hasAnyEvolutionFlag } from './evolution-flags.js';
import { rejectionsFor } from '../evolution/rejections.js';
import type { EvolutionConfig, EvolutionConfigOverride } from '../types.js';

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

  // Anything left that is not one of the four action flags is an error, not a
  // shrug. Round 7 measured what the shrug cost, at the live CLI:
  //
  //   darwin evolve writer --rset            -> prints the status block, exit 0
  //   darwin evolve writer --gepa --enabel   -> persists gepa, swallows the
  //                                             typo, exit 0, evolution stays OFF
  //   darwin evolve writer --disbale         -> "Enabled: yes", exit 0
  //
  // The last one is the dangerous arm: someone wanted an evolving agent
  // stopped, the shell said fine, and it kept evolving. The same class was
  // closed for `darwin approve` in this release ("anything not recognised is
  // an ERROR, not a shrug") and left open on the neighbouring command, which
  // is the worse half of a half-fix. Pre-existing since v0.6, not a v0.17
  // regression, and there is no legitimate non-flag token after the agent
  // name, so refusing costs nothing.
  const ACTIONS = new Set(['--enable', '--disable', '--reset', '--force']);
  const unknown = flags.filter((f) => !ACTIONS.has(f));
  if (unknown.length > 0) {
    throw new Error(
      `darwin evolve: unrecognised ${unknown.length === 1 ? 'argument' : 'arguments'} ` +
        `${unknown.map((u) => `"${u}"`).join(', ')}.\n` +
        `  Actions: --enable, --disable, --reset, --force\n` +
        `  Run "darwin --help" for the persistable evolution flags.`,
    );
  }
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
    // v0.17.0 — was getState + mutate + saveState, which writes the WHOLE state
    // blob from a snapshot taken before the awaits. Any write another process
    // made in between (an A/B test starting for a different agent, a proposal
    // landing) was silently overwritten: `darwin evolve A --reset` could erase
    // agent B's pending approval, leaving Telegram saying "approval needed"
    // while `darwin approve B` says nothing is pending. updateState runs under
    // the same write lock every other state writer uses.
    await memory.updateState((state) => {
      state.activeVersions[agentName] = 'v1';
      state.abTests[agentName] = null;
      state.consecutiveFailures[agentName] = 0;
      // A reset that leaves a pending proposal behind is worse than no reset.
      // The proposal names an incumbent that no longer exists (we just pointed
      // the agent back at v1), and until someone decides on it the agent cannot
      // evolve at all. Clearing it is the same "free the slot" move `--reset`
      // already makes for a running A/B test.
      if (state.pendingApprovals?.[agentName]) {
        state.pendingApprovals[agentName] = null;
      }
      return state;
    });
    // The state map alone was never the whole reset. run.ts ROUTES on
    // `activeVersions`, but `getActivePrompt` reads the `active` FLAG on the
    // version rows, and only the map was being written: after a reset the
    // agent served v1 while the flag still said v3, so the next cycle proposed
    // "v3 to v4" and approving it put 50% of traffic back on the version the
    // reset was trying to leave. Both sources move together now.
    const versions = await memory.getAllPromptVersions(agentName);
    for (const pv of versions) {
      const shouldBeActive = pv.version === 'v1';
      if (pv.active !== shouldBeActive) {
        pv.active = shouldBeActive;
        await memory.savePromptVersion(pv);
      }
    }
    console.log(`[darwin] Evolution RESET for ${agentName}. Back to v1.`);
    // v0.18.0: --reset does NOT clear the rejection memory, and reads like it
    // does. Keeping it is the right default (a rejection is a judgment about a
    // TEXT, and the text did not change because the version pointer moved),
    // but an agent that then refuses to propose is a surprise unless the reset
    // says so here.
    const remembered = rejectionsFor(await memory.getState(), agentName);
    if (remembered.length > 0) {
      console.log(
        `[darwin] ${remembered.length} rejected prompt(s) are still remembered and will not be ` +
          `proposed again. Clear them with "darwin approve ${agentName} --forget all".`,
      );
    }
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
    const loop = buildResolvedEvolutionLoop(agent, state, config, memory);
    const evoResult = await loop.forceEvolve(agentName);
    if (evoResult.abTestStarted) {
      console.log(`[darwin] EVOLVED: ${evoResult.message}`);
    } else if (evoResult.awaitingApproval) {
      // v0.17.0: same reason as in run.ts. `--force` that produced a proposal
      // did something and needs a decision; the plain tail below reads like a
      // refusal.
      console.log(`[darwin] APPROVAL NEEDED: ${evoResult.message}`);
    } else if (evoResult.rejectedRepeat) {
      // v0.18.0, same reason as in run.ts: a forced cycle that produced only
      // an already-rejected text needs a person, and the plain tail below
      // reads like "nothing to do".
      console.log(`[darwin] NOTHING NEW TO PROPOSE: ${evoResult.message}`);
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
/**
 * One-line summary of what a `darwin evolve <agent> --flag` call just wrote.
 *
 * Exported since v0.17.0 so a guard can walk it. Round 5 of the adversarial
 * review counted the hand-maintained key lists in this chain: the guard's own
 * name said "all four places", and this function plus {@link describeConfig}
 * are the fifth and sixth. The drift is not hypothetical, it already happened:
 * `--require-confidence` and `--confidence-method` were persistable from
 * v0.14 and appeared in neither summary for three releases, so setting one
 * confirmed itself with "(none)".
 */
export function describeOverride(o: EvolutionConfigOverride): string {
  const parts: string[] = [];
  if (o.useGepa !== undefined) parts.push(`gepa=${o.useGepa}`);
  if (o.useMerge !== undefined) parts.push(`merge=${o.useMerge}`);
  if (o.paretoGate !== undefined) parts.push(`paretoGate=${o.paretoGate}`);
  if (o.useCoverage !== undefined) parts.push(`coverage=${o.useCoverage}`);
  if (o.reflectionModel !== undefined) parts.push(`reflectionModel=${o.reflectionModel}`);
  if (o.useDemos !== undefined) parts.push(`demos=${o.useDemos}`);
  if (o.candidateSelection !== undefined) parts.push(`candidateSelection=${o.candidateSelection}`);
  if (o.skipPerfectFeedback !== undefined) parts.push(`skipPerfect=${o.skipPerfectFeedback}`);
  if (o.maxMergeInvocations !== undefined) parts.push(`maxMerge=${o.maxMergeInvocations}`);
  if (o.maxTestDays !== undefined) parts.push(`maxTestDays=${o.maxTestDays}`);
  // v0.14's two confidence knobs were persistable from the day they shipped but
  // never made it into this summary, so `--require-confidence` confirmed itself
  // with "(none)". Added here alongside the v0.17 pair rather than left as the
  // one hole next to the fix.
  if (o.requireConfidence !== undefined) parts.push(`requireConfidence=${o.requireConfidence}`);
  if (o.confidenceMethod !== undefined) parts.push(`confidenceMethod=${o.confidenceMethod}`);
  if (o.requireApproval !== undefined) parts.push(`requireApproval=${o.requireApproval}`);
  if (o.approvalTimeoutDays !== undefined) parts.push(`approvalTimeoutDays=${o.approvalTimeoutDays}`);
  if (o.rejectionNoteLimit !== undefined) parts.push(`rejectionNotes=${o.rejectionNoteLimit}`);
  return parts.length > 0 ? parts.join(', ') : '(none)';
}

/** One-line summary of the effective advanced config for the status view. */
export function describeConfig(evo: EvolutionConfig | undefined): string {
  if (!evo) return '(no evolution config)';
  const parts = [
    `gepa=${evo.useGepa ?? false}`,
    `merge=${evo.useMerge ?? false}`,
    `paretoGate=${evo.paretoGate ?? false}`,
    `coverage=${evo.useCoverage ?? false}`,
    `demos=${evo.useDemos ?? false}`,
    `skipPerfect=${evo.skipPerfectFeedback ?? false}`,
    // v0.17: an always-shown slot, not an only-when-set one. This flag decides
    // whether the loop measures anything at all, so "not mentioned" must not be
    // readable as "not relevant".
    `requireApproval=${evo.requireApproval ?? false}`,
  ];
  if (evo.reflectionModel) parts.push(`reflectionModel=${evo.reflectionModel}`);
  if (evo.candidateSelection && evo.candidateSelection !== 'active') {
    parts.push(`candidateSelection=${evo.candidateSelection}`);
  }
  // maxMerge is genuinely optional (unset = uncapped), so it is shown only when
  // set — unlike the always-shown booleans above.
  if (evo.maxMergeInvocations !== undefined) parts.push(`maxMerge=${evo.maxMergeInvocations}`);
  // Same rule as maxMerge — unset means "no wall-clock budget", so it is only
  // worth a slot in the summary once someone has set it.
  if (evo.maxTestDays !== undefined) parts.push(`maxTestDays=${evo.maxTestDays}`);
  // Same only-when-set rule as maxTestDays: unset means the proposal waits
  // indefinitely, which is the default and needs no slot.
  if (evo.approvalTimeoutDays !== undefined) {
    parts.push(`approvalTimeoutDays=${evo.approvalTimeoutDays}`);
  }
  // Only-when-set like the two above: unset means the default note window, and
  // the refusal to re-propose a rejected text is unconditional either way, so
  // an unset value has nothing to report.
  if (evo.rejectionNoteLimit !== undefined) {
    parts.push(`rejectionNotes=${evo.rejectionNoteLimit}`);
  }
  // v0.14 knobs, same omission as in describeOverride above.
  if (evo.safety?.requireConfidence !== undefined) {
    parts.push(`requireConfidence=${evo.safety.requireConfidence}`);
  }
  if (evo.safety?.confidenceMethod !== undefined) {
    parts.push(`confidenceMethod=${evo.safety.confidenceMethod}`);
  }
  return parts.join(', ');
}
