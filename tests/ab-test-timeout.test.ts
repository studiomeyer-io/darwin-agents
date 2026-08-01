/**
 * v0.13.0 — wall-clock budget for A/B tests (`evolution.maxTestDays`).
 *
 * `minRuns` is a SAMPLE budget with no notion of throughput.
 * `computeDynamicMinRuns` correctly raises it to the 30-run ceiling when scores
 * cluster tightly — but an agent that runs twice a week cannot pay 30 runs per
 * arm inside a year, and it cannot evolve at all while its test is open. This
 * budget closes such a test WITHOUT promoting the challenger: inconclusive
 * evidence must never activate anything, since measured judge variance (±1 on a
 * 10-point scale) dwarfs the real evolution lift (~+0.1–0.2).
 *
 * Unset (the default) must behave exactly as before — the "stays open" cases
 * below pin that.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';
import { resolveEvolutionConfig } from '../src/evolution/enabled-state.js';
import { parseEvolutionConfigFlags, hasAnyEvolutionFlag } from '../src/cli/evolution-flags.js';
import type { AgentDefinition, DarwinMetrics, DarwinState } from '../src/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function metrics(partial: Partial<DarwinMetrics> = {}): DarwinMetrics {
  return {
    qualityScore: 7,
    sourceCount: 10,
    outputLength: 6000,
    errorCount: 0,
    durationMs: 30000,
    ...partial,
  };
}

/**
 * An A/B test that is genuinely mid-flight: both arms are well below `minRuns`,
 * so `evaluateABTest` returns 'continue' and only the wall-clock budget can
 * close it. `ageDays` controls how long ago it started.
 */
async function runMidFlightTest(opts: { ageDays: number; maxTestDays?: number; startedAt?: string }) {
  const memory = createMockMemory();
  memory._versions.push(
    makePromptVersion({ version: 'v1', active: true, promptText: 'incumbent' }),
    makePromptVersion({ version: 'v2', active: false, promptText: 'challenger' }),
  );

  const startedAt = opts.startedAt ?? new Date(Date.now() - opts.ageDays * DAY_MS).toISOString();
  memory._state.abTests['researcher'] = {
    versionA: 'v1',
    versionB: 'v2',
    runsA: 1,
    runsB: 1,
    failsA: 0,
    failsB: 0,
    minRuns: 30, // far out of reach — the point of the scenario
    startedAt,
  };
  memory._state.activeVersions['researcher'] = 'v1';
  memory._state.lastKnownGood['researcher'] = 'v1';

  // A couple of scored runs per arm so composite lookups have data.
  for (const version of ['v1', 'v2']) {
    const e = makeExperiment({
      agentName: 'researcher',
      promptVersion: version,
      taskType: 'tech',
      success: true,
      metrics: metrics(),
    });
    e.feedback = { score: 7, report: `${version} run`, evaluator: 'multi-critic' };
    memory._experiments.push(e);
  }

  const agent: AgentDefinition = {
    name: 'researcher',
    role: 'Researcher',
    description: 'test agent',
    type: 'llm',
    systemPrompt: 'You are a research agent. Never fabricate sources.',
    model: 'claude-sonnet-4-6',
    evolution: { enabled: true, minRuns: 30, maxTestDays: opts.maxTestDays },
  };

  const loop = new DarwinLoop({
    memory,
    tracker: new ExperimentTracker(memory),
    optimizer: new PromptOptimizer(async () => 'unused'),
    safety: new SafetyGate(),
    patterns: new PatternDetector(memory),
    agent,
  });

  const result = await loop.afterRun(
    makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v2',
      taskType: 'tech',
      success: true,
      metrics: metrics(),
      feedback: { score: 7, report: 'trigger', evaluator: 'multi-critic' },
    }),
  );

  return { memory, result, state: await memory.getState() };
}

describe('A/B wall-clock budget (maxTestDays)', () => {
  it('leaves a mid-flight test running when no budget is configured', async () => {
    const { result, state } = await runMidFlightTest({ ageDays: 400 });

    assert.equal(result.abTestCompleted, false, 'default must never time a test out');
    assert.ok(state.abTests['researcher'], 'test should still be open');
    assert.equal(state.activeVersions['researcher'], 'v1');
  });

  it('leaves a test running while it is still inside its budget', async () => {
    const { result, state } = await runMidFlightTest({ ageDays: 3, maxTestDays: 30 });

    assert.equal(result.abTestCompleted, false);
    assert.ok(state.abTests['researcher'], 'test should still be open');
  });

  it('closes an over-budget test and keeps the incumbent', async () => {
    const { result, state } = await runMidFlightTest({ ageDays: 31, maxTestDays: 30 });

    assert.equal(result.abTestCompleted, true, 'over-budget test should close');
    assert.equal(result.newVersion, 'v1', 'the incumbent keeps the slot');
    assert.equal(result.promptEvolved, false, 'a timeout is not an evolution');
    assert.equal(state.abTests['researcher'], null, 'slot must be freed for a later challenger');
    assert.ok(/timed out/i.test(result.message), `expected a timeout message: ${result.message}`);
  });

  it('never promotes the challenger on a timeout', async () => {
    // The whole point: a test that ran out of clock produced NO evidence that
    // the challenger is better, so it must not be activated.
    const { memory, state } = await runMidFlightTest({ ageDays: 90, maxTestDays: 14 });

    assert.equal(state.activeVersions['researcher'], 'v1');
    const active = memory._versions.filter((v) => v.active).map((v) => v.version);
    assert.deepEqual(active, ['v1'], 'only the incumbent may be active after a timeout');
    // A timeout is not evidence about which version is good, so the
    // last-known-good marker must be left exactly as it was.
    assert.equal(state.lastKnownGood['researcher'], 'v1');
  });

  it('does not expire on an unparsable startedAt', async () => {
    const { result, state } = await runMidFlightTest({
      ageDays: 0,
      maxTestDays: 1,
      startedAt: 'not-a-date',
    });

    assert.equal(result.abTestCompleted, false, 'an unreadable clock must not abandon a test');
    assert.ok(state.abTests['researcher']);
  });

  it('treats a non-positive budget as "no budget"', async () => {
    for (const maxTestDays of [0, -5]) {
      const { result } = await runMidFlightTest({ ageDays: 400, maxTestDays });
      assert.equal(result.abTestCompleted, false, `maxTestDays=${maxTestDays} must not expire tests`);
    }
  });
});

describe('maxTestDays config plumbing', () => {
  it('is overridable and persists through resolveEvolutionConfig', async () => {
    // The documented OVERRIDE_KEYS trap: a new EvolutionConfig field that is
    // not in the allowlist is persisted but never applied.
    const agent: AgentDefinition = {
      name: 'researcher',
      role: 'Researcher',
      description: 'test agent',
      type: 'llm',
      systemPrompt: 'prompt',
      model: 'claude-sonnet-4-6',
      evolution: { enabled: true },
    };
    const state = {
      evolutionConfigOverrides: { researcher: { maxTestDays: 21 } },
    } as unknown as Pick<DarwinState, 'evolutionConfigOverrides'>;

    assert.equal(resolveEvolutionConfig(agent, state)?.maxTestDays, 21);
    // CLI layer must win over the persisted one.
    assert.equal(resolveEvolutionConfig(agent, state, { maxTestDays: 7 })?.maxTestDays, 7);
  });

  it('parses --max-test-days and rejects the Number() coercion footguns', async () => {
    assert.equal(parseEvolutionConfigFlags(['--max-test-days', '30']).override.maxTestDays, 30);

    for (const bad of ['', '-3', '2.5', 'abc', '1e3']) {
      const { override } = parseEvolutionConfigFlags(['--max-test-days', bad]);
      assert.equal(override.maxTestDays, undefined, `"${bad}" must not set a budget`);
    }

    // A following flag is a missing value, not this flag's argument — the
    // action flag behind it must survive.
    const { override, rest } = parseEvolutionConfigFlags(['--max-test-days', '--force']);
    assert.equal(override.maxTestDays, undefined);
    assert.deepEqual(rest, ['--force'], '--force must not be eaten as the value');

    // Single-dash flags too: the CLI defines `-v` (verbose). The old guard
    // only recognised `--…` and swallowed `-v` as an invalid value, silently
    // disabling verbose mode (round-2 review finding, both value flags).
    for (const flag of ['--max-test-days', '--max-merge']) {
      const r = parseEvolutionConfigFlags([flag, '-v']);
      assert.deepEqual(r.rest, ['-v'], `${flag} must not eat a following -v`);
      assert.equal(r.override.maxTestDays, undefined);
      assert.equal(r.override.maxMergeInvocations, undefined);
    }

    assert.equal(hasAnyEvolutionFlag({ maxTestDays: 30 }), true);
    assert.equal(hasAnyEvolutionFlag({}), false);
  });

  it('accepts 0 as the off switch so a persisted budget can be removed', async () => {
    // Overrides are merged and never deleted, and `--reset` does not touch
    // them. Without an in-band "no budget" value, `--max-test-days 30` would be
    // irreversible short of hand-editing the state blob. Mirrors `--max-merge 0`.
    const { override } = parseEvolutionConfigFlags(['--max-test-days', '0']);
    assert.equal(override.maxTestDays, 0, '0 must be accepted, not rejected as "not positive"');
    assert.equal(hasAnyEvolutionFlag(override), true, '0 must still count as an explicit override');

    // And it must actually disarm the budget downstream.
    const { result } = await runMidFlightTest({ ageDays: 400, maxTestDays: 0 });
    assert.equal(result.abTestCompleted, false, 'maxTestDays=0 must behave as "no budget"');
  });
});

describe('maxTestDays is snapshotted onto the test at start (v0.13.1)', () => {
  // Third-model-review finding (Codex R1 F5): expiry used to read the
  // CURRENT invocation's config, so a test started via a one-off CLI
  // `--max-test-days 7` silently lost its budget on the next plain run.
  // A deadline is a property of the test — snapshot it at start.

  async function startTestWithBudget(maxTestDays: number | undefined) {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', active: true, promptText: 'incumbent' }));
    for (let i = 0; i < 20; i++) {
      const e = makeExperiment({
        agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
        metrics: metrics({ qualityScore: 4.0 }),
      });
      e.feedback = { score: 4.0, report: `weak ${i}`, evaluator: 'multi-critic' };
      memory._experiments.push(e);
    }
    const loop = new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      optimizer: new PromptOptimizer(async () => 'challenger text'),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      agent: {
        name: 'researcher', role: 'Researcher', description: 'test agent', type: 'llm',
        systemPrompt: 'prompt', model: 'claude-sonnet-4-6',
        evolution: { enabled: true, minRuns: 5, maxTestDays },
      },
    });
    await loop.afterRun(makeExperiment({
      agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
      metrics: metrics({ qualityScore: 4.0 }),
      feedback: { score: 4.0, report: 'trigger', evaluator: 'multi-critic' },
    }));
    return memory;
  }

  it('writes the budget onto the started test, and omits it when unset', async () => {
    const withBudget = await startTestWithBudget(7);
    assert.equal(withBudget._state.abTests['researcher']?.maxTestDays, 7);

    const without = await startTestWithBudget(undefined);
    assert.ok(without._state.abTests['researcher'], 'test should have started');
    assert.equal(without._state.abTests['researcher']?.maxTestDays, undefined);
  });

  it('a later invocation WITHOUT the budget flag still expires the test', async () => {
    const memory = await startTestWithBudget(7);
    // Age the snapshotted test beyond its budget.
    memory._state.abTests['researcher']!.startedAt = new Date(Date.now() - 8 * DAY_MS).toISOString();

    // The "next plain invocation": a loop whose agent config has NO budget.
    const plainLoop = new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      optimizer: new PromptOptimizer(async () => 'unused'),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      agent: {
        name: 'researcher', role: 'Researcher', description: 'test agent', type: 'llm',
        systemPrompt: 'prompt', model: 'claude-sonnet-4-6',
        evolution: { enabled: true, minRuns: 5 },
      },
    });

    const result = await plainLoop.afterRun(makeExperiment({
      agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
      metrics: metrics(),
      feedback: { score: 7, report: 'later run', evaluator: 'multi-critic' },
    }));

    assert.equal(result.abTestCompleted, true, 'snapshot must survive the flag being absent');
    assert.equal((await memory.getState()).abTests['researcher'], null);
    assert.equal((await memory.getState()).activeVersions['researcher'], 'v1');
  });
});

describe('forceEvolve against an expired-but-open test', () => {
  it('still refuses, and leaves the test untouched', async () => {
    // `forceEvolve` reads the A/B test to decide whether to refuse. Since the
    // refusal text became conditional on `isTestExpired`, this path now reads
    // `startedAt` on a state the old code never inspected — and nothing else
    // in the suite exercises it. Pinning it here matters less for the wording
    // than for the boundary: the obvious next change (auto-closing the expired
    // test from inside forceEvolve) would alter exactly these assertions and
    // needs its own review of notify / lastKnownGood / ordering.
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({ version: 'v1', active: true, promptText: 'incumbent' }),
      makePromptVersion({ version: 'v2', active: false, promptText: 'challenger' }),
    );
    const startedAt = new Date(Date.now() - 90 * DAY_MS).toISOString();
    memory._state.abTests['researcher'] = {
      versionA: 'v1',
      versionB: 'v2',
      runsA: 2,
      runsB: 1,
      failsA: 0,
      failsB: 0,
      minRuns: 30,
      startedAt,
    };
    memory._state.activeVersions['researcher'] = 'v1';

    const e = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      taskType: 'tech',
      success: true,
      metrics: metrics(),
    });
    e.feedback = { score: 7, report: 'run', evaluator: 'multi-critic' };
    memory._experiments.push(e);

    const loop = new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      optimizer: new PromptOptimizer(async () => 'unused'),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      agent: {
        name: 'researcher',
        role: 'Researcher',
        description: 'test agent',
        type: 'llm',
        systemPrompt: 'prompt',
        model: 'claude-sonnet-4-6',
        evolution: { enabled: true, minRuns: 30, maxTestDays: 14 },
      },
    });

    const result = await loop.forceEvolve('researcher');

    assert.equal(result.promptEvolved, false, 'forceEvolve must still refuse');
    assert.equal(result.abTestStarted, false);
    assert.equal(result.newVersion, undefined);

    // The refusal must be inert: forcing does NOT get to close the test as a
    // side effect, and must not touch the version rows.
    const state = await memory.getState();
    assert.ok(state.abTests['researcher'], 'the open test must survive a refused force');
    assert.equal(state.activeVersions['researcher'], 'v1');
    assert.equal(memory._versions.length, 2, 'no challenger may be created');

    // And the message has to tell the operator what actually unblocks it,
    // including the cost of --reset (it also reverts activeVersions to v1).
    assert.ok(/budget/i.test(result.message), `expected the budget to be named: ${result.message}`);
    assert.ok(/v1/.test(result.message), `expected the --reset caveat: ${result.message}`);
  });
});

describe('maxTestDays applies on the incomplete-run path', () => {
  it('closes an over-budget test even when every run is too short to score', async () => {
    // An agent producing short outputs returns at Step 0 and never reaches the
    // normal A/B handling — so without an expiry check there, its test would
    // stay open past the budget forever. That is exactly the low-throughput
    // agent the budget exists for.
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({ version: 'v1', active: true, promptText: 'incumbent' }),
      makePromptVersion({ version: 'v2', active: false, promptText: 'challenger' }),
    );
    memory._state.abTests['researcher'] = {
      versionA: 'v1',
      versionB: 'v2',
      runsA: 1,
      runsB: 1,
      failsA: 0,
      failsB: 0,
      minRuns: 30,
      startedAt: new Date(Date.now() - 90 * DAY_MS).toISOString(),
    };
    memory._state.activeVersions['researcher'] = 'v1';
    memory._state.lastKnownGood['researcher'] = 'v1';

    const agent: AgentDefinition = {
      name: 'researcher',
      role: 'Researcher',
      description: 'test agent',
      type: 'llm',
      systemPrompt: 'prompt',
      model: 'claude-sonnet-4-6',
      evolution: { enabled: true, minRuns: 30, maxTestDays: 14 },
    };

    const loop = new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      optimizer: new PromptOptimizer(async () => 'unused'),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      agent,
    });

    // 10 chars — far under the 2000-char default, so isIncompleteRun() fires.
    const result = await loop.afterRun(
      makeExperiment({
        agentName: 'researcher',
        promptVersion: 'v2',
        taskType: 'tech',
        success: true,
        metrics: metrics({ outputLength: 10 }),
      }),
    );

    assert.equal(result.abTestCompleted, true, 'budget must apply on the incomplete-run path too');
    const state = await memory.getState();
    assert.equal(state.abTests['researcher'], null, 'slot must be freed');
    assert.equal(state.activeVersions['researcher'], 'v1', 'challenger must not be promoted');
  });
});
