/**
 * Budget-cap regression tests for the Darwin runner.
 * Round-4 OSS-Sweep (2026-04-24).
 *
 * Before this change, a runaway A/B-critic-convergence loop had no upper
 * bound — a single stuck process could burn through hundreds of paid
 * provider calls before anyone noticed. These tests lock in the ceiling
 * so future refactors can't silently remove it.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  runAgent,
  DarwinBudgetError,
  setMaxRunsPerProcess,
  setMaxRunWallMs,
  resetRunCounters,
} from '../src/core/runner.js';
import type { AgentDefinition } from '../src/types.js';
import type { LLMProvider } from '../src/providers/types.js';

// Fake provider — never touches the network or spawns a subprocess.
function makeFakeProvider(): LLMProvider {
  return {
    name: 'fake',
    supportsMcp: false,
    async run() {
      return {
        output: '## Fake output\n' + 'x'.repeat(200),
        durationMs: 1,
        model: 'fake-model',
      };
    },
  };
}

const TEST_AGENT: AgentDefinition = {
  name: 'test-agent',
  role: 'Test Agent',
  type: 'llm',
  description: 'test',
  systemPrompt: 'You are a test agent.',
  maxTurns: 1,
};

describe('Darwin runner budget caps', () => {
  afterEach(() => {
    // Restore defaults so test ordering can't leak state.
    setMaxRunsPerProcess(100);
    setMaxRunWallMs(60 * 60 * 1000);
    resetRunCounters();
  });

  it('throws DarwinBudgetError when max runs per process is exceeded', async () => {
    setMaxRunsPerProcess(3);
    setMaxRunWallMs(0); // disable wall cap for this test
    resetRunCounters();

    const provider = makeFakeProvider();

    // First 3 runs succeed.
    for (let i = 0; i < 3; i++) {
      await runAgent(TEST_AGENT, 'task ' + String(i), {
        provider,
        config: { provider: 'claude-cli', memory: 'sqlite', dataDir: '/tmp/darwin-budget-test-' + String(process.pid) },
      });
    }

    // 4th run is blocked.
    await assert.rejects(
      runAgent(TEST_AGENT, 'task 4', {
        provider,
        config: { provider: 'claude-cli', memory: 'sqlite', dataDir: '/tmp/darwin-budget-test-' + String(process.pid) },
      }),
      (err: unknown) => {
        assert.ok(err instanceof DarwinBudgetError);
        assert.equal((err as DarwinBudgetError).budget, 'runs');
        return true;
      },
    );
  });

  it('honours 0 = disabled for max runs', async () => {
    setMaxRunsPerProcess(0);
    setMaxRunWallMs(0);
    resetRunCounters();

    const provider = makeFakeProvider();

    // 10 runs — all allowed because cap is 0.
    for (let i = 0; i < 10; i++) {
      await runAgent(TEST_AGENT, 'task ' + String(i), {
        provider,
        config: { provider: 'claude-cli', memory: 'sqlite', dataDir: '/tmp/darwin-budget-test-' + String(process.pid) },
      });
    }
  });

  it('throws DarwinBudgetError when wall-clock cap is exceeded', async () => {
    setMaxRunsPerProcess(0); // disable runs cap
    resetRunCounters(); // refresh processStartMs baseline
    // Wait 15 ms so that Date.now() - processStartMs exceeds the 10 ms cap.
    await new Promise((r) => setTimeout(r, 15));
    setMaxRunWallMs(10);

    const provider = makeFakeProvider();

    await assert.rejects(
      runAgent(TEST_AGENT, 'task', {
        provider,
        config: { provider: 'claude-cli', memory: 'sqlite', dataDir: '/tmp/darwin-budget-test-' + String(process.pid) },
      }),
      (err: unknown) => {
        assert.ok(err instanceof DarwinBudgetError);
        assert.equal((err as DarwinBudgetError).budget, 'wall');
        return true;
      },
    );
  });
});
