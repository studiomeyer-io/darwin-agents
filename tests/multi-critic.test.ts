import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMultiCritic, getCriticPrompts } from '../src/evolution/multi-critic.js';
import type { RunCriticFn } from '../src/evolution/multi-critic.js';

describe('runMultiCritic', () => {
  it('passes criticName to RunCriticFn callback', async () => {
    const receivedNames: string[] = [];

    const mockCritic: RunCriticFn = async (_prompt, _task, criticName) => {
      receivedNames.push(criticName);
      return '===SCORE===\n8\n===ASSESSMENT===\nGood.\n===END===';
    };

    await runMultiCritic('test output', 'test task', mockCritic);

    assert.deepStrictEqual(receivedNames.sort(), [
      'completeness-structure',
      'facts-sources',
      'honesty-courage',
    ]);
  });

  it('returns median score from 3 critics', async () => {
    const scores = [6, 8, 7];
    let idx = 0;

    const mockCritic: RunCriticFn = async () => {
      const score = scores[idx++];
      return `===SCORE===\n${score}\n===ASSESSMENT===\nOK.\n===END===`;
    };

    const result = await runMultiCritic('test output', 'test task', mockCritic);
    assert.equal(result.medianScore, 7); // median of [6,7,8]
    assert.equal(result.critics.length, 3);
  });

  it('handles failed critics gracefully', async () => {
    let call = 0;
    const mockCritic: RunCriticFn = async () => {
      call++;
      if (call === 2) throw new Error('API error');
      return '===SCORE===\n8\n===ASSESSMENT===\nOK.\n===END===';
    };

    const result = await runMultiCritic('test output', 'test task', mockCritic);
    assert.equal(result.medianScore, 8); // median of [8, 8], one failed
    assert.equal(result.critics.filter(c => c.score > 0).length, 2);
  });

  it('returns 0 when all critics fail', async () => {
    const mockCritic: RunCriticFn = async () => {
      throw new Error('All fail');
    };

    const result = await runMultiCritic('test output', 'test task', mockCritic);
    assert.equal(result.medianScore, 0);
  });
});

// ─── v0.4.6 — Critic-set registry & anti-fallback regression ────

describe('getCriticPrompts — agent-specific sets (v0.4.6)', () => {
  it('returns 3 critics for every registered agent', () => {
    for (const agent of [
      'investigator', 'writer', 'marketing', 'blog-writer',
      'research', 'researcher', 'critic', 'analyst',
    ]) {
      const prompts = getCriticPrompts(agent);
      assert.equal(prompts.length, 3, `agent ${agent} must have 3 critic prompts`);
      const names = new Set(prompts.map((p) => p.name));
      assert.equal(names.size, 3, `agent ${agent} critic names must be unique`);
      for (const p of prompts) {
        assert.ok(p.prompt.length > 100, `agent ${agent} critic ${p.name} prompt too short`);
        assert.ok(p.prompt.includes('===SCORE==='), `agent ${agent} critic ${p.name} missing OUTPUT_FORMAT`);
      }
    }
  });

  // Anti-fallback regression: in v0.4.5 and earlier, analyst/researcher/critic
  // fell back to INVESTIGATOR_PROMPTS — which mis-scored their outputs (e.g.
  // code-analysis got dinged for "no URLs cited"). v0.4.6 fixes this with
  // dedicated sets. This test locks the fix.
  it('analyst uses code-analysis critics, NOT investigator (anti-fallback)', () => {
    const analyst = getCriticPrompts('analyst');
    const investigator = getCriticPrompts('investigator');
    const aNames = analyst.map((p) => p.name).sort();
    const iNames = investigator.map((p) => p.name).sort();
    assert.notDeepStrictEqual(aNames, iNames, 'analyst must NOT use investigator critic set');
    const blob = analyst.map((p) => p.prompt).join('\n').toLowerCase();
    assert.ok(blob.includes('file path') || blob.includes('file paths'),
      'analyst critics must reference file paths');
    assert.ok(blob.includes('function') || blob.includes('class'),
      'analyst critics must reference functions/classes');
  });

  it('research uses synthesis-quality critics, NOT investigator (anti-fallback)', () => {
    const research = getCriticPrompts('research');
    const investigator = getCriticPrompts('investigator');
    const rNames = research.map((p) => p.name).sort();
    const iNames = investigator.map((p) => p.name).sort();
    assert.notDeepStrictEqual(rNames, iNames, 'research must NOT use investigator critic set');
    const blob = research.map((p) => p.prompt).join('\n').toLowerCase();
    assert.ok(blob.includes('synthesis'), 'research critics must score synthesis');
    assert.ok(blob.includes('multi-engine') || blob.includes('cross-reference') || blob.includes('coverage'),
      'research critics must score source coverage');
  });

  it('critic uses critique-of-critique critics, NOT investigator (anti-fallback)', () => {
    const critic = getCriticPrompts('critic');
    const investigator = getCriticPrompts('investigator');
    const cNames = critic.map((p) => p.name).sort();
    const iNames = investigator.map((p) => p.name).sort();
    assert.notDeepStrictEqual(cNames, iNames, 'critic must NOT use investigator critic set');
    const blob = critic.map((p) => p.prompt).join('\n').toLowerCase();
    assert.ok(blob.includes('steelman'), 'critic critics must score steelmanning');
    assert.ok(blob.includes('verdict'), 'critic critics must score actionable verdict');
  });

  it('researcher is an alias of research (back-compat)', () => {
    const a = getCriticPrompts('research').map((p) => p.name).sort();
    const b = getCriticPrompts('researcher').map((p) => p.name).sort();
    assert.deepStrictEqual(a, b);
  });

  it('falls back to investigator for unknown agents', () => {
    const unknown = getCriticPrompts('totally-made-up-agent');
    const investigator = getCriticPrompts('investigator');
    assert.deepStrictEqual(
      unknown.map((p) => p.name).sort(),
      investigator.map((p) => p.name).sort(),
    );
  });
});

describe('runMultiCritic — uses agent-specific critic set (v0.4.6)', () => {
  it('passes analyst critic names when agentName=analyst', async () => {
    const received: string[] = [];
    const mock: RunCriticFn = async (_p, _t, name) => {
      received.push(name);
      return '===SCORE===\n8\n===ASSESSMENT===\nOK.\n===END===';
    };
    await runMultiCritic('analysis output', 'analyze codebase', mock, 'analyst');
    assert.deepStrictEqual(received.sort(), [
      'pattern-recognition', 'recommendation-quality', 'technical-accuracy',
    ]);
  });

  it('passes research critic names when agentName=research', async () => {
    const received: string[] = [];
    const mock: RunCriticFn = async (_p, _t, name) => {
      received.push(name);
      return '===SCORE===\n7\n===ASSESSMENT===\nOK.\n===END===';
    };
    await runMultiCritic('research report', 'survey topic X', mock, 'research');
    assert.deepStrictEqual(received.sort(), [
      'analytical-depth', 'completeness-decision', 'source-quality',
    ]);
  });

  it('passes critic critic names when agentName=critic', async () => {
    const received: string[] = [];
    const mock: RunCriticFn = async (_p, _t, name) => {
      received.push(name);
      return '===SCORE===\n6\n===ASSESSMENT===\nOK.\n===END===';
    };
    await runMultiCritic('critique', 'critique idea X', mock, 'critic');
    assert.deepStrictEqual(received.sort(), [
      'actionability-verdict', 'counter-argument-depth', 'fairness-steelman',
    ]);
  });
});
