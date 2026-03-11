/**
 * darwin create <name>
 *
 * Scaffolds a new agent definition file in agents/<name>.ts.
 * Validates the name (lowercase, no spaces) and generates a template.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Generate the agent template file content for a given agent name.
 */
function agentTemplate(name: string): string {
  const roleName = name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return `/**
 * ${roleName} Agent
 *
 * Created with: darwin create ${name}
 * Run with:     darwin run ${name} "your task"
 */

import { defineAgent } from 'darwin-agents';

export default defineAgent({
  name: '${name}',
  role: '${roleName}',
  description: 'TODO: Describe what this agent does.',
  systemPrompt: \`You are a ${roleName} agent.

YOUR MISSION:
TODO: Define the agent's core purpose.

RULES:
- Be precise and thorough
- Cite sources when applicable
- Structure output clearly with headers
- Never invent information

OUTPUT FORMAT:
# Result

## Summary
{One-sentence overview}

## Details
{Main content with structured sections}

## Next Steps
{Actionable recommendations}\`,

  evolution: {
    enabled: true,
    evaluator: 'critic',
  },
});
`;
}

/**
 * Scaffold a new agent. Validates name and writes template to agents/<name>.ts.
 */
export async function createCommand(args: string[]): Promise<void> {
  const name = args[0];

  if (!name) {
    throw new Error('Usage: darwin create <name>\n  Example: darwin create summarizer');
  }

  // Validate agent name
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid agent name: "${name}". ` +
      `Must be lowercase, start with a letter, and contain only letters, digits, and hyphens.`
    );
  }

  if (name.length > 64) {
    throw new Error(`Agent name "${name}" exceeds 64 character limit`);
  }

  const cwd = process.cwd();
  const agentsDir = join(cwd, 'agents');
  const filePath = join(agentsDir, `${name}.ts`);

  // Check if file already exists
  if (existsSync(filePath)) {
    throw new Error(`Agent already exists: agents/${name}.ts`);
  }

  // Create agents/ directory if needed
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
    console.log('[darwin] Created agents/ directory');
  }

  // Write agent template
  writeFileSync(filePath, agentTemplate(name), 'utf-8');

  console.log(`
[darwin] Created agent: agents/${name}.ts

  Next steps:

  1. Edit agents/${name}.ts — update role, description, and systemPrompt
  2. Run it:
     darwin run ${name} "your task here"

  3. Check evolution after a few runs:
     darwin status ${name}
`);
}
