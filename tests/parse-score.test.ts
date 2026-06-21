/**
 * Tests for parseCriticScore — the shared, robust critic-score extractor
 * (item 3).
 *
 * The old inline logic in cli/run.ts and the benchmark only handled
 * `===SCORE===` then a bare `N/10` fallback, so every other natural phrasing
 * ("8.5 out of 10", "Score: 8/10", "rating: 8", "I'd rate this 9",
 * "9 out of 10") parsed to null and silently dropped the run from evolution.
 * This suite locks in every one of those formats plus the genuine no-match
 * case, scale normalisation, and clamping.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCriticScore } from '../src/evolution/parse-score.js';

describe('parseCriticScore', () => {
  // ── The authoritative marker (must stay byte-compatible) ──
  it('parses the ===SCORE=== marker', () => {
    assert.equal(parseCriticScore('===SCORE===\n8'), 8);
    assert.equal(parseCriticScore('===SCORE=== 7.5\n===END==='), 7.5);
  });

  it('the marker wins over later numbers in the report', () => {
    const out = '===SCORE===\n9\n===HONESTY===\n4/10 — weak';
    assert.equal(parseCriticScore(out), 9);
  });

  // ── Every format the recon flagged as previously broken ──
  it('parses "8.5 out of 10"', () => {
    assert.equal(parseCriticScore('Overall this is 8.5 out of 10, solid work.'), 8.5);
  });

  it('parses "rating: 8"', () => {
    assert.equal(parseCriticScore('rating: 8'), 8);
  });

  it('parses "Score: 8/10"', () => {
    assert.equal(parseCriticScore('Score: 8/10'), 8);
  });

  it("parses \"I'd rate this 9\"", () => {
    assert.equal(parseCriticScore("I'd rate this 9 — strong sources."), 9);
  });

  it('parses "9 out of 10"', () => {
    assert.equal(parseCriticScore('9 out of 10'), 9);
  });

  // ── The genuine no-match case ──
  it('returns null when there is no score-like number', () => {
    assert.equal(parseCriticScore('This report is excellent and well sourced.'), null);
    assert.equal(parseCriticScore('No numeric verdict here at all.'), null);
  });

  it('returns null for empty / non-string input', () => {
    assert.equal(parseCriticScore(''), null);
    assert.equal(parseCriticScore(undefined as unknown as string), null);
  });

  // ── Extra real-world phrasings ──
  it('parses "Score: 8" (bare number after a score word)', () => {
    assert.equal(parseCriticScore('Final Score: 8'), 8);
  });

  it('parses "rating is 7"', () => {
    assert.equal(parseCriticScore('My rating is 7 for this piece.'), 7);
  });

  it('parses "I would rate it 8.5"', () => {
    assert.equal(parseCriticScore('I would rate it 8.5 for depth.'), 8.5);
  });

  it('parses "rate this a 9"', () => {
    assert.equal(parseCriticScore('I rate this a 9.'), 9);
  });

  // ── Scale normalisation ──
  it('normalises an explicit /100 fraction onto 0–10', () => {
    assert.equal(parseCriticScore('85/100'), 8.5);
  });

  it('normalises a /5 fraction onto 0–10', () => {
    assert.equal(parseCriticScore('4/5'), 8);
  });

  it('normalises an "out of 100" score', () => {
    assert.equal(parseCriticScore('85 out of 100'), 8.5);
  });

  it('normalises a bare score-word value on the 0–100 scale', () => {
    assert.equal(parseCriticScore('Score: 85'), 8.5);
  });

  // ── Clamping ──
  it('clamps an out-of-range marker score into 1–10', () => {
    assert.equal(parseCriticScore('===SCORE===\n12'), 10);
    assert.equal(parseCriticScore('===SCORE===\n0'), 1);
  });

  it('clamps a normalised value into 1–10', () => {
    // 0/10 → 0 → clamp to 1
    assert.equal(parseCriticScore('0/10'), 1);
  });

  // ── Precedence: a slash fraction beats a bare score-word number ──
  it('prefers the explicit fraction when both a fraction and a bare number exist', () => {
    // "Score: 8/10" must read 8 (the fraction), not mis-handle the trailing 10.
    assert.equal(parseCriticScore('Quality Score: 8/10 (10 = perfect)'), 8);
  });
});
