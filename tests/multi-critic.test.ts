import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMultiCritic } from '../src/evolution/multi-critic.js';
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
