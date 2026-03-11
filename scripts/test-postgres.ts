#!/usr/bin/env npx tsx
/**
 * Quick test: PostgreSQL Memory Provider connection + CRUD
 */

import { PostgresMemoryProvider } from '../src/memory/postgres-memory.js';

const POSTGRES_URL = process.env.DARWIN_POSTGRES_URL ?? 'postgresql://localhost:5432/darwin_db';

async function main(): Promise<void> {
  const pg = new PostgresMemoryProvider({
    provider: 'claude-cli',
    memory: 'postgres',
    postgresUrl: POSTGRES_URL,
  });

  await pg.init();
  console.log('✓ Connected + tables created');

  // Test state round-trip
  const state = await pg.getState();
  console.log('✓ getState():', JSON.stringify(state).slice(0, 80));

  // Test updateState atomicity
  const updated = await pg.updateState(s => ({
    ...s,
    experimentCounts: { ...s.experimentCounts, _test_: 1 },
  }));
  console.log('✓ updateState():', JSON.stringify(updated.experimentCounts));

  // Clean up test entry
  await pg.updateState(s => {
    delete s.experimentCounts._test_;
    return s;
  });
  console.log('✓ Cleanup done');

  await pg.close();
  console.log('✓ All PostgreSQL tests passed');
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
