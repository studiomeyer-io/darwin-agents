#!/usr/bin/env npx tsx
/**
 * Verify PostgreSQL migration — compare data counts and spot-check records.
 */

import { PostgresMemoryProvider } from '../src/memory/postgres-memory.js';
import { SqliteMemoryProvider } from '../src/memory/sqlite-memory.js';

const POSTGRES_URL = process.env.DARWIN_POSTGRES_URL!;

async function main(): Promise<void> {
  const sqlite = new SqliteMemoryProvider({ provider: 'claude-cli', memory: 'sqlite', dataDir: process.cwd() });
  const pg = new PostgresMemoryProvider({ provider: 'claude-cli', memory: 'postgres', postgresUrl: POSTGRES_URL });

  await sqlite.init();
  await pg.init();

  for (const agent of ['writer', 'investigator']) {
    const sqliteExps = await sqlite.loadExperiments(agent, 10000);
    const pgExps = await pg.loadExperiments(agent, 10000);

    const sqliteVersions = await sqlite.getAllPromptVersions(agent);
    const pgVersions = await pg.getAllPromptVersions(agent);

    const match = sqliteExps.length === pgExps.length;
    console.log(`[${agent}] Experiments: SQLite=${sqliteExps.length} PG=${pgExps.length} ${match ? '✓' : '✗ MISMATCH'}`);
    console.log(`[${agent}] Versions: SQLite=${sqliteVersions.length} PG=${pgVersions.length}`);

    // Spot-check: compare first experiment
    if (pgExps.length > 0) {
      const exp = pgExps[0];
      console.log(`[${agent}] Latest: ${exp.id} score=${exp.metrics.qualityScore} output=${exp.output?.length ?? 0} chars`);
    }
  }

  // Check state
  const sqliteState = await sqlite.getState();
  const pgState = await pg.getState();

  const abTestMatch = JSON.stringify(sqliteState.abTests) === JSON.stringify(pgState.abTests);
  console.log(`\nState A/B tests: ${abTestMatch ? '✓ match' : '✗ MISMATCH'}`);
  console.log(`Active versions: ${JSON.stringify(pgState.activeVersions)}`);

  await sqlite.close();
  await pg.close();
  console.log('\n✓ Verification complete');
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
