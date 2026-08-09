/**
 * darwin eval <agent> --tasks <file.json>
 *
 * Offline eval: run stored prompt versions (or all of them) over a frozen
 * task set, score each output with the built-in critic, and print/write a
 * per-task comparison table with arm deltas against the baseline.
 *
 *   darwin eval writer --tasks tasks.json                # active version vs v1
 *   darwin eval writer --tasks tasks.json --versions v1,v3
 *   darwin eval writer --tasks tasks.json --all-versions --runs 3
 *   darwin eval writer --tasks tasks.json --dry          # wiring check, 0 LLM calls
 *
 * Task-set format (JSON): `[{"id": "t1", "type": "tech", "task": "..."}, …]`
 * or `{"tasks": [...]}` — the same shape as `benchmark/seed-tasks.json`.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { builtinAgents } from '../agents/index.js';
import { createMemory } from '../memory/index.js';
import { loadConfig } from '../core/agent.js';
import { runAgent, setMaxRunsPerProcess, setMaxRunWallMs } from '../core/runner.js';
import { parseCriticScore } from '../evolution/parse-score.js';
import {
  parseEvalTasks,
  runEval,
  renderEvalReport,
  type EvalArm,
  type EvalTask,
} from '../eval/eval-runner.js';
import type { AgentDefinition } from '../types.js';

interface EvalFlags {
  agentName: string;
  tasksPath?: string;
  /** Explicit version labels (`--versions v1,v3`). */
  versions?: string[];
  allVersions: boolean;
  runsPerCell: number;
  json: boolean;
  dry: boolean;
}

export function parseEvalArgs(args: string[]): EvalFlags {
  const flags: EvalFlags = {
    agentName: '',
    allVersions: false,
    runsPerCell: 1,
    json: false,
    dry: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case '--tasks': {
        // A following flag token is a missing value, not this flag's argument
        // (same contract as every value-taking flag since 0.13.2) — otherwise
        // `--tasks --json` silently eats --json and the error surfaces later
        // as a bizarre "no such file: --json".
        const value = args[i + 1];
        if (value === undefined || value.startsWith('-')) {
          console.warn('[darwin] --tasks needs a file path — ignored.');
          break;
        }
        flags.tasksPath = value;
        i++;
        break;
      }
      case '--versions': {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('-')) {
          console.warn('[darwin] --versions needs a comma-separated list (e.g. v1,v3) — ignored.');
          break;
        }
        flags.versions = value
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v !== '');
        i++;
        break;
      }
      case '--all-versions':
        flags.allVersions = true;
        break;
      case '--runs': {
        // Same guard family as --max-merge (evolution-flags.ts): a following
        // flag token is a missing value, and strict digits-only parsing keeps
        // Number()'s coercions ('' → 0) out. Digits alone are NOT enough
        // (R3 review, P0): Number('9'.repeat(400)) === Infinity, and the
        // sweep swallows cell errors by design — an infinite runsPerCell
        // would loop one cell forever. Safe-integer + a hard cap close that.
        const MAX_RUNS_PER_CELL = 1000;
        const value = args[i + 1];
        if (value === undefined || value.startsWith('-') || !/^\d+$/.test(value.trim())) {
          console.warn('[darwin] --runs needs a positive integer — using 1.');
          if (value !== undefined && !value.startsWith('-')) i++;
          break;
        }
        const n = Number(value.trim());
        if (!Number.isSafeInteger(n) || n < 1 || n > MAX_RUNS_PER_CELL) {
          console.warn(`[darwin] --runs must be 1-${MAX_RUNS_PER_CELL} — using 1.`);
          i++;
          break;
        }
        flags.runsPerCell = n;
        i++;
        break;
      }
      case '--json':
        flags.json = true;
        break;
      case '--dry':
        flags.dry = true;
        break;
      default:
        positional.push(arg);
    }
  }

  flags.agentName = positional[0] ?? '';
  return flags;
}

export async function evalCommand(args: string[]): Promise<void> {
  const flags = parseEvalArgs(args);

  if (!flags.agentName) {
    throw new Error('Usage: darwin eval <agent> --tasks <file.json> [--versions v1,v3 | --all-versions] [--runs N]');
  }
  if (!flags.tasksPath) {
    throw new Error('darwin eval needs a task set: --tasks <file.json> (same shape as benchmark/seed-tasks.json).');
  }

  const agent = builtinAgents[flags.agentName];
  if (!agent) {
    throw new Error(
      `Unknown agent: "${flags.agentName}". Available: ${Object.keys(builtinAgents).join(', ')}`,
    );
  }

  const tasks: EvalTask[] = parseEvalTasks(readFileSync(resolve(flags.tasksPath), 'utf-8'));

  const config = await loadConfig();
  const memory = createMemory(config);
  await memory.init();

  try {
    // ── Resolve arms from stored prompt versions ─────
    const stored = await memory.getAllPromptVersions(agent.name);
    const state = await memory.getState();
    const activeLabel = state.activeVersions[agent.name] ?? 'v1';

    // v1 always exists conceptually: it is the agent definition's static
    // prompt, seeded on first run. When nothing is stored yet, fall back to
    // the definition so `darwin eval` works before the first `darwin run`.
    const promptByLabel = new Map<string, string>();
    promptByLabel.set('v1', agent.systemPrompt);
    for (const v of stored) promptByLabel.set(v.version, v.promptText);

    let labels: string[];
    if (flags.versions && flags.versions.length > 0) {
      labels = flags.versions;
    } else if (flags.allVersions) {
      labels = [...promptByLabel.keys()];
    } else {
      // Default: baseline v1 vs the active version (one arm when they match).
      labels = activeLabel === 'v1' ? ['v1'] : ['v1', activeLabel];
    }

    const missing = labels.filter((l) => !promptByLabel.has(l));
    if (missing.length > 0) {
      throw new Error(
        `No stored prompt for version${missing.length > 1 ? 's' : ''} ${missing.join(', ')} of "${agent.name}". ` +
          `Stored: ${[...promptByLabel.keys()].join(', ')}.`,
      );
    }
    // Fail duplicate arms HERE so --dry validates what the real run would
    // reject (R6 review) — `--versions v3,v3` must not report a green dry run.
    if (new Set(labels).size !== labels.length) {
      throw new Error(`Duplicate versions in --versions: ${labels.join(', ')} — each arm once.`);
    }

    // Canonical labels stay clean — `active` is display metadata, so a real
    // stored version can never collide with a decorated label (R3 review).
    const arms: EvalArm[] = labels.map((label) => ({
      label,
      promptText: promptByLabel.get(label)!,
      active: label === activeLabel,
    }));

    const llmCalls = arms.length * tasks.length * flags.runsPerCell * 2;
    console.log(`\n[darwin] Offline eval: ${agent.name}`);
    console.log(`[darwin] Arms: ${arms.map((a) => a.label + (a.active ? '*' : '')).join(', ')}  (* = active)`);
    console.log(`[darwin] Tasks: ${tasks.length}   Runs/cell: ${flags.runsPerCell}`);
    console.log(`[darwin] LLM calls expected: ~${llmCalls} (arms × tasks × runs × [1 run + 1 judge])`);

    if (flags.dry) {
      console.log('\n--dry: wiring validated (agent + versions + tasks loaded). No LLM calls made.');
      return;
    }

    // Deliberate batch — same reasoning as benchmark/evolution-benchmark.ts:
    // the per-process budget caps are sized for one agent session, not a
    // sweep, so a full grid would trip them halfway through.
    setMaxRunsPerProcess(0);
    setMaxRunWallMs(0);

    // ── Wire run + judge to the real agent/critic ────
    const run = async (promptText: string, task: EvalTask): Promise<string> => {
      const armAgent: AgentDefinition = { ...agent, systemPrompt: promptText, evolution: undefined };
      const r = await runAgent(armAgent, task.task, {
        config,
        taskType: task.type ?? 'general',
        autonomous: true,
      });
      return r.output;
    };

    const critic = builtinAgents['critic']!;
    const score = async (task: EvalTask, output: string): Promise<number | null> => {
      const criticTask = `Evaluate the following ${agent.role} output for the task "${task.task}":\n\n${output}`;
      const judged = await runAgent(critic, criticTask, {
        config,
        taskType: 'evaluation',
        autonomous: true,
      });
      return parseCriticScore(judged.output);
    };

    const report = await runEval({
      agentName: agent.name,
      arms,
      tasks,
      run,
      score,
      runsPerCell: flags.runsPerCell,
      onCell: (arm, task, cell) => {
        console.log(
          `[darwin]   ${arm.label}${arm.active ? '*' : ''} × ${task.id}: ` +
            (cell.mean === null ? 'no score' : `${cell.mean.toFixed(2)}/10 (n=${cell.samples})`) +
            (cell.failures > 0 ? `  (${cell.failures} dropped)` : ''),
        );
      },
    });

    const rendered = renderEvalReport(report);
    console.log('\n' + rendered);

    // ── Persist next to the runner's reports ─────────
    const dataDir = config.dataDir ?? '.darwin';
    const outDir = resolve(join(dataDir, 'reports'));
    mkdirSync(outDir, { recursive: true });
    // Millisecond stamp + pid: a re-run — even two processes in the same
    // second (R4 review) — must not overwrite an earlier report or strand a
    // stale .json next to a fresh .md.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = join(outDir, `eval-${agent.name}-${stamp}-${process.pid}`);
    writeFileSync(`${base}.md`, `# Darwin offline eval — ${agent.name} (${stamp})\n\n\`\`\`\n${rendered}\n\`\`\`\n`, 'utf-8');
    if (flags.json) {
      writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), 'utf-8');
    }
    console.log(`\n[darwin] Wrote ${base}.md${flags.json ? ` and ${base}.json` : ''}`);
  } finally {
    await memory.close();
  }
}
