/**
 * darwin approve [agent] [--reject] [--reason <text>] [--force]
 *
 * The human half of the v0.17.0 approval gate
 * ({@link EvolutionConfig.requireApproval}). With the gate on, a generated
 * challenger is persisted but no A/B test opens until someone decides here.
 *
 * Usage:
 *   darwin approve                       list every pending proposal
 *   darwin approve researcher            show both prompts, then approve
 *   darwin approve researcher --reject   discard it, free the slot
 *   darwin approve researcher --reject --reason "leaks the system prompt"
 *   darwin approve researcher --force    approve even though the incumbent moved
 *
 * Without a diff there is nothing to approve, so the command prints the
 * incumbent and challenger prompts before acting. A proposal is a prompt, and
 * a prompt is the thing being judged.
 *
 * ## Why the parser is strict
 *
 * The bare command APPROVES. Every other CLI in this repo can ignore an
 * unrecognised token because the worst case is a flag that does nothing; here
 * the worst case is the opposite of what was typed. `--rejct`, `-reject` and
 * `--reject=true` all used to parse to `{reject: false}`, so a typo put the
 * challenger on roughly half of live traffic, and the only way to stop the
 * resulting test is `darwin evolve <agent> --reset`, which also throws the
 * evolved incumbent back to v1.
 *
 * So: anything not recognised is an ERROR, not a shrug. That includes a second
 * positional and the `--flag=value` spelling this CLI does not use.
 */

import { createMemory } from '../memory/index.js';
import { loadConfig } from '../core/agent.js';
import { builtinAgents } from '../agents/index.js';
import { resolveEvolutionConfig } from '../evolution/enabled-state.js';
import { buildEvolutionLoop } from '../evolution/build-loop.js';
import type { AgentDefinition, MemoryProvider, PendingApproval } from '../types.js';

/** Everything one walk over argv produces. */
export interface ApproveArgs {
  agent?: string;
  reject: boolean;
  force: boolean;
  reason?: string;
  /** Human-readable reasons the input was refused. Empty means usable. */
  errors: string[];
}

/**
 * Parse `darwin approve`'s argv in ONE walk.
 *
 * One function rather than a flag parser plus a separate agent picker: two
 * walks with slightly different rules about which token belongs to `--reason`
 * is a bug waiting to be written, and the whole point here is that the two
 * never disagree about what the user typed.
 *
 * Never throws. The caller decides what to do with `errors`, which keeps this
 * testable without catching.
 */
export function parseApproveArgs(args: string[]): ApproveArgs {
  const out: ApproveArgs = { reject: false, force: false, errors: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--reject') {
      out.reject = true;
      continue;
    }
    if (arg === '--force') {
      out.force = true;
      continue;
    }
    if (arg === '--reason') {
      const next = args[i + 1];
      // A missing value or a following flag is a MISSING value, not the
      // argument. Single-dash counts: `-v` is a real flag elsewhere in this
      // CLI, and the `--`-only guard once swallowed it (v0.13.2).
      if (next === undefined || next.startsWith('-')) {
        out.errors.push('--reason needs a value, for example: --reason "drops the citation rule"');
        continue;
      }
      out.reason = next;
      i++;
      continue;
    }

    if (arg.startsWith('-')) {
      // `--reject=true` is the most likely near-miss, so it gets its own line.
      // Deliberately does NOT suggest `--reject true`: --reject is a boolean,
      // and that spelling would read "true" as a second agent name. Naming the
      // bare flag is the only advice that is actually correct here.
      const eq = arg.indexOf('=');
      const base = eq > 0 ? arg.slice(0, eq) : arg;
      const hint =
        eq > 0
          ? ` This CLI does not use "=". ${
              base === '--reason'
                ? 'Write: --reason <text>'
                : `Write the flag on its own: ${base}`
            }`
          : '';
      out.errors.push(
        `unknown flag "${arg}".${hint} Valid: --reject, --reason <text>, --force`,
      );
      continue;
    }

    if (out.agent !== undefined) {
      out.errors.push(
        `"${arg}" is a second agent name (already have "${out.agent}"). Decide on one at a time.`,
      );
      continue;
    }
    out.agent = arg;
  }

  return out;
}

export async function approveCommand(args: string[]): Promise<void> {
  const parsed = parseApproveArgs(args);

  if (parsed.errors.length > 0) {
    // Hard fail. A command whose default action is consent must never act on
    // input it did not fully understand.
    throw new Error(
      `darwin approve: ${parsed.errors.join('; ')}\n` +
        `  Usage: darwin approve [agent] [--reject] [--reason <text>] [--force]`,
    );
  }

  const agentName = parsed.agent;

  // A decision flag with no target is an error, not a listing. Round 2:
  // `darwin approve "$AGENT" --reject` with an unset or empty shell variable
  // fell through to the listing branch and exited 0, so the script believed the
  // rejection happened while the challenger stayed pending and approvable by
  // anyone. Without a timeout it then blocks evolution forever, silently.
  //
  // The parser already hard-fails on `--rejct`; shrugging at `--reject` with no
  // agent would be the same failure with better spelling. An empty string is
  // caught too: it is falsy, so `parsed.agent` stays undefined.
  if (!agentName && (parsed.reject || parsed.force || parsed.reason !== undefined)) {
    const given = [
      parsed.reject ? '--reject' : null,
      parsed.force ? '--force' : null,
      parsed.reason !== undefined ? '--reason' : null,
    ].filter(Boolean).join(', ');
    throw new Error(
      `darwin approve: ${given} needs an agent to act on, and none was given ` +
        `(an empty shell variable looks exactly like this).\n` +
        `  Run "darwin approve" with no flags to list what is pending.`,
    );
  }

  const config = await loadConfig();
  const memory = createMemory(config);
  await memory.init();
  const state = await memory.getState();

  // No agent named: list everything pending.
  if (!agentName) {
    const pending = Object.entries(state.pendingApprovals ?? {}).filter(
      (entry): entry is [string, PendingApproval] => entry[1] !== null && entry[1] !== undefined,
    );
    if (pending.length === 0) {
      console.log('[darwin] Nothing is awaiting approval.');
      return;
    }
    console.log(`[darwin] ${pending.length} proposal(s) awaiting approval:\n`);
    for (const [name, p] of pending) {
      const gone = builtinAgents[name] === undefined ? '  (agent no longer defined)' : '';
      console.log(
        `  ${name}: ${p.versionA} to ${p.versionB}  (via ${p.generatedBy}, proposed ${p.proposedAt})${gone}`,
      );
      console.log(`    reason: ${p.changeReason}`);
      console.log(`    review: darwin approve ${name}\n`);
    }
    return;
  }

  // The proposal is looked up BEFORE the agent definition on purpose. An agent
  // that was renamed or removed can still have a proposal parked in state, and
  // refusing on "unknown agent" would leave it undecidable and undeletable
  // (`--reset` throws on the same check first). Rejecting needs no definition;
  // approving does, because the A/B test needs an agent to run.
  const proposal = state.pendingApprovals?.[agentName] ?? null;
  const agent = builtinAgents[agentName];

  if (!proposal) {
    if (!agent) {
      throw new Error(
        `Unknown agent: "${agentName}", and nothing is awaiting approval under that name. ` +
          `Available: ${Object.keys(builtinAgents).join(', ')}`,
      );
    }
    console.log(`[darwin] No challenger is awaiting approval for "${agentName}".`);
    return;
  }

  // Show what is being decided on, before deciding. A missing prompt makes the
  // proposal unreadable, so approving is refused rather than warned about.
  const readable = await printProposal(agentName, proposal, memory);

  if (!agent) {
    if (!parsed.reject) {
      throw new Error(
        `"${agentName}" has a proposal (${proposal.versionA} to ${proposal.versionB}) but is no ` +
          `longer a defined agent, so its A/B test cannot run. ` +
          `Reject it with: darwin approve ${agentName} --reject`,
      );
    }
    // Rejecting only clears state, so it works without a definition. Build the
    // loop against a minimal stand-in: rejectChallenger touches memory only.
    const stub: AgentDefinition = {
      name: agentName,
      role: agentName,
      description: 'removed agent, proposal cleanup only',
      type: 'llm',
      systemPrompt: '',
      model: 'claude-sonnet-4-6',
    };
    const res = await buildEvolutionLoop(stub, config, memory).rejectChallenger(
      agentName,
      parsed.reason,
    );
    console.log(`[darwin] ${res.message}`);
    return;
  }

  const resolvedEvolution = resolveEvolutionConfig(agent, state);
  const evolutionAgent: AgentDefinition = resolvedEvolution
    ? { ...agent, evolution: resolvedEvolution }
    : agent;
  const loop = buildEvolutionLoop(evolutionAgent, config, memory);

  if (parsed.reject) {
    const res = await loop.rejectChallenger(agentName, parsed.reason);
    console.log(`[darwin] ${res.message}`);
    return;
  }

  if (!readable) {
    throw new Error(
      `Refusing to approve "${agentName}": the prompt text for one arm is missing from the ` +
        `version history, so nobody can read what is being approved. Reject it instead ` +
        `(darwin approve ${agentName} --reject) and let the next cycle propose a fresh one.`,
    );
  }

  const res = await loop.approveChallenger(agentName, { force: parsed.force });
  console.log(`[darwin] ${res.message}`);
}

/**
 * Print the incumbent and challenger prompt so the decision is made on the
 * text, not on a version label. Returns false when either prompt is missing.
 *
 * Full text on purpose, no truncation: a prompt is short enough to read, and
 * an elided middle is exactly where a bad mutation hides.
 */
async function printProposal(
  agentName: string,
  p: PendingApproval,
  memory: MemoryProvider,
): Promise<boolean> {
  const versions = await memory.getAllPromptVersions(agentName);
  const incumbent = versions.find((v) => v.version === p.versionA);
  const challenger = versions.find((v) => v.version === p.versionB);

  console.log(`\n=== PROPOSAL: ${agentName} ===`);
  console.log(`  ${p.versionA} to ${p.versionB}   (via ${p.generatedBy})`);
  console.log(`  proposed: ${p.proposedAt}`);
  console.log(`  reason:   ${p.changeReason}`);
  console.log(
    `  if approved: A/B test, ${p.minRuns} runs per arm${
      p.maxTestDays !== undefined ? `, ${p.maxTestDays}d budget` : ''
    }`,
  );
  console.log('');

  if (!incumbent || !challenger) {
    // Only reachable if the prompt rows were pruned out from under the
    // proposal. The caller refuses to approve on a false return; a test opened
    // on a missing arm would be cleared as dead by the orphan repair in run.ts
    // on the very next run, so approving it approves nothing.
    console.log(
      `[darwin] The prompt text for ${!incumbent ? p.versionA : p.versionB} is missing from the ` +
        `version history.`,
    );
    return false;
  }

  console.log(`--- ${p.versionA} (active) ${'-'.repeat(30)}`);
  console.log(incumbent.promptText);
  console.log(`\n--- ${p.versionB} (proposed) ${'-'.repeat(28)}`);
  console.log(challenger.promptText);
  console.log('');
  return true;
}
