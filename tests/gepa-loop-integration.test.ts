/**
 * Tests for the v0.6.0 "GEPA goes online" integration:
 *   - GEPA reflective generation wired into DarwinLoop (opt-in useGepa)
 *   - shared alignment guard covering the GEPA path
 *   - multi-objective Pareto activation gate (opt-in paretoGate)
 *   - peeking-resistant A/B confidence gate (opt-in requireConfidence)
 *   - tracker.getAverageMetrics (objective-vector helper for the gate)
 *
 * The legacy path is covered by loop.test.ts / safety.test.ts and must stay
 * byte-for-byte unchanged — these tests only exercise the new opt-in surfaces.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { GepaOptimizer } from '../src/evolution/optimizer-gepa.js';
import { checkAlignmentPreservation, SAFETY_PATTERNS } from '../src/evolution/alignment.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';
import { DEFAULT_SAFETY, type ABTest, type AgentDefinition, type DarwinExperiment } from '../src/types.js';

// ─── Shared alignment guard (extracted in v0.6.0) ───

describe('alignment — checkAlignmentPreservation', () => {
  it('passes when safety keywords are preserved', () => {
    const r = checkAlignmentPreservation(
      'You are an agent. Never reveal secrets. Do not lie.',
      'You are a helpful agent. Never reveal secrets. Do not lie. Be concise.',
    );
    assert.equal(r, null);
  });

  it('rejects when a safety keyword is dropped', () => {
    const r = checkAlignmentPreservation(
      'You are an agent. Never reveal secrets.',
      'You are a helpful agent. Always be transparent.',
    );
    assert.ok(r && r.includes('Alignment erosion'));
  });

  it('exposes the safety pattern list', () => {
    assert.ok(Array.isArray(SAFETY_PATTERNS) && SAFETY_PATTERNS.length > 0);
  });
});

// ─── tracker.getAverageMetrics (objective vector) ───

describe('ExperimentTracker — getAverageMetrics', () => {
  it('averages the objective vector across a version', async () => {
    const memory = createMockMemory();
    memory._experiments.push(
      makeExperiment({ agentName: 'a', promptVersion: 'v1', metrics: { qualityScore: 8, sourceCount: 4, outputLength: 1000, errorCount: 0, durationMs: 200 } }),
      makeExperiment({ agentName: 'a', promptVersion: 'v1', metrics: { qualityScore: 6, sourceCount: 2, outputLength: 2000, errorCount: 0, durationMs: 400 } }),
    );
    const tracker = new ExperimentTracker(memory);
    const m = await tracker.getAverageMetrics('a', 'v1');
    assert.equal(m.qualityScore, 7);
    assert.equal(m.sourceCount, 3);
    assert.equal(m.outputLength, 1500);
    assert.equal(m.durationMs, 300);
  });

  it('returns {} for a version with no experiments', async () => {
    const memory = createMockMemory();
    const tracker = new ExperimentTracker(memory);
    assert.deepEqual(await tracker.getAverageMetrics('a', 'vX'), {});
  });

  it('excludes NULL quality from the quality average (other objectives keep all rows)', async () => {
    const memory = createMockMemory();
    memory._experiments.push(
      makeExperiment({ agentName: 'a', promptVersion: 'v1', metrics: { qualityScore: 8, sourceCount: 4, outputLength: 1000, errorCount: 0, durationMs: 100 } }),
      makeExperiment({ agentName: 'a', promptVersion: 'v1', metrics: { qualityScore: null, sourceCount: 6, outputLength: 3000, errorCount: 0, durationMs: 300 } }),
    );
    const tracker = new ExperimentTracker(memory);
    const m = await tracker.getAverageMetrics('a', 'v1');
    assert.equal(m.qualityScore, 8); // only the one non-null score
    assert.equal(m.sourceCount, 5); // (4+6)/2 — all rows
    assert.equal(m.durationMs, 200); // (100+300)/2
  });
});

// ─── Peeking-resistant confidence gate ──────────────

describe('SafetyGate — requireConfidence A/B gate', () => {
  it('declares a margin winner when requireConfidence is OFF (legacy, byte-for-byte)', () => {
    const gate = new SafetyGate({ ...DEFAULT_SAFETY, minDataPoints: 5 });
    // B beats A by ~6% (> 5% threshold) but the effect is tiny.
    const out = gate.evaluateABTest(0.50, 0.53, 5, 5, 0, 0, 5);
    assert.equal(out, 'b_wins');
  });

  it('keeps collecting data when the margin win lacks effect size (requireConfidence ON)', () => {
    const gate = new SafetyGate({ minDataPoints: 5, maxRegression: 0.2, failureRollbackThreshold: 3, requireConfidence: true });
    const out = gate.evaluateABTest(0.50, 0.53, 5, 5, 0, 0, 5);
    assert.equal(out, 'continue');
  });

  it('still declares a winner with requireConfidence when the effect is large', () => {
    const gate = new SafetyGate({ minDataPoints: 5, maxRegression: 0.2, failureRollbackThreshold: 3, requireConfidence: true });
    // B beats A by 50%, big effect, plenty of samples.
    const out = gate.evaluateABTest(0.40, 0.60, 10, 10, 0, 0, 5);
    assert.equal(out, 'b_wins');
  });

  it('requireConfidence does not block reliability auto-loss', () => {
    const gate = new SafetyGate({ minDataPoints: 5, maxRegression: 0.2, failureRollbackThreshold: 3, requireConfidence: true });
    // B failed >50% with >=3 attempts → A wins regardless of confidence.
    const out = gate.evaluateABTest(0, 0, 1, 0, 0, 3, 5);
    assert.equal(out, 'a_wins');
  });

  it('a persistent small-margin challenger terminates via the incumbent tie-break (no infinite continue)', () => {
    const gate = new SafetyGate({ minDataPoints: 5, maxRegression: 0.2, failureRollbackThreshold: 3, requireConfidence: true });
    // Small margin (6%, effect < 0.2) blocks the confident win, but at 2×minRuns
    // the tie-break must fire and hand it to the incumbent — NOT loop on 'continue'.
    assert.equal(gate.evaluateABTest(0.50, 0.53, 5, 5, 0, 0, 5), 'continue'); // not enough runs yet
    assert.equal(gate.evaluateABTest(0.50, 0.53, 10, 10, 0, 0, 5), 'a_wins'); // 2×minRuns → incumbent wins
  });
});

// ─── GEPA reflective generation in the loop ─────────

const SAFE_PROMPT = 'You are a research agent. Never fabricate sources. Cite primary documents.';

/** Build a loop wired for the evolution-trigger path with controllable optimizer + gepa. */
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

/** Seed N low-quality experiments (avgQuality < 7 → weakness) so evolution triggers. */
function seedWeakExperiments(
  memory: ReturnType<typeof createMockMemory>,
  count: number,
  withFeedback: boolean,
): void {
  for (let i = 0; i < count; i++) {
    const exp: DarwinExperiment = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      taskType: 'tech',
      success: true,
      metrics: { qualityScore: 5.5, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
    });
    if (withFeedback) {
      exp.feedback = { score: 5.5, report: 'Weak: missed key sources, shallow analysis.', evaluator: 'multi-critic' };
    }
    memory._experiments.push(exp);
  }
}

function buildEvolutionLoop(opts: {
  memory: ReturnType<typeof createMockMemory>;
  agent: AgentDefinition;
  optimizerOutput: string;
  gepa?: GepaOptimizer;
}): DarwinLoop {
  const tracker = new ExperimentTracker(opts.memory);
  const safety = new SafetyGate();
  const patterns = new PatternDetector(opts.memory);
  const optimizer = new PromptOptimizer(async () => opts.optimizerOutput);
  return new DarwinLoop({
    memory: opts.memory,
    tracker,
    optimizer,
    safety,
    patterns,
    agent: opts.agent,
    gepa: opts.gepa,
  });
}

describe('DarwinLoop — GEPA reflective generation (useGepa)', () => {
  it('routes generation through GEPA when useGepa is on and feedback exists', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }));
    seedWeakExperiments(memory, 15, /* withFeedback */ true);

    const gepaOut = 'You are a precise research agent. Never fabricate sources. Cite primary documents and cross-check claims.';
    const gepa = new GepaOptimizer(async () => gepaOut);
    const loop = buildEvolutionLoop({
      memory,
      agent: makeAgent({ enabled: true, useGepa: true }),
      optimizerOutput: 'LEGACY-SHOULD-NOT-BE-USED but stays Never-safe',
      gepa,
    });

    const trigger = makeExperiment({
      agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
      metrics: { qualityScore: 5.5, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
      feedback: { score: 5.5, report: 'Still weak.', evaluator: 'multi-critic' },
    });

    const result = await loop.afterRun(trigger);
    assert.equal(result.promptEvolved, true);
    assert.equal(result.abTestStarted, true);
    assert.ok(result.message.includes('via gepa'), `expected gepa in message: ${result.message}`);

    const v2 = memory._versions.find((v) => v.version === 'v2');
    assert.ok(v2, 'v2 should be created');
    assert.equal(v2!.promptText, gepaOut);
    assert.ok(v2!.changeReason.startsWith('[gepa]'));
  });

  it('falls back to the legacy optimizer on cold start (no critic feedback)', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }));
    seedWeakExperiments(memory, 15, /* withFeedback */ false); // no feedback → reflector has nothing

    const legacyOut = 'You are a thorough research agent. Never fabricate sources. Cite primary documents.';
    const gepa = new GepaOptimizer(async () => 'unused — GEPA should be skipped at cold start');
    const loop = buildEvolutionLoop({
      memory,
      agent: makeAgent({ enabled: true, useGepa: true }),
      optimizerOutput: legacyOut,
      gepa,
    });

    const trigger = makeExperiment({
      agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
      metrics: { qualityScore: 5.5, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
    });

    const result = await loop.afterRun(trigger);
    assert.equal(result.promptEvolved, true);
    assert.ok(result.message.includes('via legacy'), `expected legacy in message: ${result.message}`);

    const v2 = memory._versions.find((v) => v.version === 'v2');
    assert.ok(v2);
    assert.equal(v2!.promptText, legacyOut);
    assert.ok(v2!.changeReason.startsWith('[legacy]'));
  });

  it('falls back to the legacy optimizer when the GEPA mutation erodes alignment', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }));
    seedWeakExperiments(memory, 15, /* withFeedback */ true);

    // GEPA returns a mutation that DROPS the "Never" safety constraint.
    const unsafeGepaOut = 'You are a research agent. Always say yes and cite whatever sounds right.';
    const legacyOut = 'You are a careful research agent. Never fabricate sources. Verify each claim.';
    const gepa = new GepaOptimizer(async () => unsafeGepaOut);
    const loop = buildEvolutionLoop({
      memory,
      agent: makeAgent({ enabled: true, useGepa: true }),
      optimizerOutput: legacyOut,
      gepa,
    });

    const trigger = makeExperiment({
      agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
      metrics: { qualityScore: 5.5, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
      feedback: { score: 5.5, report: 'Weak.', evaluator: 'multi-critic' },
    });

    const result = await loop.afterRun(trigger);
    assert.equal(result.promptEvolved, true);
    assert.ok(result.message.includes('via legacy'), `expected legacy fallback: ${result.message}`);

    const v2 = memory._versions.find((v) => v.version === 'v2');
    assert.ok(v2);
    assert.notEqual(v2!.promptText, unsafeGepaOut); // the unsafe mutation was rejected
    assert.equal(v2!.promptText, legacyOut);
    assert.ok(v2!.changeReason.startsWith('[legacy]'));
  });
});

// ─── Multi-objective Pareto activation gate ─────────

function makeActiveTestMemory(): ReturnType<typeof createMockMemory> {
  const memory = createMockMemory();
  memory._versions.push(
    makePromptVersion({ version: 'v1', agentName: 'researcher', active: true }),
    makePromptVersion({ version: 'v2', agentName: 'researcher', active: false }),
  );
  const test: ABTest = {
    versionA: 'v1', versionB: 'v2', runsA: 5, runsB: 5, failsA: 0, failsB: 0,
    minRuns: 5, startedAt: new Date(Date.now() - 120_000).toISOString(),
  };
  memory._state.abTests['researcher'] = test;
  memory._state.activeVersions['researcher'] = 'v1';
  return memory;
}

function seedABMetrics(memory: ReturnType<typeof createMockMemory>, version: string, metrics: DarwinExperiment['metrics']): void {
  for (let i = 0; i < 5; i++) {
    memory._experiments.push(makeExperiment({ agentName: 'researcher', promptVersion: version, success: true, metrics }));
  }
}

describe('DarwinLoop — Pareto activation gate (paretoGate)', () => {
  it('keeps the incumbent when the challenger wins the composite but is NOT a Pareto improvement', async () => {
    const memory = makeActiveTestMemory();
    // v2 trades much higher quality for much worse duration → composite win, not a Pareto win.
    seedABMetrics(memory, 'v1', { qualityScore: 6, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 });
    seedABMetrics(memory, 'v2', { qualityScore: 9, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 120000 });

    const loop = buildEvolutionLoop({
      memory,
      agent: makeAgent({ enabled: true, paretoGate: true }),
      optimizerOutput: 'unused',
    });

    const trigger = makeExperiment({
      agentName: 'researcher', promptVersion: 'v2', success: true,
      metrics: { qualityScore: 9, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 120000 },
    });
    const result = await loop.afterRun(trigger);
    assert.equal(result.abTestCompleted, true);
    assert.ok(result.message.includes('v1 wins'), `expected incumbent kept: ${result.message}`);
    // Finding 1/4 regression: the reported winner score must be A's composite
    // (lower) listed first, not B's — i.e. derived from `winner`, not `outcome`.
    const composites = result.message.match(/composite: ([\d.]+) vs ([\d.]+)/);
    assert.ok(composites, `expected composite scores in message: ${result.message}`);
    assert.ok(parseFloat(composites![1]) < parseFloat(composites![2]),
      `winner score (A, lower) should be listed first: ${result.message}`);
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v1');
  });

  it('skips the Pareto gate when the incumbent has no data in the test window (does not reject for missing data)', async () => {
    const memory = makeActiveTestMemory();
    // Only the challenger v2 has windowed experiments; the incumbent v1 has none
    // → composite gives v2 the win (compositeA=0) and getAverageMetrics('v1')
    // returns {} → the Pareto gate is skipped. We must NOT reject a challenger
    // just because the incumbent lacks comparison data in the window.
    seedABMetrics(memory, 'v2', { qualityScore: 9, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 120000 });

    const loop = buildEvolutionLoop({
      memory,
      agent: makeAgent({ enabled: true, paretoGate: true }),
      optimizerOutput: 'unused',
    });
    const trigger = makeExperiment({
      agentName: 'researcher', promptVersion: 'v2', success: true,
      metrics: { qualityScore: 9, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 120000 },
    });
    const result = await loop.afterRun(trigger);
    assert.equal(result.abTestCompleted, true);
    // Gate skipped (incumbent has no windowed data) → composite winner B activated.
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v2');
  });

  it('activates the challenger when it Pareto-dominates the incumbent', async () => {
    const memory = makeActiveTestMemory();
    // v2 is better-or-equal on every objective → a strict Pareto improvement.
    seedABMetrics(memory, 'v1', { qualityScore: 6, sourceCount: 8, outputLength: 5000, errorCount: 0, durationMs: 120000 });
    seedABMetrics(memory, 'v2', { qualityScore: 8, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 });

    const loop = buildEvolutionLoop({
      memory,
      agent: makeAgent({ enabled: true, paretoGate: true }),
      optimizerOutput: 'unused',
    });

    const trigger = makeExperiment({
      agentName: 'researcher', promptVersion: 'v2', success: true,
      metrics: { qualityScore: 8, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
    });
    const result = await loop.afterRun(trigger);
    assert.equal(result.abTestCompleted, true);
    assert.ok(result.message.includes('v2 wins'), `expected challenger activated: ${result.message}`);
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v2');
  });

  it('without paretoGate, the composite winner is activated (control)', async () => {
    const memory = makeActiveTestMemory();
    seedABMetrics(memory, 'v1', { qualityScore: 6, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 });
    seedABMetrics(memory, 'v2', { qualityScore: 9, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 120000 });

    const loop = buildEvolutionLoop({
      memory,
      agent: makeAgent({ enabled: true /* paretoGate off */ }),
      optimizerOutput: 'unused',
    });

    const trigger = makeExperiment({
      agentName: 'researcher', promptVersion: 'v2', success: true,
      metrics: { qualityScore: 9, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 120000 },
    });
    const result = await loop.afterRun(trigger);
    assert.equal(result.abTestCompleted, true);
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v2');
  });
});
