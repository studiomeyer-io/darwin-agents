/**
 * Tests for examples/closed-loop-feedback.ts (v0.4.6).
 *
 * Locks the polarity logic + content/tag/confidence builders + persist orchestration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldPersist,
  buildContent,
  buildTags,
  computeConfidence,
  persistFeedback,
  fromMultiCriticResult,
  DEFAULT_LOW_THRESHOLD,
  DEFAULT_HIGH_THRESHOLD,
  type FeedbackInput,
  type FeedbackStore,
  type FeedbackRecord,
} from '../examples/closed-loop-feedback.js';

function makeInput(overrides: Partial<FeedbackInput> = {}): FeedbackInput {
  return {
    agentName: 'analyst',
    topic: 'Review module X',
    outputLength: 5000,
    medianScore: 3.5,
    combinedReport: 'Critic A: missing security review. Critic B: vague refactor recommendations.',
    criticScores: [
      { critic: 'technical-accuracy', score: 3 },
      { critic: 'pattern-recognition', score: 4 },
      { critic: 'recommendation-quality', score: 3 },
    ],
    ...overrides,
  };
}

function makeStore(): { store: FeedbackStore; saved: FeedbackRecord[] } {
  const saved: FeedbackRecord[] = [];
  return {
    store: { async save(record) { saved.push(record); } },
    saved,
  };
}

// ─── shouldPersist ───────────────────────────────────

describe('shouldPersist', () => {
  it('persists as mistake when score < low threshold', () => {
    const r = shouldPersist(makeInput({ medianScore: 3 }));
    assert.equal(r.persist, true);
    assert.equal(r.polarity, 'mistake');
    assert.equal(r.reason, 'below-low-threshold');
  });

  it('persists as pattern when score >= high threshold', () => {
    const r = shouldPersist(makeInput({ medianScore: 9 }));
    assert.equal(r.persist, true);
    assert.equal(r.polarity, 'pattern');
    assert.equal(r.reason, 'above-high-threshold');
  });

  it('skips mediocre band (low <= score < high)', () => {
    const r = shouldPersist(makeInput({ medianScore: 6.5 }));
    assert.equal(r.persist, false);
    assert.equal(r.reason, 'score-in-mediocre-band');
  });

  it('boundary: low threshold value is in mediocre band', () => {
    const r = shouldPersist(makeInput({ medianScore: DEFAULT_LOW_THRESHOLD }));
    assert.equal(r.persist, false);
    assert.equal(r.reason, 'score-in-mediocre-band');
  });

  it('boundary: high threshold value persists as pattern (>= is inclusive)', () => {
    const r = shouldPersist(makeInput({ medianScore: DEFAULT_HIGH_THRESHOLD }));
    assert.equal(r.persist, true);
    assert.equal(r.polarity, 'pattern');
  });

  it('NaN score is rejected before any other check', () => {
    const r = shouldPersist(makeInput({ medianScore: Number.NaN }));
    assert.equal(r.persist, false);
    assert.equal(r.reason, 'score-not-finite');
  });

  it('Infinity score is rejected', () => {
    const r = shouldPersist(makeInput({ medianScore: Number.POSITIVE_INFINITY }));
    assert.equal(r.persist, false);
    assert.equal(r.reason, 'score-not-finite');
  });

  it('score=0 means "all critics failed" — skipped', () => {
    const r = shouldPersist(makeInput({
      medianScore: 0,
      criticScores: [{ critic: 'a', score: -1 }, { critic: 'b', score: -1 }],
    }));
    assert.equal(r.persist, false);
    assert.equal(r.reason, 'all-critics-failed');
  });

  it('short output is skipped (CLI failure heuristic)', () => {
    const r = shouldPersist(makeInput({ outputLength: 50 }));
    assert.equal(r.persist, false);
    assert.equal(r.reason, 'output-too-short');
  });

  it('respects custom thresholds', () => {
    const r1 = shouldPersist(makeInput({ medianScore: 6 }), { lowThreshold: 7 });
    assert.equal(r1.polarity, 'mistake');
    const r2 = shouldPersist(makeInput({ medianScore: 7 }), { lowThreshold: 5, highThreshold: 6 });
    assert.equal(r2.polarity, 'pattern');
  });
});

// ─── buildContent ────────────────────────────────────

describe('buildContent', () => {
  it('frames as failure for mistake polarity', () => {
    const c = buildContent(makeInput(), 'mistake');
    assert.match(c, /low quality/);
    assert.match(c, /Recurring failure mode/);
  });

  it('frames as success for pattern polarity', () => {
    const c = buildContent(makeInput({ medianScore: 9 }), 'pattern');
    assert.match(c, /high quality/);
    assert.match(c, /Recurring success pattern/);
  });

  it('marks failed critics in the breakdown', () => {
    const c = buildContent(makeInput({
      criticScores: [
        { critic: 'ok', score: 4 },
        { critic: 'boom', score: -1 },
      ],
    }), 'mistake');
    assert.match(c, /boom: FAILED\/10/);
  });

  it('truncates topic to ~200 chars with ellipsis', () => {
    const longTopic = 'Topic '.repeat(100);
    const c = buildContent(makeInput({ topic: longTopic }), 'mistake');
    assert.match(c, /\.\.\./);
  });
});

// ─── buildTags ───────────────────────────────────────

describe('buildTags', () => {
  it('uses low-quality tag for mistake polarity', () => {
    const tags = buildTags(makeInput(), 'mistake');
    assert.ok(tags.includes('low-quality'));
    assert.ok(tags.includes('darwin-feedback'));
    assert.ok(tags.includes('agent:analyst'));
  });

  it('uses high-quality tag for pattern polarity', () => {
    const tags = buildTags(makeInput({ medianScore: 9 }), 'pattern');
    assert.ok(tags.includes('high-quality'));
  });

  it('adds critic:<lowest> for mistake polarity', () => {
    const tags = buildTags(makeInput({
      criticScores: [
        { critic: 'weak', score: 2 },
        { critic: 'mid', score: 5 },
        { critic: 'strong', score: 8 },
      ],
    }), 'mistake');
    assert.ok(tags.includes('critic:weak'));
  });

  it('adds critic:<highest> for pattern polarity', () => {
    const tags = buildTags(makeInput({
      medianScore: 9,
      criticScores: [
        { critic: 'weak', score: 6 },
        { critic: 'strong', score: 10 },
      ],
    }), 'pattern');
    assert.ok(tags.includes('critic:strong'));
  });

  it('omits critic:* tag when all critics failed', () => {
    const tags = buildTags(makeInput({
      criticScores: [{ critic: 'a', score: -1 }, { critic: 'b', score: -1 }],
    }), 'mistake');
    assert.ok(!tags.some((t) => t.startsWith('critic:')));
  });
});

// ─── computeConfidence ───────────────────────────────

describe('computeConfidence', () => {
  it('mistake: lower score → higher confidence', () => {
    const lo = computeConfidence(makeInput({ medianScore: 1 }), 'mistake');
    const hi = computeConfidence(makeInput({ medianScore: 4 }), 'mistake');
    assert.ok(lo > hi);
    assert.ok(lo <= 0.9);
    assert.ok(hi >= 0.5);
  });

  it('pattern: higher score → higher confidence', () => {
    const lo = computeConfidence(makeInput({ medianScore: 8 }), 'pattern');
    const hi = computeConfidence(makeInput({ medianScore: 10 }), 'pattern');
    assert.ok(hi > lo);
    assert.ok(hi <= 0.9);
    assert.ok(lo >= 0.5);
  });
});

// ─── persistFeedback ─────────────────────────────────

describe('persistFeedback', () => {
  it('saves a mistake record for low scores', async () => {
    const { store, saved } = makeStore();
    const r = await persistFeedback(makeInput(), store);
    assert.equal(r.persisted, true);
    assert.equal(r.polarity, 'mistake');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].polarity, 'mistake');
    assert.ok(saved[0].tags.includes('low-quality'));
  });

  it('saves a pattern record for high scores', async () => {
    const { store, saved } = makeStore();
    const r = await persistFeedback(makeInput({ medianScore: 9 }), store);
    assert.equal(r.persisted, true);
    assert.equal(r.polarity, 'pattern');
    assert.equal(saved[0].polarity, 'pattern');
  });

  it('skips mediocre runs without calling store', async () => {
    const { store, saved } = makeStore();
    const r = await persistFeedback(makeInput({ medianScore: 6.5 }), store);
    assert.equal(r.persisted, false);
    assert.equal(saved.length, 0);
  });

  it('returns persisted=false (no throw) when store rejects', async () => {
    const failingStore: FeedbackStore = {
      async save() { throw new Error('disk full'); },
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    const r = await persistFeedback(makeInput(), failingStore);
    console.warn = originalWarn;
    assert.equal(r.persisted, false);
    assert.equal(r.reason, 'store-error');
  });
});

// ─── fromMultiCriticResult ───────────────────────────

describe('fromMultiCriticResult', () => {
  it('maps MultiCriticResult into FeedbackInput shape', () => {
    const input = fromMultiCriticResult({
      medianScore: 7,
      combinedReport: 'report',
      critics: [
        { critic: 'a', score: 7, report: 'r1' },
        { critic: 'b', score: 8, report: 'r2' },
      ],
    }, { agentName: 'researcher', topic: 'topic', outputLength: 100 });
    assert.equal(input.agentName, 'researcher');
    assert.equal(input.medianScore, 7);
    assert.equal(input.criticScores.length, 2);
    assert.equal(input.criticScores[0].critic, 'a');
    assert.equal(input.criticScores[0].score, 7);
  });
});
