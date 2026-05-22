/**
 * Tests for examples/memory-darwin-integration.ts (v0.4.7).
 *
 * Uses an in-memory FeedbackStore stand-in (no MCP wire) so we can validate
 * the orchestration logic without spinning up child processes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderLessonContext,
  runClosedLoopTurn,
  type ClosedLoopOptions,
  type AgentRunInput,
  type AgentRunOutput,
} from '../examples/memory-darwin-integration.js';
import type { RetrievableFeedbackStore, Lesson } from '../examples/mcp-memory-bridge.js';
import type { FeedbackRecord } from '../examples/closed-loop-feedback.js';
import type { MultiCriticResult } from '../src/evolution/multi-critic.js';

function makeInMemoryStore(initial: Lesson[] = []): {
  store: RetrievableFeedbackStore;
  saved: FeedbackRecord[];
  fetchedFor: string[];
  state: Lesson[];
} {
  const saved: FeedbackRecord[] = [];
  const state: Lesson[] = [...initial];
  const fetchedFor: string[] = [];
  return {
    saved,
    fetchedFor,
    state,
    store: {
      async save(record) {
        saved.push(record);
        state.push({
          content: record.content,
          tags: record.tags,
          score: record.confidence,
        });
      },
      async fetchRelevant(queryOrOpts, legacyLimit) {
        const q = typeof queryOrOpts === 'string' ? queryOrOpts : queryOrOpts.query;
        const limit = typeof queryOrOpts === 'string' ? legacyLimit : queryOrOpts.limit;
        fetchedFor.push(q);
        return state.slice(0, limit ?? 5);
      },
      async close() {
        /* noop */
      },
    },
  };
}

function makeCritic(score: number): MultiCriticResult {
  return {
    medianScore: score,
    combinedReport: `score=${score.toFixed(1)} summary`,
    critics: [
      { critic: 'a', score },
      { critic: 'b', score: score - 0.2 },
      { critic: 'c', score: score + 0.1 },
    ],
  } as MultiCriticResult;
}

// ─── renderLessonContext ─────────────────────────────

describe('renderLessonContext', () => {
  it('returns empty string when no lessons', () => {
    assert.equal(renderLessonContext([]), '');
  });

  it('renders lessons as bullets with tag trail', () => {
    const out = renderLessonContext([
      { content: 'Watch out for foo.', tags: ['a', 'b'] },
      { content: 'Reuse bar pattern.', tags: ['c'] },
    ]);
    assert.match(out, /## Past Lessons/);
    assert.match(out, /Watch out for foo\..*\[tags: a, b\]/);
    assert.match(out, /Reuse bar pattern\.\s+\[tags: c\]/);
  });

  it('honours maxChars budget and elides remainder', () => {
    const many: Lesson[] = Array.from({ length: 20 }, (_, i) => ({
      content: `Lesson #${i} ` + 'x'.repeat(120),
      tags: [],
    }));
    const out = renderLessonContext(many, 600);
    assert.ok(out.length < 900, `expected truncation, got ${out.length} chars`);
    assert.match(out, /more lesson\(s\) elided/);
  });
});

// ─── runClosedLoopTurn ───────────────────────────────

describe('runClosedLoopTurn', () => {
  it('Run 1 sees zero lessons + persists high-score as pattern', async () => {
    const { store, saved, state, fetchedFor } = makeInMemoryStore();
    const runner: ClosedLoopOptions['runner'] = async () => ({
      text: 'x'.repeat(5000),
      critic: makeCritic(8.5),
    });
    const r = await runClosedLoopTurn({ agentName: 'analyst', topic: 'audit module X' }, { runner, store });
    assert.equal(r.lessonsUsed, 0);
    assert.equal(r.persisted, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].polarity, 'pattern');
    assert.equal(fetchedFor[0], 'audit module X');
    assert.equal(state.length, 1);
  });

  it('Run 2 sees lessons from Run 1 (closed loop works)', async () => {
    const { store, state } = makeInMemoryStore([
      { content: 'Lesson from run 1', tags: ['darwin-feedback', 'high-quality'], score: 0.85 },
    ]);
    let receivedContext: string | undefined;
    const runner: ClosedLoopOptions['runner'] = async (input) => {
      receivedContext = input.context;
      return { text: 'x'.repeat(5000), critic: makeCritic(7.0) };
    };
    const r = await runClosedLoopTurn({ agentName: 'analyst', topic: 'audit module X' }, { runner, store });
    assert.equal(r.lessonsUsed, 1);
    assert.ok(receivedContext, 'expected context to be passed to runner');
    assert.match(receivedContext!, /Lesson from run 1/);
    // 7.0 is in the mediocre band → NOT persisted
    assert.equal(r.persisted, false);
    assert.equal(state.length, 1); // unchanged
  });

  it('low-score run persists as mistake', async () => {
    const { store, saved } = makeInMemoryStore();
    const runner: ClosedLoopOptions['runner'] = async () => ({
      text: 'x'.repeat(5000),
      critic: makeCritic(3.5),
    });
    await runClosedLoopTurn({ agentName: 'analyst', topic: 'task Y' }, { runner, store });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].polarity, 'mistake');
  });

  it('continues when fetchRelevant throws', async () => {
    const store: RetrievableFeedbackStore = {
      async save() { /* noop */ },
      async fetchRelevant() { throw new Error('mock fetch failure'); },
      async close() { /* noop */ },
    };
    const runner: ClosedLoopOptions['runner'] = async () => ({
      text: 'x'.repeat(5000),
      critic: makeCritic(9.0),
    });
    const r = await runClosedLoopTurn({ agentName: 'analyst', topic: 'task Z' }, { runner, store });
    assert.equal(r.lessonsUsed, 0);
    assert.equal(r.persisted, true);
  });

  it('respects custom persistThresholds', async () => {
    const { store, saved } = makeInMemoryStore();
    const runner: ClosedLoopOptions['runner'] = async () => ({
      text: 'x'.repeat(5000),
      critic: makeCritic(6.0),
    });
    // Stricter band: below 7 = mistake, 9+ = pattern → 6.0 is now a mistake
    const r = await runClosedLoopTurn(
      { agentName: 'analyst', topic: 'task W' },
      { runner, store, persistThresholds: { lowThreshold: 7.0, highThreshold: 9.0 } },
    );
    assert.equal(r.persisted, true);
    assert.equal(saved[0].polarity, 'mistake');
  });
});
