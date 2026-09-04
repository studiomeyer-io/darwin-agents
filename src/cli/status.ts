/**
 * darwin status [agent]
 *
 * Shows evolution status, metrics, and patterns for an agent (or all agents).
 */

import { createMemory } from '../memory/index.js';
import { loadConfig } from '../core/agent.js';
import { builtinAgents } from '../agents/index.js';
import { rejectionsFor } from '../evolution/rejections.js';
import type { DarwinState, MemoryProvider } from '../types.js';

export async function statusCommand(args: string[]): Promise<void> {
  const agentName = args[0];
  const config = await loadConfig();
  const memory = createMemory(config);
  await memory.init();

  const state = await memory.getState();

  if (agentName) {
    // Show status for specific agent
    await showAgentStatus(agentName, state, memory as MemoryProvider);
  } else {
    // Show overview of all agents
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║  DARWIN STATUS                                        ║');
    console.log('╠═══════════════════════════════════════════════════════╣');

    const agents = Object.keys({ ...builtinAgents, ...state.experimentCounts });
    const seen = new Set<string>();

    for (const name of agents) {
      if (seen.has(name)) continue;
      seen.add(name);

      const count = state.experimentCounts[name] ?? 0;
      if (count === 0 && !builtinAgents[name]) continue;

      const version = state.activeVersions[name] ?? 'v1';
      const failures = state.consecutiveFailures[name] ?? 0;
      const abTest = state.abTests[name];
      // v0.17.0: its own icon, ahead of the A/B one. A held proposal is not
      // "running" and not "fine": it needs a person, and the overview is the
      // place where that has to be noticeable without asking per agent.
      const held = state.pendingApprovals?.[name];

      const bar = count > 0 ? '█'.repeat(Math.min(count, 20)) + '░'.repeat(Math.max(0, 20 - count)) : '░'.repeat(20);
      const statusIcon = failures > 2 ? '⚠' : held ? '⏸' : abTest ? '🔄' : count > 0 ? '✓' : '·';

      console.log(`║  ${statusIcon} ${name.padEnd(15)} ${version.padEnd(4)} ${bar} ${String(count).padStart(3)} runs ║`);
    }

    if (seen.size === 0) {
      console.log('║  No experiments yet. Run: darwin run writer "Hello"    ║');
    }

    console.log('╚═══════════════════════════════════════════════════════╝');
  }

  await memory.close();
}

async function showAgentStatus(
  agentName: string,
  state: DarwinState,
  memory: MemoryProvider,
): Promise<void> {
  const typedState = state;
  const experiments = await memory.loadExperiments(agentName, 50);
  const versions = await memory.getAllPromptVersions(agentName);
  const activeVersion = typedState.activeVersions[agentName] ?? 'v1';
  const abTest = typedState.abTests[agentName];
  const totalRuns = typedState.experimentCounts[agentName] ?? 0;

  // Calculate metrics
  const scored = experiments.filter(e => e.metrics.qualityScore !== null);
  const avgQuality = scored.length > 0
    ? scored.reduce((sum, e) => sum + (e.metrics.qualityScore ?? 0), 0) / scored.length
    : 0;
  const avgSources = experiments.length > 0
    ? experiments.reduce((sum, e) => sum + e.metrics.sourceCount, 0) / experiments.length
    : 0;
  const avgDuration = experiments.length > 0
    ? experiments.reduce((sum, e) => sum + e.metrics.durationMs, 0) / experiments.length / 1000
    : 0;
  const successRate = experiments.length > 0
    ? experiments.filter(e => e.success).length / experiments.length * 100
    : 0;

  // Calculate improvement since v1
  const v1Exps = experiments.filter(e => e.promptVersion === 'v1');
  const v1Quality = v1Exps.filter(e => e.metrics.qualityScore !== null).length > 0
    ? v1Exps.reduce((s, e) => s + (e.metrics.qualityScore ?? 0), 0) / v1Exps.filter(e => e.metrics.qualityScore !== null).length
    : 0;

  // Quality bar
  const qualityBar = avgQuality > 0
    ? '█'.repeat(Math.round(avgQuality)) + '░'.repeat(10 - Math.round(avgQuality))
    : '░'.repeat(10);

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log(`║  DARWIN STATUS: ${agentName.padEnd(40)} ║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║                                                          ║');
  console.log(`║  Prompt Version: ${activeVersion.padEnd(5)} (${versions.length} total versions)${' '.repeat(Math.max(0, 18 - String(versions.length).length))}║`);
  console.log(`║  Total Runs: ${String(totalRuns).padEnd(43)} ║`);
  console.log('║                                                          ║');
  console.log(`║  Quality Score    ${qualityBar}  ${avgQuality.toFixed(1)}/10${v1Quality > 0 && activeVersion !== 'v1' ? `  (+${(avgQuality - v1Quality).toFixed(1)} since v1)` : ''}${' '.repeat(Math.max(0, 16 - (v1Quality > 0 && activeVersion !== 'v1' ? `  (+${(avgQuality - v1Quality).toFixed(1)} since v1)` .length : 0)))}║`);
  console.log(`║  Success Rate     ${String(successRate.toFixed(0)).padStart(3)}%${' '.repeat(35)}║`);
  console.log(`║  Avg Duration     ${avgDuration.toFixed(1)}s${' '.repeat(Math.max(0, 36 - String(avgDuration.toFixed(1)).length))}║`);
  console.log(`║  Avg Sources      ${avgSources.toFixed(1)}${' '.repeat(Math.max(0, 37 - String(avgSources.toFixed(1)).length))}║`);
  console.log('║                                                          ║');

  // A/B Test status
  if (abTest) {
    console.log(`║  A/B Test: ${abTest.versionA} vs ${abTest.versionB} (${abTest.runsA}/${abTest.runsB} runs)${' '.repeat(Math.max(0, 20))}║`);
  }

  // v0.17.0: a proposal held by the approval gate stops evolution entirely
  // until someone decides, so it has to be visible here. A silent block is
  // exactly the failure mode the timeout exists to prevent, and the timeout
  // is opt-in.
  const pending = typedState.pendingApprovals?.[agentName];
  if (pending) {
    // Padded by measurement, not by a hand-counted constant. The first draft
    // of these three lines was off by 9, 2 and 1 columns respectively, which
    // is what hand-counting into a fixed-width box reliably produces.
    console.log(boxLine(`  AWAITING APPROVAL: ${pending.versionA} to ${pending.versionB}`));
    console.log(boxLine(`    proposed ${pending.proposedAt.slice(0, 10)}, no test running`));
    console.log(boxLine(`    decide: darwin approve ${agentName}`));
  }

  // v0.18.0: the rejection memory, one line. It changes what the loop will
  // propose next (a remembered text is refused), so a status view that omits
  // it explains an agent's silence with the wrong reason.
  const remembered = rejectionsFor(typedState, agentName);
  if (remembered.length > 0) {
    const last = remembered[remembered.length - 1]!;
    console.log(
      boxLine(
        `  Rejected: ${remembered.length} remembered, last ${last.version} ` +
          `on ${last.rejectedAt.slice(0, 10)}`,
      ),
    );
  }

  // v0.18.0: an agent inside the cool-down is quiet for a REASON, and a status
  // view that shows the memory but not the wait explains the silence only
  // halfway. Same argument as the pending-approval block above.
  const stall = typedState.rejectionStalls?.[agentName];
  if (stall && totalRuns < stall.retryAtExperimentCount) {
    console.log(
      boxLine(
        `    waiting ${stall.retryAtExperimentCount - totalRuns} more run(s) after ` +
          `${stall.version} came back`,
      ),
    );
  }

  // Version history
  if (versions.length > 1) {
    console.log('║  Evolution History:                                      ║');
    for (const v of versions.slice(-3)) {
      const marker = v.active ? '→' : ' ';
      console.log(`║  ${marker} ${v.version}: ${v.changeReason.slice(0, 45).padEnd(45)}${v.stats.totalRuns > 0 ? ` (${v.stats.avgQuality.toFixed(1)})` : ''}  ║`);
    }
  }

  // Task type breakdown
  const taskTypes = new Map<string, { count: number; avgQuality: number }>();
  for (const exp of experiments) {
    const existing = taskTypes.get(exp.taskType) ?? { count: 0, avgQuality: 0 };
    existing.count++;
    if (exp.metrics.qualityScore !== null) {
      existing.avgQuality = (existing.avgQuality * (existing.count - 1) + exp.metrics.qualityScore) / existing.count;
    }
    taskTypes.set(exp.taskType, existing);
  }

  if (taskTypes.size > 1) {
    console.log('║                                                          ║');
    console.log('║  Performance by Task Type:                                ║');
    for (const [type, data] of taskTypes) {
      console.log(`║    ${type.padEnd(15)} ${data.avgQuality.toFixed(1)}/10  (${data.count} runs)${' '.repeat(Math.max(0, 20 - type.length))}║`);
    }
  }

  console.log('║                                                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
}

/** Interior width of the per-agent status box, measured from its own border. */
const BOX_INTERIOR = 58;

/**
 * Pad `content` into one row of the status box.
 *
 * Over-long content is truncated rather than allowed to blow the border out,
 * because a ragged box is how the surrounding lines already look and the point
 * here was to stop adding to that.
 */
function boxLine(content: string): string {
  const body =
    content.length > BOX_INTERIOR ? content.slice(0, BOX_INTERIOR - 1) + '\u2026' : content;
  return `\u2551${body.padEnd(BOX_INTERIOR)}\u2551`;
}
