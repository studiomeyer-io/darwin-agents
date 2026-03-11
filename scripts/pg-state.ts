#!/usr/bin/env npx tsx
import { PostgresMemoryProvider } from '../src/memory/postgres-memory.js';

async function main(): Promise<void> {
  const pg = new PostgresMemoryProvider({
    provider: 'claude-cli',
    memory: 'postgres',
    postgresUrl: process.env.DARWIN_POSTGRES_URL!,
  });
  await pg.init();

  const state = await pg.getState();
  console.log('Active version:', state.activeVersions?.writer);
  console.log('A/B test:', JSON.stringify(state.abTests?.writer, null, 2));
  console.log('Experiment counts:', JSON.stringify(state.experimentCounts));
  console.log('Last known good:', JSON.stringify(state.lastKnownGood));

  // Count experiments per version in PG
  const v1Exps = await pg.loadExperiments('writer', 10000);
  const v1Count = v1Exps.filter(e => e.promptVersion === 'v1').length;
  const v2Count = v1Exps.filter(e => e.promptVersion === 'v2').length;
  console.log(`\nPG experiments: v1=${v1Count}, v2=${v2Count}, total=${v1Exps.length}`);

  // Active prompt
  const active = await pg.getActivePrompt('writer');
  console.log(`Active prompt: ${active?.version} (${active?.promptText.length} chars)`);

  await pg.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
