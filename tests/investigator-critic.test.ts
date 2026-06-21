/**
 * Smoke test for the investigator-critic agent (item 5).
 *
 * This agent shipped with zero test coverage. It is a pure AgentDefinition
 * (no LLM call needed to exercise it), so the smoke test imports it, validates
 * its shape through the same defineAgent() path the framework uses, confirms it
 * is registered in builtinAgents, and — because its whole point is a
 * machine-parseable verdict — checks that a verdict in its documented
 * ===SCORE=== format actually parses with the shared parseCriticScore helper.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { investigatorCritic } from '../src/agents/investigator-critic.js';
import { builtinAgents } from '../src/agents/index.js';
import { defineAgent } from '../src/core/agent.js';
import { parseCriticScore } from '../src/evolution/parse-score.js';

describe('investigator-critic agent', () => {
  it('has the expected identity and evaluation focus', () => {
    assert.equal(investigatorCritic.name, 'investigator-critic');
    assert.equal(investigatorCritic.role, 'Investigation Quality Evaluator');
    assert.ok(investigatorCritic.systemPrompt.length > 0);
    // It is an evaluator that judges honesty/balance/depth, not a writer.
    assert.match(investigatorCritic.systemPrompt, /Honesty/);
    assert.match(investigatorCritic.systemPrompt, /Balance/);
    assert.match(investigatorCritic.systemPrompt, /Source Diversity/i);
  });

  it('does not self-evolve (avoids the critic circular-dependency)', () => {
    assert.equal(investigatorCritic.evolution?.enabled, false);
  });

  it('passes defineAgent validation (applies framework defaults)', () => {
    const defined = defineAgent(investigatorCritic);
    assert.equal(defined.name, 'investigator-critic');
    assert.equal(defined.type, 'llm');
    assert.ok((defined.maxTurns ?? 0) > 0);
    assert.ok(defined.model, 'a default model is applied');
  });

  it('is registered in builtinAgents under its hyphenated key', () => {
    assert.equal(builtinAgents['investigator-critic'], investigatorCritic);
  });

  it('documents a ===SCORE=== output format that the score parser understands', () => {
    // The prompt promises a parseable verdict — prove a verdict in that exact
    // shape extracts cleanly, so the agent is wired to the real scoring path.
    assert.match(investigatorCritic.systemPrompt, /===SCORE===/);
    const sampleVerdict = [
      '===SCORE===',
      '8',
      '===HONESTY===',
      '7/10 — takes a clear position',
      '===END===',
    ].join('\n');
    assert.equal(parseCriticScore(sampleVerdict), 8);
  });
});
