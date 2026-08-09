/**
 * Tests for the v0.14.0 rollback lineage walk.
 *
 * The gap (cross-model review): `handleABTest` promotes a winner by setting
 * `activeVersions` AND `lastKnownGood` to the same label. From that moment
 * `rollback()` compared them, found them equal, and declared "nothing to roll
 * back" — the advertised failure rollback was dead exactly when a
 * freshly-promoted prompt started degrading in real traffic. v0.14 walks one
 * step up the version lineage instead.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';

let memory: ReturnType<typeof createMockMemory>;
let loop: DarwinLoop;

function failingExperiment() {
  return makeExperiment({
    agentName: 'researcher',
    promptVersion: 'v2',
    success: false,
    metrics: { qualityScore: 2, sourceCount: 0, outputLength: 5000, errorCount: 3, durationMs: 1000 },
  });
}

beforeEach(() => {
  memory = createMockMemory();
  const tracker = new ExperimentTracker(memory);
  loop = new DarwinLoop({
    memory,
    tracker,
    optimizer: new PromptOptimizer(async () => 'improved prompt text'),
    safety: new SafetyGate(),
    patterns: new PatternDetector(memory),
  });
});

describe('rollback after a promoted winner degrades', () => {
  it('walks to the parent version when active === lastKnownGood', async () => {
    // Post-promotion state: v2 won its A/B test — active AND last-known-good.
    await memory.savePromptVersion(makePromptVersion({
      version: 'v1', agentName: 'researcher', active: false, parentVersion: null,
    }));
    await memory.savePromptVersion(makePromptVersion({
      version: 'v2', agentName: 'researcher', active: true, parentVersion: 'v1',
      changeReason: 'won A/B',
    }));
    await memory.updateState((s) => {
      s.activeVersions['researcher'] = 'v2';
      s.lastKnownGood['researcher'] = 'v2';
      s.consecutiveFailures['researcher'] = 2; // next failure crosses the threshold
      return s;
    });

    const result = await loop.afterRun(failingExperiment());

    assert.equal(result.rolledBack, true, 'the failure burst must trigger a rollback');
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v1');
    assert.equal(state.lastKnownGood['researcher'], 'v1', 'last-known-good walks along');
    assert.equal(state.consecutiveFailures['researcher'], 0);
    const v1 = (await memory.getAllPromptVersions('researcher')).find((v) => v.version === 'v1');
    assert.equal(v1?.active, true, 'parent version is re-activated');
  });

  it('does not roll back below the lineage floor (v1 without a parent)', async () => {
    await memory.savePromptVersion(makePromptVersion({
      version: 'v1', agentName: 'researcher', active: true, parentVersion: null,
    }));
    await memory.updateState((s) => {
      s.activeVersions['researcher'] = 'v1';
      s.lastKnownGood['researcher'] = 'v1';
      s.consecutiveFailures['researcher'] = 2;
      return s;
    });

    const result = await loop.afterRun(makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      success: false,
      metrics: { qualityScore: 2, sourceCount: 0, outputLength: 5000, errorCount: 3, durationMs: 1000 },
    }));

    assert.equal(result.rolledBack, false, 'v1 has no parent — nothing to walk to');
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v1');
  });

  it('still prefers lastKnownGood when it differs from the active version', async () => {
    // Divergent state without an open test (e.g. manual state surgery):
    // active v2, last-known-good v1 — classic stage-1 rollback to v1.
    await memory.savePromptVersion(makePromptVersion({
      version: 'v1', agentName: 'researcher', active: false, parentVersion: null,
    }));
    await memory.savePromptVersion(makePromptVersion({
      version: 'v2', agentName: 'researcher', active: true, parentVersion: 'v1',
    }));
    await memory.updateState((s) => {
      s.activeVersions['researcher'] = 'v2';
      s.lastKnownGood['researcher'] = 'v1';
      s.consecutiveFailures['researcher'] = 2;
      return s;
    });

    const result = await loop.afterRun(failingExperiment());

    assert.equal(result.rolledBack, true);
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v1');
    assert.equal(state.lastKnownGood['researcher'], 'v1');
  });

  it('never walks the lineage while an A/B test is open (failing challenger must not sink the incumbent)', async () => {
    // R3 review P0: incumbent v2 is active AND last-known-good while v2-vs-v3
    // tests; the failure counter is version-agnostic, so a failing CHALLENGER
    // burst must NOT roll the healthy incumbent back to v1.
    await memory.savePromptVersion(makePromptVersion({
      version: 'v1', agentName: 'researcher', active: false, parentVersion: null,
    }));
    await memory.savePromptVersion(makePromptVersion({
      version: 'v2', agentName: 'researcher', active: true, parentVersion: 'v1',
    }));
    await memory.savePromptVersion(makePromptVersion({
      version: 'v3', agentName: 'researcher', active: false, parentVersion: 'v2',
    }));
    await memory.updateState((s) => {
      s.activeVersions['researcher'] = 'v2';
      s.lastKnownGood['researcher'] = 'v2';
      s.consecutiveFailures['researcher'] = 2;
      s.abTests['researcher'] = {
        versionA: 'v2', versionB: 'v3', runsA: 4, runsB: 1,
        failsA: 0, failsB: 2, minRuns: 10,
        startedAt: new Date().toISOString(),
      };
      return s;
    });

    const result = await loop.afterRun(makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v3',
      success: false,
      metrics: { qualityScore: 2, sourceCount: 0, outputLength: 5000, errorCount: 3, durationMs: 1000 },
    }));

    assert.equal(result.rolledBack, false, 'no lineage walk during an open test');
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v2', 'incumbent stays active');
    assert.ok(state.abTests['researcher'], 'the test survives');
  });

  it('never rolls back on stage 1 either while a test is open (divergent lastKnownGood)', async () => {
    // R4 review P0: with an open test AND active !== lastKnownGood (state
    // surgery / legacy state), stage 1 used to fire mid-test and destroy it.
    await memory.savePromptVersion(makePromptVersion({
      version: 'v1', agentName: 'researcher', active: false, parentVersion: null,
    }));
    await memory.savePromptVersion(makePromptVersion({
      version: 'v2', agentName: 'researcher', active: true, parentVersion: 'v1',
    }));
    await memory.updateState((s) => {
      s.activeVersions['researcher'] = 'v2';
      s.lastKnownGood['researcher'] = 'v1'; // divergent
      s.consecutiveFailures['researcher'] = 2;
      s.abTests['researcher'] = {
        versionA: 'v2', versionB: 'v3', runsA: 3, runsB: 2,
        failsA: 0, failsB: 0, minRuns: 10,
        startedAt: new Date().toISOString(),
      };
      return s;
    });

    const result = await loop.afterRun(failingExperiment());

    assert.equal(result.rolledBack, false, 'the open test owns the decision');
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v2');
    assert.ok(state.abTests['researcher'], 'the test survives');
  });

  it('aborts the commit when a test appears between guard-check and transition (TOCTOU)', async () => {
    // R5 review P0: the open-test guard reads a snapshot; a concurrent
    // process can start a test during the awaited version lookup. The
    // re-check inside the atomic updateState must let that test survive.
    await memory.savePromptVersion(makePromptVersion({
      version: 'v1', agentName: 'researcher', active: false, parentVersion: null,
    }));
    await memory.savePromptVersion(makePromptVersion({
      version: 'v2', agentName: 'researcher', active: true, parentVersion: 'v1',
    }));
    await memory.updateState((s) => {
      s.activeVersions['researcher'] = 'v2';
      s.lastKnownGood['researcher'] = 'v2';
      s.consecutiveFailures['researcher'] = 2;
      return s;
    });

    // Simulate the race: the moment rollback() loads the version lineage,
    // a "concurrent process" starts a fresh A/B test.
    const originalGetAll = memory.getAllPromptVersions.bind(memory);
    let injected = false;
    memory.getAllPromptVersions = async (agentName: string) => {
      const versions = await originalGetAll(agentName);
      if (!injected) {
        injected = true;
        await memory.updateState((s) => {
          s.abTests['researcher'] = {
            versionA: 'v2', versionB: 'v3', runsA: 0, runsB: 0,
            failsA: 0, failsB: 0, minRuns: 10,
            startedAt: new Date().toISOString(),
          };
          return s;
        });
      }
      return versions;
    };

    const result = await loop.afterRun(failingExperiment());

    assert.equal(result.rolledBack, false, 'transition must abort — the new test wins');
    const state = await memory.getState();
    assert.ok(state.abTests['researcher'], 'the concurrently-started test survives');
    assert.equal(state.activeVersions['researcher'], 'v2', 'incumbent untouched');
  });

  it('resets the failure streak when a test closes (loser fails must not sink the winner)', async () => {
    // R5 review P0: a counter filled by the losing arm survived the test and
    // teed up a lineage rollback against the confirmed winner. Exercised via
    // the timeout path — the same reset runs on every closing path.
    await memory.savePromptVersion(makePromptVersion({
      version: 'v1', agentName: 'researcher', active: false, parentVersion: null,
    }));
    await memory.savePromptVersion(makePromptVersion({
      version: 'v2', agentName: 'researcher', active: true, parentVersion: 'v1',
    }));
    await memory.updateState((s) => {
      s.activeVersions['researcher'] = 'v2';
      s.lastKnownGood['researcher'] = 'v2';
      s.consecutiveFailures['researcher'] = 2; // filled by the challenger era
      s.abTests['researcher'] = {
        versionA: 'v2', versionB: 'v3', runsA: 1, runsB: 1,
        failsA: 0, failsB: 0, minRuns: 30,
        startedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        maxTestDays: 7, // already expired
      };
      return s;
    });

    // A successful complete run trips the expiry check and closes the test.
    const result = await loop.afterRun(makeExperiment({
      agentName: 'researcher', promptVersion: 'v2', success: true,
    }));

    assert.equal(result.abTestCompleted, true, 'expired test closes');
    const state = await memory.getState();
    assert.equal(state.abTests['researcher'], null);
    assert.equal(
      state.consecutiveFailures['researcher'], 0,
      'the closed test takes its failure era with it',
    );
  });

  it('does not activate a phantom lastKnownGood label (falls back to the lineage)', async () => {
    // R3 review P1: lastKnownGood points at a label with no stored prompt.
    // Activating it would deactivate every real version and persist the
    // phantom — the rollback must walk the current version's lineage instead.
    await memory.savePromptVersion(makePromptVersion({
      version: 'v1', agentName: 'researcher', active: false, parentVersion: null,
    }));
    await memory.savePromptVersion(makePromptVersion({
      version: 'v2', agentName: 'researcher', active: true, parentVersion: 'v1',
    }));
    await memory.updateState((s) => {
      s.activeVersions['researcher'] = 'v2';
      s.lastKnownGood['researcher'] = 'v9'; // stale/foreign — never stored
      s.consecutiveFailures['researcher'] = 2;
      return s;
    });

    const result = await loop.afterRun(failingExperiment());

    assert.equal(result.rolledBack, true, 'lineage fallback still rolls back');
    const state = await memory.getState();
    assert.equal(state.activeVersions['researcher'], 'v1', 'walked to the real parent, not v9');
    assert.equal(state.lastKnownGood['researcher'], 'v1');
    const versions = await memory.getAllPromptVersions('researcher');
    assert.equal(versions.find((v) => v.version === 'v1')?.active, true);
  });
});
