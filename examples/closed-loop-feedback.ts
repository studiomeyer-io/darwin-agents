/**
 * Example: Closed-Loop Feedback Persistence (Darwin → External Memory)
 *
 * After Darwin's multi-critic evaluates an agent run, this example shows
 * how to persist critic findings as external lessons that the NEXT agent
 * run can consult. We call the polarity rule "symmetric self-evolution"
 * because it writes BOTH success patterns and failure modes — not only
 * one side. This is structurally aligned with reflective self-improvement
 * approaches like GEPA (Genetic-Pareto, ICLR 2026 Oral, arXiv 2507.19457)
 * and the closed-loop pattern used by NousResearch's hermes-agent-self-
 * evolution repo.
 *
 * Why a separate persistence layer?
 *  - darwin_db.darwin_experiments.feedback_report is great for analytics
 *    but it never reaches the agent's prompt on the next run
 *  - If your agents already read from a memory store (Mem0, Zep, Letta,
 *    Cognee, a Postgres table, or even a markdown directory), pipe the
 *    critic findings into THAT store so the next run sees them as context
 *
 * This example uses an in-memory store for demonstration. Replace with
 * your real backend (database, vector store, file system, etc.).
 *
 * Run: npx tsx examples/closed-loop-feedback.ts
 */

import type { MultiCriticResult } from '../src/evolution/multi-critic.js';

// ─── Generic types ────────────────────────────────────

export type FeedbackPolarity = 'mistake' | 'pattern';

export interface FeedbackInput {
  /** Darwin agent name (matches AGENT_CRITIC_MAP key). */
  agentName: string;
  /** The original task / prompt the agent ran. */
  topic: string;
  /** Length of the agent's output in characters. */
  outputLength: number;
  /** Median critic score (0-10). */
  medianScore: number;
  /** Combined report text from all critics. */
  combinedReport: string;
  /** Per-critic scores (NEGATIVE score = critic failed). */
  criticScores: Array<{ critic: string; score: number }>;
}

export interface FeedbackRecord {
  polarity: FeedbackPolarity;
  content: string;
  tags: string[];
  /** 0-1, higher = more confident this is a real signal. */
  confidence: number;
}

/** Pluggable storage backend. Implement against your real store. */
export interface FeedbackStore {
  save(record: FeedbackRecord): Promise<void>;
}

// ─── Default thresholds ──────────────────────────────

/** Below this score → persist as 'mistake'. */
export const DEFAULT_LOW_THRESHOLD = 5.0;
/** At/above this score → persist as 'pattern'. */
export const DEFAULT_HIGH_THRESHOLD = 8.0;
/** Skip persistence when output is below this length (likely CLI failure). */
export const DEFAULT_MIN_OUTPUT_CHARS = 200;

// ─── Decision logic ───────────────────────────────────

/**
 * Decide whether to persist this run and which polarity.
 * Mid-range scores (5..8) are intentionally NOT persisted — mediocre runs
 * are noise. We want strong signal in both directions.
 */
export function shouldPersist(
  input: FeedbackInput,
  options: {
    lowThreshold?: number;
    highThreshold?: number;
    minOutputChars?: number;
  } = {},
): { persist: boolean; reason: string; polarity?: FeedbackPolarity } {
  const low = options.lowThreshold ?? DEFAULT_LOW_THRESHOLD;
  const high = options.highThreshold ?? DEFAULT_HIGH_THRESHOLD;
  const minOut = options.minOutputChars ?? DEFAULT_MIN_OUTPUT_CHARS;

  if (!Number.isFinite(input.medianScore)) {
    return { persist: false, reason: 'score-not-finite' };
  }
  if (input.medianScore <= 0) {
    return { persist: false, reason: 'all-critics-failed' };
  }
  if (input.criticScores.filter((c) => c.score > 0).length === 0) {
    return { persist: false, reason: 'no-valid-critic-scores' };
  }
  if (input.outputLength < minOut) {
    return { persist: false, reason: 'output-too-short' };
  }
  if (input.medianScore < low) {
    return { persist: true, reason: 'below-low-threshold', polarity: 'mistake' };
  }
  if (input.medianScore >= high) {
    return { persist: true, reason: 'above-high-threshold', polarity: 'pattern' };
  }
  return { persist: false, reason: 'score-in-mediocre-band' };
}

// ─── Record builders ─────────────────────────────────

export function buildContent(input: FeedbackInput, polarity: FeedbackPolarity): string {
  const scores = input.criticScores
    .map((c) => `${c.critic}: ${c.score > 0 ? c.score.toFixed(1) : 'FAILED'}/10`)
    .join(', ');
  const reportExcerpt = input.combinedReport.length > 1200
    ? input.combinedReport.slice(0, 1197) + '...'
    : input.combinedReport;
  const topic = input.topic.length > 200
    ? input.topic.slice(0, 197) + '...'
    : input.topic;

  const isMistake = polarity === 'mistake';
  const headline = isMistake
    ? `Darwin multi-critic flagged ${input.agentName} as low quality (${input.medianScore.toFixed(1)}/10) on task "${topic}".`
    : `Darwin multi-critic scored ${input.agentName} as high quality (${input.medianScore.toFixed(1)}/10) on task "${topic}".`;
  const tail = isMistake
    ? `Recurring failure mode to watch out for in future ${input.agentName} runs.`
    : `Recurring success pattern to reproduce in future ${input.agentName} runs.`;

  return [
    headline,
    `Critic breakdown: ${scores}.`,
    `Output length: ${input.outputLength} chars.`,
    '',
    'Critic feedback excerpt:',
    reportExcerpt,
    '',
    tail,
  ].join('\n');
}

export function buildTags(input: FeedbackInput, polarity: FeedbackPolarity): string[] {
  const polarityTag = polarity === 'mistake' ? 'low-quality' : 'high-quality';
  const tags = ['darwin-feedback', polarityTag, `agent:${input.agentName}`];
  const valid = input.criticScores.filter((c) => c.score > 0);
  if (valid.length > 0) {
    const target = polarity === 'mistake'
      ? valid.reduce((a, b) => (a.score <= b.score ? a : b))
      : valid.reduce((a, b) => (a.score >= b.score ? a : b));
    tags.push(`critic:${target.critic}`);
  }
  return tags;
}

export function computeConfidence(input: FeedbackInput, polarity: FeedbackPolarity): number {
  if (polarity === 'mistake') {
    // Lower score → more confident this is a real issue. Clamp [0.5, 0.9].
    return Math.max(0.5, Math.min(0.9, 1.0 - input.medianScore / 10));
  }
  // pattern: higher score → more confident this is reproducible. Clamp [0.5, 0.9].
  return Math.max(0.5, Math.min(0.9, 0.5 + (input.medianScore - DEFAULT_HIGH_THRESHOLD) / 5));
}

// ─── Main entry point ─────────────────────────────────

/**
 * Persist a Darwin critic result to your external memory store.
 * Non-blocking — store errors are caught and surfaced as { persisted: false }.
 */
export async function persistFeedback(
  input: FeedbackInput,
  store: FeedbackStore,
  options: {
    lowThreshold?: number;
    highThreshold?: number;
    minOutputChars?: number;
  } = {},
): Promise<{ persisted: boolean; reason: string; polarity?: FeedbackPolarity }> {
  const decision = shouldPersist(input, options);
  if (!decision.persist || !decision.polarity) {
    return { persisted: false, reason: decision.reason };
  }
  try {
    const record: FeedbackRecord = {
      polarity: decision.polarity,
      content: buildContent(input, decision.polarity),
      tags: buildTags(input, decision.polarity),
      confidence: computeConfidence(input, decision.polarity),
    };
    await store.save(record);
    return { persisted: true, reason: decision.reason, polarity: decision.polarity };
  } catch (err) {
    console.warn(`[closed-loop] persist failed: ${(err as Error).message}`);
    return { persisted: false, reason: 'store-error' };
  }
}

/**
 * Bridge a Darwin MultiCriticResult into FeedbackInput shape.
 * Pure helper — no I/O.
 */
export function fromMultiCriticResult(
  result: MultiCriticResult,
  meta: { agentName: string; topic: string; outputLength: number },
): FeedbackInput {
  return {
    agentName: meta.agentName,
    topic: meta.topic,
    outputLength: meta.outputLength,
    medianScore: result.medianScore,
    combinedReport: result.combinedReport,
    criticScores: result.critics.map((c) => ({ critic: c.critic, score: c.score })),
  };
}

// ─── Demo: in-memory store ────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const inMemoryStore: FeedbackStore = {
    async save(record) {
      console.log('[in-memory-store] saved:', {
        polarity: record.polarity,
        tags: record.tags,
        confidence: record.confidence,
        contentPreview: record.content.slice(0, 100) + '...',
      });
    },
  };

  // Demo 1: low-score → mistake
  await persistFeedback({
    agentName: 'analyst',
    topic: 'Audit module X for tech debt',
    outputLength: 5000,
    medianScore: 3.5,
    combinedReport: 'Analyst missed two security issues. Recommendations vague.',
    criticScores: [
      { critic: 'technical-accuracy', score: 3 },
      { critic: 'pattern-recognition', score: 4 },
      { critic: 'recommendation-quality', score: 3 },
    ],
  }, inMemoryStore);

  // Demo 2: high-score → pattern
  await persistFeedback({
    agentName: 'analyst',
    topic: 'Audit module Y for tech debt',
    outputLength: 6500,
    medianScore: 9.0,
    combinedReport: 'Analyst surfaced 4 concrete issues, all with file:line refs and effort estimates.',
    criticScores: [
      { critic: 'technical-accuracy', score: 9 },
      { critic: 'pattern-recognition', score: 9 },
      { critic: 'recommendation-quality', score: 9 },
    ],
  }, inMemoryStore);

  // Demo 3: mediocre-band → NOT persisted
  const result3 = await persistFeedback({
    agentName: 'analyst',
    topic: 'Audit module Z',
    outputLength: 5000,
    medianScore: 6.5,
    combinedReport: 'OK but unremarkable.',
    criticScores: [{ critic: 'a', score: 6 }, { critic: 'b', score: 7 }, { critic: 'c', score: 6 }],
  }, inMemoryStore);
  console.log('[demo 3] skipped:', result3.reason);
}
