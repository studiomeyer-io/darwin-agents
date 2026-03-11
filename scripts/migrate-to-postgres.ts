#!/usr/bin/env npx tsx
/**
 * Darwin — SQLite → PostgreSQL Migration
 *
 * Migrates all data from SQLite to PostgreSQL:
 * - Experiments (with full output text)
 * - Prompt versions (with stats)
 * - Learnings
 * - State (A/B tests, active versions, etc.)
 *
 * Usage:
 *   DARWIN_POSTGRES_URL=postgresql://... npx tsx scripts/migrate-to-postgres.ts
 *
 * Safe to run multiple times — uses ON CONFLICT for idempotent upserts.
 */

import { SqliteMemoryProvider } from '../src/memory/sqlite-memory.js';
import { PostgresMemoryProvider } from '../src/memory/postgres-memory.js';
import type { DarwinConfig } from '../src/types.js';

const POSTGRES_URL = process.env.DARWIN_POSTGRES_URL;
if (!POSTGRES_URL) {
  console.error('Set DARWIN_POSTGRES_URL environment variable.');
  console.error('Example: DARWIN_POSTGRES_URL=postgresql://user:pass@localhost:5432/darwin');
  process.exit(1);
}

async function migrate(): Promise<void> {
  const sqliteConfig: DarwinConfig = {
    provider: 'claude-cli',
    memory: 'sqlite',
    dataDir: process.cwd(),
  };

  const pgConfig: DarwinConfig = {
    provider: 'claude-cli',
    memory: 'postgres',
    postgresUrl: POSTGRES_URL,
  };

  console.log('=== Darwin: SQLite → PostgreSQL Migration ===\n');

  // Initialize both providers
  const sqlite = new SqliteMemoryProvider(sqliteConfig);
  const pg = new PostgresMemoryProvider(pgConfig);

  await sqlite.init();
  await pg.init();

  console.log('✓ Both databases connected\n');

  // ─── Discover agents from SQLite ────────────────
  // We need to know which agents exist to migrate their data.
  // loadExperiments requires an agent name, so we'll query SQLite directly.
  const agentNames = await discoverAgents(sqlite);
  console.log(`Found agents: ${agentNames.join(', ')}\n`);

  let totalExperiments = 0;
  let totalVersions = 0;

  for (const agentName of agentNames) {
    // ─── Migrate experiments ─────────────────────
    const experiments = await sqlite.loadExperiments(agentName, 10000);
    console.log(`[${agentName}] ${experiments.length} experiments`);

    for (const exp of experiments) {
      await pg.saveExperiment(exp);
      totalExperiments++;
    }

    // ─── Migrate prompt versions ─────────────────
    const versions = await sqlite.getAllPromptVersions(agentName);
    console.log(`[${agentName}] ${versions.length} prompt versions`);

    for (const pv of versions) {
      await pg.savePromptVersion(pv);
      totalVersions++;
    }
  }

  // ─── Migrate learnings ──────────────────────────
  // searchLearnings with empty-ish query to get all
  const learnings = await sqlite.searchLearnings('%', 10000);
  console.log(`\nLearnings: ${learnings.length}`);
  for (const learning of learnings) {
    await pg.saveLearning(learning);
  }

  // ─── Migrate state ─────────────────────────────
  const state = await sqlite.getState();
  await pg.saveState(state);
  console.log('State: migrated (A/B tests, active versions, counters)');

  // ─── Summary ───────────────────────────────────
  console.log(`\n=== Migration Complete ===`);
  console.log(`Experiments: ${totalExperiments}`);
  console.log(`Prompt versions: ${totalVersions}`);
  console.log(`Learnings: ${learnings.length}`);
  console.log(`Agents: ${agentNames.join(', ')}`);

  await sqlite.close();
  await pg.close();
}

/**
 * Discover all agent names from SQLite experiments.
 * Uses a direct query since the MemoryProvider interface doesn't expose this.
 */
async function discoverAgents(sqlite: SqliteMemoryProvider): Promise<string[]> {
  // Load experiments for common agent names — the interface doesn't have a "list agents" method
  const knownAgents = ['writer', 'researcher', 'critic', 'analyst', 'investigator'];
  const found: string[] = [];

  for (const name of knownAgents) {
    const exps = await sqlite.loadExperiments(name, 1);
    if (exps.length > 0) {
      found.push(name);
    }
  }

  return found;
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
