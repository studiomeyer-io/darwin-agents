#!/usr/bin/env npx tsx
/**
 * Reset the writer A/B test result — v2 won through a composite score bug
 * (all-time data instead of A/B-period-only). Revert to v1 as active.
 */

import { PostgresMemoryProvider } from '../src/memory/postgres-memory.js';

async function main(): Promise<void> {
  const pg = new PostgresMemoryProvider({
    provider: 'claude-cli',
    memory: 'postgres',
    postgresUrl: process.env.DARWIN_POSTGRES_URL!,
  });
  await pg.init();

  // Reset state: v1 active, no A/B test, clear lastKnownGood
  await pg.updateState(s => ({
    ...s,
    activeVersions: { ...s.activeVersions, writer: 'v1' },
    abTests: { ...s.abTests, writer: null },
    lastKnownGood: { ...s.lastKnownGood, writer: 'v1' },
  }));

  // Set v1 prompt as active, v2 as inactive
  const versions = await pg.getAllPromptVersions('writer');
  for (const pv of versions) {
    const shouldBeActive = pv.version === 'v1';
    if (pv.active !== shouldBeActive) {
      pv.active = shouldBeActive;
      await pg.savePromptVersion(pv);
      console.log(`${pv.version}: active=${shouldBeActive}`);
    }
  }

  const state = await pg.getState();
  console.log('Active version:', state.activeVersions.writer);
  console.log('A/B test:', state.abTests.writer);

  await pg.close();
  console.log('✓ Reset complete — v1 is active, ready for next evolution cycle');
}

main().catch(e => { console.error(e.message); process.exit(1); });
