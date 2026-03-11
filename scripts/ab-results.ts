#!/usr/bin/env npx tsx
/**
 * Show detailed A/B test results.
 */
import { PostgresMemoryProvider } from '../src/memory/postgres-memory.js';

async function main(): Promise<void> {
  const pg = new PostgresMemoryProvider({
    provider: 'claude-cli',
    memory: 'postgres',
    postgresUrl: process.env.DARWIN_POSTGRES_URL ?? '',
  });
  await pg.init();

  const versions = await pg.getAllPromptVersions('writer');
  for (const v of versions) {
    console.log(`--- ${v.version} ---`);
    console.log('Active:', v.active);
    console.log('Stats:', JSON.stringify(v.stats));
    console.log('Change reason:', v.changeReason);
    console.log('Prompt (first 300):', v.promptText.substring(0, 300));
    console.log();
  }

  const exps = await pg.loadExperiments('writer');
  const sorted = [...exps].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const last30 = sorted.slice(-30);
  const v1AB = last30.filter((e) => e.promptVersion === 'v1');
  const v2AB = last30.filter((e) => e.promptVersion === 'v2');

  console.log('=== Recent A/B Period Stats (last 30 runs) ===');
  if (v1AB.length > 0) {
    const avgQ1 = v1AB.reduce((s, e) => s + e.metrics.qualityScore, 0) / v1AB.length;
    const avgO1 = v1AB.reduce((s, e) => s + e.metrics.outputLength, 0) / v1AB.length;
    const avgD1 = v1AB.reduce((s, e) => s + e.metrics.durationMs, 0) / v1AB.length;
    console.log(`v1: ${v1AB.length} runs | quality: ${avgQ1.toFixed(2)} | output: ${avgO1.toFixed(0)} | duration: ${(avgD1 / 1000).toFixed(0)}s`);
  }
  if (v2AB.length > 0) {
    const avgQ2 = v2AB.reduce((s, e) => s + e.metrics.qualityScore, 0) / v2AB.length;
    const avgO2 = v2AB.reduce((s, e) => s + e.metrics.outputLength, 0) / v2AB.length;
    const avgD2 = v2AB.reduce((s, e) => s + e.metrics.durationMs, 0) / v2AB.length;
    console.log(`v2: ${v2AB.length} runs | quality: ${avgQ2.toFixed(2)} | output: ${avgO2.toFixed(0)} | duration: ${(avgD2 / 1000).toFixed(0)}s`);
  }

  // All-time stats
  const allV1 = exps.filter((e) => e.promptVersion === 'v1');
  const allV2 = exps.filter((e) => e.promptVersion === 'v2');
  console.log('\n=== All-Time Stats ===');
  console.log(`v1: ${allV1.length} runs total`);
  console.log(`v2: ${allV2.length} runs total`);
  console.log(`Total experiments: ${exps.length}`);

  await pg.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
