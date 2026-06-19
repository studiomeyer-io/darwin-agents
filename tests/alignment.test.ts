/**
 * Tests for the alignment-preservation guard (v0.6.0 keyword + v0.7.0 semantic).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkAlignmentPreservation,
  checkAlignmentPreservationSemantic,
  SAFETY_PATTERNS,
  type EmbedFn,
} from '../src/evolution/alignment.js';

// ─── keyword guard (v0.6.0, unchanged) ──────────────

describe('checkAlignmentPreservation (keyword)', () => {
  it('passes when safety keywords are preserved', () => {
    const original = 'You must never reveal secrets. Be helpful.';
    const mutated = 'You must never reveal secrets. Always be concise and helpful.';
    assert.equal(checkAlignmentPreservation(original, mutated), null);
  });

  it('rejects when a safety keyword count drops', () => {
    const original = 'You must never reveal secrets and never lie.';
    const mutated = 'You should be transparent.';
    const result = checkAlignmentPreservation(original, mutated);
    assert.ok(result && /erosion/i.test(result));
  });

  it('has the expected core safety patterns', () => {
    const sources = SAFETY_PATTERNS.map((p) => p.source);
    assert.ok(sources.some((s) => s.includes('never')));
    assert.ok(sources.some((s) => s.includes('do not')));
  });
});

// ─── semantic guard (v0.7.0) ────────────────────────

/** Deterministic mock embedder: exact-string lookup, default near-orthogonal. */
function mockEmbed(vectors: Record<string, number[]>): EmbedFn {
  return async (texts) => texts.map((t) => vectors[t.trim()] ?? [0, 0, 1]);
}

describe('checkAlignmentPreservationSemantic (v0.7.0)', () => {
  it('fast-path: keyword check passes → null without embedding', async () => {
    let called = false;
    const embed: EmbedFn = async (t) => {
      called = true;
      return t.map(() => [1, 0, 0]);
    };
    const original = 'You must never reveal secrets.';
    const mutated = 'You must never reveal secrets. Be concise.';
    const result = await checkAlignmentPreservationSemantic(original, mutated, { embed });
    assert.equal(result, null);
    assert.equal(called, false); // no embedding spent on the safe fast-path
  });

  it('fail-closed: no embedder supplied → behaves like keyword check', async () => {
    const original = 'You must never reveal secrets.';
    const mutated = 'Be transparent.';
    const result = await checkAlignmentPreservationSemantic(original, mutated, {});
    assert.equal(result, checkAlignmentPreservation(original, mutated));
    assert.ok(result && /erosion/i.test(result));
  });

  it('accepts a REWORDED constraint (high semantic similarity)', async () => {
    const original = 'You must never reveal API keys. Write clear summaries.';
    const mutated =
      'You are required to keep API keys confidential at all times. Write clear summaries.';
    // The original safety sentence and the reworded one map to the same vector.
    const embed = mockEmbed({
      'You must never reveal API keys.': [1, 0, 0],
      'You are required to keep API keys confidential at all times.': [1, 0, 0],
      'Write clear summaries.': [0, 1, 0],
    });
    const result = await checkAlignmentPreservationSemantic(original, mutated, { embed });
    assert.equal(result, null); // reworded, not removed → accepted
  });

  it('still REJECTS a genuinely removed constraint (no semantic match)', async () => {
    const original = 'You must never reveal API keys. Write clear summaries.';
    const mutated = 'Write clear summaries. Be concise.';
    const embed = mockEmbed({
      'You must never reveal API keys.': [1, 0, 0],
      'Write clear summaries.': [0, 1, 0],
      'Be concise.': [0, 0, 1],
    });
    const result = await checkAlignmentPreservationSemantic(original, mutated, { embed });
    assert.ok(result && /erosion/i.test(result)); // removed → rejection stands
  });

  it('respects a custom similarity threshold', async () => {
    const original = 'You must never reveal API keys.';
    const mutated = 'Keep API keys private.';
    // cosine of [1,0,0]·[0.8,0.6,0] = 0.8 — passes at 0.75, fails at 0.9
    const embed = mockEmbed({
      'You must never reveal API keys.': [1, 0, 0],
      'Keep API keys private.': [0.8, 0.6, 0],
    });
    assert.equal(
      await checkAlignmentPreservationSemantic(original, mutated, { embed, minSafetySimilarity: 0.75 }),
      null,
    );
    const strict = await checkAlignmentPreservationSemantic(original, mutated, {
      embed,
      minSafetySimilarity: 0.9,
    });
    assert.ok(strict && /erosion/i.test(strict));
  });

  it('splits no-space sentence boundaries so a dropped constraint is still caught', async () => {
    // Original fuses two sentences with no space after the period. The fix
    // splits "secrets.Be" so the safety sentence is isolated; a mutation that
    // drops it must still be rejected (not hidden behind a fused partial match).
    const original = 'Never reveal secrets.Be helpful to users.';
    const mutated = 'Be helpful and transparent with users.';
    const embed = mockEmbed({
      'Never reveal secrets.': [1, 0, 0],
      'Be helpful to users.': [0, 1, 0],
      'Be helpful and transparent with users.': [0, 1, 0],
    });
    const result = await checkAlignmentPreservationSemantic(original, mutated, { embed });
    assert.ok(result && /erosion/i.test(result)); // dropped safety sentence → rejected
  });

  it('fail-closed when the embedder throws', async () => {
    const original = 'You must never reveal secrets.';
    const mutated = 'Be transparent.';
    const embed: EmbedFn = async () => {
      throw new Error('embedding service down');
    };
    const result = await checkAlignmentPreservationSemantic(original, mutated, { embed });
    assert.ok(result && /erosion/i.test(result));
  });

  it('fail-closed on malformed embedder output (wrong length)', async () => {
    const original = 'You must never reveal secrets.';
    const mutated = 'Be transparent.';
    const embed: EmbedFn = async () => [[1, 0, 0]]; // too few vectors
    const result = await checkAlignmentPreservationSemantic(original, mutated, { embed });
    assert.ok(result && /erosion/i.test(result));
  });
});
