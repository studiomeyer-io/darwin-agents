/**
 * Tests for DarwinLoop.forceEvolve — the engine behind `darwin evolve
 * <agent> --force` (item 2).
 *
 * `--force` used to be a stub that printed "not yet available". It now runs the
 * loop's real variant-generation + A/B-start path ONCE, bypassing the automatic
 * loop's "enough runs / actionable patterns / data-quality" gates, while still
 * refusing the genuinely-impossible cases (no active prompt, no experiments, a
 * test already running).
 *
 * These tests inject a STUB optimizer (no real LLM call) so they are hermetic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { GepaOptimizer } from '../src/evolution/optimizer-gepa.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';
import type { AgentDefinition, ABTest, DarwinExperiment } from '../src/types.js';

const SAFE_PROMPT = 'You are a research agent. Never fabricate sources. Cite primary documents.';

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

function buildLoop(opts: {
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

/** Seed N STRONG experiments (high quality → NO weakness → automatic loop would NOT evolve). */
function seedStrongExperiments(memory: ReturnType<typeof createMockMemory>, count: number): void {
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

describe('DarwinLoop.forceEvolve', () => {
  it('generates a challenger + starts an A/B test even when the automatic gates would NOT fire', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }));
    // Strong runs → the automatic loop sees no weakness and would skip evolution.
    seedStrongExperiments(memory, 3);

    const forcedOut = 'You are a meticulous research agent. Never fabricate sources. Cite and cross-check primary documents.';
    const loop = buildLoop({ memory, agent: makeAgent({ enabled: true }), optimizerOutput: forcedOut });

    const result = await loop.forceEvolve('researcher');

    assert.equal(result.promptEvolved, true);
    assert.equal(result.abTestStarted, true);
    assert.ok(result.newVersion === 'v2', `expected v2, got ${result.newVersion}`);

    const v2 = memory._versions.find((v) => v.version === 'v2');
    assert.ok(v2, 'v2 should be created');
    assert.equal(v2!.promptText, forcedOut);
    assert.equal(v2!.active, false, 'challenger is not active until it wins the A/B test');

    const test = memory._state.abTests['researcher'] as ABTest | null;
    assert.ok(test, 'an A/B test should be started');
    assert.equal(test!.versionA, 'v1');
    assert.equal(test!.versionB, 'v2');
  });

  it('uses the GEPA reflective path when the agent opts into useGepa', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }));
    // Strong runs WITH critic feedback so the reflector has something to mutate from.
    for (let i = 0; i < 3; i++) {
      memory._experiments.push(makeExperiment({
        agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
        metrics: { qualityScore: 9, sourceCount: 12, outputLength: 6000, errorCount: 0, durationMs: 30000 },
        feedback: { score: 9, report: 'Strong, but could tighten the methodology section.', evaluator: 'multi-critic' },
      }));
    }

    const gepaOut = 'You are a rigorous research agent. Never fabricate sources. Cite primary documents and state your methodology.';
    const gepa = new GepaOptimizer(async () => gepaOut);
    const loop = buildLoop({
      memory,
      agent: makeAgent({ enabled: true, useGepa: true }),
      optimizerOutput: 'LEGACY-SHOULD-NOT-BE-USED but stays Never-safe',
      gepa,
    });

    const result = await loop.forceEvolve('researcher');

    assert.equal(result.abTestStarted, true);
    assert.ok(result.message.includes('via gepa'), `expected gepa in message: ${result.message}`);
    const v2 = memory._versions.find((v) => v.version === 'v2');
    assert.equal(v2!.promptText, gepaOut);
    assert.ok(v2!.changeReason.startsWith('[gepa]'));
  });

  it('refuses when the agent has no recorded experiments yet', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }));

    const loop = buildLoop({ memory, agent: makeAgent({ enabled: true }), optimizerOutput: 'unused' });
    const result = await loop.forceEvolve('researcher');

    assert.equal(result.abTestStarted, false);
    assert.equal(result.promptEvolved, false);
    assert.ok(result.message.includes('No recorded experiments'), result.message);
    assert.equal(memory._versions.find((v) => v.version === 'v2'), undefined);
    assert.equal(memory._state.abTests['researcher'] ?? null, null);
  });

  it('refuses when an A/B test is already running', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }));
    seedStrongExperiments(memory, 3);
    const existing: ABTest = {
      versionA: 'v1', versionB: 'v2', runsA: 1, runsB: 1, failsA: 0, failsB: 0, minRuns: 5,
      startedAt: new Date().toISOString(),
    };
    memory._state.abTests['researcher'] = existing as unknown as null;

    const loop = buildLoop({ memory, agent: makeAgent({ enabled: true }), optimizerOutput: 'unused' });
    const result = await loop.forceEvolve('researcher');

    assert.equal(result.abTestStarted, false);
    assert.ok(result.message.includes('already running'), result.message);
    // The existing test is untouched.
    assert.equal((memory._state.abTests['researcher'] as unknown as ABTest).versionB, 'v2');
    assert.equal(memory._versions.find((v) => v.version === 'v3'), undefined);
  });

  it('refuses when no active prompt has been seeded', async () => {
    const memory = createMockMemory();
    seedStrongExperiments(memory, 3); // experiments exist, but no prompt version

    const loop = buildLoop({ memory, agent: makeAgent({ enabled: true }), optimizerOutput: 'unused' });
    const result = await loop.forceEvolve('researcher');

    assert.equal(result.abTestStarted, false);
    assert.ok(result.message.includes('No active prompt'), result.message);
  });
});
