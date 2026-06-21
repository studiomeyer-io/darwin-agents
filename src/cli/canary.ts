/**
 * darwin canary <agent> [--json] [--exit-on-drift]
 *
 * Validate-by-reproduce drift check (Phase 2 A5). Loads the agent's recent
 * experiments, baselines within the active prompt version, and reports whether
 * the recent trajectories have drifted from that baseline (different tools,
 * more turns, more errors) — behavioural drift the A/B *quality* gate can miss.
 *
 * Read-only. Exits 0 by default even on drift (the signal is the printed report
 * / JSON, mirroring the staleness monitor); pass `--exit-on-drift` for CI.
 */

import { createMemory } from '../memory/index.js';
import { loadConfig } from '../core/agent.js';
import { runCanaryOverExperiments, type CanaryReport } from '../evolution/canary.js';

/** How many recent experiments to pull for the drift window — wide enough that
 *  several same-version runs land in it after an evolution. */
const CANARY_WINDOW = 100;

export async function canaryCommand(args: string[]): Promise<void> {
  const agentName = args.find((a) => !a.startsWith('--'));
  if (!agentName) {
    throw new Error('Usage: darwin canary <agent> [--json] [--exit-on-drift]');
  }
  const asJson = args.includes('--json');
  const exitOnDrift = args.includes('--exit-on-drift');

  const config = await loadConfig();
  const memory = createMemory(config);
  await memory.init();

  try {
    const state = await memory.getState();
    const activeVersion = state.activeVersions[agentName] ?? null;
    const experiments = await memory.loadExperiments(agentName, CANARY_WINDOW);

    const report = runCanaryOverExperiments(agentName, experiments, activeVersion);

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }

    if (exitOnDrift && report.status === 'drift') {
      process.exitCode = 1;
    }
  } finally {
    await memory.close();
  }
}

function printReport(report: CanaryReport): void {
  const icon =
    report.status === 'drift' ? '⚠' : report.status === 'ok' ? '✓' : '·';

  console.log('');
  console.log(`[darwin] Canary: ${report.agentName}${report.promptVersion ? ` / ${report.promptVersion}` : ''}`);
  if (report.baselineId) console.log(`  Baseline:  ${report.baselineId}`);
  console.log(`  Evaluated: ${report.evaluated} candidate run(s)`);
  console.log(`  Status:    ${icon} ${report.status.toUpperCase()}`);

  if (report.result) {
    const r = report.result;
    console.log(`  Drifted:   ${r.driftedCount}/${r.total} runs`);
    console.log(`  Medians:   tool-Jaccard ${r.medianToolJaccard.toFixed(2)} | turn-ratio ${r.medianTurnRatio.toFixed(2)}`);
    if (r.reasons.length > 0) {
      console.log(`  Reasons:   ${r.reasons.join('; ')}`);
    }
  }

  console.log(`  ${report.message}`);
  console.log('');
}
