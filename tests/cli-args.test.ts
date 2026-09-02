/**
 * Tests for CLI argument parsing (v0.14.0) — `darwin run` and `darwin eval`.
 *
 * The CLI was the only zero-coverage layer in the repo, and its parsers are
 * where real regressions have lived (0.13.2: `--max-test-days -v` swallowed
 * the verbose flag). These tests pin the parsing contracts without spawning
 * anything.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseRunArgs, pickRunVersion, resolveRunPrompt, abTestArmsResolvable } from '../src/cli/run.js';
import { parseEvalArgs } from '../src/cli/eval.js';
import type { ABTest, AgentDefinition } from '../src/types.js';

// ─── darwin run ─────────────────────────────────────

describe('parseRunArgs', () => {
  it('splits agent + multi-word task from positionals', () => {
    const flags = parseRunArgs(['writer', 'Explain', 'the', 'CAP', 'theorem']);
    assert.equal(flags.agentName, 'writer');
    assert.equal(flags.task, 'Explain the CAP theorem');
    assert.equal(flags.taskType, 'general');
  });

  it('parses value flags and boolean flags together', () => {
    const flags = parseRunArgs([
      'researcher', 'topic',
      '--task-type', 'tech',
      '--model', 'claude-opus-4-8',
      '--provider', 'openai',
      '--base-url', 'http://localhost:1234',
      '--no-critic', '--no-evolve', '-v',
    ]);
    assert.equal(flags.taskType, 'tech');
    assert.equal(flags.model, 'claude-opus-4-8');
    assert.equal(flags.provider, 'openai');
    assert.equal(flags.baseUrl, 'http://localhost:1234');
    assert.equal(flags.noCritic, true);
    assert.equal(flags.noEvolve, true);
    assert.equal(flags.verbose, true);
  });

  it('keeps -v alive after a value-taking evolution flag (0.13.2 regression)', () => {
    const flags = parseRunArgs(['writer', 'task', '--max-test-days', '-v']);
    assert.equal(flags.verbose, true, '-v must be parsed as verbose, not swallowed');
    assert.equal(flags.evolutionOverride.maxTestDays, undefined);
  });

  it('routes evolution flags into evolutionOverride, not positionals', () => {
    const flags = parseRunArgs([
      'writer', 'do', 'it',
      '--gepa', '--confidence-method', 'msprt', '--require-confidence',
    ]);
    assert.equal(flags.agentName, 'writer');
    assert.equal(flags.task, 'do it');
    assert.equal(flags.evolutionOverride.useGepa, true);
    assert.equal(flags.evolutionOverride.confidenceMethod, 'msprt');
    assert.equal(flags.evolutionOverride.requireConfidence, true);
  });

  it('parses --path without a task (analyst mode)', () => {
    const flags = parseRunArgs(['analyst', '--path', './src']);
    assert.equal(flags.agentName, 'analyst');
    assert.equal(flags.task, '');
    assert.equal(flags.path, './src');
  });
});

// ─── darwin eval ────────────────────────────────────

describe('parseEvalArgs', () => {
  it('parses agent, tasks path, and version list', () => {
    const flags = parseEvalArgs(['writer', '--tasks', 't.json', '--versions', 'v1, v3,,v5']);
    assert.equal(flags.agentName, 'writer');
    assert.equal(flags.tasksPath, 't.json');
    assert.deepEqual(flags.versions, ['v1', 'v3', 'v5']);
    assert.equal(flags.allVersions, false);
  });

  it('parses --all-versions, --json, --dry', () => {
    const flags = parseEvalArgs(['writer', '--tasks', 't.json', '--all-versions', '--json', '--dry']);
    assert.equal(flags.allVersions, true);
    assert.equal(flags.json, true);
    assert.equal(flags.dry, true);
  });

  it('accepts a valid --runs and clamps to ≥ 1 semantics via strict parsing', () => {
    assert.equal(parseEvalArgs(['w', '--tasks', 't', '--runs', '3']).runsPerCell, 3);
  });

  it('falls back to 1 run on a missing, flag-shaped, or non-numeric --runs value', () => {
    assert.equal(parseEvalArgs(['w', '--tasks', 't', '--runs']).runsPerCell, 1);
    assert.equal(parseEvalArgs(['w', '--tasks', 't', '--runs', '--json']).runsPerCell, 1);
    assert.equal(parseEvalArgs(['w', '--tasks', 't', '--runs', '-3']).runsPerCell, 1);
    assert.equal(parseEvalArgs(['w', '--tasks', 't', '--runs', 'many']).runsPerCell, 1);
  });

  it('does not lose a boolean flag that follows an invalid --runs value', () => {
    const flags = parseEvalArgs(['w', '--tasks', 't', '--runs', '--json']);
    assert.equal(flags.json, true, '--json must survive as its own flag');
  });

  it('treats a flag after --tasks / --versions as a missing value, not the value', () => {
    // R3 review: `--tasks --json` must not eat --json as a "file path".
    const a = parseEvalArgs(['w', '--tasks', '--json']);
    assert.equal(a.tasksPath, undefined);
    assert.equal(a.json, true);

    const b = parseEvalArgs(['w', '--tasks', 't', '--versions', '--dry']);
    assert.equal(b.versions, undefined);
    assert.equal(b.dry, true);
  });

  it('rejects an overflow --runs that would coerce to Infinity', () => {
    // R3 review P0: Number('9'.repeat(400)) === Infinity — with swallowed
    // cell errors that loops one cell forever.
    const flags = parseEvalArgs(['w', '--tasks', 't', '--runs', '9'.repeat(400)]);
    assert.equal(flags.runsPerCell, 1);
    const capped = parseEvalArgs(['w', '--tasks', 't', '--runs', '5000']);
    assert.equal(capped.runsPerCell, 1, 'above the 1000 cap → fallback 1');
  });
});

// ─── prompt-version routing (v0.14.0 review fixes) ──

const makeTest = (runsA: number, runsB: number): ABTest => ({
  versionA: 'v3',
  versionB: 'v4',
  runsA,
  runsB,
  failsA: 0,
  failsB: 0,
  minRuns: 10,
  startedAt: new Date().toISOString(),
});

describe('pickRunVersion', () => {
  it('round-robins the arms of an active test when evolution is enabled', () => {
    assert.equal(pickRunVersion(makeTest(0, 0), true, 'v3'), 'v3');
    assert.equal(pickRunVersion(makeTest(3, 2), true, 'v3'), 'v4');
  });

  it('runs the ACTIVE version — not static v1 — when no test is running', () => {
    // The promoted-winner bug: active v3 with no open test must run v3.
    assert.equal(pickRunVersion(null, true, 'v3'), 'v3');
    assert.equal(pickRunVersion(null, true, 'v1'), 'v1');
  });

  it('ignores a running test when evolution is disabled (challenger gets no traffic)', () => {
    // The --disable bug: a disabled agent must stop routing runs through
    // the challenger arm and stay on its active version.
    assert.equal(pickRunVersion(makeTest(0, 5), false, 'v3'), 'v3');
  });
});

// ─── resolveRunPrompt (label follows the prompt that runs) ──

const staticAgent: AgentDefinition = {
  name: 'writer',
  role: 'Writer',
  description: 'test',
  type: 'llm',
  systemPrompt: 'STATIC-V1',
};

describe('resolveRunPrompt', () => {
  it('returns the stored prompt for a stored label', () => {
    const r = resolveRunPrompt(staticAgent, [
      { version: 'v1', promptText: 'STORED-V1' },
      { version: 'v3', promptText: 'STORED-V3' },
    ], 'v3');
    assert.deepEqual(r, { version: 'v3', promptText: 'STORED-V3', missingStored: false });
  });

  it('prefers the SEEDED v1 over the static definition (live and eval agree)', () => {
    const r = resolveRunPrompt(staticAgent, [{ version: 'v1', promptText: 'STORED-V1' }], 'v1');
    assert.equal(r.promptText, 'STORED-V1');
  });

  it('falls back to the static prompt for v1 before the first seed', () => {
    const r = resolveRunPrompt(staticAgent, [], 'v1');
    assert.deepEqual(r, { version: 'v1', promptText: 'STATIC-V1', missingStored: false });
  });

  it('RELABELS to v1 when the requested label has no stored prompt', () => {
    // R3 review P0: running static v1 while recording the run as v3 would
    // corrupt v3's stats and could decide an A/B test on wrong data.
    const r = resolveRunPrompt(staticAgent, [{ version: 'v1', promptText: 'STORED-V1' }], 'v3');
    assert.equal(r.version, 'v1', 'label must follow the prompt that actually runs');
    assert.equal(r.promptText, 'STORED-V1');
    assert.equal(r.missingStored, true);
  });
});

// ─── abTestArmsResolvable (orphaned-test detection, R4 P0) ──

describe('abTestArmsResolvable', () => {
  const test = (a: string, b: string): ABTest => ({
    versionA: a, versionB: b, runsA: 0, runsB: 0, failsA: 0, failsB: 0,
    minRuns: 10, startedAt: new Date().toISOString(),
  });

  it('resolves when both arms are stored (or v1)', () => {
    const stored = [{ version: 'v2' }, { version: 'v3' }];
    assert.equal(abTestArmsResolvable(test('v2', 'v3'), stored), true);
    assert.equal(abTestArmsResolvable(test('v1', 'v2'), stored), true, 'v1 always resolves');
    assert.equal(abTestArmsResolvable(test('v1', 'v2'), [{ version: 'v2' }]), true);
  });

  it('flags a test whose arm has no stored prompt as dead', () => {
    assert.equal(abTestArmsResolvable(test('v1', 'v4'), [{ version: 'v2' }]), false);
    assert.equal(abTestArmsResolvable(test('v3', 'v4'), []), false);
  });
});

describe('darwin run: no value flag swallows a following flag (v0.17)', () => {
  // Round 9 measured this, the third appearance of the same class in one
  // release and the last parser in src/cli that still had it:
  //
  //     darwin run writer --task-type --no-evolve "Do X"
  //       -> taskType = "--no-evolve", noEvolve = FALSE
  //
  // The run then went ahead with A/B routing and the evolution loop and
  // counted into the statistics the operator had just asked to be left alone.
  // `--task-type --no-critic` likewise ran the critic, a real model call.
  const VALUE_FLAGS = ['--task-type', '--model', '--path', '--provider', '--base-url'];
  const FOLLOWING = ['--no-evolve', '--no-critic', '--verbose', '-v'];

  for (const flag of VALUE_FLAGS) {
    for (const following of FOLLOWING) {
      it(`"${flag}" does not eat "${following}"`, () => {
        const f = parseRunArgs(['writer', flag, following, 'do something']) as unknown as Record<string, unknown>;
        // The following flag must have taken effect...
        if (following === '--no-evolve') assert.equal(f.noEvolve, true);
        if (following === '--no-critic') assert.equal(f.noCritic, true);
        if (following === '--verbose' || following === '-v') assert.equal(f.verbose, true);
        // ...and must not have been stored as a value.
        for (const key of ['taskType', 'model', 'path', 'provider', 'baseUrl']) {
          assert.notEqual(
            f[key],
            following,
            `"${flag}" stored "${following}" as ${key}`,
          );
        }
      });
    }
  }

  it('and a real value still works', () => {
    const f = parseRunArgs(['writer', '--task-type', 'tech', '--model', 'gpt-5.4', 'do it']) as unknown as Record<string, unknown>;
    assert.equal(f.taskType, 'tech');
    assert.equal(f.model, 'gpt-5.4');
  });
});

describe('darwin run warns when a dash token lands in the task (v0.17)', () => {
  // Round 10, the last finding of the loop and explicitly not a blocker:
  //
  //     darwin run writer --no-evolv "Do X"
  //       -> noEvolve = FALSE, task = "--no-evolv Do X"
  //
  // The run then evolved and the critic ran, which is a real model call and
  // real money, silently and with exit 0. `approve` and `evolve` refuse
  // unrecognised arguments outright; here the task is FREE TEXT, so refusing
  // would be genuinely ambiguous (a task may legitimately start with a dash,
  // and quoting is the documented way). A warning is the right tool.

  function withWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      return { result: fn(), warnings };
    } finally {
      console.warn = original;
    }
  }

  for (const typo of ['--no-evolv', '--no-critc', '--verbse', '-vv']) {
    it(`warns about "${typo}" instead of taking it silently`, () => {
      const { result, warnings } = withWarnings(() =>
        parseRunArgs(['writer', typo, 'Do X']) as unknown as Record<string, unknown>,
      );
      assert.ok(
        warnings.some((w) => w.includes(typo) && w.includes('not a known flag')),
        `no warning for "${typo}": ${warnings.join(' | ')}`,
      );
      // The token still reaches the task, because the task is free text.
      assert.ok(String(result.task).includes(typo));
    });
  }

  it('stays quiet for an ordinary run', () => {
    const { warnings } = withWarnings(() => parseRunArgs(['writer', 'Explain the CAP theorem']));
    assert.deepEqual(warnings, [], `unexpected warnings: ${warnings.join(' | ')}`);
  });

  it('stays quiet for a task that merely contains a dash', () => {
    const { result, warnings } = withWarnings(() =>
      parseRunArgs(['writer', 'Compare cost-per-token across providers']) as unknown as Record<string, unknown>,
    );
    assert.deepEqual(warnings, []);
    assert.equal(result.task, 'Compare cost-per-token across providers');
  });
});
