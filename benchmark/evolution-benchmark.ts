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
 *   npm run benchmark            # full run, all seed tasks (≈4 LLM calls/task)
 *   npm run benchmark -- --quick # 1 task (smoke test)
 *   npm run benchmark -- --dry   # validate wiring, make zero LLM calls
 *
 * Provider: uses your default Darwin provider. With the Claude CLI provider the
 * runs go through your Claude subscription (no per-token billing); set
 * DARWIN_USE_API_KEY=1 to bill against an API key instead.
 *
 * NOTE on provenance: `prompts/writer-v2-evolved.txt` is verbatim what Darwin's
 * optimizer generated from v1 in our own run (change reason: "address 1 weakness:
 * 'market' below good threshold"). It was NOT hand-tuned for the tasks below.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgent, loadConfig, writer, critic } from '../src/index.js';
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
}

const flags = new Set(process.argv.slice(2));
const DRY = flags.has('--dry');
const QUICK = flags.has('--quick');

const v1Prompt = readFileSync(join(HERE, 'prompts/writer-v1-baseline.txt'), 'utf-8').trim();
const v2Prompt = readFileSync(join(HERE, 'prompts/writer-v2-evolved.txt'), 'utf-8').trim();
const allTasks = JSON.parse(readFileSync(join(HERE, 'seed-tasks.json'), 'utf-8')) as SeedTask[];
const tasks = QUICK ? allTasks.slice(0, 1) : allTasks;

/** Parse a 1–10 critic score from its output (mirrors the CLI's run command). */
function parseScore(out: string): number | null {
  const primary = out.match(/===SCORE===\s*(\d+(?:\.\d+)?)/);
  let score = primary ? parseFloat(primary[1]!) : null;
  if (score === null) {
    const fallback = out.match(/\b(\d+(?:\.\d+)?)\s*\/\s*10\b/);
    if (fallback) score = parseFloat(fallback[1]!);
  }
  return score === null ? null : Math.max(1, Math.min(10, score));
}

/** Run the writer with `promptText` on `task`, then score the output with the built-in critic. */
async function scoreOne(promptText: string, task: SeedTask, config: DarwinConfig): Promise<number | null> {
  const agent: AgentDefinition = { ...writer, systemPrompt: promptText, evolution: undefined };
  const run = await runAgent(agent, task.task, { config, taskType: task.type, autonomous: true });

  const criticTask = `Evaluate the following Content Writer output for the task "${task.task}":\n\n${run.output}`;
  const judged = await runAgent(critic, criticTask, { config, taskType: 'evaluation', autonomous: true });
  return parseScore(judged.output);
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

async function main(): Promise<void> {
  const config = await loadConfig();

  console.log('\nDarwin Evolution Benchmark');
  console.log('──────────────────────────');
  console.log(`Baseline prompt: writer-v1-baseline.txt (${v1Prompt.length} chars)`);
  console.log(`Evolved  prompt: writer-v2-evolved.txt  (${v2Prompt.length} chars)`);
  console.log(`Tasks: ${tasks.length}${QUICK ? ' (--quick)' : ''}`);
  console.log(`LLM calls expected: ~${tasks.length * 4} (2 arms × [1 write + 1 critic] per task)`);

  if (DRY) {
    console.log('\n--dry: wiring validated (prompts + tasks + config loaded). No LLM calls made.');
    return;
  }

  const v1Results: ArmResult[] = [];
  const v2Results: ArmResult[] = [];

  for (const task of tasks) {
    process.stdout.write(`\n[${task.id}] baseline… `);
    const s1 = await scoreOne(v1Prompt, task, config);
    process.stdout.write(s1 === null ? 'no score' : `${s1}/10`);
    v1Results.push({ taskId: task.id, score: s1 });

    process.stdout.write('  |  evolved… ');
    const s2 = await scoreOne(v2Prompt, task, config);
    process.stdout.write(s2 === null ? 'no score' : `${s2}/10`);
    v2Results.push({ taskId: task.id, score: s2 });
  }

  const v1Scores = v1Results.map((r) => r.score).filter((s): s is number => s !== null);
  const v2Scores = v2Results.map((r) => r.score).filter((s): s is number => s !== null);
  const v1Avg = mean(v1Scores);
  const v2Avg = mean(v2Scores);
  const delta = v2Avg - v1Avg;

  const lines = [
    '',
    '',
    'Results',
    '───────',
    'Task                   baseline   evolved',
  ];
  for (const task of tasks) {
    const a = v1Results.find((r) => r.taskId === task.id)?.score;
    const b = v2Results.find((r) => r.taskId === task.id)?.score;
    lines.push(
      `${task.id.padEnd(22)} ${String(a ?? '—').padStart(8)} ${String(b ?? '—').padStart(9)}`,
    );
  }
  lines.push('─'.repeat(42));
  lines.push(
    `${'AVG'.padEnd(22)} ${v1Avg.toFixed(2).padStart(8)} ${v2Avg.toFixed(2).padStart(9)}`,
  );
  lines.push('');
  lines.push(
    `Evolved prompt ${delta >= 0 ? 'beat' : 'trailed'} baseline by ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} points on ${tasks.length} held-out tasks.`,
  );
  lines.push('(Small samples are noisy — this is a reproducible harness, not a significance test.)');

  const report = lines.join('\n');
  console.log(report);

  const outDir = join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(join(outDir, `benchmark-${stamp}.md`), `# Darwin Evolution Benchmark — ${stamp}\n\n\`\`\`${report}\n\`\`\`\n`, 'utf-8');
  console.log(`\nWrote benchmark/results/benchmark-${stamp}.md`);
}

main().catch((err) => {
  console.error('\nBenchmark failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
