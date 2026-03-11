import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DARWIN_POSTGRES_URL });

async function main() {
  const r1 = await pool.query("SELECT COUNT(*) as total FROM darwin_experiments WHERE agent_name = $1", ['writer']);
  console.log('Total experiments:', r1.rows[0].total);

  const r2 = await pool.query("SELECT version, COUNT(*) as cnt, ROUND(AVG(score)::numeric, 2) as avg_score FROM darwin_experiments WHERE agent_name = $1 GROUP BY version ORDER BY version", ['writer']);
  console.log('\nBy version:');
  r2.rows.forEach((r: any) => console.log(`  v${r.version}: ${r.cnt} runs, avg ${r.avg_score}`));

  const r3 = await pool.query("SELECT id, version_a, version_b, status, winner, started_at FROM darwin_ab_tests WHERE agent_name = $1 ORDER BY started_at DESC LIMIT 5", ['writer']);
  console.log('\nA/B tests:');
  r3.rows.forEach((r: any) => console.log(`  v${r.version_a} vs v${r.version_b}: ${r.status} (winner: ${r.winner || 'pending'}) started ${r.started_at}`));

  const r4 = await pool.query("SELECT version, is_active, ROUND(avg_score::numeric, 2) as score FROM darwin_prompts WHERE agent_name = $1 ORDER BY version", ['writer']);
  console.log('\nPrompts:');
  r4.rows.forEach((r: any) => console.log(`  v${r.version}: active=${r.is_active}, score=${r.score}`));

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
