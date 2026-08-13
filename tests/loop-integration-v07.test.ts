/**
 * v0.7.0 end-to-end integration tests — driving the ACTUAL DarwinLoop.
 *
 * The pure functions (sequential.ts mSPRT/Hoeffding, pareto.ts dominatesEpsilon,
 * optimizer-gepa.ts epochShuffledMinibatch, alignment.ts semantic guard) already
 * have strong unit coverage in their own *.test.ts files. What was missing is
 * coverage of the WIRING: that DarwinLoop.afterRun / handleABTest actually
 * routes through those new v0.7.0 surfaces with the right inputs and produces the
 * right adopt/keep decision. These tests exercise exactly that seam.
 *
 * Everything is deterministic — injected RunPromptFn / EmbedFn, no real LLM, no
 * network, no Math.random. v0.6.0 behaviour (covered by gepa-loop-integration.ts)
 * stays untouched; this file only drives the v0.7.0-specific paths.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { GepaOptimizer } from '../src/evolution/optimizer-gepa.js';
import { epochShuffledMinibatch } from '../src/evolution/optimizer-gepa.js';
import type { EmbedFn } from '../src/evolution/alignment.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';
import type {
  ABTest,
  AgentDefinition,
  DarwinExperiment,
  DarwinMetrics,
  MetricWeights,
  SafetyThresholds,
} from '../src/types.js';

type MockMemory = ReturnType<typeof createMockMemory>;

// ─── Shared fixtures ────────────────────────────────

const SAFE_PROMPT =
  'You are a research agent. Never fabricate sources. Cite primary documents.';

/** Build an agent with the given evolution config and the safe base prompt. */
function makeAgent(evolution: AgentDefinition['evolution']): AgentDefinition {
  return {
    name: 'researcher',
    role: 'Researcher',
    description: 'test agent',
    type: 'llm',
    systemPrompt: SAFE_PROMPT,
    model: 'claude-sonnet-4-6',
    evolution,
  };
}

/** Full metrics object from a partial — keeps the per-test metric vector terse. */
function metrics(partial: Partial<DarwinMetrics>): DarwinMetrics {
  return {
    qualityScore: 7,
    sourceCount: 10,
    outputLength: 6000,
    errorCount: 0,
    durationMs: 30000,
    ...partial,
  };
}

// ════════════════════════════════════════════════════
// 1. Sequential confidence gate (mSPRT / Hoeffding)
// ════════════════════════════════════════════════════
//
// When the SafetyGate is configured with a sequential confidence method,
// handleABTest must load the RAW per-arm composite samples via
// tracker.getCompositeScores (gated by usesSequentialConfidence) and feed them
// to evaluateABTest. A clear, consistent winner is adopted; a noisy/overlapping
// pair is NOT adopted (test continues, incumbent kept).

/**
 * Seed an active A/B test plus per-arm experiments, all timestamped inside the
 * test window. runsA is pre-counted; runsB is one short so a single trigger run
 * (promptVersion v2) brings it to parity.
 */
function setupActiveSequentialTest(
  thresholds: SafetyThresholds,
  // v0.15: the Hoeffding case needs 60 records per arm, and the state counters
  // have to match, or the fixture describes a state production cannot reach
  // (runsA/runsB ARE the experiment counts). Cross-model review flagged the
  // mismatch; the override keeps every other case on the old small numbers.
  counters: { runsA?: number; runsB?: number; minRuns?: number } = {},
): {
  memory: MockMemory;
  loop: DarwinLoop;
  startedAt: string;
  getScoreLoadCount: () => number;
} {
  const memory = createMockMemory();
  memory._versions.push(
    makePromptVersion({ version: 'v1', agentName: 'researcher', active: true }),
    makePromptVersion({ version: 'v2', agentName: 'researcher', active: false }),
  );
  const startedAt = new Date(Date.now() - 600_000).toISOString();
  const test: ABTest = {
    versionA: 'v1',
    versionB: 'v2',
    runsA: counters.runsA ?? 6,
    runsB: counters.runsB ?? 5,
    failsA: 0,
    failsB: 0,
    minRuns: counters.minRuns ?? 5,
    startedAt,
  };
  memory._state.abTests['researcher'] = test;
  memory._state.activeVersions['researcher'] = 'v1';

  const tracker = new ExperimentTracker(memory);

  // Spy on getCompositeScores to prove the sequential gate loads per-sample data.
  let scoreLoadCount = 0;
  const original = tracker.getCompositeScores.bind(tracker);
  tracker.getCompositeScores = (
    agentName: string,
    version: string,
    weights?: MetricWeights,
    since?: string,
  ): Promise<number[]> => {
    scoreLoadCount++;
    return original(agentName, version, weights, since);
  };

  const loop = new DarwinLoop({
    memory,
    tracker,
    optimizer: new PromptOptimizer(async () => 'unused'),
    safety: new SafetyGate(thresholds),
    patterns: new PatternDetector(memory),
  });

  return { memory, loop, startedAt, getScoreLoadCount: () => scoreLoadCount };
}

/** Append `count` experiments for a version, all stamped inside the test window. */
function seedVersionRuns(
  memory: MockMemory,
  version: string,
  qualities: number[],
  startedAt: string,
  extra: Partial<DarwinMetrics> = {},
): void {
  for (const q of qualities) {
    memory._experiments.push(
      makeExperiment({
        agentName: 'researcher',
        promptVersion: version,
        success: true,
        startedAt,
        metrics: metrics({ qualityScore: q, ...extra }),
      }),
    );
  }
}

describe('DarwinLoop — sequential confidence A/B gate (v0.7.0)', () => {
  it('mSPRT: adopts a clear, consistent winner end-to-end', async () => {
    const { memory, loop, startedAt, getScoreLoadCount } = setupActiveSequentialTest({
      minDataPoints: 5,
      maxRegression: 0.2,
      failureRollbackThreshold: 3,
      requireConfidence: true,
      confidenceMethod: 'msprt',
    });
    // A consistently low (~4), B consistently high (~9): a real, separable gap.
    seedVersionRuns(memory, 'v1', [4, 4, 5, 4, 5, 4], startedAt);
    seedVersionRuns(memory, 'v2', [9, 9, 10, 9, 9], startedAt); // 5 seeded + 1 trigger = 6

    const trigger = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v2',
      success: true,
      startedAt: new Date().toISOString(),
      metrics: metrics({ qualityScore: 10 }),
    });

    const result = await loop.afterRun(trigger);

    assert.equal(result.abTestCompleted, true);
    assert.ok(result.message.includes('v2 wins'), `expected v2 adopted: ${result.message}`);
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v2');
    assert.equal(state.abTests['researcher'], null, 'A/B test should be cleared');
    // usesSequentialConfidence() gated the extra sample-loading: one load per arm.
    assert.equal(getScoreLoadCount(), 2, 'getCompositeScores must be loaded per arm under mSPRT');
  });

  it('mSPRT: does NOT adopt a noisy/overlapping pair (stays in test, incumbent kept)', async () => {
    const { memory, loop, startedAt } = setupActiveSequentialTest({
      minDataPoints: 5,
      maxRegression: 0.2,
      failureRollbackThreshold: 3,
      requireConfidence: true,
      confidenceMethod: 'msprt',
    });
    // Both arms hover around the same mid band — no decisive separation.
    seedVersionRuns(memory, 'v1', [6, 7, 6.5, 7, 6, 7.5], startedAt);
    seedVersionRuns(memory, 'v2', [6.5, 7, 7, 6.5, 7], startedAt);

    const trigger = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v2',
      success: true,
      startedAt: new Date().toISOString(),
      metrics: metrics({ qualityScore: 7 }),
    });

    const result = await loop.afterRun(trigger);

    assert.equal(result.abTestCompleted, false);
    assert.ok(result.message.includes('A/B test in progress'), `expected continue: ${result.message}`);
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v1', 'incumbent must be kept');
    assert.ok(state.abTests['researcher'], 'A/B test should still be active');
  });

  it('Hoeffding: adopts a clear winner end-to-end (bounded score range)', async () => {
    // Hoeffding is a σ-free, conservative confidence sequence: its half-width
    // shrinks with n, so it needs a decent sample count to clear a gap. We use
    // the TRUE composite bound [0, 1] (composite scores are bounded there by
    // construction) and enough samples that the sequences genuinely separate,
    // exercising the real bounded-variable contract rather than an
    // out-of-range shortcut. Arms: A worst on every objective (composite ≈
    // 0.25, the success-weight floor), B best on every objective (composite
    // = 1.0), so the gap on offer is ≈ 0.75.
    //
    // 60 runs per arm, up from 30 before v0.15. The corrected boundary (see
    // sequential.ts) is wider, and at 30 runs per arm the two half-widths sum
    // to ≈ 0.87, which no gap inside [0, 1] can clear, let alone 0.75. The
    // old number only worked because the pre-0.15 boundary was narrower than
    // its own error budget allowed: cumulatively those per-look bounds sum
    // past α rather than to it. This is the practical cost of the fix, made visible here
    // rather than hidden.
    const { memory, loop, startedAt } = setupActiveSequentialTest(
      {
        minDataPoints: 5,
        maxRegression: 0.2,
        failureRollbackThreshold: 3,
        requireConfidence: true,
        confidenceMethod: 'hoeffding',
        confidenceScoreRange: [0, 1],
      },
      // Counters match the records injected below EXACTLY: 60 seeded for A, 59
      // for B plus the trigger run that makes 60. An earlier attempt seeded 60
      // B records against a counter of 59, so evaluation saw 61 samples for a
      // counter of 60; cross-model review caught it.
      //
      // Honest about what this fixture is: a 60/60 state with a 0.75 gap is
      // not something per-run evaluation would still be sitting in, because
      // the α=0.05 boundary already clears that gap at 43 runs per arm. It is
      // a direct exercise of the Hoeffding wiring at a size where the verdict
      // is unambiguous, not a claim about the path production would take.
      { runsA: 60, runsB: 59, minRuns: 25 },
    );
    for (let i = 0; i < 60; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'researcher',
          promptVersion: 'v1',
          success: true,
          startedAt,
          metrics: metrics({ qualityScore: 0, sourceCount: 0, outputLength: 0, errorCount: 5, durationMs: 300000 }),
        }),
      );
    }
    for (let i = 0; i < 59; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'researcher',
          promptVersion: 'v2',
          success: true,
          startedAt,
          metrics: metrics({ qualityScore: 10, sourceCount: 20, outputLength: 10000, errorCount: 0, durationMs: 0 }),
        }),
      );
    }

    const trigger = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v2',
      success: true,
      startedAt: new Date().toISOString(),
      metrics: metrics({ qualityScore: 10, sourceCount: 20, outputLength: 10000, errorCount: 0, durationMs: 0 }),
    });

    const result = await loop.afterRun(trigger);

    assert.equal(result.abTestCompleted, true);
    assert.ok(result.message.includes('v2 wins'), `expected v2 adopted: ${result.message}`);
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v2');
  });

  it('Hoeffding: does NOT adopt an overlapping pair (stays in test)', async () => {
    const { memory, loop, startedAt } = setupActiveSequentialTest({
      minDataPoints: 5,
      maxRegression: 0.2,
      failureRollbackThreshold: 3,
      requireConfidence: true,
      confidenceMethod: 'hoeffding',
      confidenceScoreRange: [0.6, 0.9],
    });
    seedVersionRuns(memory, 'v1', [6, 7, 6.5, 7, 6, 7.5], startedAt);
    seedVersionRuns(memory, 'v2', [6.5, 7, 7, 6.5, 7], startedAt);

    const trigger = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v2',
      success: true,
      startedAt: new Date().toISOString(),
      metrics: metrics({ qualityScore: 7 }),
    });

    const result = await loop.afterRun(trigger);

    assert.equal(result.abTestCompleted, false);
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v1', 'incumbent must be kept');
    assert.ok(state.abTests['researcher'], 'A/B test should still be active');
  });

  it('default (no requireConfidence): does NOT load per-sample scores', async () => {
    // Control for the gating: without a sequential method usesSequentialConfidence()
    // is false, so the loop must NOT call getCompositeScores at all.
    const { memory, loop, startedAt, getScoreLoadCount } = setupActiveSequentialTest({
      minDataPoints: 5,
      maxRegression: 0.2,
      failureRollbackThreshold: 3,
    });
    seedVersionRuns(memory, 'v1', [4, 4, 5, 4, 5, 4], startedAt);
    seedVersionRuns(memory, 'v2', [9, 9, 10, 9, 9], startedAt);

    const trigger = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v2',
      success: true,
      startedAt: new Date().toISOString(),
      metrics: metrics({ qualityScore: 10 }),
    });

    await loop.afterRun(trigger);
    assert.equal(getScoreLoadCount(), 0, 'getCompositeScores must NOT be loaded without a sequential method');
  });
});

// ════════════════════════════════════════════════════
// 2. ε-Pareto activation gate
// ════════════════════════════════════════════════════
//
// With paretoGate on, a challenger that wins the scalar composite is activated
// only if it Pareto-dominates the incumbent. With a positive paretoEpsilon a
// marginal (≤ε) regression on one objective is forgiven; beyond ε the incumbent
// is kept. Strict (ε=0) is the control that proves ε is the thing that flips it.

/** Active A/B test ready for the activation-gate path (both arms at minRuns). */
function makeActiveTestMemory(): MockMemory {
  const memory = createMockMemory();
  memory._versions.push(
    makePromptVersion({ version: 'v1', agentName: 'researcher', active: true }),
    makePromptVersion({ version: 'v2', agentName: 'researcher', active: false }),
  );
  const test: ABTest = {
    versionA: 'v1',
    versionB: 'v2',
    runsA: 5,
    runsB: 5,
    failsA: 0,
    failsB: 0,
    minRuns: 5,
    startedAt: new Date(Date.now() - 120_000).toISOString(),
  };
  memory._state.abTests['researcher'] = test;
  memory._state.activeVersions['researcher'] = 'v1';
  return memory;
}

function seedABMetrics(memory: MockMemory, version: string, m: DarwinMetrics): void {
  for (let i = 0; i < 5; i++) {
    memory._experiments.push(
      makeExperiment({ agentName: 'researcher', promptVersion: version, success: true, metrics: m }),
    );
  }
}

function buildGateLoop(memory: MockMemory, agent: AgentDefinition): DarwinLoop {
  return new DarwinLoop({
    memory,
    tracker: new ExperimentTracker(memory),
    optimizer: new PromptOptimizer(async () => 'unused'),
    safety: new SafetyGate(),
    patterns: new PatternDetector(memory),
    agent,
  });
}

describe('DarwinLoop — ε-Pareto activation gate (v0.7.0)', () => {
  // Incumbent A. Challenger B wins composite (much higher quality) but regresses
  // sourceCount: 9.6 = 4% below A's 10 (within ε=0.05) vs 9.0 = 10% below (beyond).
  const A = metrics({ qualityScore: 6, sourceCount: 10 });
  const B_within = metrics({ qualityScore: 8, sourceCount: 9.6 });
  const B_beyond = metrics({ qualityScore: 8, sourceCount: 9.0 });

  it('accepts the challenger when its single-objective regression is within ε', async () => {
    const memory = makeActiveTestMemory();
    seedABMetrics(memory, 'v1', A);
    seedABMetrics(memory, 'v2', B_within);

    const loop = buildGateLoop(memory, makeAgent({ enabled: true, paretoGate: true, paretoEpsilon: 0.05 }));
    const trigger = makeExperiment({ agentName: 'researcher', promptVersion: 'v2', success: true, metrics: B_within });

    const result = await loop.afterRun(trigger);

    assert.equal(result.abTestCompleted, true);
    assert.ok(result.message.includes('v2 wins'), `ε should forgive the marginal regression: ${result.message}`);
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v2');
  });

  it('keeps the incumbent when the regression exceeds ε', async () => {
    const memory = makeActiveTestMemory();
    seedABMetrics(memory, 'v1', A);
    seedABMetrics(memory, 'v2', B_beyond);

    const loop = buildGateLoop(memory, makeAgent({ enabled: true, paretoGate: true, paretoEpsilon: 0.05 }));
    const trigger = makeExperiment({ agentName: 'researcher', promptVersion: 'v2', success: true, metrics: B_beyond });

    const result = await loop.afterRun(trigger);

    assert.equal(result.abTestCompleted, true);
    assert.ok(result.message.includes('v1 wins'), `beyond-ε regression should keep incumbent: ${result.message}`);
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v1');
  });

  it('control: strict gate (ε=0) rejects the SAME within-ε challenger', async () => {
    // Proves ε is the lever: the marginal-regression case that ε=0.05 accepts is
    // rejected by the strict (default) gate.
    const memory = makeActiveTestMemory();
    seedABMetrics(memory, 'v1', A);
    seedABMetrics(memory, 'v2', B_within);

    const loop = buildGateLoop(memory, makeAgent({ enabled: true, paretoGate: true /* paretoEpsilon defaults to 0 */ }));
    const trigger = makeExperiment({ agentName: 'researcher', promptVersion: 'v2', success: true, metrics: B_within });

    const result = await loop.afterRun(trigger);

    assert.equal(result.abTestCompleted, true);
    assert.ok(result.message.includes('v1 wins'), `strict gate should reject marginal regression: ${result.message}`);
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v1');
  });
});

// ════════════════════════════════════════════════════
// 3. feedbackWindow + reflection minibatch
// ════════════════════════════════════════════════════
//
// generateVariantGepa pulls feedbackWindow() reports (default 15) then, when
// reflectionMinibatchSize is set and smaller than the window, hands the reflector
// an epoch-shuffled minibatch of that size. We capture the reflector's meta-prompt
// (which embeds one "=== Variant N ===" block per feedback) and count them.

/** Seed `count` weak experiments each carrying a uniquely-marked critic report. */
function seedMarkedFeedback(memory: MockMemory, count: number): void {
  for (let i = 0; i < count; i++) {
    const exp: DarwinExperiment = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      taskType: 'tech',
      success: true,
      metrics: metrics({ qualityScore: 5.5 }),
    });
    exp.feedback = { score: 5.5, report: `REPORT_MARKER_${i}: shallow analysis.`, evaluator: 'multi-critic' };
    memory._experiments.push(exp);
  }
}

/**
 * Drive the evolution-trigger path with a GEPA optimizer whose RunPromptFn
 * captures the reflection meta-prompt. Returns the captured prompt + result.
 */
async function runGepaAndCaptureMeta(evolution: AgentDefinition['evolution']): Promise<{
  meta: string;
  variantBlocks: number;
  reportedN: number | null;
  viaGepa: boolean;
}> {
  const memory = createMockMemory();
  memory._versions.push(
    makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
  );
  seedMarkedFeedback(memory, 20); // more than any window so the cap actually bites

  let capturedMeta = '';
  const gepaOut =
    'You are a precise research agent. Never fabricate sources. Cite primary documents and verify each claim.';
  const gepa = new GepaOptimizer(async (meta: string) => {
    capturedMeta = meta;
    return gepaOut;
  });

  const loop = new DarwinLoop({
    memory,
    tracker: new ExperimentTracker(memory),
    optimizer: new PromptOptimizer(async () => 'LEGACY-should-not-be-used but stays Never-safe'),
    safety: new SafetyGate(),
    patterns: new PatternDetector(memory),
    agent: makeAgent(evolution),
    gepa,
  });

  const trigger = makeExperiment({
    agentName: 'researcher',
    promptVersion: 'v1',
    taskType: 'tech',
    success: true,
    metrics: metrics({ qualityScore: 5.5 }),
    feedback: { score: 5.5, report: 'REPORT_MARKER_TRIGGER: weak.', evaluator: 'multi-critic' },
  });

  const result = await loop.afterRun(trigger);
  const variantBlocks = (capturedMeta.match(/=== Variant /g) ?? []).length;
  const nMatch = capturedMeta.match(/feedback from (\d+) variant evaluations/);

  return {
    meta: capturedMeta,
    variantBlocks,
    reportedN: nMatch ? Number(nMatch[1]) : null,
    viaGepa: result.message.includes('via gepa'),
  };
}

describe('DarwinLoop — feedbackWindow + reflection minibatch (v0.7.0)', () => {
  it('default feedbackWindow is 15 when unset', async () => {
    const captured = await runGepaAndCaptureMeta({ enabled: true, useGepa: true });
    assert.equal(captured.viaGepa, true);
    assert.equal(captured.variantBlocks, 15, 'reflector should see the default window of 15');
    assert.equal(captured.reportedN, 15);
  });

  it('reflection minibatch bounds the reflector to ≤ reflectionMinibatchSize', async () => {
    const captured = await runGepaAndCaptureMeta({
      enabled: true,
      useGepa: true,
      feedbackWindow: 12,
      reflectionMinibatchSize: 4,
    });
    assert.equal(captured.viaGepa, true);
    assert.ok(captured.variantBlocks <= 4, `minibatch must be bounded, got ${captured.variantBlocks}`);
    assert.equal(captured.variantBlocks, 4);
  });

  it('the minibatch is drawn FROM the feedback window (epoch-shuffled slice)', async () => {
    // window = first 12 reports (loadExperiments insertion order) = markers 0..11.
    // epoch = versionInt('v1') = 1, size = 4 → epochShuffledMinibatch picks a
    // contiguous, wrapping slice of the window — here markers 4,5,6,7.
    const captured = await runGepaAndCaptureMeta({
      enabled: true,
      useGepa: true,
      feedbackWindow: 12,
      reflectionMinibatchSize: 4,
    });

    const expectedIdx = epochShuffledMinibatch([...Array(12).keys()], 4, 1);
    for (const i of expectedIdx) {
      assert.ok(
        captured.meta.includes(`REPORT_MARKER_${i}:`),
        `expected minibatch marker ${i} in reflector meta`,
      );
    }
    // Markers outside the window (12..19) and the trigger must NOT leak in.
    assert.ok(!captured.meta.includes('REPORT_MARKER_15:'), 'marker outside the window must not appear');
    assert.ok(!captured.meta.includes('REPORT_MARKER_TRIGGER'), 'trigger report is outside the window');
  });
});

// ════════════════════════════════════════════════════
// 4. Semantic alignment guard in the loop
// ════════════════════════════════════════════════════
//
// When an embedder is injected, generateVariantGepa upgrades its alignment guard
// to checkAlignmentPreservationSemantic: a constraint that was REWORDED (keyword
// dropped but meaning preserved) is accepted, while a constraint that was DROPPED
// falls back to the legacy optimizer. Without an embedder the keyword-only guard
// rejects even the reworded one — the control that proves the loop uses the
// semantic path when embed is present.

const REWORDED_GEPA =
  'You are a precise research agent. Always present only genuine, real sources. Cite primary documents.';
const DROPPED_GEPA =
  'You are a friendly research agent. Share whatever sounds plausible. Cite primary documents.';
const LEGACY_OUT =
  'You are a careful research agent. Never fabricate sources. Verify each claim.';

/**
 * Deterministic concept embedder. Maps each sentence to a 3-axis vector:
 *   axis 0 "honest-sourcing" — fabricate / genuine / real / verified
 *   axis 1 "loose-sourcing"  — plausible / whatever / sounds
 *   axis 2 "citation"        — cite / primary / document
 * The original "Never fabricate sources." and the reworded "…only genuine, real
 * sources." both land on axis 0 (cosine 1.0 ≥ 0.82), so the rewording is judged
 * equivalent; the dropped variant has no axis-0 sentence, so it stays rejected.
 */
const conceptEmbed: EmbedFn = (texts) =>
  Promise.resolve(
    texts.map((t) => {
      const lt = t.toLowerCase();
      const honest = /fabricate|genuine|real|verified|authentic/.test(lt) ? 1 : 0;
      const loose = /plausible|whatever|sounds/.test(lt) ? 1 : 0;
      const cite = /cite|primary|document/.test(lt) ? 1 : 0;
      return [honest, loose, cite];
    }),
  );

function buildSemanticLoop(opts: {
  memory: MockMemory;
  gepaOut: string;
  embed?: EmbedFn;
}): DarwinLoop {
  const gepa = new GepaOptimizer(async () => opts.gepaOut);
  return new DarwinLoop({
    memory: opts.memory,
    tracker: new ExperimentTracker(opts.memory),
    optimizer: new PromptOptimizer(async () => LEGACY_OUT),
    safety: new SafetyGate(),
    patterns: new PatternDetector(opts.memory),
    agent: makeAgent({ enabled: true, useGepa: true }),
    gepa,
    embed: opts.embed,
  });
}

function seedWeakFeedbackV1(memory: MockMemory, count: number): void {
  for (let i = 0; i < count; i++) {
    const exp: DarwinExperiment = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      taskType: 'tech',
      success: true,
      metrics: metrics({ qualityScore: 5.5 }),
    });
    exp.feedback = { score: 5.5, report: 'Weak: shallow.', evaluator: 'multi-critic' };
    memory._experiments.push(exp);
  }
}

async function runSemanticCase(gepaOut: string, embed?: EmbedFn): Promise<{
  viaGepa: boolean;
  v2Text: string | undefined;
  v2Reason: string | undefined;
}> {
  const memory = createMockMemory();
  memory._versions.push(
    makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
  );
  seedWeakFeedbackV1(memory, 15);

  const loop = buildSemanticLoop({ memory, gepaOut, embed });
  const trigger = makeExperiment({
    agentName: 'researcher',
    promptVersion: 'v1',
    taskType: 'tech',
    success: true,
    metrics: metrics({ qualityScore: 5.5 }),
    feedback: { score: 5.5, report: 'Weak.', evaluator: 'multi-critic' },
  });

  const result = await loop.afterRun(trigger);
  const v2 = memory._versions.find((v) => v.version === 'v2');
  return { viaGepa: result.message.includes('via gepa'), v2Text: v2?.promptText, v2Reason: v2?.changeReason };
}

describe('DarwinLoop — semantic alignment guard (v0.7.0)', () => {
  it('accepts a reworded-but-equivalent mutation when an embedder is injected', async () => {
    const r = await runSemanticCase(REWORDED_GEPA, conceptEmbed);
    assert.equal(r.viaGepa, true, 'semantic guard should accept the reworded mutation → GEPA path');
    assert.equal(r.v2Text, REWORDED_GEPA);
    assert.ok(r.v2Reason?.startsWith('[gepa]'));
  });

  it('rejects a constraint-dropping mutation (falls back to legacy → null)', async () => {
    const r = await runSemanticCase(DROPPED_GEPA, conceptEmbed);
    assert.equal(r.viaGepa, false, 'a genuinely dropped constraint must be rejected');
    assert.equal(r.v2Text, LEGACY_OUT, 'loop must fall back to the legacy optimizer');
    assert.notEqual(r.v2Text, DROPPED_GEPA);
    assert.ok(r.v2Reason?.startsWith('[legacy]'));
  });

  it('control: WITHOUT an embedder the keyword-only guard rejects the reworded mutation', async () => {
    // Same reworded mutation, no embed → fail-closed keyword check rejects it,
    // proving the acceptance above is driven by checkAlignmentPreservationSemantic.
    const r = await runSemanticCase(REWORDED_GEPA /* no embed */);
    assert.equal(r.viaGepa, false);
    assert.equal(r.v2Text, LEGACY_OUT);
    assert.ok(r.v2Reason?.startsWith('[legacy]'));
  });
});

// ════════════════════════════════════════════════════
// 5. Additivity smoke — no new flags ⇒ legacy path
// ════════════════════════════════════════════════════
//
// An agent with NONE of the v0.7.0 flags set must behave exactly like the legacy
// path: no throw, the legacy optimizer produces the variant, and the loop emits
// no "via gepa/legacy" generator tag (that tag only appears when useGepa is on).

describe('DarwinLoop — additivity smoke (v0.7.0 flags off)', () => {
  it('runs the legacy evolution path unchanged when no new flags are set', async () => {
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
    );
    for (let i = 0; i < 15; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'researcher',
          promptVersion: 'v1',
          taskType: 'tech',
          success: true,
          metrics: metrics({ qualityScore: 5.5 }),
        }),
      );
    }

    let optimizerCalls = 0;
    const legacyOut = LEGACY_OUT;
    const optimizer = new PromptOptimizer(async () => {
      optimizerCalls++;
      return legacyOut;
    });
    const loop = new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      optimizer,
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      agent: makeAgent({ enabled: true }), // no useGepa / paretoGate / requireConfidence
    });

    const trigger = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      taskType: 'tech',
      success: true,
      metrics: metrics({ qualityScore: 5.5 }),
    });

    const result = await loop.afterRun(trigger);

    assert.equal(result.promptEvolved, true);
    assert.equal(optimizerCalls, 1, 'legacy optimizer must produce the variant');
    assert.ok(!result.message.includes('via'), `no generator tag on the legacy path: ${result.message}`);
    const v2 = memory._versions.find((v) => v.version === 'v2');
    assert.ok(v2, 'v2 should be created');
    assert.equal(v2!.promptText, legacyOut);
    assert.ok(!v2!.changeReason.startsWith('['), 'legacy changeReason carries no [generator] prefix');
  });

  it('also works with no agent at all (pure legacy, no throw)', async () => {
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
    );
    for (let i = 0; i < 15; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'researcher',
          promptVersion: 'v1',
          taskType: 'tech',
          success: true,
          metrics: metrics({ qualityScore: 5.5 }),
        }),
      );
    }

    const loop = new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      optimizer: new PromptOptimizer(async () => LEGACY_OUT),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      // no agent injected
    });

    const trigger = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      taskType: 'tech',
      success: true,
      metrics: metrics({ qualityScore: 5.5 }),
    });

    const result = await loop.afterRun(trigger);
    assert.equal(result.promptEvolved, true);
    assert.ok(!result.message.includes('via'));
    const v2 = memory._versions.find((v) => v.version === 'v2');
    assert.equal(v2!.promptText, LEGACY_OUT);
  });
});

// ─── GEPA system-aware MERGE wiring (v0.7.0) ────────────────────────

/** A meta-prompt is the MERGE template (vs the reflection template). */
function isMergeMeta(meta: string): boolean {
  return /PARENT A/.test(meta) && /merger/i.test(meta);
}

const MERGE_OUT =
  'You are a research agent. Never fabricate sources. Cite many primary documents AND write deep, high-quality analysis.';
const REFLECT_OUT = 'You are a research agent. Never fabricate sources. Reflective edit applied.';

async function setupMergeLoop(
  evolution: AgentDefinition['evolution'],
  opts: { seedParents: boolean } = { seedParents: true },
): Promise<{ result: Awaited<ReturnType<DarwinLoop['afterRun']>>; mergeCalled: boolean; reflectCalled: boolean; newPrompt: string }> {
  const memory = createMockMemory();
  // v1 + v2 are HISTORY (Pareto-distinct merge parents); v3 is the ACTIVE
  // version being evolved. Active=v3 so the challenger is v4 — no name clash
  // with the existing versions (nextVersion('v3')='v4').
  memory._versions.push(
    makePromptVersion({
      version: 'v1', agentName: 'researcher', active: false,
      promptText: 'You are a research agent. Never fabricate sources. Cite many primary documents.',
    }),
    makePromptVersion({
      version: 'v2', agentName: 'researcher', active: false,
      promptText: 'You are a research agent. Never fabricate sources. Write deep, high-quality analysis.',
    }),
    makePromptVersion({
      version: 'v3', agentName: 'researcher', active: true,
      promptText: 'You are a research agent. Never fabricate sources. Do solid work.',
    }),
  );
  // v3 (active): weak quality → triggers evolution. Always seeded (20 so the
  // weakness/trigger fires reliably even when no contrasting versions exist).
  for (let i = 0; i < 20; i++) {
    const e = makeExperiment({
      agentName: 'researcher', promptVersion: 'v3', taskType: 'tech', success: true,
      metrics: metrics({ qualityScore: 4.0, sourceCount: 8 }),
    });
    e.feedback = { score: 4.0, report: `v3 shallow ${i}`, evaluator: 'multi-critic' };
    memory._experiments.push(e);
  }
  // v1 (high quality / low sources) + v2 (low quality / high sources) are two
  // Pareto-distinct historical parents. Seeded only when we want a merge.
  if (opts.seedParents) {
    for (let i = 0; i < 6; i++) {
      const a = makeExperiment({
        agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
        metrics: metrics({ qualityScore: 8.5, sourceCount: 2 }),
      });
      a.feedback = { score: 8.5, report: `v1 deep ${i}`, evaluator: 'multi-critic' };
      memory._experiments.push(a);
      const b = makeExperiment({
        agentName: 'researcher', promptVersion: 'v2', taskType: 'tech', success: true,
        metrics: metrics({ qualityScore: 4.5, sourceCount: 18 }),
      });
      b.feedback = { score: 4.5, report: `v2 broad ${i}`, evaluator: 'multi-critic' };
      memory._experiments.push(b);
    }
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
    optimizer: new PromptOptimizer(async () => 'LEGACY Never-safe fallback'),
    safety: new SafetyGate(),
    patterns: new PatternDetector(memory),
    agent: makeAgent(evolution),
    gepa,
  });

  const trigger = makeExperiment({
    agentName: 'researcher', promptVersion: 'v3', taskType: 'tech', success: true,
    metrics: metrics({ qualityScore: 4.0, sourceCount: 8 }),
    feedback: { score: 4.0, report: 'trigger shallow', evaluator: 'multi-critic' },
  });
  const result = await loop.afterRun(trigger);
  const newVer = memory._versions.find(
    (v) => v.version !== 'v1' && v.version !== 'v2' && v.version !== 'v3',
  );
  return { result, mergeCalled, reflectCalled, newPrompt: newVer?.promptText ?? '' };
}

describe('DarwinLoop — GEPA system-aware merge (v0.7.0)', () => {
  it('merges the two best Pareto versions on a K-th cycle (useMerge on)', async () => {
    const { result, mergeCalled, newPrompt } = await setupMergeLoop({
      enabled: true, useGepa: true, useMerge: true, mergeEveryK: 1,
    });
    assert.equal(mergeCalled, true, 'gepa.merge should have been invoked');
    assert.ok(result.message.includes('via merge'), `expected merge tag: ${result.message}`);
    assert.equal(newPrompt, MERGE_OUT, 'challenger should be the merged prompt');
  });

  it('falls back to reflective when fewer than two scored versions exist', async () => {
    const { mergeCalled, reflectCalled, newPrompt } = await setupMergeLoop(
      { enabled: true, useGepa: true, useMerge: true, mergeEveryK: 1 },
      { seedParents: false }, // only the active v3 has metric data → < 2 Pareto parents
    );
    assert.equal(mergeCalled, false, 'merge cannot run with one scored version');
    assert.equal(reflectCalled, true, 'should fall back to the reflective path');
    assert.equal(newPrompt, REFLECT_OUT);
  });

  it('does NOT merge when useMerge is off (default), even with two Pareto versions', async () => {
    const { mergeCalled, reflectCalled, result } = await setupMergeLoop({
      enabled: true, useGepa: true, // no useMerge
    });
    assert.equal(mergeCalled, false);
    assert.equal(reflectCalled, true);
    assert.ok(result.message.includes('via gepa'), `expected gepa tag: ${result.message}`);
  });

  it('respects mergeEveryK cadence (epoch not divisible → reflective)', async () => {
    // active version v3 → epoch 3; mergeEveryK=2 → 3 % 2 != 0 → no merge this cycle.
    const { mergeCalled, reflectCalled } = await setupMergeLoop({
      enabled: true, useGepa: true, useMerge: true, mergeEveryK: 2,
    });
    assert.equal(mergeCalled, false, 'merge should not fire off-cadence');
    assert.equal(reflectCalled, true);
  });
});
