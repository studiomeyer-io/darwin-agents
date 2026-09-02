#!/usr/bin/env node
/**
 * Darwin CLI — AI agents that improve themselves.
 *
 * Usage:
 *   darwin run <agent> "task description"
 *   darwin evolve <agent> --enable
 *   darwin approve [agent]
 *   darwin status [agent]
 *   darwin create <name>
 *   darwin init
 */

import { runCommand } from './run.js';
import { statusCommand } from './status.js';
import { evolveCommand } from './evolve.js';
import { initCommand } from './init.js';
import { createCommand } from './create.js';
import { canaryCommand } from './canary.js';
import { evalCommand } from './eval.js';
import { approveCommand } from './approve.js';

const HELP = `
  darwin — AI agents that improve themselves.

  Usage:
    darwin run <agent> "task"     Run an agent on a task
    darwin status [agent]        Show evolution status & metrics
    darwin eval <agent> --tasks <file>   Offline eval: stored versions over a frozen task set
    darwin canary <agent>        Check for behavioural drift vs a frozen baseline
    darwin approve [agent]       Decide on a challenger held by the approval gate
    darwin evolve <agent>        Manage evolution settings
    darwin create <name>         Scaffold a new agent
    darwin init                  Initialize darwin in current project

  Agents:
    writer       Content writer (zero-config, no API keys)
    researcher   Web research (needs TAVILY_API_KEY)
    critic       Quality evaluator (used by Darwin internally)
    analyst      Code analysis (filesystem access)

  Examples:
    darwin run writer "Explain the CAP theorem"
    darwin run researcher "AI Agent frameworks 2026"
    darwin run analyst --path ./src
    darwin status researcher
    darwin eval writer --tasks tasks.json --versions v1,v3 --runs 3
    darwin evolve researcher --enable
    darwin evolve researcher --force
    darwin approve                          List proposals awaiting approval
    darwin approve researcher               Show the diff, then approve it
    darwin approve researcher --reject      Discard it and free the slot

  Evolve flags:
    --enable / --disable  Persistently turn self-evolution on/off for an agent
    --reset               Reset the agent back to its v1 prompt
    --force               Force one optimization cycle now (needs >=1 prior run)

  Options:
    --task-type <type>    Categorize the task (tech, webdesign, market, general)
    --no-evolve           Skip evolution check after run
    --no-critic           Skip automatic critic evaluation
    --model <model>       Override LLM model
    --verbose             Show detailed output
    --help                Show this help

  Advanced evolution flags (run + evolve; persisted by evolve):
    --gepa / --no-gepa            GEPA reflective optimizer
    --merge / --no-merge          GEPA system-aware merge
    --pareto-gate / --no-pareto-gate   multi-objective A/B activation gate
    --coverage / --no-coverage    instance-wise coverage selection
    --reflection-model <id>       stronger reflection model for GEPA
    --demos / --no-demos          SIMBA-style demo injection (v0.10)
    --candidate-selection <s>     reflection parent: active|best|pareto|epsilon-greedy
    --skip-perfect / --no-skip-perfect   drop perfect-score runs from optimizer feedback (v0.11)
    --max-merge <n>               lifetime cap on merge-derived challengers (v0.11)
    --max-test-days <n>           close an A/B test after n days if it cannot reach minRuns (v0.13)
    --require-confidence / --no-require-confidence   confidence gate on the A/B margin (v0.14)
    --confidence-method <m>       effect-size | msprt | hoeffding | eb (v0.14; eb v0.16)
    --require-approval / --no-require-approval       hold challengers for a human (v0.17)
    --approval-timeout-days <n>   auto-reject an untouched proposal after n days (v0.17)

  Approve flags (darwin approve):
    --reject                      Discard the proposal instead of starting its A/B test
    --reason <text>               Recorded with the rejection
    --force                       Approve even though the active prompt moved since the proposal

  Eval flags (darwin eval):
    --tasks <file.json>           Frozen task set ([{id, type, task}, …])
    --versions v1,v3              Compare specific stored versions (default: v1 vs active)
    --all-versions                Compare every stored version
    --runs <n>                    Samples per cell (averages judge variance)
    --json                        Also write the report as JSON
    --dry                         Validate wiring, make zero LLM calls
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  const command = args[0];

  try {
    switch (command) {
      case 'run':
        await runCommand(args.slice(1));
        break;
      case 'status':
        await statusCommand(args.slice(1));
        break;
      case 'eval':
        await evalCommand(args.slice(1));
        break;
      case 'canary':
        await canaryCommand(args.slice(1));
        break;
      case 'approve':
        await approveCommand(args.slice(1));
        break;
      case 'evolve':
        await evolveCommand(args.slice(1));
        break;
      case 'create':
        await createCommand(args.slice(1));
        break;
      case 'init':
        await initCommand();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n[darwin] Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
