import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEvolutionLoop,
  DarwinLoop,
  ExperimentTracker,
  PatternDetector,
  PromptOptimizer,
  SafetyGate,
  runMultiCritic,
  createMemory,
  loadConfig,
  builtinAgents,
  createProvider,
  loadNotificationConfig,
  createTraceCapture,
} from '../src/index.js';

/**
 * v0.12.1 — the loop-composition surface must stay importable from the
 * package ROOT. External post-run hooks (score with custom judges via
 * runMultiCritic criticPrompts, then drive the same evolution cycle) cannot
 * deep-import from dist/ — the package `exports` map blocks it — so removing
 * any of these from the root index is a breaking change for them.
 */
describe('root export surface — loop composition (v0.12.1)', () => {
  it('exports the evolution-loop composition surface', () => {
    assert.strictEqual(typeof buildEvolutionLoop, 'function');
    assert.strictEqual(typeof DarwinLoop, 'function');
    assert.strictEqual(typeof ExperimentTracker, 'function');
    assert.strictEqual(typeof PatternDetector, 'function');
    assert.strictEqual(typeof PromptOptimizer, 'function');
    assert.strictEqual(typeof SafetyGate, 'function');
  });

  it('keeps the post-run-hook companion surface exported', () => {
    assert.strictEqual(typeof runMultiCritic, 'function');
    assert.strictEqual(typeof createMemory, 'function');
    assert.strictEqual(typeof loadConfig, 'function');
    assert.strictEqual(typeof createProvider, 'function');
    assert.strictEqual(typeof loadNotificationConfig, 'function');
    assert.strictEqual(typeof createTraceCapture, 'function');
    assert.ok(builtinAgents && typeof builtinAgents === 'object');
  });

  it('buildEvolutionLoop composes a DarwinLoop instance (mock memory, no disk)', () => {
    const mockMemory = {} as Parameters<typeof buildEvolutionLoop>[2];
    const loop = buildEvolutionLoop(
      {
        name: 'export-smoke',
        role: 'smoke',
        description: 'root-export smoke agent',
        systemPrompt: 'noop',
        evolution: { enabled: false },
      },
      { provider: 'claude-cli', memory: 'sqlite' } as Parameters<typeof buildEvolutionLoop>[1],
      mockMemory,
    );
    assert.ok(loop instanceof DarwinLoop);
  });
});
