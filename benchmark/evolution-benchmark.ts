/**
 * Darwin — Evolution Benchmark
 *
 * Reproducible proof that an *evolved* prompt beats the *baseline* it grew from,
 * scored on a frozen set of held-out tasks the evolution never saw.
 *
 * This is the honest version of a metrics claim: we ship the two prompts (the
 * baseline `writer-v1` and the prompt Darwin's own optimizer produced, `writer-v2`),
 * a fixed task set, and the exact scoring loop — so anyone can reproduce the delta
 * on their own machine and their own tasks.
 *
 *   npm run benchmark               # all seed tasks, 1 run/cell (≈4 LLM calls/task)
 *   npm run benchmark -- --runs 3   # 3 runs per cell, averaged — cuts judge variance
 *   npm run benchmark -- --quick    # 1 task (smoke test)
 *   npm run benchmark -- --dry      # validate wiring, make zero LLM calls
 *
 * Provider: uses your default Darwin provider. With the Claude CLI provider the
 * runs go through your Claude subscription (no per-token billing); set
 * DARWIN_USE_API_KEY=1 to bill against an API key instead.
 *
 * NOTE on provenance: `prompts/writer-v2-evolved.txt` is verbatim what Darwin's
 * optimizer generated from v1 in our own run (change reason: "address 1 weakness:
 * 'market' below good threshold"). It was NOT hand-tuned for the tasks below.
 *
 * NOTE on noise: a single run per cell is dominated by LLM-judge variance (±1 pt
 * is common). Use `--runs 3` (or more) so each cell is the mean of N samples;
 * even then, treat small task counts as directional, not significant — for a real
 * significance test run the live loop with `confidenceMethod: 'msprt'`.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgent, loadConfig, writer, critic, parseCriticScore } from '../src/index.js';
import { setMaxRunsPerProcess, setMaxRunWallMs } from '../src/core/runner.js';
import type { AgentDefinition, DarwinConfig } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface SeedTask {
  id: string;
  type: string;
  task: string;
}

interface ArmResult {
  taskId: string;
  score: number | null;
  samples: number;
}

const argv = process.argv.slice(2);
const flags = new Set(argv);
const DRY = flags.has('--dry');
const QUICK = flags.has('--quick');
const runsIdx = argv.indexOf('--runs');
const RUNS =
  runsIdx >= 0 && argv[runsIdx + 1] ? Math.max(1, parseInt(argv[runsIdx + 1]!, 10) || 1) : 1;

const v1Prompt = readFileSync(join(HERE, 'prompts/writer-v1-baseline.txt'), 'utf-8').trim();
const v2Prompt = readFileSync(join(HERE, 'prompts/writer-v2-evolved.txt'), 'utf-8').trim();
const allTasks = JSON.parse(readFileSync(join(HERE, 'seed-tasks.json'), 'utf-8')) as SeedTask[];
const tasks = QUICK ? allTasks.slice(0, 1) : allTasks;

/**
 * Parse a 1–10 critic score from its output. Delegates to the shared
 * {@link parseCriticScore} so the benchmark and the CLI's run command extract
 * scores identically (===SCORE===, N/10, "N out of 10", "rating: N", …).
 */
function parseScore(out: string): number | null {
  return parseCriticScore(out);
}

/** Run the writer with `promptText` on `task` once, then score the output with the built-in critic. */
async function scoreOnce(promptText: string, task: SeedTask, config: DarwinConfig): Promise<number | null> {
  const agent: AgentDefinition = { ...writer, systemPrompt: promptText, evolution: undefined };
  const run = await runAgent(agent, task.task, { config, taskType: task.type, autonomous: true });

  const criticTask = `Evaluate the following Content Writer output for the task "${task.task}":\n\n${run.output}`;
  const judged = await runAgent(critic, criticTask, { config, taskType: 'evaluation', autonomous: true });
  return parseScore(judged.output);
}

/** Run a cell `runs` times and return the mean of the non-null scores (null if all failed). */
async function scoreCell(
  promptText: string,
  task: SeedTask,
  config: DarwinConfig,
  runs: number,
): Promise<{ mean: number | null; samples: number }> {
  const scores: number[] = [];
  for (let i = 0; i < runs; i++) {
    try {
      const s = await scoreOnce(promptText, task, config);
      if (s !== null) scores.push(s);
    } catch {
      // A transient run failure (provider hiccup, timeout) drops one sample
      // instead of aborting the whole sweep — partial cells still report.
      process.stdout.write('!');
    }
  }
  return { mean: scores.length === 0 ? null : mean(scores), samples: scores.length };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function fmt(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : x.toFixed(2);
}

async function main(): Promise<void> {
  const config = await loadConfig();

  console.log('\nDarwin Evolution Benchmark');
  console.log('──────────────────────────');
  console.log(`Baseline prompt: writer-v1-baseline.txt (${v1Prompt.length} chars)`);
  console.log(`Evolved  prompt: writer-v2-evolved.txt  (${v2Prompt.length} chars)`);
  console.log(`Tasks: ${tasks.length}${QUICK ? ' (--quick)' : ''}   Runs per cell: ${RUNS}`);
  console.log(`LLM calls expected: ~${tasks.length * 4 * RUNS} (2 arms × ${RUNS} runs × [1 write + 1 critic] per task)`);

  if (DRY) {
    console.log('\n--dry: wiring validated (prompts + tasks + config loaded). No LLM calls made.');
    return;
  }

  // This benchmark is an intentional batch — many runAgent calls in one process.
  // Disable Darwin's per-process budget caps (default 100 runs / 1h wall-clock,
  // sized for a single agent session, not a sweep) so the full grid completes.
  setMaxRunsPerProcess(0);
  setMaxRunWallMs(0);

  const v1Results: ArmResult[] = [];
  const v2Results: ArmResult[] = [];

  for (const task of tasks) {
    process.stdout.write(`\n[${task.id}] baseline… `);
    const c1 = await scoreCell(v1Prompt, task, config, RUNS);
    process.stdout.write(c1.mean === null ? 'no score' : `${c1.mean.toFixed(2)}/10 (n=${c1.samples})`);
    v1Results.push({ taskId: task.id, score: c1.mean, samples: c1.samples });

    process.stdout.write('  |  evolved… ');
    const c2 = await scoreCell(v2Prompt, task, config, RUNS);
    process.stdout.write(c2.mean === null ? 'no score' : `${c2.mean.toFixed(2)}/10 (n=${c2.samples})`);
    v2Results.push({ taskId: task.id, score: c2.mean, samples: c2.samples });
  }

  const v1Scores = v1Results.map((r) => r.score).filter((s): s is number => s !== null);
  const v2Scores = v2Results.map((r) => r.score).filter((s): s is number => s !== null);
  const v1Avg = mean(v1Scores);
  const v2Avg = mean(v2Scores);
  const delta = v2Avg - v1Avg;

  const lines = [
    '',
    '',
    `Results  (${tasks.length} tasks × ${RUNS} run${RUNS > 1 ? 's' : ''}/cell, scores = mean per cell)`,
    '─'.repeat(46),
    'Task                   baseline   evolved',
  ];
  for (const task of tasks) {
    const a = v1Results.find((r) => r.taskId === task.id)?.score;
    const b = v2Results.find((r) => r.taskId === task.id)?.score;
    lines.push(`${task.id.padEnd(22)} ${fmt(a).padStart(8)} ${fmt(b).padStart(9)}`);
  }
  lines.push('─'.repeat(46));
  lines.push(`${'AVG'.padEnd(22)} ${v1Avg.toFixed(2).padStart(8)} ${v2Avg.toFixed(2).padStart(9)}`);
  lines.push('');
  lines.push(
    `Evolved prompt ${delta >= 0 ? 'beat' : 'trailed'} baseline by ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} points across ${tasks.length} held-out tasks (${RUNS} run${RUNS > 1 ? 's' : ''}/cell).`,
  );
  lines.push('Small task counts stay noisy even when averaged — this is a reproducible harness, not a significance test.');

  const report = lines.join('\n');
  console.log(report);

  const outDir = join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(outDir, `benchmark-${stamp}.md`),
    `# Darwin Evolution Benchmark — ${stamp}\n\n\`\`\`${report}\n\`\`\`\n`,
    'utf-8',
  );
  console.log(`\nWrote benchmark/results/benchmark-${stamp}.md`);
}

main().catch((err) => {
  console.error('\nBenchmark failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
