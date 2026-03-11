/**
 * darwin status [agent]
 *
 * Shows evolution status, metrics, and patterns for an agent (or all agents).
 */

import { createMemory } from '../memory/index.js';
import { loadConfig } from '../core/agent.js';
import { builtinAgents } from '../agents/index.js';
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

      const bar = count > 0 ? '█'.repeat(Math.min(count, 20)) + '░'.repeat(Math.max(0, 20 - count)) : '░'.repeat(20);
      const statusIcon = failures > 2 ? '⚠' : abTest ? '🔄' : count > 0 ? '✓' : '·';

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
  const latestExps = experiments.filter(e => e.promptVersion === activeVersion);
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
