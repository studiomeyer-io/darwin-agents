#!/usr/bin/env npx tsx
import { PostgresMemoryProvider } from '../src/memory/postgres-memory.js';

async function main(): Promise<void> {
  const pg = new PostgresMemoryProvider({
    provider: 'claude-cli',
    memory: 'postgres',
    postgresUrl: process.env.DARWIN_POSTGRES_URL!,
  });
  await pg.init();

  const exps = await pg.loadExperiments('writer', 3);
  console.log('=== Latest 3 Writer Experiments (PostgreSQL) ===');
  for (const e of exps) {
    console.log(`  ${e.id} | ${e.taskType} | score=${e.metrics.qualityScore} | ${e.metrics.outputLength} chars | ${e.promptVersion}`);
  }

  const total = await pg.loadExperiments('writer', 10000);
  console.log(`\nTotal writer experiments in PG: ${total.length}`);

  await pg.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
