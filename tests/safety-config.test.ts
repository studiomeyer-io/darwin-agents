/**
 * Tests for v0.14.0 — per-agent safety thresholds (`evolution.safety`) and
 * their CLI door (`--require-confidence`, `--confidence-method`).
 *
 * Before v0.14 the statistical-rigor knobs existed but were reachable ONLY by
 * hand-wiring a SafetyGate; these tests pin the whole path from flag → merged
 * config → a gate that actually runs the sequential test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SafetyGate } from '../src/evolution/safety.js';
import { DEFAULT_SAFETY } from '../src/types.js';
import { resolveEvolutionConfig } from '../src/evolution/enabled-state.js';
import {
  applyEvolutionFlag,
  isEvolutionConfigFlag,
  parseEvolutionConfigFlags,
  hasAnyEvolutionFlag,
} from '../src/cli/evolution-flags.js';
import type { AgentDefinition, EvolutionConfigOverride } from '../src/types.js';

const agentWith = (evolution: AgentDefinition['evolution']): AgentDefinition => ({
  name: 'writer',
  role: 'Writer',
  description: 'test agent',
  type: 'llm',
  systemPrompt: 'Write.',
  evolution,
});

// ─── Flag parsing ───────────────────────────────────

describe('confidence flags', () => {
  it('recognises the three new flags', () => {
    assert.ok(isEvolutionConfigFlag('--require-confidence'));
    assert.ok(isEvolutionConfigFlag('--no-require-confidence'));
    assert.ok(isEvolutionConfigFlag('--confidence-method'));
  });

  it('parses --require-confidence / --no-require-confidence', () => {
    const on: EvolutionConfigOverride = {};
    applyEvolutionFlag('--require-confidence', undefined, on);
    assert.equal(on.requireConfidence, true);

    const off: EvolutionConfigOverride = {};
    applyEvolutionFlag('--no-require-confidence', undefined, off);
    assert.equal(off.requireConfidence, false);
  });

  it('parses --confidence-method with a valid value and consumes it', () => {
    const target: EvolutionConfigOverride = {};
    const consumed = applyEvolutionFlag('--confidence-method', 'msprt', target);
    assert.equal(consumed, 1);
    assert.equal(target.confidenceMethod, 'msprt');
  });

  it('rejects an unknown method (consumes the token, persists nothing)', () => {
    const target: EvolutionConfigOverride = {};
    const consumed = applyEvolutionFlag('--confidence-method', 'chi-squared', target);
    assert.equal(consumed, 1);
    assert.equal(target.confidenceMethod, undefined);
  });

  it('treats a following flag token as a missing value — including single-dash', () => {
    // The 0.13.2 lesson: `-v` is a real CLI flag and must not be swallowed.
    const target: EvolutionConfigOverride = {};
    assert.equal(applyEvolutionFlag('--confidence-method', '-v', target), 0);
    assert.equal(applyEvolutionFlag('--confidence-method', '--force', target), 0);
    assert.equal(applyEvolutionFlag('--confidence-method', undefined, target), 0);
    assert.equal(target.confidenceMethod, undefined);
  });

  it('flows through parseEvolutionConfigFlags and hasAnyEvolutionFlag', () => {
    const { override, rest } = parseEvolutionConfigFlags([
      '--require-confidence',
      '--confidence-method',
      'hoeffding',
      '--force',
    ]);
    assert.equal(override.requireConfidence, true);
    assert.equal(override.confidenceMethod, 'hoeffding');
    assert.deepEqual(rest, ['--force']);
    assert.ok(hasAnyEvolutionFlag(override));
    assert.ok(hasAnyEvolutionFlag({ confidenceMethod: 'msprt' }));
  });
});

// ─── Override → nested safety merge ─────────────────

describe('resolveEvolutionConfig — safety merge', () => {
  it('maps confidence overrides into the nested safety block', () => {
    const agent = agentWith({ enabled: true });
    const resolved = resolveEvolutionConfig(agent, {}, {
      requireConfidence: true,
      confidenceMethod: 'msprt',
    });
    assert.deepEqual(resolved?.safety, {
      requireConfidence: true,
      confidenceMethod: 'msprt',
    });
  });

  it('merges over a static safety block instead of replacing it', () => {
    const agent = agentWith({
      enabled: true,
      safety: { maxRegression: 0.1, requireConfidence: false },
    });
    const resolved = resolveEvolutionConfig(agent, {}, { requireConfidence: true });
    assert.equal(resolved?.safety?.maxRegression, 0.1, 'static field survives');
    assert.equal(resolved?.safety?.requireConfidence, true, 'override wins');
  });

  it('persisted override loses to a later CLI override (layer order)', () => {
    const agent = agentWith({ enabled: true });
    const resolved = resolveEvolutionConfig(
      agent,
      { evolutionConfigOverrides: { writer: { confidenceMethod: 'hoeffding' } } },
      { confidenceMethod: 'msprt' },
    );
    assert.equal(resolved?.safety?.confidenceMethod, 'msprt');
  });
});

// ─── Gate behaviour ─────────────────────────────────

describe('SafetyGate from evolution.safety', () => {
  it('a merged partial actually arms the sequential-confidence path', () => {
    const merged = { ...DEFAULT_SAFETY, requireConfidence: true, confidenceMethod: 'msprt' as const };
    assert.equal(new SafetyGate(merged).usesSequentialConfidence(), true);
    assert.equal(new SafetyGate().usesSequentialConfidence(), false);
    assert.equal(
      new SafetyGate({ ...DEFAULT_SAFETY, requireConfidence: true }).usesSequentialConfidence(),
      false,
      'effect-size default is not a sequential method',
    );
  });
});
