/**
 * Tests for the cross-family critic diversity check.
 *
 * LLM-as-judge bias is reduced when critics come from more than one model
 * family. `resolveCriticProviders` only achieves that when a non-Anthropic
 * provider key is present; otherwise every critic collapses onto the Anthropic
 * family (claude-cli AND anthropic-api are the same family — they differ only in
 * latency). This suite locks the family counting, the env-gated enforcement
 * switch, and the operator hint.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkCriticFamilies,
  crossFamilyRequired,
  singleFamilyHint,
} from '../src/evolution/critic-families.js';

describe('checkCriticFamilies', () => {
  it('flags the all-Anthropic case (no OpenAI key) as single-family', () => {
    // The real-world default: claude-cli + anthropic-api + claude-cli.
    const r = checkCriticFamilies({
      facts: { family: 'anthropic' },
      honesty: { family: 'anthropic' },
      completeness: { family: 'anthropic' },
    });
    assert.equal(r.singleFamily, true);
    assert.equal(r.count, 1);
    assert.deepEqual(r.families, ['anthropic']);
  });

  it('treats claude-cli + anthropic-api as ONE family (the key nuance)', () => {
    // Both are Anthropic; only latency differs. Mixing them is NOT diversity.
    const r = checkCriticFamilies({
      a: { family: 'anthropic' }, // claude-cli
      b: { family: 'anthropic' }, // anthropic-api
    });
    assert.equal(r.singleFamily, true);
    assert.equal(r.count, 1);
  });

  it('passes when a second family is present (OpenAI key set)', () => {
    const r = checkCriticFamilies({
      facts: { family: 'openai' },
      honesty: { family: 'anthropic' },
      completeness: { family: 'anthropic' },
    });
    assert.equal(r.singleFamily, false);
    assert.equal(r.count, 2);
    assert.deepEqual(r.families, ['anthropic', 'openai']); // sorted
  });

  it('counts three distinct families', () => {
    const r = checkCriticFamilies({
      a: { family: 'openai' },
      b: { family: 'anthropic' },
      c: { family: 'ollama' },
    });
    assert.equal(r.count, 3);
    assert.deepEqual(r.families, ['anthropic', 'ollama', 'openai']);
  });

  it('is case- and whitespace-insensitive when de-duplicating', () => {
    const r = checkCriticFamilies({
      a: { family: 'Anthropic' },
      b: { family: '  anthropic ' },
      c: { family: 'ANTHROPIC' },
    });
    assert.equal(r.count, 1);
    assert.deepEqual(r.families, ['anthropic']);
  });

  it('ignores blank / non-string families instead of inflating the count', () => {
    const r = checkCriticFamilies({
      a: { family: 'anthropic' },
      b: { family: '   ' },
      // deliberately malformed entry — must not become a "family"
      c: { family: undefined as unknown as string },
    });
    assert.equal(r.count, 1);
    assert.equal(r.singleFamily, true);
    assert.deepEqual(r.families, ['anthropic']);
  });

  it('treats an empty critic map as single-family (degenerate, not a win)', () => {
    const r = checkCriticFamilies({});
    assert.equal(r.count, 0);
    assert.equal(r.singleFamily, true);
    assert.deepEqual(r.families, []);
  });
});

describe('crossFamilyRequired', () => {
  it('is true for the documented truthy values', () => {
    for (const v of ['1', 'true', 'yes']) {
      assert.equal(crossFamilyRequired({ DARWIN_REQUIRE_CROSS_FAMILY: v }), true, v);
    }
  });

  it('is false when unset or a non-truthy value', () => {
    assert.equal(crossFamilyRequired({}), false);
    for (const v of ['0', 'false', 'no', '', 'on']) {
      assert.equal(crossFamilyRequired({ DARWIN_REQUIRE_CROSS_FAMILY: v }), false, v);
    }
  });
});

describe('singleFamilyHint', () => {
  it('names the collapsed family and points at the fix', () => {
    const hint = singleFamilyHint(checkCriticFamilies({ a: { family: 'anthropic' } }));
    assert.match(hint, /anthropic/);
    assert.match(hint, /OPENAI_API_KEY/);
  });

  it('falls back to "unknown" for an empty map without throwing', () => {
    const hint = singleFamilyHint(checkCriticFamilies({}));
    assert.match(hint, /unknown/);
  });
});
