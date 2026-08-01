/**
 * Tests for the v0.11.0 "GEPA budget discipline" wave:
 *   - skipPerfectFeedback (GEPA `skip_perfect_score`) — drop already-perfect
 *     runs from BOTH the legacy optimizer feedback and the GEPA reflective
 *     feedback (feedback-filter.ts pure helpers + loop wiring).
 *   - maxMergeInvocations (GEPA `max_merge_invocations`) — lifetime cap on
 *     merge-derived challengers, persisted per-agent in DarwinState.
 *   - CLI flags --skip-perfect / --no-skip-perfect / --max-merge <n>.
 *
 * The legacy path stays byte-for-byte unchanged with the flags off — these
 * tests only exercise the new opt-in surfaces (default-off controls included).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPerfectScore,
  resolvePerfectFeedbackScore,
  filterPerfectFeedback,
  DEFAULT_PERFECT_FEEDBACK_SCORE,
} from '../src/evolution/feedback-filter.js';
import {
  parseEvolutionConfigFlags,
  hasAnyEvolutionFlag,
} from '../src/cli/evolution-flags.js';
import { resolveEvolutionConfig } from '../src/evolution/enabled-state.js';
import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { GepaOptimizer } from '../src/evolution/optimizer-gepa.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';
import type { AgentDefinition, DarwinExperiment, DarwinMetrics, DarwinState } from '../src/types.js';

// ─── feedback-filter.ts — pure helpers ──────────────

describe('feedback-filter — resolvePerfectFeedbackScore', () => {
  it('defaults to 10 for undefined / non-finite / out-of-range', () => {
    assert.equal(resolvePerfectFeedbackScore(undefined), DEFAULT_PERFECT_FEEDBACK_SCORE);
    assert.equal(resolvePerfectFeedbackScore(NaN), 10);
    assert.equal(resolvePerfectFeedbackScore(Infinity), 10);
    assert.equal(resolvePerfectFeedbackScore(0), 10); // below the 1-10 scale
    assert.equal(resolvePerfectFeedbackScore(11), 10); // above the scale
    assert.equal(resolvePerfectFeedbackScore(-5), 10);
  });

  it('keeps a valid in-range threshold', () => {
    assert.equal(resolvePerfectFeedbackScore(9), 9);
    assert.equal(resolvePerfectFeedbackScore(1), 1);
    assert.equal(resolvePerfectFeedbackScore(9.5), 9.5);
  });
});

describe('feedback-filter — isPerfectScore', () => {
  it('is true at or above the threshold', () => {
    assert.equal(isPerfectScore(10, 10), true);
    assert.equal(isPerfectScore(10, 9), true);
    assert.equal(isPerfectScore(9.2, 9), true);
  });

  it('is false below the threshold', () => {
    assert.equal(isPerfectScore(9.9, 10), false);
    assert.equal(isPerfectScore(4, 10), false);
  });

  it('treats a non-finite score as NOT perfect (keeps broken runs visible)', () => {
    assert.equal(isPerfectScore(NaN, 10), false);
    assert.equal(isPerfectScore(Infinity, 10), false);
  });
});

describe('feedback-filter — filterPerfectFeedback', () => {
  it('drops perfect items, preserves order, keeps NaN-scored items', () => {
    const items = [
      { score: 4, id: 'a' },
      { score: 10, id: 'b' },
      { score: 7, id: 'c' },
      { score: NaN, id: 'd' },
      { score: 10, id: 'e' },
    ];
    const kept = filterPerfectFeedback(items, 10);
    assert.deepEqual(kept.map((i) => i.id), ['a', 'c', 'd']);
  });

  it('returns everything when the threshold is above any score', () => {
    const items = [{ score: 8 }, { score: 9 }];
    assert.equal(filterPerfectFeedback(items, 10).length, 2);
  });
});

// ─── CLI flags ──────────────────────────────────────

describe('v0.11 CLI flags', () => {
  it('parses --skip-perfect / --no-skip-perfect', () => {
    assert.equal(parseEvolutionConfigFlags(['--skip-perfect']).override.skipPerfectFeedback, true);
    assert.equal(parseEvolutionConfigFlags(['--no-skip-perfect']).override.skipPerfectFeedback, false);
  });

  it('parses --max-merge with a non-negative integer', () => {
    const { override, rest } = parseEvolutionConfigFlags(['--max-merge', '5', 'researcher']);
    assert.equal(override.maxMergeInvocations, 5);
    assert.deepEqual(rest, ['researcher']);
  });

  it('accepts --max-merge 0 (disables merge)', () => {
    assert.equal(parseEvolutionConfigFlags(['--max-merge', '0']).override.maxMergeInvocations, 0);
  });

  it('ignores a non-integer --max-merge value (consumed); dash-prefixed tokens stay unconsumed', () => {
    const { override, rest } = parseEvolutionConfigFlags(['--max-merge', 'abc', 'researcher']);
    assert.equal(override.maxMergeInvocations, undefined);
    assert.deepEqual(rest, ['researcher']); // value consumed, not left as a positional
    // '-3' is treated as a missing value since v0.13.2 (the guard covers all
    // '-'-prefixed tokens because '-v' is a real CLI flag) — it is NOT
    // consumed and survives into rest.
    {
      const r = parseEvolutionConfigFlags(['--max-merge', '-3']);
      assert.equal(r.override.maxMergeInvocations, undefined);
      assert.deepEqual(r.rest, ['-3']);
    }
    assert.equal(parseEvolutionConfigFlags(['--max-merge', '2.5']).override.maxMergeInvocations, undefined);
  });

  it('rejects an empty --max-merge value instead of coercing "" to 0', () => {
    // Number('') === 0 would silently disable merge for the agent's life.
    assert.equal(parseEvolutionConfigFlags(['--max-merge', '']).override.maxMergeInvocations, undefined);
    assert.equal(parseEvolutionConfigFlags(['--max-merge', '   ']).override.maxMergeInvocations, undefined);
  });

  it('does not eat a following flag when --max-merge has no value', () => {
    // `--max-merge --gepa` must not swallow --gepa as the (invalid) cap value.
    const { override } = parseEvolutionConfigFlags(['--max-merge', '--gepa']);
    assert.equal(override.maxMergeInvocations, undefined);
    assert.equal(override.useGepa, true); // --gepa still parsed
    // Trailing --max-merge (end of argv) is a no-op, not a crash.
    assert.deepEqual(parseEvolutionConfigFlags(['researcher', '--max-merge']).rest, ['researcher']);
  });

  it('hasAnyEvolutionFlag detects the new flags', () => {
    assert.equal(hasAnyEvolutionFlag({ skipPerfectFeedback: true }), true);
    assert.equal(hasAnyEvolutionFlag({ maxMergeInvocations: 0 }), true);
    assert.equal(hasAnyEvolutionFlag({}), false);
  });
});

// ─── Override resolution + persistence ──────────────

const overrideAgent: AgentDefinition = {
  name: 'researcher',
  role: 'Researcher',
  description: 'r',
  systemPrompt: 'You research.',
  evolution: { enabled: true, evaluator: 'critic', minRuns: 7 },
};

function stateWith(overrides: Partial<DarwinState> = {}): DarwinState {
  return {
    activeVersions: {},
    abTests: {},
    lastKnownGood: {},
    consecutiveFailures: {},
    experimentCounts: {},
    ...overrides,
  };
}

describe('v0.11 override resolution', () => {
  it('applies a persisted skipPerfectFeedback override', () => {
    const resolved = resolveEvolutionConfig(
      overrideAgent,
      stateWith({ evolutionConfigOverrides: { researcher: { skipPerfectFeedback: true } } }),
    );
    assert.equal(resolved?.skipPerfectFeedback, true);
  });

  it('applies a persisted maxMergeInvocations override (numeric, not cast to boolean)', () => {
    const resolved = resolveEvolutionConfig(
      overrideAgent,
      stateWith({ evolutionConfigOverrides: { researcher: { maxMergeInvocations: 3 } } }),
    );
    assert.equal(resolved?.maxMergeInvocations, 3);
  });

  it('lets a CLI override win over a persisted one, and preserves maxMergeInvocations: 0', () => {
    const resolved = resolveEvolutionConfig(
      overrideAgent,
      stateWith({ evolutionConfigOverrides: { researcher: { maxMergeInvocations: 5 } } }),
      { maxMergeInvocations: 0 },
    );
    assert.equal(resolved?.maxMergeInvocations, 0);
  });
});

// ─── Loop harness ───────────────────────────────────

const SAFE_PROMPT = 'You are a research agent. Never fabricate sources. Do solid work.';

function makeAgent(evolution: AgentDefinition['evolution']): AgentDefinition {
  return {
    name: 'researcher',
    role: 'Researcher',
    description: 'test agent',
    systemPrompt: SAFE_PROMPT,
    model: 'claude-sonnet-4-6',
    evolution,
  };
}

function metrics(partial: Partial<DarwinMetrics>): DarwinMetrics {
  return { qualityScore: 7, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000, ...partial };
}

const PERFECT_MARKER = 'PERFECTMARKER';
const WEAK_MARKER = 'WEAKMARKER';

/** Seed 4 perfect (10/10) runs first, then 16 weak (4/10) — 20 total, all on v1. */
function seedMixed(memory: ReturnType<typeof createMockMemory>): void {
  for (let i = 0; i < 4; i++) {
    memory._experiments.push(makeExperiment({
      agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
      metrics: metrics({ qualityScore: 10 }),
      feedback: { score: 10, report: `${PERFECT_MARKER} flawless ${i}`, evaluator: 'multi-critic' },
    }));
  }
  for (let i = 0; i < 16; i++) {
    memory._experiments.push(makeExperiment({
      agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
      metrics: metrics({ qualityScore: 4 }),
      feedback: { score: 4, report: `${WEAK_MARKER} shallow ${i}`, evaluator: 'multi-critic' },
    }));
  }
}

function trigger(): DarwinExperiment {
  return makeExperiment({
    agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
    metrics: metrics({ qualityScore: 4 }),
    feedback: { score: 4, report: `${WEAK_MARKER} trigger`, evaluator: 'multi-critic' },
  });
}

// ─── F1: skipPerfectFeedback — legacy path ──────────

describe('DarwinLoop — skipPerfectFeedback (legacy optimizer path)', () => {
  it('drops perfect-score reports from the optimizer feedback when on', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', active: true, promptText: SAFE_PROMPT }));
    seedMixed(memory);

    let capturedMeta = '';
    const loop = new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      optimizer: new PromptOptimizer(async (meta: string) => {
        capturedMeta = meta;
        return 'You are a research agent. Never fabricate sources. Improved variant.';
      }),
      agent: makeAgent({ enabled: true, skipPerfectFeedback: true }),
    });

    const result = await loop.afterRun(trigger());
    assert.equal(result.abTestStarted, true, `evolution should have started: ${result.message}`);
    assert.ok(capturedMeta.includes(WEAK_MARKER), 'weak reports must reach the optimizer');
    assert.ok(!capturedMeta.includes(PERFECT_MARKER), 'perfect reports must be filtered out');
  });

  it('includes perfect reports when off (byte-for-byte default behaviour)', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', active: true, promptText: SAFE_PROMPT }));
    seedMixed(memory);

    let capturedMeta = '';
    const loop = new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      optimizer: new PromptOptimizer(async (meta: string) => {
        capturedMeta = meta;
        return 'You are a research agent. Never fabricate sources. Improved variant.';
      }),
      agent: makeAgent({ enabled: true }), // skipPerfectFeedback off
    });

    await loop.afterRun(trigger());
    assert.ok(capturedMeta.includes(PERFECT_MARKER), 'default path keeps every report');
  });
});

// ─── F1: skipPerfectFeedback — GEPA reflective path ─

describe('DarwinLoop — skipPerfectFeedback (GEPA reflective path)', () => {
  it('drops perfect-score reports from the reflection feedback when on', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', active: true, promptText: SAFE_PROMPT }));
    seedMixed(memory);

    let reflectionMeta = '';
    const gepa = new GepaOptimizer(async (meta: string) => {
      reflectionMeta = meta;
      return 'You are a research agent. Never fabricate sources. Reflective edit applied.';
    });

    const loop = new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      optimizer: new PromptOptimizer(async () => 'LEGACY fallback. Never fabricate sources.'),
      agent: makeAgent({ enabled: true, useGepa: true, skipPerfectFeedback: true }),
      gepa,
    });

    const result = await loop.afterRun(trigger());
    assert.equal(result.abTestStarted, true, `evolution should have started: ${result.message}`);
    assert.ok(reflectionMeta.includes(WEAK_MARKER), 'weak reports must reach the reflector');
    assert.ok(!reflectionMeta.includes(PERFECT_MARKER), 'perfect reports must be filtered out');
  });
});

// ─── F2: maxMergeInvocations — merge budget cap ─────

const MERGE_OUT =
  'You are a research agent. Never fabricate sources. Cite many primary documents AND write deep analysis.';
const REFLECT_OUT = 'You are a research agent. Never fabricate sources. Reflective edit applied.';

/** A meta-prompt is the MERGE template (vs the reflection template). */
function isMergeMeta(meta: string): boolean {
  return /PARENT A/.test(meta) && /merger/i.test(meta);
}

/**
 * Merge harness mirroring loop-integration-v07: v1/v2 are Pareto-distinct
 * merge parents, v3 is the active (weak) version being evolved. Returns the
 * memory so the caller can assert the persisted merge-invocation counter.
 */
async function setupMergeLoop(
  evolution: AgentDefinition['evolution'],
  seedState?: Partial<DarwinState>,
): Promise<{
  result: Awaited<ReturnType<DarwinLoop['afterRun']>>;
  mergeCalled: boolean;
  reflectCalled: boolean;
  memory: ReturnType<typeof createMockMemory>;
}> {
  const memory = createMockMemory();
  // Seed via updateState so the change lands on the closure's state object the
  // loop actually reads (reassigning `memory._state` would leave getState()
  // pointing at the original reference).
  if (seedState) await memory.updateState((s) => Object.assign(s, seedState));
  memory._versions.push(
    makePromptVersion({ version: 'v1', active: false, promptText: 'You are a research agent. Never fabricate sources. Cite many primary documents.' }),
    makePromptVersion({ version: 'v2', active: false, promptText: 'You are a research agent. Never fabricate sources. Write deep, high-quality analysis.' }),
    makePromptVersion({ version: 'v3', active: true, promptText: SAFE_PROMPT }),
  );
  for (let i = 0; i < 20; i++) {
    memory._experiments.push(makeExperiment({
      agentName: 'researcher', promptVersion: 'v3', taskType: 'tech', success: true,
      metrics: metrics({ qualityScore: 4.0, sourceCount: 8 }),
      feedback: { score: 4.0, report: `v3 shallow ${i}`, evaluator: 'multi-critic' },
    }));
  }
  for (let i = 0; i < 6; i++) {
    memory._experiments.push(makeExperiment({
      agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
      metrics: metrics({ qualityScore: 8.5, sourceCount: 2 }),
      feedback: { score: 8.5, report: `v1 deep ${i}`, evaluator: 'multi-critic' },
    }));
    memory._experiments.push(makeExperiment({
      agentName: 'researcher', promptVersion: 'v2', taskType: 'tech', success: true,
      metrics: metrics({ qualityScore: 4.5, sourceCount: 18 }),
      feedback: { score: 4.5, report: `v2 broad ${i}`, evaluator: 'multi-critic' },
    }));
  }

  let mergeCalled = false;
  let reflectCalled = false;
  const gepa = new GepaOptimizer(async (meta: string) => {
    if (isMergeMeta(meta)) { mergeCalled = true; return MERGE_OUT; }
    reflectCalled = true; return REFLECT_OUT;
  });

  const loop = new DarwinLoop({
    memory,
    tracker: new ExperimentTracker(memory),
    optimizer: new PromptOptimizer(async () => 'LEGACY fallback. Never fabricate sources.'),
    safety: new SafetyGate(),
    patterns: new PatternDetector(memory),
    agent: makeAgent(evolution),
    gepa,
  });

  const result = await loop.afterRun(makeExperiment({
    agentName: 'researcher', promptVersion: 'v3', taskType: 'tech', success: true,
    metrics: metrics({ qualityScore: 4.0, sourceCount: 8 }),
    feedback: { score: 4.0, report: 'trigger shallow', evaluator: 'multi-critic' },
  }));

  return { result, mergeCalled, reflectCalled, memory };
}

describe('DarwinLoop — maxMergeInvocations (merge budget cap)', () => {
  it('merges and increments the persisted counter when under the cap', async () => {
    const { mergeCalled, result, memory } = await setupMergeLoop({
      enabled: true, useGepa: true, useMerge: true, mergeEveryK: 1, maxMergeInvocations: 5,
    });
    assert.equal(mergeCalled, true, 'merge should fire under the cap');
    assert.ok(result.message.includes('via merge'), `expected merge tag: ${result.message}`);
    assert.equal(memory._state.mergeInvocations?.researcher, 1, 'counter incremented once');
  });

  it('merges without touching state when uncapped (byte-for-byte v0.10)', async () => {
    const { mergeCalled, memory } = await setupMergeLoop({
      enabled: true, useGepa: true, useMerge: true, mergeEveryK: 1, // no maxMergeInvocations
    });
    assert.equal(mergeCalled, true);
    // No cap configured → the counter is never written, so an uncapped
    // useMerge agent's persisted state is unchanged from v0.10.
    assert.equal(memory._state.mergeInvocations, undefined);
  });

  it('skips merge (falls back to reflective) when maxMergeInvocations is 0', async () => {
    const { mergeCalled, reflectCalled, result } = await setupMergeLoop({
      enabled: true, useGepa: true, useMerge: true, mergeEveryK: 1, maxMergeInvocations: 0,
    });
    assert.equal(mergeCalled, false, 'a zero cap disables merge entirely');
    assert.equal(reflectCalled, true, 'the loop falls back to the reflective path');
    assert.ok(result.message.includes('via gepa'), `expected gepa tag: ${result.message}`);
  });

  it('skips merge once the persisted count has already reached the cap', async () => {
    const { mergeCalled, reflectCalled } = await setupMergeLoop(
      { enabled: true, useGepa: true, useMerge: true, mergeEveryK: 1, maxMergeInvocations: 1 },
      { mergeInvocations: { researcher: 1 } }, // budget already spent
    );
    assert.equal(mergeCalled, false, 'no merge when the cap is already reached');
    assert.equal(reflectCalled, true);
  });
});
