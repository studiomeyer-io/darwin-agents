#!/usr/bin/env node
/**
 * Darwin CLI — AI agents that improve themselves.
 *
 * Usage:
 *   darwin run <agent> "task description"
 *   darwin evolve <agent> --enable
 *   darwin status [agent]
 *   darwin create <name>
 *   darwin init
 */

import { runCommand } from './run.js';
import { statusCommand } from './status.js';
import { evolveCommand } from './evolve.js';
import { initCommand } from './init.js';
import { createCommand } from './create.js';

const HELP = `
  darwin — AI agents that improve themselves.

  Usage:
    darwin run <agent> "task"     Run an agent on a task
    darwin status [agent]        Show evolution status & metrics
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
    darwin evolve researcher --enable

  Options:
    --task-type <type>    Categorize the task (tech, webdesign, market, general)
    --no-evolve           Skip evolution check after run
    --no-critic           Skip automatic critic evaluation
    --model <model>       Override LLM model
    --verbose             Show detailed output
    --help                Show this help
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
