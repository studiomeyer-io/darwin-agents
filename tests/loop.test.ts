/**
 * Tests for DarwinLoop — the core evolution cycle.
 *
 * Focus: incomplete run detection, experiment recording gating,
 * rollback triggering, and A/B test failure tracking.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';
import type { ABTest } from '../src/types.js';

let memory: ReturnType<typeof createMockMemory>;
let loop: DarwinLoop;
let tracker: ExperimentTracker;

function createLoop(mem: ReturnType<typeof createMockMemory>): {
  loop: DarwinLoop;
  tracker: ExperimentTracker;
} {
  const t = new ExperimentTracker(mem);
  const safety = new SafetyGate();
  const patterns = new PatternDetector(mem);
  const optimizer = new PromptOptimizer(async () => 'improved prompt text');

  const l = new DarwinLoop({
    memory: mem,
    tracker: t,
    optimizer,
    safety,
    patterns,
  });

  return { loop: l, tracker: t };
}

// ─── Incomplete Run Detection ───────────────────────

describe('DarwinLoop — incomplete run detection', () => {
  beforeEach(() => {
    memory = createMockMemory();
    const created = createLoop(memory);
    loop = created.loop;
    tracker = created.tracker;
  });

  it('skips recording when outputLength < 2000 (incomplete)', async () => {
    const exp = makeExperiment({
      agentName: 'researcher',
      metrics: {
        qualityScore: 8,
        sourceCount: 10,
        outputLength: 500, // < 2000 = incomplete
        errorCount: 0,
        durationMs: 30000,
      },
    });

    const result = await loop.afterRun(exp);

    assert.ok(result.message.includes('Incomplete run'));
    // The experiment should NOT be saved
    assert.equal(memory._experiments.length, 0);
  });

  it('skips recording when outputLength is exactly 1999', async () => {
    const exp = makeExperiment({
      agentName: 'researcher',
      metrics: {
        qualityScore: 8,
        sourceCount: 10,
        outputLength: 1999,
        errorCount: 0,
        durationMs: 30000,
      },
    });

    const result = await loop.afterRun(exp);
    assert.ok(result.message.includes('Incomplete run'));
    assert.equal(memory._experiments.length, 0);
  });

  it('records experiment when outputLength is exactly 2000', async () => {
    const exp = makeExperiment({
      agentName: 'researcher',
      metrics: {
        qualityScore: 8,
        sourceCount: 10,
        outputLength: 2000, // >= 2000 = complete
        errorCount: 0,
        durationMs: 30000,
      },
    });

    await loop.afterRun(exp);
    assert.equal(memory._experiments.length, 1);
  });

  it('records experiment when outputLength is well above threshold', async () => {
    const exp = makeExperiment({
      agentName: 'researcher',
      metrics: {
        qualityScore: 8,
        sourceCount: 10,
        outputLength: 8000,
        errorCount: 0,
        durationMs: 30000,
      },
    });

    await loop.afterRun(exp);
    assert.equal(memory._experiments.length, 1);
  });

  it('incomplete run with success=true is still skipped (output too short)', async () => {
    const exp = makeExperiment({
      agentName: 'researcher',
      success: true,
      metrics: {
        qualityScore: 9,
        sourceCount: 15,
        outputLength: 300, // success flag is true but output is garbage
        errorCount: 0,
        durationMs: 20000,
      },
    });

    const result = await loop.afterRun(exp);
    assert.ok(result.message.includes('Incomplete run'));
    assert.equal(memory._experiments.length, 0);
  });
});

// ─── Incomplete Run + A/B Test Fail Tracking ────────

describe('DarwinLoop — incomplete runs track A/B test failures', () => {
  beforeEach(() => {
    memory = createMockMemory();
    const created = createLoop(memory);
    loop = created.loop;
    tracker = created.tracker;
  });

  it('increments failsB when incomplete run uses versionB of active A/B test', async () => {
    // Set up an active A/B test
    const abTest: ABTest = {
      versionA: 'v1',
      versionB: 'v2',
      runsA: 3,
      runsB: 1,
      failsA: 0,
      failsB: 0,
      minRuns: 5,
      startedAt: new Date().toISOString(),
    };
    memory._state.abTests['researcher'] = abTest;

    const exp = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v2',
      metrics: {
        qualityScore: 2,
        sourceCount: 0,
        outputLength: 500, // incomplete
        errorCount: 3,
        durationMs: 180000,
      },
    });

    await loop.afterRun(exp);

    const state = await memory.getState();
    const test = state.abTests['researcher'];
    assert.ok(test, 'A/B test should still be active');
    assert.equal(test!.failsB, 1);
    assert.equal(test!.failsA, 0);
  });

  it('increments failsA when incomplete run uses versionA', async () => {
    const abTest: ABTest = {
      versionA: 'v1',
      versionB: 'v2',
      runsA: 2,
      runsB: 2,
      failsA: 0,
      failsB: 0,
      minRuns: 5,
      startedAt: new Date().toISOString(),
    };
    memory._state.abTests['researcher'] = abTest;

    const exp = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      metrics: {
        qualityScore: 1,
        sourceCount: 0,
        outputLength: 100,
        errorCount: 5,
        durationMs: 200000,
      },
    });

    await loop.afterRun(exp);

    const state = await memory.getState();
    const test = state.abTests['researcher'];
    assert.ok(test, 'A/B test should still be active');
    assert.equal(test!.failsA, 1);
    assert.equal(test!.failsB, 0);
  });

  it('auto-ends A/B test when version exceeds 50% failure rate with >=3 attempts', async () => {
    // Set up A/B test where v2 already has 1 fail
    const abTest: ABTest = {
      versionA: 'v1',
      versionB: 'v2',
      runsA: 3,
      runsB: 1,
      failsA: 0,
      failsB: 1,
      minRuns: 5,
      startedAt: new Date().toISOString(),
    };
    memory._state.abTests['researcher'] = abTest;

    // Set up prompt versions so activateVersion works
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: true }),
      makePromptVersion({ version: 'v2', agentName: 'researcher', active: false }),
    );

    // Another incomplete run for v2 => failsB=2, totalB=1+2=3, failure rate=66%
    const exp = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v2',
      metrics: {
        qualityScore: 1,
        sourceCount: 0,
        outputLength: 200,
        errorCount: 3,
        durationMs: 180000,
      },
    });

    const result = await loop.afterRun(exp);

    assert.ok(result.abTestCompleted, 'A/B test should auto-complete');
    assert.ok(result.message.includes('unreliable'));
    assert.ok(result.message.includes('v1 wins') || result.message.includes('v1'));
  });
});

// ─── Rollback on Consecutive Failures ───────────────

describe('DarwinLoop — rollback on consecutive failures', () => {
  beforeEach(() => {
    memory = createMockMemory();
    const created = createLoop(memory);
    loop = created.loop;
    tracker = created.tracker;
  });

  it('triggers rollback after 3 consecutive failures', async () => {
    // Pre-set state: 2 consecutive failures, different active vs last-known-good
    memory._state.consecutiveFailures['researcher'] = 2;
    memory._state.lastKnownGood['researcher'] = 'v1';
    memory._state.activeVersions['researcher'] = 'v2';

    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: false }),
      makePromptVersion({ version: 'v2', agentName: 'researcher', active: true }),
    );

    // Third failure (will be recorded first, making consecutiveFailures=3)
    const exp = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v2',
      success: false,
      metrics: {
        qualityScore: 2,
        sourceCount: 3,
        outputLength: 3000, // above incomplete threshold
        errorCount: 2,
        durationMs: 60000,
      },
    });

    const result = await loop.afterRun(exp);

    assert.ok(result.rolledBack, 'Should have rolled back');
    assert.ok(result.message.includes('Rolled back'));

    // v1 should now be active
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v1');
    assert.equal(state.consecutiveFailures['researcher'], 0);
  });

  it('does not roll back when failures < threshold', async () => {
    memory._state.consecutiveFailures['researcher'] = 0;

    const exp = makeExperiment({
      agentName: 'researcher',
      success: false,
      metrics: {
        qualityScore: 3,
        sourceCount: 5,
        outputLength: 3000,
        errorCount: 1,
        durationMs: 60000,
      },
    });

    const result = await loop.afterRun(exp);
    assert.equal(result.rolledBack, false);
  });
});

// ─── Evolution Gating ───────────────────────────────

describe('DarwinLoop — evolution gating', () => {
  beforeEach(() => {
    memory = createMockMemory();
    const created = createLoop(memory);
    loop = created.loop;
    tracker = created.tracker;
  });

  it('does not evolve when not enough data points', async () => {
    // Only 1 experiment total (need 10 for canEvolve)
    const exp = makeExperiment({
      agentName: 'researcher',
      metrics: {
        qualityScore: 7,
        sourceCount: 10,
        outputLength: 6000,
        errorCount: 0,
        durationMs: 30000,
      },
    });

    const result = await loop.afterRun(exp);
    assert.equal(result.promptEvolved, false);
    assert.ok(result.message.includes('Collecting data'));
  });

  it('does not evolve when only strengths are found (no weaknesses)', async () => {
    // Pre-populate 10+ good experiments to pass canEvolve
    for (let i = 0; i < 11; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'researcher',
          taskType: 'tech',
          success: true,
          metrics: {
            qualityScore: 9,
            sourceCount: 15,
            outputLength: 7000,
            errorCount: 0,
            durationMs: 30000,
          },
        }),
      );
    }

    const exp = makeExperiment({
      agentName: 'researcher',
      taskType: 'tech',
      success: true,
      metrics: {
        qualityScore: 9,
        sourceCount: 15,
        outputLength: 7000,
        errorCount: 0,
        durationMs: 30000,
      },
    });

    const result = await loop.afterRun(exp);
    assert.equal(result.promptEvolved, false);
    assert.ok(result.message.includes('no weaknesses'));
  });
});

// ─── A/B Test: in-progress tracking ─────────────────

describe('DarwinLoop — A/B test in progress', () => {
  beforeEach(() => {
    memory = createMockMemory();
    const created = createLoop(memory);
    loop = created.loop;
    tracker = created.tracker;
  });

  it('increments runsA when experiment uses versionA', async () => {
    const abTest: ABTest = {
      versionA: 'v1',
      versionB: 'v2',
      runsA: 2,
      runsB: 1,
      failsA: 0,
      failsB: 0,
      minRuns: 5,
      startedAt: new Date().toISOString(),
    };
    memory._state.abTests['researcher'] = abTest;

    const exp = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      metrics: {
        qualityScore: 7,
        sourceCount: 10,
        outputLength: 6000,
        errorCount: 0,
        durationMs: 30000,
      },
    });

    const result = await loop.afterRun(exp);
    assert.ok(result.message.includes('A/B test in progress'));

    // Verify the run was counted
    const state = await memory.getState();
    const test = state.abTests['researcher'];
    assert.ok(test);
    assert.equal(test!.runsA, 3); // was 2, now 3
    assert.equal(test!.runsB, 1); // unchanged
  });

  it('increments runsB when experiment uses versionB', async () => {
    const abTest: ABTest = {
      versionA: 'v1',
      versionB: 'v2',
      runsA: 3,
      runsB: 2,
      failsA: 0,
      failsB: 0,
      minRuns: 5,
      startedAt: new Date().toISOString(),
    };
    memory._state.abTests['researcher'] = abTest;

    const exp = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v2',
      metrics: {
        qualityScore: 7,
        sourceCount: 10,
        outputLength: 6000,
        errorCount: 0,
        durationMs: 30000,
      },
    });

    const result = await loop.afterRun(exp);
    assert.ok(result.message.includes('A/B test in progress'));

    const state = await memory.getState();
    const test = state.abTests['researcher'];
    assert.ok(test);
    assert.equal(test!.runsA, 3); // unchanged
    assert.equal(test!.runsB, 3); // was 2, now 3
  });
});
