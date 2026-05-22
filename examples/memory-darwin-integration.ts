/**
 * Example: End-to-End Memory + Darwin Integration
 *
 * Closed-loop in three lines:
 *   1. Run an agent.
 *   2. After multi-critic, persist findings via McpMemoryBridge.
 *   3. Before the next run, fetch relevant lessons and inject them.
 *
 * Backend-agnostic: defaults to `@studiomeyer/local-memory-mcp` so it works
 * out of the box with no API keys. Override `localMemory()` with
 * `remoteMemory(url, …)` to point at any MCP-compliant memory server.
 *
 * Run demo (requires `@studiomeyer/local-memory-mcp` reachable via npx):
 *   npx tsx examples/memory-darwin-integration.ts
 *
 * The demo deliberately uses a stub agent runner so it doesn't depend on
 * a live LLM connection. Replace `simulateAgentRun()` with your real
 * `runAgent()` call once you wire this into your codebase.
 */

import { localMemory, type Lesson, type RetrievableFeedbackStore } from './mcp-memory-bridge.js';
import { persistFeedback } from './closed-loop-feedback.js';
import type { MultiCriticResult } from '../src/evolution/multi-critic.js';

// ─── Lesson injection helper ─────────────────────────

/**
 * Render a list of past lessons as a context block that you can prepend to
 * the next agent's system prompt. Empty lessons → empty string (cheap to
 * call unconditionally).
 */
export function renderLessonContext(lessons: Lesson[], maxChars = 1800): string {
  if (lessons.length === 0) return '';
  const lines: string[] = [
    '## Past Lessons (from previous runs)',
    'The following patterns and failure modes were observed in earlier runs of this agent.',
    'Read them once, then continue with the task.',
    '',
  ];
  let budget = maxChars - lines.join('\n').length - 16;
  for (const lesson of lessons) {
    const tagTrail = lesson.tags.length > 0 ? `  [tags: ${lesson.tags.slice(0, 5).join(', ')}]` : '';
    const line = `- ${lesson.content}${tagTrail}`;
    if (line.length > budget) {
      lines.push(`- … ${lessons.length - lines.length + 4} more lesson(s) elided (token budget).`);
      break;
    }
    lines.push(line);
    budget -= line.length + 1;
  }
  return lines.join('\n');
}

// ─── Tiny harness: agent run → critic → persist → next run ───

export interface AgentRunInput {
  agentName: string;
  topic: string;
  /** Optional context block (e.g. rendered past lessons). */
  context?: string;
}

export interface AgentRunOutput {
  text: string;
  critic: MultiCriticResult;
}

/**
 * The orchestration shape. Bring your own implementations for the two
 * function fields when wiring this into a real codebase:
 *   - runner: anything that takes (topic, context) → {text, critic}
 *   - store:  the McpMemoryBridge (or any RetrievableFeedbackStore)
 */
export interface ClosedLoopOptions {
  runner: (input: AgentRunInput) => Promise<AgentRunOutput>;
  store: RetrievableFeedbackStore;
  /** Cap how many lessons to inject. Default: 5. */
  fetchLimit?: number;
  /** Override persist thresholds (same shape as persistFeedback options). */
  persistThresholds?: {
    lowThreshold?: number;
    highThreshold?: number;
    minOutputChars?: number;
  };
}

/** Run one closed-loop turn: fetch lessons → run → persist findings. */
export async function runClosedLoopTurn(
  input: AgentRunInput,
  options: ClosedLoopOptions,
): Promise<{ run: AgentRunOutput; lessonsUsed: number; persisted: boolean; reason: string }> {
  // 1. Fetch lessons relevant to the topic
  let lessons: Lesson[] = [];
  try {
    lessons = await options.store.fetchRelevant({ query: input.topic, limit: options.fetchLimit ?? 5 });
  } catch (err) {
    console.warn(`[closed-loop] fetch failed (continuing without lessons): ${(err as Error).message}`);
  }

  // 2. Render lessons + run the agent
  const context = lessons.length > 0 ? renderLessonContext(lessons) : input.context;
  const runOut = await options.runner({ ...input, context });

  // 3. Persist findings from the critic round
  const persistResult = await persistFeedback(
    {
      agentName: input.agentName,
      topic: input.topic,
      outputLength: runOut.text.length,
      medianScore: runOut.critic.medianScore,
      combinedReport: runOut.critic.combinedReport,
      criticScores: runOut.critic.critics.map((c) => ({ critic: c.critic, score: c.score })),
    },
    options.store,
    options.persistThresholds,
  );

  return {
    run: runOut,
    lessonsUsed: lessons.length,
    persisted: persistResult.persisted,
    reason: persistResult.reason,
  };
}

// ─── Demo ────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  // Stub agent runner — replace with your real Darwin `runAgent()` call.
  function simulateAgentRun(scoreFloor: number) {
    return async (input: AgentRunInput): Promise<AgentRunOutput> => {
      const text = [
        `[stub] agent=${input.agentName} topic=${input.topic}`,
        input.context ? `[stub] received lesson-context (${input.context.length} chars)` : '[stub] no lesson-context',
        ...Array(40).fill('Lorem ipsum dolor sit amet, consectetur adipiscing elit.'),
      ].join(' ');
      const score = scoreFloor + Math.random() * 1.5;
      return {
        text,
        critic: {
          medianScore: score,
          combinedReport: `[stub critic] scored ${score.toFixed(1)} based on three rubric checks.`,
          critics: [
            { critic: 'technical-accuracy', score },
            { critic: 'pattern-recognition', score: score - 0.3 },
            { critic: 'recommendation-quality', score: score + 0.2 },
          ],
        } as MultiCriticResult,
      };
    };
  }

  const memory = localMemory();

  try {
    console.log('--- Run 1 (cold — no lessons yet) ---');
    const r1 = await runClosedLoopTurn(
      { agentName: 'analyst', topic: 'Audit module X for tech debt' },
      { runner: simulateAgentRun(2.5), store: memory },
    );
    console.log(`lessonsUsed=${r1.lessonsUsed} persisted=${r1.persisted} reason=${r1.reason}`);

    console.log('\n--- Run 2 (warm — should see the lesson from Run 1) ---');
    // tiny sleep so SQLite FTS5 catches up
    await new Promise((r) => setTimeout(r, 100));
    const r2 = await runClosedLoopTurn(
      { agentName: 'analyst', topic: 'Audit module X for tech debt' },
      { runner: simulateAgentRun(8.5), store: memory },
    );
    console.log(`lessonsUsed=${r2.lessonsUsed} persisted=${r2.persisted} reason=${r2.reason}`);

    console.log('\n--- Run 3 (warm — should see lessons from both prior runs) ---');
    await new Promise((r) => setTimeout(r, 100));
    const r3 = await runClosedLoopTurn(
      { agentName: 'analyst', topic: 'Audit module X for tech debt' },
      { runner: simulateAgentRun(6.0), store: memory },
    );
    console.log(`lessonsUsed=${r3.lessonsUsed} persisted=${r3.persisted} reason=${r3.reason}`);
  } finally {
    await memory.close();
  }
}
