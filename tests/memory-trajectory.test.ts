/**
 * Tests for trajectory persistence in the SQLite memory provider.
 *
 * Coverage:
 *   - SQLite roundtrip: write trajectory, load it back unchanged
 *   - backward-compat: experiment WITHOUT trajectory still saves + loads
 *   - defensive parsing: malformed JSON / wrong version / wrong type
 *     in the column produces trajectory=undefined (no crash)
 *   - additive migration: PRAGMA table_info detects existing column and
 *     skips ADD COLUMN on re-init
 *
 * Postgres roundtrip is gated by DARWIN_POSTGRES_URL — when unset, the
 * Postgres tests are skipped so this file runs in CI without a DB server.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteMemoryProvider } from '../src/memory/sqlite-memory.js';
import { createTraceCapture } from '../src/core/trace-capture.js';
import type { DarwinConfig, DarwinExperiment, ExecutionTrace } from '../src/types.js';

// Re-usable trajectory factory.
function makeTrajectory(): ExecutionTrace {
  const cap = createTraceCapture({ now: (() => { let t = 1_700_000_000_000; return () => (t += 50); })() });
  cap.startTurn();
  cap.recordTextBlock();
  cap.recordToolUse('id1', 'mcp__nex__search', { query: 'darwin' });
  cap.recordToolResult('id1', 'success', { resultSummary: '5 hits' });
  cap.recordToolUse('id2', 'Read', { file: 'README.md' });
  cap.recordToolResult('id2', 'error', { errorClass: 'enoent', errorMessage: 'not found' });
  return cap.finalize();
}

function makeExp(overrides: Partial<DarwinExperiment> = {}): DarwinExperiment {
  return {
    id: overrides.id ?? `exp-trajectory-${Math.random().toString(36).slice(2, 10)}`,
    agentName: 'researcher',
    promptVersion: 'v1',
    task: 'trajectory roundtrip test',
    taskType: 'general',
    startedAt: new Date(Date.now() - 1000).toISOString(),
    completedAt: new Date().toISOString(),
    success: true,
    metrics: {
      qualityScore: 7,
      sourceCount: 1,
      outputLength: 5000,
      errorCount: 0,
      durationMs: 1000,
    },
    output: 'trajectory test output',
    ...overrides,
  };
}

// ─── SQLite ──────────────────────────────────────────

describe('SqliteMemoryProvider — trajectory column', () => {
  let tempDir: string;
  let memory: SqliteMemoryProvider;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'darwin-trajectory-test-'));
    const cfg: DarwinConfig = {
      provider: 'claude-cli',
      memory: 'sqlite',
      dataDir: tempDir,
    };
    memory = new SqliteMemoryProvider(cfg);
    await memory.init();
  });

  after(async () => {
    await memory.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('roundtrips a trajectory unchanged', async () => {
    const trajectory = makeTrajectory();
    const exp = makeExp({ id: 'exp-roundtrip-1', trajectory });
    await memory.saveExperiment(exp);

    const loaded = await memory.loadExperiments('researcher');
    const found = loaded.find((e) => e.id === 'exp-roundtrip-1');
    assert.ok(found, 'experiment must round-trip');
    assert.ok(found.trajectory, 'trajectory must survive roundtrip');
    assert.equal(found.trajectory.version, 1);
    assert.equal(found.trajectory.toolCalls.length, 2);
    assert.equal(found.trajectory.toolCalls[0].tool, 'mcp__nex__search');
    assert.equal(found.trajectory.toolCalls[1].outcome, 'error');
    assert.equal(found.trajectory.toolCalls[1].errorClass, 'enoent');
    assert.equal(found.trajectory.mcpInvocations, 1);
    assert.equal(found.trajectory.textBlockCount, 1);
    assert.equal(found.trajectory.turnCount, 1);
  });

  it('backward-compat: experiment WITHOUT trajectory still saves + loads', async () => {
    const exp = makeExp({ id: 'exp-no-trajectory-1' });
    delete exp.trajectory;
    await memory.saveExperiment(exp);

    const loaded = await memory.loadExperiments('researcher');
    const found = loaded.find((e) => e.id === 'exp-no-trajectory-1');
    assert.ok(found, 'experiment without trajectory must still roundtrip');
    assert.equal(found.trajectory, undefined, 'missing trajectory must be undefined, not {} or null');
  });

  it('UPDATE preserves NULL trajectory column (INSERT OR REPLACE)', async () => {
    // INSERT OR REPLACE means we drop + re-insert; callers who want to
    // preserve trajectory on update must include it in the payload.
    // This test documents the (acceptable) behaviour so the contract is explicit.
    const trajectory = makeTrajectory();
    await memory.saveExperiment(makeExp({ id: 'exp-replace', trajectory }));
    await memory.saveExperiment(makeExp({ id: 'exp-replace', output: 'updated, no trajectory' }));
    const loaded = await memory.loadExperiments('researcher');
    const found = loaded.find((e) => e.id === 'exp-replace');
    assert.ok(found);
    assert.equal(found.output, 'updated, no trajectory');
    assert.equal(found.trajectory, undefined, 'INSERT OR REPLACE dropped the trajectory — documented behaviour');
  });

  it('defensive parse: rejects wrong version', async () => {
    // Simulate a future schema by writing the column directly.
    // (We bypass saveExperiment to inject the malformed value.)
    const internalDb = (memory as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db;
    internalDb
      .prepare(
        `INSERT INTO experiments (id, agent_name, prompt_version, task, task_type, started_at, completed_at, success, output, trajectory)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        'exp-bad-version',
        'researcher',
        'v1',
        'malformed test',
        'general',
        new Date().toISOString(),
        new Date().toISOString(),
        'ignored',
        JSON.stringify({ version: 999, toolCalls: [] }),
      );
    const loaded = await memory.loadExperiments('researcher');
    const found = loaded.find((e) => e.id === 'exp-bad-version');
    assert.ok(found);
    assert.equal(found.trajectory, undefined, 'wrong version must be dropped silently');
  });

  it('defensive parse: rejects malformed JSON', async () => {
    const internalDb = (memory as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db;
    internalDb
      .prepare(
        `INSERT INTO experiments (id, agent_name, prompt_version, task, task_type, started_at, completed_at, success, output, trajectory)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        'exp-bad-json',
        'researcher',
        'v1',
        'malformed test',
        'general',
        new Date().toISOString(),
        new Date().toISOString(),
        'ignored',
        '{this is not valid json',
      );
    const loaded = await memory.loadExperiments('researcher');
    const found = loaded.find((e) => e.id === 'exp-bad-json');
    assert.ok(found);
    assert.equal(found.trajectory, undefined, 'malformed JSON must be dropped silently');
  });

  it('migration is idempotent: re-init does not duplicate the column', async () => {
    // Calling init() on a fresh SqliteMemoryProvider against the same path
    // (after close) should detect the column and skip ADD COLUMN.
    await memory.close();
    const cfg: DarwinConfig = { provider: 'claude-cli', memory: 'sqlite', dataDir: tempDir };
    const memory2 = new SqliteMemoryProvider(cfg);
    await memory2.init(); // should NOT throw "duplicate column"

    const exp = makeExp({ id: 'exp-after-reinit', trajectory: makeTrajectory() });
    await memory2.saveExperiment(exp);
    const loaded = await memory2.loadExperiments('researcher');
    assert.ok(loaded.find((e) => e.id === 'exp-after-reinit')?.trajectory);

    await memory2.close();
    // Re-open the original `memory` reference for the after() hook.
    memory = new SqliteMemoryProvider(cfg);
    await memory.init();
  });
});

// ─── Postgres (gated) ────────────────────────────────

describe('PostgresMemoryProvider — trajectory column (gated)', () => {
  const PG_URL = process.env.DARWIN_POSTGRES_URL;
  if (!PG_URL) {
    it.skip('skipped — DARWIN_POSTGRES_URL not set', () => {});
    return;
  }

  it('JSONB roundtrip preserves the trajectory object', async () => {
    // `pg` is a peer-dep — skip cleanly if not installed (OS-test scenario,
    // where the package consumer hasn't `npm install pg`'d yet).
    try {
      await import('pg');
    } catch {
      console.warn('  [skip] `pg` not installed — `npm install pg` to run Postgres tests');
      return;
    }
    const { PostgresMemoryProvider } = await import('../src/memory/postgres-memory.js');
    const cfg: DarwinConfig = {
      provider: 'claude-cli',
      memory: 'postgres',
      postgresUrl: PG_URL,
    };
    const pg = new PostgresMemoryProvider(cfg);
    await pg.init();

    try {
      const trajectory = makeTrajectory();
      const exp = makeExp({
        id: `exp-pg-trajectory-${Date.now()}`,
        agentName: 'researcher',
        trajectory,
      });
      await pg.saveExperiment(exp);

      const loaded = await pg.loadExperiments('researcher', 50);
      const found = loaded.find((e) => e.id === exp.id);
      assert.ok(found, 'experiment must roundtrip via Postgres');
      assert.ok(found.trajectory, 'trajectory survives JSONB roundtrip');
      assert.equal(found.trajectory.version, 1);
      assert.equal(found.trajectory.toolCalls.length, 2);
    } finally {
      await pg.close();
    }
  });
});
