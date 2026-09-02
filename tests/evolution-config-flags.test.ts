/**
 * Tests for the advanced evolution-config CLI flags + persistence (item 6a).
 *
 * `darwin evolve <agent>` / `darwin run …` can now toggle the v0.6/v0.7
 * evolution knobs (useGepa / useMerge / paretoGate / useCoverage /
 * reflectionModel). This suite covers the flag parser, the override resolution
 * (static config < persisted override < CLI override), and that overrides
 * survive a fresh SQLite state load.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseEvolutionConfigFlags,
  hasAnyEvolutionFlag,
  applyEvolutionFlag,
  isEvolutionConfigFlag,
} from '../src/cli/evolution-flags.js';
import {
  OVERRIDE_KEYS,
  resolveEvolutionConfig,
  setEvolutionConfigOverrides,
} from '../src/evolution/enabled-state.js';
import { SqliteMemoryProvider } from '../src/memory/sqlite-memory.js';
import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';
import type { AgentDefinition, DarwinConfig, DarwinState } from '../src/types.js';

const baseAgent: AgentDefinition = {
  name: 'researcher',
  role: 'Researcher',
  description: 'r',
  systemPrompt: 'You research.',
  evolution: { enabled: true, evaluator: 'critic', minRuns: 7 },
};

function emptyState(overrides: Partial<DarwinState> = {}): DarwinState {
  return {
    activeVersions: {},
    abTests: {},
    lastKnownGood: {},
    consecutiveFailures: {},
    experimentCounts: {},
    evolutionEnabled: {},
    evolutionConfigOverrides: {},
    ...overrides,
  };
}

// ─── flag parser ────────────────────────────────────

describe('parseEvolutionConfigFlags', () => {
  it('parses boolean flags and leaves the rest untouched', () => {
    const { override, rest } = parseEvolutionConfigFlags(['--gepa', 'researcher', '--coverage', '--no-merge']);
    assert.equal(override.useGepa, true);
    assert.equal(override.useCoverage, true);
    assert.equal(override.useMerge, false);
    assert.deepEqual(rest, ['researcher']);
  });

  it('parses --reflection-model with its value', () => {
    const { override, rest } = parseEvolutionConfigFlags(['--reflection-model', 'claude-opus-4-8', '--pareto-gate']);
    assert.equal(override.reflectionModel, 'claude-opus-4-8');
    assert.equal(override.paretoGate, true);
    assert.deepEqual(rest, []);
  });

  it('returns an empty override when no evolution flags are present', () => {
    const { override, rest } = parseEvolutionConfigFlags(['researcher', '--enable']);
    assert.equal(hasAnyEvolutionFlag(override), false);
    assert.deepEqual(rest, ['researcher', '--enable']);
  });

  it('isEvolutionConfigFlag recognises the flag set', () => {
    assert.equal(isEvolutionConfigFlag('--gepa'), true);
    assert.equal(isEvolutionConfigFlag('--no-coverage'), true);
    assert.equal(isEvolutionConfigFlag('--reflection-model'), true);
    assert.equal(isEvolutionConfigFlag('--enable'), false);
  });

  it('applyEvolutionFlag reports tokens consumed', () => {
    const target = {};
    assert.equal(applyEvolutionFlag('--gepa', undefined, target), 0);
    assert.equal(applyEvolutionFlag('--reflection-model', 'm', target), 1);
    assert.equal(applyEvolutionFlag('--reflection-model', undefined, target), 0); // no value → nothing consumed
  });
});

// ─── resolveEvolutionConfig ─────────────────────────

describe('resolveEvolutionConfig', () => {
  it('returns the static config untouched when no override exists', () => {
    const evo = resolveEvolutionConfig(baseAgent, emptyState());
    assert.equal(evo?.enabled, true);
    assert.equal(evo?.minRuns, 7);
    assert.equal(evo?.useGepa, undefined);
  });

  it('merges persisted overrides over the static config', () => {
    const state = emptyState({ evolutionConfigOverrides: { researcher: { useGepa: true, useCoverage: true } } });
    const evo = resolveEvolutionConfig(baseAgent, state);
    assert.equal(evo?.useGepa, true);
    assert.equal(evo?.useCoverage, true);
    // Untouched static fields survive.
    assert.equal(evo?.enabled, true);
    assert.equal(evo?.evaluator, 'critic');
  });

  it('lets a CLI override win over a persisted override', () => {
    const state = emptyState({ evolutionConfigOverrides: { researcher: { useGepa: true } } });
    const evo = resolveEvolutionConfig(baseAgent, state, { useGepa: false, reflectionModel: 'claude-opus-4-8' });
    assert.equal(evo?.useGepa, false); // CLI beats persisted
    assert.equal(evo?.reflectionModel, 'claude-opus-4-8');
  });

  it('never clobbers a static default with an undefined override value', () => {
    const agentWithGepa: AgentDefinition = { ...baseAgent, evolution: { enabled: true, useGepa: true } };
    // Override only sets coverage; useGepa must stay true.
    const evo = resolveEvolutionConfig(agentWithGepa, emptyState(), { useCoverage: true });
    assert.equal(evo?.useGepa, true);
    assert.equal(evo?.useCoverage, true);
  });

  it('returns undefined for an agent with no evolution block and no override', () => {
    const plain: AgentDefinition = { name: 'plain', role: 'p', description: 'p', systemPrompt: 'x' };
    assert.equal(resolveEvolutionConfig(plain, emptyState()), undefined);
  });
});

// ─── persistence across a fresh SQLite load ─────────

describe('setEvolutionConfigOverrides — persists across a fresh state load', () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'darwin-evo-config-test-'));
  });
  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeProvider(): SqliteMemoryProvider {
    const cfg: DarwinConfig = { provider: 'claude-cli', memory: 'sqlite', dataDir: tempDir };
    return new SqliteMemoryProvider(cfg);
  }

  it('records flags and merges later partial updates (survives reopen)', async () => {
    const writer = makeProvider();
    await writer.init();
    await setEvolutionConfigOverrides(writer, 'researcher', { useGepa: true, reflectionModel: 'claude-opus-4-8' });
    // A second call must MERGE, not replace.
    await setEvolutionConfigOverrides(writer, 'researcher', { useCoverage: true });
    await writer.close();

    const reader = makeProvider();
    await reader.init();
    const state = await reader.getState();
    const ov = state.evolutionConfigOverrides?.researcher;
    assert.equal(ov?.useGepa, true);
    assert.equal(ov?.reflectionModel, 'claude-opus-4-8');
    assert.equal(ov?.useCoverage, true);

    // And it resolves onto the agent config.
    const evo = resolveEvolutionConfig(baseAgent, state);
    assert.equal(evo?.useGepa, true);
    assert.equal(evo?.useCoverage, true);
    assert.equal(evo?.reflectionModel, 'claude-opus-4-8');
    await reader.close();
  });
});

// ─── v0.17.0: the four-places-by-hand guard ───────────────────────────────
//
// Adding an override flag means touching OVERRIDE_KEYS (persistence),
// isEvolutionConfigFlag (recognition), applyEvolutionFlag (parsing) and
// hasAnyEvolutionFlag (detection). `--require-approval` shipped with the
// fourth missed: it parsed, applied and persisted correctly, yet
// `darwin evolve <agent> --require-approval` skipped its confirmation line and
// then printed `requireApproval=false` right after setting it. Nothing threw.
//
// The CLI spellings are NOT derivable from the key names (useGepa is --gepa,
// skipPerfectFeedback is --skip-perfect, maxMergeInvocations is --max-merge),
// so this maps them explicitly and then asserts the map COVERS every key. A
// new key with no entry fails here, which is the whole point: guessing a
// spelling would let a wrong guess pass as a wiring bug, or worse, pass.

/** key in OVERRIDE_KEYS -> [CLI flag, value token or undefined for booleans] */
const FLAG_FOR_KEY: Record<string, readonly [string, string | undefined]> = {
  useGepa: ['--gepa', undefined],
  useMerge: ['--merge', undefined],
  paretoGate: ['--pareto-gate', undefined],
  useCoverage: ['--coverage', undefined],
  reflectionModel: ['--reflection-model', 'claude-opus-4-8'],
  useDemos: ['--demos', undefined],
  candidateSelection: ['--candidate-selection', 'best'],
  skipPerfectFeedback: ['--skip-perfect', undefined],
  maxMergeInvocations: ['--max-merge', '3'],
  maxTestDays: ['--max-test-days', '7'],
  requireConfidence: ['--require-confidence', undefined],
  confidenceMethod: ['--confidence-method', 'eb'],
  requireApproval: ['--require-approval', undefined],
  approvalTimeoutDays: ['--approval-timeout-days', '5'],
};

describe('every OVERRIDE_KEY is wired through all four places', () => {
  it('has an entry in the flag map (a new key without one fails here)', () => {
    for (const key of OVERRIDE_KEYS) {
      assert.ok(
        FLAG_FOR_KEY[key] !== undefined,
        `override key "${key}" has no CLI flag recorded in this test. Add it, then ` +
          `check it is wired in isEvolutionConfigFlag and applyEvolutionFlag too.`,
      );
    }
    // And no stale entries pointing at keys that no longer exist.
    for (const key of Object.keys(FLAG_FOR_KEY)) {
      assert.ok(
        (OVERRIDE_KEYS as readonly string[]).includes(key),
        `this test maps "${key}", which is no longer an override key`,
      );
    }
  });

  it('isEvolutionConfigFlag recognises every mapped flag', () => {
    for (const key of OVERRIDE_KEYS) {
      const [flag] = FLAG_FOR_KEY[key]!;
      assert.ok(isEvolutionConfigFlag(flag), `isEvolutionConfigFlag missed "${flag}" (${key})`);
    }
  });

  it('applyEvolutionFlag sets each key, and hasAnyEvolutionFlag then sees it', () => {
    for (const key of OVERRIDE_KEYS) {
      const [flag, value] = FLAG_FOR_KEY[key]!;
      const target: Record<string, unknown> = {};
      applyEvolutionFlag(flag, value, target as never);

      assert.notEqual(
        target[key],
        undefined,
        `"${flag}" did not set override key "${key}" (missing case in applyEvolutionFlag?)`,
      );
      assert.equal(
        hasAnyEvolutionFlag(target as never),
        true,
        `hasAnyEvolutionFlag missed override key "${key}"`,
      );
    }
  });

  it('the boolean flags all have a --no- counterpart that sets false', () => {
    for (const key of OVERRIDE_KEYS) {
      const [flag, value] = FLAG_FOR_KEY[key]!;
      if (value !== undefined) continue; // value-takers have no negation
      const negated = flag.replace(/^--/, '--no-');
      assert.ok(isEvolutionConfigFlag(negated), `no negation for "${flag}"`);
      const target: Record<string, unknown> = {};
      applyEvolutionFlag(negated, undefined, target as never);
      assert.equal(target[key], false, `"${negated}" should set ${key} to false`);
    }
  });

  it('hasAnyEvolutionFlag is false for an empty override and for explicit undefined', () => {
    assert.equal(hasAnyEvolutionFlag({}), false);
    assert.equal(hasAnyEvolutionFlag({ useGepa: undefined }), false);
  });
});

// ─── The chain ends at the EFFECT, not at the bookkeeping ─────────────────
//
// The guard above walks four places (OVERRIDE_KEYS, isEvolutionConfigFlag,
// applyEvolutionFlag, hasAnyEvolutionFlag). Round 2 of the adversarial review
// found there are FIVE: resolveEvolutionConfig feeds the agent definition that
// the loop reads, and that last hop was unpinned. A mutation dropping the
// persisted `requireApproval` inside resolveEvolutionConfig left all 821 tests
// green, while in production `darwin evolve writer --require-approval` would
// confirm itself and every later run would go UNGATED, putting challengers on
// live traffic behind a gate the operator believes is armed.
//
// Same shape as round 1's hasAnyEvolutionFlag hole, one level deeper: a guard
// that stops before the value changes BEHAVIOUR proves only bookkeeping.

describe('a persisted override reaches the behaviour it controls', () => {
  const gateAgent: AgentDefinition = {
    ...baseAgent,
    systemPrompt: 'You are a research agent. Never fabricate sources.',
    evolution: { enabled: true },
  };

  /** Build a loop the way the CLI does: static config + persisted overrides. */
  function loopFromState(
    memory: ReturnType<typeof createMockMemory>,
    state: DarwinState,
  ): DarwinLoop {
    const resolved = resolveEvolutionConfig(gateAgent, state);
    const agent: AgentDefinition = resolved ? { ...gateAgent, evolution: resolved } : gateAgent;
    return new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      optimizer: new PromptOptimizer(async () => 'You are a meticulous research agent. Never fabricate sources.'),
      agent,
    });
  }

  function seeded(): ReturnType<typeof createMockMemory> {
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({
        version: 'v1',
        agentName: gateAgent.name,
        active: true,
        promptText: gateAgent.systemPrompt,
      }),
    );
    for (let i = 0; i < 3; i++) {
      memory._experiments.push(
        makeExperiment({
          agentName: gateAgent.name, promptVersion: 'v1', taskType: 'tech', success: true,
          metrics: { qualityScore: 9, sourceCount: 12, outputLength: 6000, errorCount: 0, durationMs: 30000 },
        }),
      );
    }
    return memory;
  }

  it('persisted --require-approval actually HOLDS the challenger on a later run', async () => {
    const memory = seeded();
    // Exactly what `darwin evolve <agent> --require-approval` writes.
    await setEvolutionConfigOverrides(memory, gateAgent.name, { requireApproval: true });

    // A fresh process: static config says nothing about approval, the override
    // has to carry it all the way to the loop's behaviour.
    const state = await memory.getState();
    const result = await loopFromState(memory, state).forceEvolve(gateAgent.name);

    assert.equal(result.abTestStarted, false, 'the persisted gate must hold the challenger');
    assert.equal(result.awaitingApproval, true);
    assert.equal(memory._state.abTests[gateAgent.name] ?? null, null, 'no test may open');
    assert.ok(memory._state.pendingApprovals?.[gateAgent.name], 'a proposal must be recorded');
  });

  it('and without the override the same setup opens the test, so the test is not vacuous', async () => {
    const memory = seeded();
    const state = await memory.getState();
    const result = await loopFromState(memory, state).forceEvolve(gateAgent.name);

    assert.equal(result.abTestStarted, true);
    assert.equal(memory._state.pendingApprovals?.[gateAgent.name] ?? null, null);
  });

  it('persisted --approval-timeout-days reaches the loop as well', async () => {
    const memory = seeded();
    await setEvolutionConfigOverrides(memory, gateAgent.name, {
      requireApproval: true,
      approvalTimeoutDays: 2,
    });
    const state = await memory.getState();
    const loop = loopFromState(memory, state);
    await loop.forceEvolve(gateAgent.name);

    // Backdate past the persisted budget; the snapshot carries it because the
    // proposal was written by a loop that had resolved the override.
    const pending = memory._state.pendingApprovals![gateAgent.name]!;
    assert.equal(pending.approvalTimeoutDays, 2, 'the resolved budget is snapshotted');
    pending.proposedAt = new Date(Date.now() - 3 * 86400_000).toISOString();

    await loop.forceEvolve(gateAgent.name);
    assert.equal(
      memory._state.pendingApprovals![gateAgent.name],
      null,
      'the persisted timeout must actually expire the proposal',
    );
  });
});
