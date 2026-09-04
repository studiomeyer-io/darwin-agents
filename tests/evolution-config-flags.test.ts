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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
import type { DarwinLoop } from '../src/evolution/loop.js';
import { buildResolvedEvolutionLoop } from '../src/evolution/build-loop.js';
import { describeConfig, describeOverride } from '../src/cli/evolve.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { createMockMemory, isolateTestEnv, makeExperiment, makePromptVersion } from './helpers.js';
import type { AgentDefinition, DarwinConfig, DarwinState } from '../src/types.js';

// Round 8: this file builds real loops (buildResolvedEvolutionLoop wires the
// env metrics sink), and it leaked five measured event lines into a developer's
// own metrics file when DARWIN_METRICS_JSONL was exported. Round 6 had fixed
// the same thing in two other files and missed this one, which is the incident
// rather than the class; the guard at the bottom of this file now walks the
// class.
isolateTestEnv();

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
// hasAnyEvolutionFlag (detection). This block covers those four. Two more
// hand-maintained lists sit downstream (describeOverride, describeConfig) and
// have their own block below, and the wiring past all of them is covered by
// "a persisted override reaches the behaviour it controls".
//
// The heading deliberately does not carry a NUMBER any more: round 5 found
// that "all four places" was hand-counted and there were six. The list of
// lists drifts exactly like the lists.
//
// `--require-approval` shipped with the fourth missed: it parsed, applied and persisted correctly, yet
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
  rejectionNoteLimit: ['--rejection-notes', '3'],
};

describe('every OVERRIDE_KEY is wired through the bookkeeping places', () => {
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

  it('no value flag swallows a FOLLOWING FLAG as its value', () => {
    // Round 8: the v0.17 "unrecognised arguments are an error" gate on
    // `darwin evolve` had an open door beside it. A value flag consumes its
    // token in the PARSER, before the gate ever sees argv, so a value flag
    // without a dash guard eats the very action the gate exists to protect.
    // Measured at the live CLI:
    //
    //   darwin evolve writer --candidate-selection --disable
    //     -> exit 0, agent still ENABLED
    //   darwin evolve writer --reflection-model --disable
    //     -> exit 0, "--disable" persisted as the reflection MODEL ID,
    //        agent still ENABLED
    //
    // `--max-merge` and `--max-test-days` got this guard in v0.13.2 and every
    // flag since was written with it; the two oldest value-takers never were.
    // This walks all of them so the next one cannot be missed either.
    for (const key of OVERRIDE_KEYS) {
      const [flag, value] = FLAG_FOR_KEY[key]!;
      if (value === undefined) continue; // booleans take no value
      for (const following of ['--disable', '--enable', '--reset', '--force', '-v']) {
        const target: Record<string, unknown> = {};
        const consumed = applyEvolutionFlag(flag, following, target as never);
        assert.equal(
          consumed,
          0,
          `"${flag}" consumed the following flag "${following}" as its value, ` +
            `which hides that action from the command`,
        );
        assert.equal(
          target[key],
          undefined,
          `"${flag}" stored "${following}" as its value`,
        );
      }
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

  /**
   * Call the SAME function the CLI calls, not a rebuild of it.
   *
   * The first version of this helper spelled the wiring out itself
   * (`resolveEvolutionConfig` then `new DarwinLoop`). Round 3 measured what
   * that proves: with `run.ts` and `evolve.ts` mutated to pass the unresolved
   * agent, all 826 tests stayed green. A guard that rebuilds the path pins the
   * building blocks, not the command. The three commands now share
   * `buildResolvedEvolutionLoop`, so there is one place to be wrong and this
   * exercises it.
   *
   * A stub provider keeps it hermetic: buildEvolutionLoop wires a real provider
   * from config, and nothing here may reach an LLM.
   */
  function loopFromState(
    memory: ReturnType<typeof createMockMemory>,
    state: DarwinState,
  ): DarwinLoop {
    const config: DarwinConfig = {
      provider: 'openai',
      memory: 'custom',
      memoryProvider: memory,
      openaiApiKey: 'test-key-not-used',
    } as DarwinConfig;
    const loop = buildResolvedEvolutionLoop(gateAgent, state, config, memory);
    // Swap in a stub optimizer so no request is ever made. The gate decision
    // happens after generation, so a fixed string is enough.
    (loop as unknown as { optimizer: PromptOptimizer }).optimizer = new PromptOptimizer(
      async () => 'You are a meticulous research agent. Never fabricate sources.',
    );
    return loop;
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

  it('a ONE-OFF cliOverride reaches the loop too (the darwin run --flag lane)', async () => {
    // Round 4: the guard only ever called buildResolvedEvolutionLoop in its
    // four-argument form, so dropping `cliOverride` from the resolve inside it
    // left all 833 tests green while `darwin run writer "task"
    // --require-approval` silently opened the A/B test UNGATED, and every
    // one-off `--gepa` / `--max-test-days` was ignored. The README documents
    // that lane explicitly ("One-off for a single run"), so it needs a guard.
    //
    // The most recently added parameter of a shared function is the likeliest
    // blind spot: this is the third round in a row that the hole sat one step
    // past where the guard stopped.
    const memory = seeded();
    const state = await memory.getState(); // nothing persisted
    const config: DarwinConfig = {
      provider: 'openai',
      memory: 'custom',
      memoryProvider: memory,
      openaiApiKey: 'test-key-not-used',
    } as DarwinConfig;
    const loop = buildResolvedEvolutionLoop(gateAgent, state, config, memory, {
      requireApproval: true,
    });
    (loop as unknown as { optimizer: PromptOptimizer }).optimizer = new PromptOptimizer(
      async () => 'You are a meticulous research agent. Never fabricate sources.',
    );

    const result = await loop.forceEvolve(gateAgent.name);

    assert.equal(result.abTestStarted, false, 'the one-off flag must gate this run');
    assert.equal(result.awaitingApproval, true);
    assert.ok(memory._state.pendingApprovals?.[gateAgent.name]);
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

  it('persisted --rejection-notes 0 reaches the loop and silences the quoting', async () => {
    // Round 2's lesson applied to the v0.18 knob: the bookkeeping guard above
    // proves the flag is parsed and printed, not that it changes anything. The
    // observable is the meta-prompt the optimizer is handed, so the stub
    // records it.
    const memory = seeded();
    await setEvolutionConfigOverrides(memory, gateAgent.name, {
      requireApproval: true,
      rejectionNoteLimit: 0,
    });

    const prompts: string[] = [];
    function loopWithCapture(state: DarwinState): DarwinLoop {
      const loop = loopFromState(memory, state);
      (loop as unknown as { optimizer: PromptOptimizer }).optimizer = new PromptOptimizer(
        async (p: string) => {
          prompts.push(p);
          return 'You are a meticulous research agent. Never fabricate sources.';
        },
      );
      return loop;
    }

    await loopWithCapture(await memory.getState()).forceEvolve(gateAgent.name);
    await loopWithCapture(await memory.getState()).rejectChallenger(
      gateAgent.name,
      'drops the citation rule',
    );
    await loopWithCapture(await memory.getState()).forceEvolve(gateAgent.name);

    assert.equal(prompts.length, 2, 'the optimizer ran twice');
    assert.ok(
      !prompts[1]!.includes('drops the citation rule'),
      'the persisted 0 must silence the quoting',
    );

    // Gegenprobe: without the override, the same sequence DOES quote it, so
    // the assertion above is not vacuous.
    const other = seeded();
    await setEvolutionConfigOverrides(other, gateAgent.name, { requireApproval: true });
    const quoted: string[] = [];
    function otherLoop(state: DarwinState): DarwinLoop {
      const loop = loopFromState(other, state);
      (loop as unknown as { optimizer: PromptOptimizer }).optimizer = new PromptOptimizer(
        async (p: string) => {
          quoted.push(p);
          return 'You are a meticulous research agent. Never fabricate sources.';
        },
      );
      return loop;
    }
    await otherLoop(await other.getState()).forceEvolve(gateAgent.name);
    await otherLoop(await other.getState()).rejectChallenger(
      gateAgent.name,
      'drops the citation rule',
    );
    await otherLoop(await other.getState()).forceEvolve(gateAgent.name);
    assert.ok(
      quoted[1]!.includes('drops the citation rule'),
      'without the override the reason IS quoted',
    );
  });
});

// ─── Every command reaches for the SHARED wiring ──────────────────────────
//
// `darwin run` is pinned behaviourally (tests/cli-run-approval-gate.test.ts
// drives the real command). `darwin evolve --force` and `darwin approve` are
// not, and a behavioural test for each would need its own mock LLM server for
// what is really a one-line question: does the command call the shared
// function, or reach past it?
//
// So this reads the source. A source check is weaker than a behavioural one
// and is used here only because the failure it guards is textual: round 3
// measured that rewiring a command to `buildEvolutionLoop(agent, ...)` leaves
// every other test green while the persisted gate silently stops working.
describe('the CLI commands use buildResolvedEvolutionLoop, never the raw builder', () => {
  const COMMANDS = ['run.ts', 'evolve.ts', 'approve.ts'] as const;

  for (const file of COMMANDS) {
    it(`${file} calls the shared, override-resolving builder`, () => {
      const src = readFileSync(
        join(import.meta.dirname, '..', 'src', 'cli', file),
        'utf8',
      );
      assert.ok(
        /buildResolvedEvolutionLoop\s*\(/.test(src),
        `${file} must build its loop through buildResolvedEvolutionLoop`,
      );
      // The raw builder skips resolveEvolutionConfig, so a command calling it
      // directly ignores every persisted and one-off override, including
      // requireApproval. Import-only mentions are fine; a CALL is not.
      assert.ok(
        !/(?<!Resolved)buildEvolutionLoop\s*\(/.test(src),
        `${file} calls buildEvolutionLoop directly, which drops persisted overrides ` +
          `(a gated agent would silently run ungated)`,
      );
    });
  }

  it('and the shared builder is the only thing outside build-loop.ts that calls the raw one', () => {
    // If a fourth command appears, it lands here rather than in production.
    const cliDir = join(import.meta.dirname, '..', 'src', 'cli');
    const offenders = readdirSync(cliDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /(?<!Resolved)buildEvolutionLoop\s*\(/.test(readFileSync(join(cliDir, f), 'utf8')));
    assert.deepEqual(offenders, [], `these CLI files call the raw builder: ${offenders.join(', ')}`);
  });
});

// ─── The confirmation lines are lists too, and lists drift ────────────────
//
// Round 5 counted them: the guard above says "all four places" and there are
// six. `describeOverride` (what `darwin evolve --flag` prints back) and
// `describeConfig` (what `darwin evolve <agent>` shows) are hand-maintained
// key lists of exactly the shape round 1 found in `hasAnyEvolutionFlag`, and
// they had already drifted once: `--require-confidence` and
// `--confidence-method` were persistable from v0.14 and appeared in neither
// summary for three releases, so setting one confirmed itself with "(none)".
//
// A wrong confirmation is not cosmetic here. `--require-approval` printing
// `requireApproval=false` right after being set is what sent round 1 looking.

describe('both confirmation summaries bind every OVERRIDE_KEY to its own label', () => {
  /**
   * The LABEL each key is printed under, and a value it accepts.
   *
   * Round 6: the first version of this guard asserted only
   * `line.includes(String(value))`. That catches an OMISSION (one key set per
   * pass, so every other boolean slot reads false), which was the round-1
   * failure. It does NOT catch the two failure forms that come next: a
   * rename, and a swap. Both measured green against the value-only check:
   * cross-wiring describeConfig so `gepa` reads useMerge and `merge` reads
   * useGepa left 26/26 passing, while `darwin evolve writer --gepa` then
   * reported "gepa=false, merge=true". A confirmation under the wrong name is
   * exactly the round-1 trigger ("requireApproval=false right after being
   * set"), so the binding is what has to be asserted.
   */
  const LABEL: Record<string, string> = {
    useGepa: 'gepa',
    useMerge: 'merge',
    paretoGate: 'paretoGate',
    useCoverage: 'coverage',
    reflectionModel: 'reflectionModel',
    useDemos: 'demos',
    candidateSelection: 'candidateSelection',
    skipPerfectFeedback: 'skipPerfect',
    maxMergeInvocations: 'maxMerge',
    maxTestDays: 'maxTestDays',
    requireConfidence: 'requireConfidence',
    confidenceMethod: 'confidenceMethod',
    requireApproval: 'requireApproval',
    approvalTimeoutDays: 'approvalTimeoutDays',
    rejectionNoteLimit: 'rejectionNotes',
  };

  /** A value each key accepts, in override shape. */
  const SAMPLE: Record<string, unknown> = {
    useGepa: true,
    useMerge: true,
    paretoGate: true,
    useCoverage: true,
    reflectionModel: 'claude-opus-4-8',
    useDemos: true,
    candidateSelection: 'best',
    skipPerfectFeedback: true,
    maxMergeInvocations: 3,
    maxTestDays: 7,
    requireConfidence: true,
    confidenceMethod: 'eb',
    requireApproval: true,
    approvalTimeoutDays: 5,
    rejectionNoteLimit: 3,
  };

  it('every key has a label and a sample recorded here', () => {
    // A new key without an entry fails HERE, not silently in the loops below.
    for (const key of OVERRIDE_KEYS) {
      assert.notEqual(LABEL[key], undefined, `no printed label recorded for "${key}"`);
      assert.notEqual(SAMPLE[key], undefined, `no sample value recorded for "${key}"`);
    }
  });

  it('describeOverride prints each key under ITS OWN label', () => {
    for (const key of OVERRIDE_KEYS) {
      const line = describeOverride({ [key]: SAMPLE[key] } as never);
      assert.ok(
        line.includes(`${LABEL[key]}=${SAMPLE[key]}`),
        `describeOverride did not report "${LABEL[key]}=${SAMPLE[key]}" for "${key}": got "${line}"`,
      );
      assert.notEqual(line, '(none)', `describeOverride reported "(none)" after "${key}" was set`);
    }
  });

  it('describeConfig prints each key under ITS OWN label once resolved', () => {
    for (const key of OVERRIDE_KEYS) {
      const resolved = resolveEvolutionConfig(
        baseAgent,
        { evolutionConfigOverrides: { [baseAgent.name]: { [key]: SAMPLE[key] } as never } },
      );
      assert.ok(resolved, `resolveEvolutionConfig returned nothing for "${key}"`);
      const line = describeConfig(resolved);
      assert.ok(
        line.includes(`${LABEL[key]}=${SAMPLE[key]}`),
        `describeConfig did not report "${LABEL[key]}=${SAMPLE[key]}" for "${key}": got "${line}"`,
      );
    }
  });

  it('the boolean labels are not interchangeable: a swap must be caught', () => {
    // The explicit statement of what the binding check buys over presence.
    // With only one key set per pass, a cross-wired describeConfig prints the
    // right VALUES in the wrong SLOTS, and every value is still "present".
    const onlyGepa = resolveEvolutionConfig(
      baseAgent,
      { evolutionConfigOverrides: { [baseAgent.name]: { useGepa: true } } },
    );
    const line = describeConfig(onlyGepa!);
    assert.ok(line.includes('gepa=true'), line);
    assert.ok(line.includes('merge=false'), `merge must NOT have picked up the gepa value: ${line}`);
  });
});

// ─── Every surface that LISTS the flags, not just the one that broke ──────
//
// Round 6 found the usage docblock in cli/evolve.ts missing the v0.14 knobs
// and guarded that file. Round 7 then found the `darwin --help` text missing
// the v0.11 and v0.13 ones: a complementary hole in a surface the guard did
// not reach, and the MORE visible of the two, because --help is how anyone
// actually discovers a flag.
//
// The lesson is about guard scope, not about either file: a guard written
// against the file where a drift was found documents the incident. The class
// is "human-readable list of the persistable flags", and this walks all of
// them. A seventh surface added later fails here only if someone adds it to
// this list, which is the honest limit of a source guard and is stated rather
// than pretended away.
describe('every surface that lists the flags lists all of them', () => {
  /**
   * Cut a section out of a file by its start and end anchors.
   *
   * Round 8: the first version used `indexOf` without checking the result, and
   * the HELP surface's end anchor (`export async function`) does not exist in
   * cli/index.ts at all. `indexOf` returned -1, so the slice silently ran to
   * end-of-file: the guard was measuring a different surface than it claimed,
   * and a stray flag mention anywhere later in the file would have hidden a
   * real gap. A missing anchor now fails loudly.
   *
   * The same round found the README slice running past its own section into
   * "Known Limitations", where both v0.14 flags happen to be mentioned in
   * prose. The table was missing them and the guard was green. Slice ends are
   * narrow now, and the README check demands a TABLE ROW rather than a
   * mention anywhere in the section.
   */
  function section(raw: string, from: string, to: string | null, what: string): string {
    const start = raw.indexOf(from);
    assert.notEqual(start, -1, `${what}: start anchor "${from}" no longer exists`);
    if (to === null) return raw.slice(start);
    const end = raw.indexOf(to, start + from.length);
    assert.notEqual(end, -1, `${what}: end anchor "${to}" no longer exists`);
    return raw.slice(start, end);
  }

  interface Surface {
    what: string;
    file: string[];
    slice: (raw: string, what: string) => string;
    /** How a flag must appear: anywhere in the slice, or as a table row. */
    shape?: (text: string, flag: string) => boolean;
  }

  const SURFACES: ReadonlyArray<Surface> = [
    {
      what: 'the usage docblock of `darwin evolve`',
      file: ['src', 'cli', 'evolve.ts'],
      slice: (raw, what) => section(raw, '/**', '*/', what),
    },
    {
      what: 'the `darwin --help` text',
      file: ['src', 'cli', 'index.ts'],
      // The HELP template literal only, ending at its own closing backtick.
      slice: (raw, what) => section(raw, 'const HELP = `', '\n`;', what),
    },
    {
      what: 'the flag table in the README',
      file: ['README.md'],
      // Ends at the next section, so a mention two headings away cannot count.
      slice: (raw, what) => section(raw, '### Advanced evolution flags', '\n## ', what),
      // And it has to be a ROW, not a passing mention in the bash example
      // above the table: removing the --reflection-model row used to leave
      // this green because the example still used the flag.
      //
      // A row opens with "| `--flag", and what follows is either the closing
      // backtick (booleans) or a space before the value placeholder
      // (`| \`--max-merge <n>\``). Matching the bare backtick form alone
      // missed all six value-taking flags, which is how this check first
      // reported six false gaps.
      shape: (text, flag) =>
        text.includes(`| \`${flag}\``) || text.includes(`| \`${flag} `),
    },
  ];

  for (const surface of SURFACES) {
    it(`${surface.what} mentions every OVERRIDE_KEY`, () => {
      const raw = readFileSync(join(import.meta.dirname, '..', ...surface.file), 'utf8');
      const text = surface.slice(raw, surface.what);
      assert.ok(text.length > 0, `the slice for ${surface.what} came back empty`);
      const has = surface.shape ?? ((t: string, f: string) => t.includes(f));
      const missing = OVERRIDE_KEYS.filter((key) => !has(text, FLAG_FOR_KEY[key]![0]));
      assert.deepEqual(
        missing,
        [],
        `${surface.what} does not list: ${missing.map((k) => FLAG_FOR_KEY[k]![0]).join(', ')}`,
      );
    });
  }
});

// ─── Every file that can build a loop isolates its environment ────────────
//
// `buildEvolutionLoop` wires a real JSONL metrics sink from
// DARWIN_METRICS_JSONL, and the notification config from the Telegram
// variables. A test file that runs a loop without clearing those writes real
// events into whatever the developer had exported, with every test green.
//
// Round 6 fixed two files, round 8 measured a third still leaking five lines.
// Fixing the incident twice is what this guard exists to stop: it walks the
// CLASS, so a new file that builds a loop and forgets `isolateTestEnv()` fails
// here instead of in someone's metrics file.
describe('test files that build a loop clear the environment first', () => {
  // Anything that can reach buildEvolutionLoop, directly or through a command.
  const BUILDS_A_LOOP = /buildResolvedEvolutionLoop\s*\(|buildEvolutionLoop\s*\(|runCommand\s*\(|evolveCommand\s*\(|approveCommand\s*\(/;

  it('calls isolateTestEnv(), or does not build a loop at all', () => {
    const dir = join(import.meta.dirname);
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .filter((f) => {
        const src = readFileSync(join(dir, f), 'utf8');
        if (!BUILDS_A_LOOP.test(src)) return false;
        // metrics-sink.test.ts sets the variable ON PURPOSE: it is the test
        // for the sink. It does not build a loop, so it never reaches here,
        // and if it ever does it should say so rather than be exempted here.
        return !src.includes('isolateTestEnv(');
      });
    assert.deepEqual(
      offenders,
      [],
      `these files build a loop without isolateTestEnv(): ${offenders.join(', ')}`,
    );
  });
});

// ─── No value flag anywhere in the CLI swallows a following flag ──────────
//
// This class was found and closed three times in this release, one parser
// further along each time: `darwin approve` (round 2), `darwin evolve`'s two
// oldest value flags (round 8), and `darwin run`'s five (round 9). Each fix
// guarded the module where the incident happened, so the next round found the
// same shape next door. Measured cost of the last one:
//
//     darwin run writer --task-type --no-evolve "Do X"
//       -> taskType = "--no-evolve", noEvolve = FALSE, the run evolves anyway
//
// So this guards the PATTERN across the whole directory. It is a source check,
// which is weaker than a behavioural one, and it is used here because the
// defect is textual: an unguarded `args[++i]` or `args[i + 1]`. Every parser
// that takes a value has to prove it looked at the token first.
//
// TWO LIMITS, both measured rather than guessed, so nobody mistakes this for
// the load-bearing layer:
//
//   1. The `args[i + 1]` arm is FILE-granular. Adding a new value flag with an
//      unguarded `args[i + 1]` to run.ts passes, because `startsWith('-')`
//      already appears elsewhere in that file. A per-site check would need a
//      real parser.
//   2. A string literal containing `//` blinds the line-comment stripper for
//      the rest of that line, including real code after it.
//
// The load-bearing layer is the behavioural tests: one per flag, per following
// action. This is a tripwire for a NEW file or a NEW parser, and it is worth
// having for that alone, but a green run here proves less than a green run
// there.
describe('every value-taking flag in src/cli guards against a following flag', () => {
  /**
   * Strip comments before scanning.
   *
   * The first version of this guard read them, and its first run flagged the
   * comment that DOCUMENTS the fix, because that comment quotes the old
   * `args[++i]`. A source guard that reads prose can be fed by prose: exactly
   * the bypass shape an earlier round pointed at, arriving from the friendly
   * direction. Strings are left alone; no flag parser hides its consumption
   * inside a string literal, and stripping those too would need a real parser.
   */
  function code(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');
  }

  it('has no unguarded args[++i] or args[i + 1] consumption', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'cli');
    const offenders: string[] = [];

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = code(readFileSync(join(dir, file), 'utf8'));
      // `args[++i]` consumes without ever looking at what it took.
      for (const m of src.matchAll(/\[\+\+\s*\w+\]/g)) {
        offenders.push(`${file}: "${m[0]}" consumes a token without inspecting it`);
      }
      // `args[i + 1]` is fine, but only where a startsWith('-') check exists
      // in the same file. Coarse on purpose: a file that reads the next token
      // anywhere and never tests for a dash is the shape being hunted.
      if (/\[\s*\w+\s*\+\s*1\s*\]/.test(src) && !/startsWith\('-'\)/.test(src)) {
        offenders.push(`${file}: reads the next token but never checks it for a leading dash`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `unguarded value consumption:\n  ${offenders.join('\n  ')}`,
    );
  });
});
