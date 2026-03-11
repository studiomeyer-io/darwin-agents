/**
 * darwin init
 *
 * Initializes Darwin in the current project.
 * Creates .darwin/ directory, darwin.config.ts template, and .gitignore.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_TEMPLATE = `import { defineConfig } from 'darwin-agents';

export default defineConfig({
  provider: 'claude-cli',
  memory: 'sqlite',
  evolution: {
    enabled: true,
    minRuns: 5,
    safetyGate: true,
  },
});
`;

const GITIGNORE_TEMPLATE = `.darwin/
node_modules/
`;

/**
 * Initialize Darwin in the current working directory.
 * Creates .darwin/ dir, darwin.config.ts, and .gitignore if they don't exist.
 */
export async function initCommand(): Promise<void> {
  const cwd = process.cwd();
  const darwinDir = join(cwd, '.darwin');
  const configPath = join(cwd, 'darwin.config.ts');
  const gitignorePath = join(cwd, '.gitignore');

  // Create .darwin/ directory
  if (existsSync(darwinDir)) {
    console.log('[darwin] .darwin/ directory already exists — skipping');
  } else {
    mkdirSync(darwinDir, { recursive: true });
    console.log('[darwin] Created .darwin/ directory');
  }

  // Create darwin.config.ts
  if (existsSync(configPath)) {
    console.log('[darwin] darwin.config.ts already exists — skipping');
  } else {
    writeFileSync(configPath, CONFIG_TEMPLATE, 'utf-8');
    console.log('[darwin] Created darwin.config.ts');
  }

  // Create .gitignore
  if (existsSync(gitignorePath)) {
    console.log('[darwin] .gitignore already exists — skipping');
  } else {
    writeFileSync(gitignorePath, GITIGNORE_TEMPLATE, 'utf-8');
    console.log('[darwin] Created .gitignore');
  }

  console.log(`
[darwin] Initialized! Next steps:

  1. Edit darwin.config.ts to configure your setup
  2. Create your first agent:
     darwin create my-agent

  3. Run it:
     darwin run my-agent "your task here"
`);
}
