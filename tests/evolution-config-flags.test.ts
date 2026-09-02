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
