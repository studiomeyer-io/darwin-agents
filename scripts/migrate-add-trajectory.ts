#!/usr/bin/env npx tsx
/**
 * Darwin — Add Execution Trajectory Column (v0.5 / A1)
 *
 * Adds optional JSONB `trajectory` column + GIN index to `darwin_experiments`.
 * Pure additive — existing rows get `trajectory = NULL` (backward-compat).
 *
 * Run BEFORE deploying agent code that captures traces.
 *
 * Idempotent: ALTER TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe
 * to run repeatedly. Detects already-applied migration and exits 0 quickly.
 *
 * Usage:
 *   DARWIN_POSTGRES_URL=postgresql://user:pass@host:5432/darwin_db \
 *     npx tsx scripts/migrate-add-trajectory.ts
 *
 * Verify after run:
 *   psql $DARWIN_POSTGRES_URL -c "\d darwin_experiments" | grep trajectory
 *   psql $DARWIN_POSTGRES_URL -c "\di idx_darwin_exp_trajectory_gin"
 *
 * Rollback (only if absolutely needed — destroys captured traces):
 *   DROP INDEX IF EXISTS idx_darwin_exp_trajectory_gin;
 *   ALTER TABLE darwin_experiments DROP COLUMN IF EXISTS trajectory;
 */

import pg from 'pg';

const POSTGRES_URL = process.env.DARWIN_POSTGRES_URL;
if (!POSTGRES_URL) {
  console.error('Set DARWIN_POSTGRES_URL environment variable.');
  console.error(
    'Example: DARWIN_POSTGRES_URL=postgresql://matthiasmeyer:pw@localhost:5433/darwin_db',
  );
  process.exit(1);
}

async function migrate(): Promise<void> {
  const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 2 });

  try {
    console.log('=== Darwin — Add trajectory JSONB column ===\n');

    // ── Pre-Check: column already exists? ─────────────
    // Filter on `table_schema = current_schema()` so the pre-check stays
    // accurate in multi-schema setups (R1 Critic M3 — if Darwin is ever
    // hosted on a shared Postgres instance with multiple databases that
    // happen to use the same table name in another schema, we want to
    // scope to the active search_path schema, not match siblings).
    const existing = await pool.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = 'darwin_experiments'
         AND column_name = 'trajectory'
         AND table_schema = current_schema()`,
    );

    if (existing.rows.length > 0) {
      const dt = existing.rows[0].data_type;
      console.log(`✓ trajectory column already exists (data_type=${dt}) — nothing to add.`);
    } else {
      console.log('→ Adding trajectory column (JSONB, nullable)…');
      await pool.query(
        `ALTER TABLE darwin_experiments ADD COLUMN IF NOT EXISTS trajectory JSONB`,
      );
      console.log('✓ trajectory column added.\n');
    }

    // ── GIN index for JSONB containment queries ───────
    const idxExists = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'darwin_experiments' AND indexname = 'idx_darwin_exp_trajectory_gin'`,
    );

    if (idxExists.rows.length > 0) {
      console.log('✓ idx_darwin_exp_trajectory_gin already exists — nothing to add.');
    } else {
      console.log('→ Creating GIN index for trajectory (may take a moment on large tables)…');
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_darwin_exp_trajectory_gin
         ON darwin_experiments USING gin(trajectory)`,
      );
      console.log('✓ idx_darwin_exp_trajectory_gin created.\n');
    }

    // ── Verify ─────────────────────────────────────────
    const verify = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE trajectory IS NULL) AS without_trajectory,
         COUNT(*) FILTER (WHERE trajectory IS NOT NULL) AS with_trajectory,
         COUNT(*) AS total
       FROM darwin_experiments`,
    );
    const row = verify.rows[0];
    console.log('=== Migration complete ===');
    console.log(`  total experiments:   ${row.total}`);
    console.log(`  with trajectory:     ${row.with_trajectory}`);
    console.log(`  without trajectory:  ${row.without_trajectory} (legacy — fine)`);
  } catch (err) {
    console.error('\n✗ Migration failed:', (err as Error).message);
    throw err;
  } finally {
    await pool.end();
  }
}

migrate()
  .then(() => {
    console.log('\n✓ Done. Agents may now write trajectory data on next run.');
    process.exit(0);
  })
  .catch(() => process.exit(1));
