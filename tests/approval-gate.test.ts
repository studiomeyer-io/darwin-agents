/**
 * Tests for the v0.17.0 human approval gate
 * (`evolution.requireApproval` / `darwin approve <agent>`).
 *
 * The README listed this under Known Limitations up to v0.16: "Prompt
 * mutations go directly to A/B testing. Telegram notifications inform you, but
 * there's no approval gate before testing starts."
 *
 * What these tests pin, in order of how much a regression would cost:
 *
 *  1. With the gate ON, no A/B test opens. This is the whole feature; if it
 *     leaks, a challenger reaches real traffic without a human.
 *  2. With the gate OFF, byte-for-byte the old behaviour. The feature is
 *     opt-in and must be invisible otherwise.
 *  3. A pending proposal BLOCKS a second challenger, on both entry points
 *     (`afterRun` and `forceEvolve`). Without this the next qualifying run
 *     overwrites the very thing a human was asked to look at.
 *  4. Approving opens EXACTLY the proposed test, with the snapshotted
 *     parameters, not recomputed ones.
 *  5. A moved incumbent refuses without `--force`. Approving against a
 *     different baseline answers a different question than the one approved.
 *  6. A timeout auto-REJECTS and never auto-approves.
 *
 * A STUB optimizer is injected everywhere, so nothing here calls an LLM.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';
import type {
  ABTest,
  AgentDefinition,
  DarwinExperiment,
  PendingApproval,
} from '../src/types.js';
import type { DarwinMetricEvent, MetricsSink } from '../src/metrics/sink.js';

const SAFE_PROMPT = 'You are a research agent. Never fabricate sources. Cite primary documents.';
const CHALLENGER = 'You are a meticulous research agent. Never fabricate sources. Cite and cross-check primary documents.';

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

/** Collects every emitted metric so the tests can assert on the event stream. */
function makeSink(): MetricsSink & { events: DarwinMetricEvent[] } {
  const events: DarwinMetricEvent[] = [];
  return { events, emit(e) { events.push(e); } };
}

function buildLoop(opts: {
  memory: ReturnType<typeof createMockMemory>;
  agent: AgentDefinition;
  optimizerOutput?: string;
  metrics?: MetricsSink;
}): DarwinLoop {
  return new DarwinLoop({
    memory: opts.memory,
    tracker: new ExperimentTracker(opts.memory),
    safety: new SafetyGate(),
    patterns: new PatternDetector(opts.memory),
    optimizer: new PromptOptimizer(async () => opts.optimizerOutput ?? CHALLENGER),
    agent: opts.agent,
    metrics: opts.metrics,
  });
}

function seedExperiments(memory: ReturnType<typeof createMockMemory>, count: number): void {
  for (let i = 0; i < count; i++) {
    const exp: DarwinExperiment = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      taskType: 'tech',
      success: true,
      metrics: { qualityScore: 9, sourceCount: 12, outputLength: 6000, errorCount: 0, durationMs: 30000 },
    });
    memory._experiments.push(exp);
  }
}

/** A memory + loop with one active v1 and enough history to force-evolve from. */
function scenario(evolution: AgentDefinition['evolution'], metrics?: MetricsSink) {
  const memory = createMockMemory();
  memory._versions.push(
    makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
  );
  seedExperiments(memory, 3);
  const loop = buildLoop({ memory, agent: makeAgent(evolution), metrics });
  return { memory, loop };
}

/**
 * Assert that NOTHING was activated except `expected`.
 *
 * Round 1 of the adversarial review caught the previous version of this check:
 * it read `activeVersions['researcher'] ?? 'v1'` and the scenario never sets
 * `activeVersions`, so the `??` made the assertion vacuous. Adding an
 * `activateVersion(challenger)` call inside `expireApproval` left the whole
 * suite green, meaning "the timeout never auto-approves" was pinned by nothing.
 *
 * There are TWO sources of truth for "active" in this codebase and a test for a
 * safety property has to read both: `activeVersions` is what run.ts routes on,
 * the `active` flag on the version rows is what `getActivePrompt` returns. A
 * flag-only activation is the more dangerous one, because the activated
 * challenger silently becomes the parent of every later mutation.
 */
function assertNothingActivated(
  memory: ReturnType<typeof createMockMemory>,
  expected: string,
): void {
  // run.ts routes on `activeVersions[agent] ?? 'v1'`, so the default is part of
  // the contract, not a way to skip the check.
  assert.equal(
    memory._state.activeVersions['researcher'] ?? 'v1',
    expected,
    'routing must still serve the incumbent',
  );
  const flagged = memory._versions.filter((v) => v.agentName === 'researcher' && v.active);
  assert.deepEqual(
    flagged.map((v) => v.version),
    [expected],
    `exactly ${expected} may carry the active flag, found: ${flagged.map((v) => v.version).join(', ') || '(none)'}`,
  );
}

describe('v0.17 approval gate: the gate itself', () => {
  it('holds the challenger and opens NO A/B test when requireApproval is on', async () => {
    const sink = makeSink();
    const { memory, loop } = scenario({ enabled: true, requireApproval: true }, sink);

    const result = await loop.forceEvolve('researcher');

    assert.equal(result.promptEvolved, true, 'the challenger was still generated');
    assert.equal(result.abTestStarted, false, 'NO test may open behind the gate');
    assert.equal(result.awaitingApproval, true);
    assert.equal(result.newVersion, 'v2');
    assertNothingActivated(memory, 'v1');

    // The challenger is persisted and readable: a proposal nobody can read is
    // a proposal nobody can judge.
    const v2 = memory._versions.find((v) => v.version === 'v2');
    assert.ok(v2, 'v2 must exist so it can be diffed');
    assert.equal(v2!.promptText, CHALLENGER);
    assert.equal(v2!.active, false);

    assert.equal(memory._state.abTests['researcher'] ?? null, null, 'no A/B test');
    const pending = memory._state.pendingApprovals?.['researcher'] as PendingApproval | null;
    assert.ok(pending, 'a proposal must be recorded');
    assert.equal(pending!.versionA, 'v1');
    assert.equal(pending!.versionB, 'v2');
    assert.ok(pending!.minRuns > 0, 'the sample budget is snapshotted');

    const types = sink.events.map((e) => e.type);
    assert.ok(types.includes('approval_requested'));
    assert.ok(!types.includes('ab_test_started'), 'nothing may claim a test started');
  });

  it('is invisible when requireApproval is off (unchanged v0.16 behaviour)', async () => {
    const { memory, loop } = scenario({ enabled: true });

    const result = await loop.forceEvolve('researcher');

    assert.equal(result.abTestStarted, true);
    assert.equal(result.awaitingApproval ?? false, false);
    assert.ok(memory._state.abTests['researcher'], 'the test opens as before');
    assert.equal(memory._state.pendingApprovals?.['researcher'] ?? null, null);
  });

  it('treats an absent evolution block as gate-off, never as gate-on', async () => {
    // Fail-open on the GATE is correct here and fail-closed would be wrong:
    // an agent that never opted in must not silently stop evolving.
    const { memory, loop } = scenario({ enabled: true, requireApproval: undefined });
    const result = await loop.forceEvolve('researcher');
    assert.equal(result.abTestStarted, true);
    assert.equal(memory._state.pendingApprovals?.['researcher'] ?? null, null);
  });
});

describe('v0.17 approval gate: a proposal blocks a second challenger', () => {
  it('forceEvolve refuses while a proposal is pending, and keeps the first one intact', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    const first = memory._state.pendingApprovals!['researcher'] as PendingApproval;

    const second = await loop.forceEvolve('researcher');

    assert.equal(second.promptEvolved, false, 'no second challenger');
    assert.equal(second.awaitingApproval, true);
    assert.ok(second.message.includes('awaiting approval'), second.message);
    assert.equal(
      memory._versions.filter((v) => v.version === 'v3').length,
      0,
      'v3 must not exist: the first proposal was not overwritten',
    );
    assert.deepEqual(memory._state.pendingApprovals!['researcher'], first);
  });

  it('afterRun refuses while a proposal is pending', async () => {
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
    );
    memory._state.pendingApprovals = {
      researcher: {
        versionA: 'v1',
        versionB: 'v2',
        minRuns: 5,
        proposedAt: new Date().toISOString(),
        changeReason: 'test',
        generatedBy: 'legacy',
      },
    };
    // Weak runs, so the automatic loop WOULD want to evolve if unblocked.
    for (let i = 0; i < 12; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
          metrics: { qualityScore: 3, sourceCount: 11, outputLength: 6000, errorCount: 0, durationMs: 30000 },
        }),
      );
    }
    const sink = makeSink();
    const loop = buildLoop({ memory, agent: makeAgent({ enabled: true, requireApproval: true }), metrics: sink });

    const result = await loop.afterRun(
      makeExperiment({
        agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
        metrics: { qualityScore: 3, sourceCount: 11, outputLength: 6000, errorCount: 0, durationMs: 30000 },
      }),
    );

    assert.equal(result.awaitingApproval, true);
    assert.equal(result.promptEvolved, false);
    assert.equal(result.abTestStarted, false);
    assert.equal(memory._versions.filter((v) => v.version === 'v3').length, 0);
    assert.ok(
      sink.events.some((e) => e.type === 'evolution_skipped' && e.data.reason === 'awaiting_approval'),
    );
  });
});

describe('v0.17 approval gate: approving', () => {
  it('opens exactly the proposed test with the SNAPSHOTTED parameters', async () => {
    const sink = makeSink();
    const { memory, loop } = scenario(
      { enabled: true, requireApproval: true, maxTestDays: 7 },
      sink,
    );
    await loop.forceEvolve('researcher');
    const proposed = memory._state.pendingApprovals!['researcher'] as PendingApproval;

    // Move the ground under the loop: MORE experiments would change what
    // computeDynamicMinRuns returns. The approved test must keep the number
    // the human was shown, not a fresh one.
    seedExperiments(memory, 40);

    const res = await loop.approveChallenger('researcher');

    assert.equal(res.approved, true, res.message);
    const test = memory._state.abTests['researcher'] as ABTest;
    assert.ok(test, 'the A/B test must now exist');
    assert.equal(test.versionA, 'v1');
    assert.equal(test.versionB, 'v2');
    assert.equal(test.minRuns, proposed.minRuns, 'minRuns comes from the proposal, not from fresh data');
    assert.equal(test.maxTestDays, 7, 'the A/B budget rides along');
    assert.equal(test.runsA, 0);
    assert.equal(test.runsB, 0);
    assert.equal(memory._state.pendingApprovals!['researcher'], null, 'the slot is freed');

    const types = sink.events.map((e) => e.type);
    assert.ok(types.includes('approval_granted'));
    assert.ok(types.includes('ab_test_started'));
  });

  it('starts the A/B clock at approval time, not at proposal time', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true, maxTestDays: 7 });
    await loop.forceEvolve('researcher');
    // Backdate the proposal by three days.
    const pending = memory._state.pendingApprovals!['researcher'] as PendingApproval;
    pending.proposedAt = new Date(Date.now() - 3 * 86400_000).toISOString();

    await loop.approveChallenger('researcher');

    const test = memory._state.abTests['researcher'] as ABTest;
    const started = Date.parse(test.startedAt);
    assert.ok(
      Date.now() - started < 60_000,
      'time spent waiting for a human is not time spent collecting data',
    );
  });

  it('refuses when the incumbent moved, and says what to do instead', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');

    // Simulate a rollback / manual activation: v3 is now the active prompt.
    memory._versions.push(
      makePromptVersion({ version: 'v3', agentName: 'researcher', active: false, promptText: SAFE_PROMPT }),
    );
    for (const v of memory._versions) v.active = v.version === 'v3';
    memory._state.activeVersions['researcher'] = 'v3';

    const res = await loop.approveChallenger('researcher');

    assert.equal(res.approved, false);
    assert.ok(res.message.includes('v3'), res.message);
    assert.ok(res.message.includes('--force'), 'the escape hatch must be named');
    assert.equal(memory._state.abTests['researcher'] ?? null, null, 'nothing was started');
    assert.ok(memory._state.pendingApprovals!['researcher'], 'the proposal survives the refusal');
  });

  it('--force approves against the LIVE incumbent, not the stale one', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    memory._versions.push(
      makePromptVersion({ version: 'v3', agentName: 'researcher', active: false, promptText: SAFE_PROMPT }),
    );
    for (const v of memory._versions) v.active = v.version === 'v3';
    memory._state.activeVersions['researcher'] = 'v3';

    const res = await loop.approveChallenger('researcher', { force: true });

    assert.equal(res.approved, true, res.message);
    const test = memory._state.abTests['researcher'] as ABTest;
    assert.equal(test.versionA, 'v3', 'forcing tests against what is actually live');
    assert.equal(test.versionB, 'v2');
  });

  it('refuses when there is nothing pending, and when a test is already open', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });

    const none = await loop.approveChallenger('researcher');
    assert.equal(none.approved, false);
    assert.ok(none.message.includes('No challenger'), none.message);

    await loop.forceEvolve('researcher');
    memory._state.abTests['researcher'] = {
      versionA: 'v1', versionB: 'v9', runsA: 0, runsB: 0, failsA: 0, failsB: 0,
      minRuns: 5, startedAt: new Date().toISOString(),
    };

    const clash = await loop.approveChallenger('researcher');
    assert.equal(clash.approved, false);
    assert.ok(clash.message.includes('already open'), clash.message);
    assert.equal(
      (memory._state.abTests['researcher'] as ABTest).versionB,
      'v9',
      'the running test must not be clobbered',
    );
    assert.ok(memory._state.pendingApprovals!['researcher'], 'the proposal must survive too');
  });
});

describe('v0.17 approval gate: rejecting', () => {
  it('frees the slot, keeps the rejected version in history, and lets the next cycle propose again', async () => {
    const sink = makeSink();
    const { memory, loop } = scenario({ enabled: true, requireApproval: true }, sink);
    await loop.forceEvolve('researcher');

    const res = await loop.rejectChallenger('researcher', 'leaks the system prompt');

    assert.equal(res.rejected, true);
    assert.ok(res.message.includes('leaks the system prompt'), res.message);
    assertNothingActivated(memory, 'v1');
    assert.equal(memory._state.pendingApprovals!['researcher'], null);
    assert.equal(memory._state.abTests['researcher'] ?? null, null, 'rejecting never starts a test');
    assert.ok(
      memory._versions.find((v) => v.version === 'v2'),
      'the rejected prompt stays on the record',
    );

    // The next challenger must NOT reuse the rejected label (v0.13.0).
    const next = await loop.forceEvolve('researcher');
    assert.equal(next.newVersion, 'v3', `expected v3, got ${next.newVersion}`);

    const rejectEvent = sink.events.find((e) => e.type === 'approval_rejected');
    assert.ok(rejectEvent);
    assert.equal(rejectEvent!.data.expired, false);
  });

  it('refuses when there is nothing pending', async () => {
    const { loop } = scenario({ enabled: true, requireApproval: true });
    const res = await loop.rejectChallenger('researcher');
    assert.equal(res.rejected, false);
  });
});

describe('v0.17 approval gate: the timeout auto-rejects, never auto-approves', () => {
  it('expires a stale proposal on the next forced cycle and keeps the incumbent', async () => {
    const { memory, loop } = scenario({
      enabled: true, requireApproval: true, approvalTimeoutDays: 3,
    });
    await loop.forceEvolve('researcher');
    const pending = memory._state.pendingApprovals!['researcher'] as PendingApproval;
    pending.proposedAt = new Date(Date.now() - 4 * 86400_000).toISOString();

    const res = await loop.forceEvolve('researcher');

    assert.equal(memory._state.pendingApprovals!['researcher'], null, 'the slot is freed');
    assert.equal(
      memory._state.abTests['researcher'] ?? null,
      null,
      'a timeout must NEVER start the test it failed to get approved',
    );
    assert.ok(res.message.includes('rejected'), res.message);
    assertNothingActivated(memory, 'v1');
  });

  it('expires through afterRun too, not only through forceEvolve', async () => {
    // Round 1 found that the whole timeout suite ran through forceEvolve, so
    // the expiry branch in afterRun Step 3b could be mutated to `if (false)`
    // and every test stayed green. afterRun is the path a cron-driven fleet
    // uses exclusively: approvalTimeoutDays could have died there silently.
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
    );
    memory._state.pendingApprovals = {
      researcher: {
        versionA: 'v1',
        versionB: 'v2',
        minRuns: 5,
        proposedAt: new Date(Date.now() - 9 * 86400_000).toISOString(),
        approvalTimeoutDays: 3,
        changeReason: 'test',
        generatedBy: 'legacy',
      },
    };
    for (let i = 0; i < 12; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
          metrics: { qualityScore: 3, sourceCount: 11, outputLength: 6000, errorCount: 0, durationMs: 30000 },
        }),
      );
    }
    const sink = makeSink();
    const loop = buildLoop({
      memory,
      agent: makeAgent({ enabled: true, requireApproval: true, approvalTimeoutDays: 3 }),
      metrics: sink,
    });

    const result = await loop.afterRun(
      makeExperiment({
        agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
        metrics: { qualityScore: 3, sourceCount: 11, outputLength: 6000, errorCount: 0, durationMs: 30000 },
      }),
    );

    assert.equal(memory._state.pendingApprovals!['researcher'], null, 'the slot must be freed');
    assert.equal(
      memory._state.abTests['researcher'] ?? null,
      null,
      'a timeout must never start the test it failed to get approved',
    );
    assertNothingActivated(memory, 'v1');
    assert.ok(result.message.includes('expired'), result.message);
    assert.ok(
      sink.events.some((e) => e.type === 'evolution_skipped' && e.data.reason === 'approval_expired'),
    );
    assert.ok(
      sink.events.some((e) => e.type === 'approval_rejected' && e.data.expired === true),
      'the auto-rejection must be visible to a metrics sink',
    );
  });

  it('never expires without a configured budget, however old the proposal is', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    const pending = memory._state.pendingApprovals!['researcher'] as PendingApproval;
    pending.proposedAt = new Date(Date.now() - 900 * 86400_000).toISOString();

    const res = await loop.forceEvolve('researcher');

    assert.equal(res.awaitingApproval, true, 'no budget means it waits, not that it dies');
    assert.ok(memory._state.pendingApprovals!['researcher'], 'still pending after 900 days');
  });

  it('never expires on an unparsable proposedAt', async () => {
    const { memory, loop } = scenario({
      enabled: true, requireApproval: true, approvalTimeoutDays: 1,
    });
    await loop.forceEvolve('researcher');
    (memory._state.pendingApprovals!['researcher'] as PendingApproval).proposedAt = 'not-a-date';

    const res = await loop.forceEvolve('researcher');

    assert.equal(res.awaitingApproval, true, 'a clock we cannot read is no reason to discard work');
    assert.ok(memory._state.pendingApprovals!['researcher']);
  });

  it('reads the SNAPSHOT budget, so a one-off CLI value does not evaporate', async () => {
    // Proposal carries 2 days; the agent config carries none. The snapshot has
    // to win, exactly as ABTest.maxTestDays does since v0.13.1.
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    const pending = memory._state.pendingApprovals!['researcher'] as PendingApproval;
    pending.approvalTimeoutDays = 2;
    pending.proposedAt = new Date(Date.now() - 3 * 86400_000).toISOString();

    await loop.forceEvolve('researcher');

    assert.equal(memory._state.pendingApprovals!['researcher'], null, 'the snapshot budget applied');
  });
});

/**
 * Replace the proposal EXACTLY ONCE, in the window between the caller's
 * `getState()` and its `updateState()` callback.
 *
 * That window is the whole point: both real providers run the callback under a
 * write lock, so the callback's read is live, while the `getState()` before it
 * is not. Another process rejecting this proposal and the next cycle proposing
 * a fresh one both land there. Swapping the state before the call instead
 * would test nothing, because then the caller reads the NEW proposal as its
 * own and every check trivially matches.
 */
function raceInAfterRead(
  memory: ReturnType<typeof createMockMemory>,
  replacement: PendingApproval | null,
): void {
  const original = memory.updateState.bind(memory);
  let fired = false;
  memory.updateState = async (fn) => {
    if (!fired) {
      fired = true;
      memory._state.pendingApprovals!['researcher'] = replacement;
    }
    return original(fn);
  };
}

describe('v0.17 approval gate: the writers pin proposal IDENTITY, not just presence', () => {
  it('approving refuses when a DIFFERENT proposal replaced the one it read', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');

    // Another process rejected v2; the next cycle proposed v7. Presence alone
    // would accept this, because pendingApprovals[researcher] is non-null again.
    const swapped: PendingApproval = {
      versionA: 'v1',
      versionB: 'v7',
      minRuns: 5,
      proposedAt: new Date(Date.now() + 1000).toISOString(),
      changeReason: 'a different challenger nobody has looked at',
      generatedBy: 'legacy',
    };
    raceInAfterRead(memory, swapped);

    const res = await loop.approveChallenger('researcher');

    assert.equal(res.approved, false, 'must not approve a proposal it never read');
    assert.equal(memory._state.abTests['researcher'] ?? null, null, 'no test started');
    assert.deepEqual(
      memory._state.pendingApprovals!['researcher'],
      swapped,
      'the newer proposal must survive untouched',
    );
  });

  it('approving refuses when the proposal disappeared in that window', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    raceInAfterRead(memory, null);

    const res = await loop.approveChallenger('researcher');

    assert.equal(res.approved, false);
    assert.equal(memory._state.abTests['researcher'] ?? null, null);
  });

  it('rejecting refuses when a DIFFERENT proposal replaced the one it read', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    const swapped: PendingApproval = {
      versionA: 'v1',
      versionB: 'v7',
      minRuns: 5,
      proposedAt: new Date(Date.now() + 1000).toISOString(),
      changeReason: 'a different challenger nobody has looked at',
      generatedBy: 'legacy',
    };
    raceInAfterRead(memory, swapped);

    const res = await loop.rejectChallenger('researcher');

    assert.equal(res.rejected, false, 'must not discard a proposal it never read');
    assert.deepEqual(memory._state.pendingApprovals!['researcher'], swapped);
  });

  it('the timeout does not expire a proposal that appeared in that window', async () => {
    // expireApproval carries the same guard as the other two writers; without
    // it, a stale expiry decision would delete a proposal made seconds ago
    // that nobody has seen, and the message would announce the wrong version.
    const { memory, loop } = scenario({
      enabled: true, requireApproval: true, approvalTimeoutDays: 3,
    });
    await loop.forceEvolve('researcher');
    const stale = memory._state.pendingApprovals!['researcher'] as PendingApproval;
    stale.proposedAt = new Date(Date.now() - 4 * 86400_000).toISOString();

    const fresh: PendingApproval = {
      versionA: 'v1',
      versionB: 'v9',
      minRuns: 5,
      proposedAt: new Date().toISOString(),
      changeReason: 'proposed while the expiry was being decided',
      generatedBy: 'legacy',
    };
    raceInAfterRead(memory, fresh);

    await loop.forceEvolve('researcher');

    assert.deepEqual(
      memory._state.pendingApprovals!['researcher'],
      fresh,
      'the fresh proposal must not be swept away by a stale expiry decision',
    );
  });

  it('same versionB but a different proposedAt still counts as a different proposal', async () => {
    // A rejected label is never reused (nextFreeVersion clears the whole
    // history), so this cannot arise on the normal path. Pinned anyway: the
    // guard must not rest on that invariant alone.
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    const live = memory._state.pendingApprovals!['researcher'] as PendingApproval;
    raceInAfterRead(memory, {
      ...live,
      proposedAt: new Date(Date.parse(live.proposedAt) + 5000).toISOString(),
    });

    const res = await loop.approveChallenger('researcher');
    assert.equal(res.approved, false);
    assert.equal(memory._state.abTests['researcher'] ?? null, null);
  });
});

describe('v0.17 approval gate: the slot is claimed under the lock, not before the LLM call', () => {
  /**
   * Plant `mutate` into the state exactly once, in the window between a
   * caller's guard read and its `updateState` callback.
   *
   * For the proposal writer that window contains an LLM call, so it is seconds
   * to minutes wide, not microseconds: two concurrent cycles for the same agent
   * genuinely both pass the guard.
   */
  function raceBeforeWrite(
    memory: ReturnType<typeof createMockMemory>,
    mutate: (s: typeof memory._state) => void,
  ): void {
    const original = memory.updateState.bind(memory);
    let fired = false;
    memory.updateState = async (fn) => {
      if (!fired) {
        fired = true;
        mutate(memory._state);
      }
      return original(fn);
    };
  }

  it('does not overwrite a proposal that landed while the challenger was being generated', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    const other: PendingApproval = {
      versionA: 'v1',
      versionB: 'v5',
      minRuns: 5,
      proposedAt: new Date().toISOString(),
      changeReason: 'the other cycle got there first',
      generatedBy: 'legacy',
    };
    raceBeforeWrite(memory, (s) => {
      s.pendingApprovals = { researcher: other };
    });

    const res = await loop.forceEvolve('researcher');

    assert.equal(res.awaitingApproval ?? false, false);
    assert.equal(res.promptEvolved, false, 'this cycle did not claim the slot');
    assert.ok(res.message.includes('claimed the slot first'), res.message);
    assert.deepEqual(
      memory._state.pendingApprovals!['researcher'],
      other,
      'the proposal that won must be untouched',
    );
    // The generated version stays on the record: it cost a model call, it is
    // inert, and its label is never reused.
    const v2 = memory._versions.find((v) => v.version === 'v2');
    assert.ok(v2, 'the losing challenger is kept, not deleted');
    assert.equal(v2!.active, false);
  });

  it('does not overwrite an A/B test that opened while the challenger was being generated', async () => {
    // Gate OFF here: the same window exists on the ungated path, where an
    // unconditional write would throw away runs the first test had collected.
    const { memory, loop } = scenario({ enabled: true });
    const running = {
      versionA: 'v1', versionB: 'v5', runsA: 3, runsB: 2, failsA: 0, failsB: 0,
      minRuns: 5, startedAt: new Date().toISOString(),
    };
    raceBeforeWrite(memory, (s) => {
      s.abTests['researcher'] = running;
    });

    const res = await loop.forceEvolve('researcher');

    assert.equal(res.abTestStarted, false);
    assert.ok(res.message.includes('claimed the slot first'), res.message);
    assert.deepEqual(
      memory._state.abTests['researcher'],
      running,
      'the running test keeps its collected runs',
    );
  });

  it('approving refuses when the incumbent moved inside the lock window', async () => {
    // The staleness decision reads the incumbent OUTSIDE the transaction. A
    // rollback landing in that window would otherwise open the test against a
    // version that was just rolled away, and arm routing would serve it again.
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    raceBeforeWrite(memory, (s) => {
      s.activeVersions['researcher'] = 'v4';
    });

    const res = await loop.approveChallenger('researcher');

    assert.equal(res.approved, false, res.message);
    assert.equal(memory._state.abTests['researcher'] ?? null, null, 'no test opened');
    assert.ok(memory._state.pendingApprovals!['researcher'], 'the proposal survives');
  });

  it('approving refuses when routing and the active flag disagree', async () => {
    // The state after a pre-v0.17 `--reset`: routing serves v1, the flag still
    // says v3. Opening a test on either answer is wrong, so it refuses.
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    memory._versions.push(
      makePromptVersion({ version: 'v3', agentName: 'researcher', active: false, promptText: SAFE_PROMPT }),
    );
    for (const v of memory._versions) v.active = v.version === 'v3';
    memory._state.activeVersions['researcher'] = 'v1';

    const res = await loop.approveChallenger('researcher');

    assert.equal(res.approved, false);
    assert.ok(res.message.includes('disagrees with itself'), res.message);
    assert.equal(memory._state.abTests['researcher'] ?? null, null);
  });
});
