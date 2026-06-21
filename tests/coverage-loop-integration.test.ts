/**
 * Integration test for the v0.7.0 instance-wise coverage path wired into the
 * evolution loop (item 6b).
 *
 * `optimizer-gepa.ts` shipped nextGeneration/selectByCoverage + the perKeyScores
 * field with unit tests, but NOTHING in the live loop ever called them and
 * nothing populated perKeyScores. This test drives DarwinLoop.afterRun with a
 * stub provider (no real LLM) + an in-memory store and asserts the coverage
 * path actually fires:
 *   - tracker emits per-task-type perKeyScores per prompt version,
 *   - the loop calls GepaOptimizer.nextGeneration with those perKeyScores,
 *   - selection by coverage picks the breadth-winning version as the reflection
 *     PARENT (not the single highest-average version), and
 *   - the challenger is reflected FROM that coverage-selected parent.
 *
 * The default path (useCoverage off) is covered by the existing loop/gepa
 * suites and must stay unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { GepaOptimizer, type ScoredVariant, type NextGenerationOptions } from '../src/evolution/optimizer-gepa.js';
import type { ReflectiveFeedback } from '../src/evolution/reflector.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';
import type { AgentDefinition, DarwinExperiment } from '../src/types.js';

// Distinct, safety-preserving prompts per version so we can tell which one the
// reflector was handed as its parent.
const PROMPT_V1 = 'You are a research agent v1. Never fabricate sources. Strong on tech.';
const PROMPT_V2 = 'You are a research agent v2. Never fabricate sources. Strong on market and webdesign.';
const PROMPT_V3 = 'You are a research agent v3 (active). Never fabricate sources.';
const GEPA_OUT = 'You are a sharp research agent. Never fabricate sources. Cite primary documents.';

/** A GepaOptimizer that records what generate() + nextGeneration() were called with. */
class SpyGepa extends GepaOptimizer {
  generateParents: string[] = [];
  nextGenCalls: Array<{ scored: ReadonlyArray<ScoredVariant>; opts: NextGenerationOptions }> = [];

  constructor() {
    super(async () => GEPA_OUT);
  }

  override async generate(
    currentPrompt: string,
    feedbacks: ReadonlyArray<ReflectiveFeedback>,
    opts?: Parameters<GepaOptimizer['generate']>[2],
  ): Promise<Array<{ id: string; prompt: string }>> {
    this.generateParents.push(currentPrompt);
    return super.generate(currentPrompt, feedbacks, opts);
  }

  override nextGeneration(
    scored: ReadonlyArray<ScoredVariant>,
    opts: NextGenerationOptions,
  ): ScoredVariant[] {
    this.nextGenCalls.push({ scored, opts });
    return super.nextGeneration(scored, opts);
  }
}

function makeAgent(evolution: AgentDefinition['evolution']): AgentDefinition {
  return {
    name: 'researcher',
    role: 'Researcher',
    description: 'test agent',
    type: 'llm',
    systemPrompt: PROMPT_V3,
    model: 'claude-sonnet-4-6',
    evolution,
  };
}

/** Push `n` experiments for a version+taskType at a given quality (drives the per-key composite). */
function pushRuns(
  memory: ReturnType<typeof createMockMemory>,
  version: string,
  taskType: string,
  quality: number,
  n: number,
  withFeedback = false,
): void {
  for (let i = 0; i < n; i++) {
    const exp: DarwinExperiment = makeExperiment({
      agentName: 'researcher',
      promptVersion: version,
      taskType,
      success: true,
      metrics: { qualityScore: quality, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
    });
    if (withFeedback) {
      exp.feedback = { score: quality, report: `Feedback for ${taskType}: room to improve.`, evaluator: 'multi-critic' };
    }
    memory._experiments.push(exp);
  }
}

function buildLoop(memory: ReturnType<typeof createMockMemory>, agent: AgentDefinition, gepa: GepaOptimizer): DarwinLoop {
  return new DarwinLoop({
    memory,
    tracker: new ExperimentTracker(memory),
    optimizer: new PromptOptimizer(async () => 'LEGACY-NOT-USED but stays Never-safe'),
    safety: new SafetyGate(),
    patterns: new PatternDetector(memory),
    agent,
    gepa,
  });
}

describe('DarwinLoop — instance-wise coverage path (useCoverage)', () => {
  function seedThreeVersions(memory: ReturnType<typeof createMockMemory>): void {
    // v3 is active; v1 + v2 are scored history. Coverage keys = task types.
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: false, promptText: PROMPT_V1 }));
    memory._versions.push(makePromptVersion({ version: 'v2', agentName: 'researcher', active: false, promptText: PROMPT_V2 }));
    memory._versions.push(makePromptVersion({ version: 'v3', agentName: 'researcher', active: true, promptText: PROMPT_V3 }));

    // Per-task-type composite is quality-dominated (quality weight 0.40).
    // tech:      v1 high (9) > v2 (5)        → v1 wins  'tech'
    pushRuns(memory, 'v1', 'tech', 9, 6);
    pushRuns(memory, 'v2', 'tech', 5, 2);
    // market:    v2 (7) > v1 (5), 12 runs <8 → weakness fires + v2 wins 'market'
    pushRuns(memory, 'v1', 'market', 5, 6, /* withFeedback */ true);
    pushRuns(memory, 'v2', 'market', 7, 6, /* withFeedback */ true);
    // webdesign: v2 (7) > v1 (4)             → v2 wins  'webdesign'
    pushRuns(memory, 'v1', 'webdesign', 4, 2);
    pushRuns(memory, 'v2', 'webdesign', 7, 6);
    // general:   v3 (active) lone runs        → v3 wins  'general' (1 key)
    pushRuns(memory, 'v3', 'general', 6, 3, /* withFeedback */ true);

    // Coverage weights: v1={tech}=1, v2={market,webdesign}=2, v3={general}=1
    // → maxCarry=1 selects v2 as the reflection parent.
  }

  it('fires nextGeneration with populated perKeyScores and reflects from the coverage-winning parent', async () => {
    const memory = createMockMemory();
    seedThreeVersions(memory);

    const gepa = new SpyGepa();
    const loop = buildLoop(memory, makeAgent({ enabled: true, useGepa: true, useCoverage: true }), gepa);

    // Trigger run on the active version (weak market) to reach the generation step.
    const trigger = makeExperiment({
      agentName: 'researcher', promptVersion: 'v3', taskType: 'market', success: true,
      metrics: { qualityScore: 5.5, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
      feedback: { score: 5.5, report: 'Market still weak.', evaluator: 'multi-critic' },
    });

    const result = await loop.afterRun(trigger);

    // The evolution actually happened via the GEPA path.
    assert.equal(result.abTestStarted, true, result.message);
    assert.ok(result.message.includes('via gepa'), `expected gepa path: ${result.message}`);

    // 1) nextGeneration was called (coverage selection ran).
    assert.equal(gepa.nextGenCalls.length, 1, 'nextGeneration should be called once for parent selection');
    const call = gepa.nextGenCalls[0]!;
    assert.equal(call.opts.useCoverage, true, 'coverage selection must be requested');

    // 2) perKeyScores were populated on EVERY scored variant the loop passed.
    assert.ok(call.scored.length >= 2, 'at least two scored versions feed coverage selection');
    for (const v of call.scored) {
      assert.ok(v.perKeyScores && Object.keys(v.perKeyScores).length > 0, `perKeyScores populated for ${v.id}`);
    }
    // The market key really carries v2 > v1 (proves tracker emitted real per-key data).
    const v1Scored = call.scored.find((v) => v.id === 'v1')!;
    const v2Scored = call.scored.find((v) => v.id === 'v2')!;
    assert.ok((v2Scored.perKeyScores!.market ?? 0) > (v1Scored.perKeyScores!.market ?? 0), 'v2 beats v1 on market');

    // 3) selection-by-coverage picked v2 (breadth winner) as the reflection parent,
    //    and the reflector was handed v2's prompt — NOT the active v3 prompt.
    assert.equal(gepa.generateParents.length, 1, 'reflector called once');
    assert.equal(gepa.generateParents[0], PROMPT_V2, 'challenger reflected from the coverage-winning parent (v2)');

    // 4) the new challenger (v4) carries the reflector output.
    const v4 = memory._versions.find((v) => v.version === 'v4');
    assert.ok(v4, 'a new challenger version v4 should be created');
    assert.equal(v4!.promptText, GEPA_OUT);
  });

  it('does NOT touch the coverage path when useCoverage is off (reflects from the active prompt)', async () => {
    const memory = createMockMemory();
    seedThreeVersions(memory);

    const gepa = new SpyGepa();
    // useGepa on, useCoverage OFF.
    const loop = buildLoop(memory, makeAgent({ enabled: true, useGepa: true }), gepa);

    const trigger = makeExperiment({
      agentName: 'researcher', promptVersion: 'v3', taskType: 'market', success: true,
      metrics: { qualityScore: 5.5, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
      feedback: { score: 5.5, report: 'Market still weak.', evaluator: 'multi-critic' },
    });

    const result = await loop.afterRun(trigger);

    assert.equal(result.abTestStarted, true, result.message);
    // No coverage selection happened...
    assert.equal(gepa.nextGenCalls.length, 0, 'nextGeneration must NOT be called when useCoverage is off');
    // ...and the reflector got the ACTIVE prompt (v3), not a coverage-selected parent.
    assert.equal(gepa.generateParents[0], PROMPT_V3, 'default path reflects from the active prompt');
  });
});
