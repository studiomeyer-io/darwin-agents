/**
 * Tests for the persisted evolution enable/disable toggle (item 1).
 *
 * Before the fix, `darwin evolve <agent> --enable` only mutated the in-memory
 * agent singleton (`agent.evolution.enabled = true`) and never persisted it, so
 * the flag was lost on process exit and `darwin run` read the static source
 * default again. The fix records the override in `DarwinState.evolutionEnabled`
 * (round-tripped by every backend) and resolves the effective value with the
 * persisted override winning over the static default.
 *
 * Coverage:
 *   - resolveEvolutionEnabled: persisted wins, missing → static default,
 *     persisted-true on an agent without an evolution block is a no-op,
 *     persisted-false always disables
 *   - setEvolutionEnabled: persists across a FRESH provider load against the
 *     same SQLite file (proves it survives process exit) — both directions
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteMemoryProvider } from '../src/memory/sqlite-memory.js';
import { resolveEvolutionEnabled, setEvolutionEnabled } from '../src/evolution/enabled-state.js';
import type { AgentDefinition, DarwinConfig, DarwinState } from '../src/types.js';

const enabledAgent: AgentDefinition = {
  name: 'writer',
  role: 'Content Writer',
  description: 'writes',
  systemPrompt: 'You write.',
  evolution: { enabled: true, evaluator: 'critic' },
};

const disabledAgent: AgentDefinition = {
  name: 'critic',
  role: 'Critic',
  description: 'judges',
  systemPrompt: 'You judge.',
  evolution: { enabled: false },
};

const noEvolutionAgent: AgentDefinition = {
  name: 'plain',
  role: 'Plain',
  description: 'no evolution config',
  systemPrompt: 'You do a thing.',
};

function emptyState(overrides: Partial<DarwinState> = {}): DarwinState {
  return {
    activeVersions: {},
    abTests: {},
    lastKnownGood: {},
    consecutiveFailures: {},
    experimentCounts: {},
    evolutionEnabled: {},
    ...overrides,
  };
}

// ─── resolveEvolutionEnabled (pure) ─────────────────

describe('resolveEvolutionEnabled', () => {
  it('falls back to the static default when no override is persisted', () => {
    assert.equal(resolveEvolutionEnabled(enabledAgent, emptyState()), true);
    assert.equal(resolveEvolutionEnabled(disabledAgent, emptyState()), false);
  });

  it('falls back to the static default when the evolutionEnabled map is absent (legacy state row)', () => {
    // Simulate a state blob written before the field existed.
    const legacy = emptyState();
    delete (legacy as { evolutionEnabled?: unknown }).evolutionEnabled;
    assert.equal(resolveEvolutionEnabled(enabledAgent, legacy), true);
    assert.equal(resolveEvolutionEnabled(disabledAgent, legacy), false);
  });

  it('lets a persisted override WIN over the static default in both directions', () => {
    // Persisted disable beats a static enable...
    assert.equal(
      resolveEvolutionEnabled(enabledAgent, emptyState({ evolutionEnabled: { writer: false } })),
      false,
    );
    // ...and persisted enable beats a static disable.
    assert.equal(
      resolveEvolutionEnabled(disabledAgent, emptyState({ evolutionEnabled: { critic: true } })),
      true,
    );
  });

  it('treats a persisted enable on an agent without an evolution block as a no-op (not a crash)', () => {
    assert.equal(
      resolveEvolutionEnabled(noEvolutionAgent, emptyState({ evolutionEnabled: { plain: true } })),
      false,
    );
  });

  it('only resolves per-agent — an override for one agent does not leak to another', () => {
    const state = emptyState({ evolutionEnabled: { writer: false } });
    assert.equal(resolveEvolutionEnabled(enabledAgent, state), false);
    assert.equal(resolveEvolutionEnabled(disabledAgent, state), false); // critic: static default
  });
});

// ─── setEvolutionEnabled persistence (real SQLite, fresh reload) ───

describe('setEvolutionEnabled — persists across a fresh state load', () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'darwin-evolve-enable-test-'));
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeProvider(): SqliteMemoryProvider {
    const cfg: DarwinConfig = { provider: 'claude-cli', memory: 'sqlite', dataDir: tempDir };
    return new SqliteMemoryProvider(cfg);
  }

  it('a persisted --enable survives reopening the DB (the v0.7.1 bug)', async () => {
    // Write the override with one provider, then drop it entirely.
    const writer1 = makeProvider();
    await writer1.init();
    // Sanity: the critic ships with evolution disabled by default.
    assert.equal(resolveEvolutionEnabled(disabledAgent, await writer1.getState()), false);
    await setEvolutionEnabled(writer1, 'critic', true);
    await writer1.close();

    // FRESH provider against the same file — mirrors a brand-new process that
    // only has the static source default unless the flag was persisted.
    const reader = makeProvider();
    await reader.init();
    const reloaded = await reader.getState();
    assert.equal(reloaded.evolutionEnabled?.critic, true);
    assert.equal(
      resolveEvolutionEnabled(disabledAgent, reloaded),
      true,
      'enable must persist across a fresh state load',
    );
    await reader.close();
  });

  it('a persisted --disable also survives and overrides a static enable', async () => {
    const writer2 = makeProvider();
    await writer2.init();
    await setEvolutionEnabled(writer2, 'writer', false);
    await writer2.close();

    const reader = makeProvider();
    await reader.init();
    const reloaded = await reader.getState();
    assert.equal(reloaded.evolutionEnabled?.writer, false);
    assert.equal(
      resolveEvolutionEnabled(enabledAgent, reloaded),
      false,
      'disable must persist and beat the static enabled:true default',
    );
    await reader.close();
  });
});
