/**
 * Example: Defining a Custom Darwin Agent
 *
 * This shows how to create a fully configured agent with evolution,
 * custom metric weights, and MCP tool access.
 *
 * Run: npx tsx examples/custom-agent.ts
 */

import { defineAgent, runAgent } from '../src/index.js';
import type { AgentDefinition, RunResult } from '../src/index.js';

// ─── Step 1: Define the agent ─────────────────────────
//
// Every agent needs: name, role, description, systemPrompt.
// The systemPrompt is what Darwin evolves over time.

const codeReviewer: AgentDefinition = defineAgent({
  name: 'code-reviewer',
  role: 'Code Review Assistant',
  description: 'Reviews code for bugs, performance issues, and style. Evolves to catch more issues over time.',

  // This prompt is the starting point. After enough runs,
  // Darwin will analyze patterns in the critic's feedback
  // and generate an improved variant automatically.
  systemPrompt: `You are a senior code reviewer.

REVIEW CHECKLIST:
- Security: injection, auth, secrets in code
- Performance: N+1 queries, unnecessary allocations, missing indexes
- Correctness: edge cases, null handling, off-by-one errors
- Style: naming, function length, dead code

RULES:
- Be specific. "Line 42: missing null check on user.email" not "handle nulls better"
- Severity levels: CRITICAL / WARNING / SUGGESTION
- If the code is clean, say so. Don't invent problems.
- Max 10 findings per review, prioritized by severity

OUTPUT FORMAT:
## Summary
One-sentence verdict.

## Findings
1. [SEVERITY] File:Line — Description
   Fix: concrete suggestion

## Verdict
APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION`,

  // ─── Step 2: Configure evolution ──────────────────────
  //
  // enabled: true  — Darwin will optimize this agent's prompt
  // evaluator: 'critic' — the built-in critic agent scores each run
  // minRuns: 5 — wait for 5 runs before attempting optimization
  evolution: {
    enabled: true,
    evaluator: 'critic',
    minRuns: 5,

    // ─── Step 3: Set metric weights ──────────────────────
    //
    // These control what Darwin optimizes FOR. Weights must sum to ~1.0.
    //
    // For a code reviewer:
    // - quality matters most (did it find real issues?)
    // - success is critical (don't crash mid-review)
    // - sources/length matter less than for a researcher
    metrics: {
      quality: 0.50,      // Critic's quality score (most important)
      sourceCount: 0.00,  // Not relevant for code review
      outputLength: 0.10, // Structured output should be consistent
      duration: 0.10,     // Fast reviews preferred
      success: 0.30,      // Must complete reliably
    },
  },

  // Optional: MCP servers and built-in tools this agent can use
  mcp: [],                              // No MCP servers needed
  tools: ['Read', 'Glob', 'Grep'],     // Filesystem access for reading code
  maxTurns: 12,                         // Enough turns for a thorough review
});

// ─── Step 4: Run the agent ──────────────────────────────

async function main(): Promise<void> {
  console.log(`Running ${codeReviewer.name}...`);

  const result: RunResult = await runAgent(
    codeReviewer,
    'Review this TypeScript function for issues:\n\n' +
    'function getUser(id: string) {\n' +
    '  const user = db.query(`SELECT * FROM users WHERE id = ${id}`);\n' +
    '  return user[0].name.toUpperCase();\n' +
    '}',
    {
      taskType: 'code-review',  // Categorize for per-type analytics
    },
  );

  console.log(`\nCompleted in ${result.experiment.metrics.durationMs}ms`);
  console.log(`Output length: ${result.experiment.metrics.outputLength} chars`);
  if (result.reportPath) {
    console.log(`Report saved: ${result.reportPath}`);
  }

  // The evolution cycle:
  // 1. This run's output gets evaluated by the critic agent
  // 2. After 5+ runs, Darwin detects patterns (e.g., "misses SQL injection")
  // 3. A new prompt variant is generated and A/B tested
  // 4. If the new variant scores >5% better, it becomes the default
  // 5. If it regresses >20%, Darwin rolls back automatically (safety gate)
}

main().catch(console.error);
