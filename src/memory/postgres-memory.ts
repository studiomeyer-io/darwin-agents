/**
 * Darwin — PostgreSQL Memory Provider
 *
 * Production-grade storage for experiments, prompt versions, learnings, and state.
 * Uses node-postgres (pg) with connection pooling. No ORM, no extra deps.
 *
 * Features over SQLite:
 * - Connection pooling (concurrent agents)
 * - Full-text search via tsvector (no FTS5 equivalent needed)
 * - JSONB for state (queryable, indexable)
 * - TIMESTAMPTZ for proper timezone handling
 * - Row-level locking for updateState() atomicity
 *
 * Requires: DARWIN_POSTGRES_URL or config.postgresUrl
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DarwinExperiment,
  DarwinState,
  Learning,
  MemoryProvider,
  PromptVersion,
  PromptVersionStats,
  DarwinConfig,
} from '../types.js';

const { Pool } = pg;

// ─── Default state for fresh installs ─────────────────

const DEFAULT_STATE: DarwinState = {
  activeVersions: {},
  abTests: {},
  lastKnownGood: {},
  consecutiveFailures: {},
  experimentCounts: {},
};

// ─── PostgreSQL Memory Provider ───────────────────────

export class PostgresMemoryProvider implements MemoryProvider {
  private pool: pg.Pool | null = null;
  private readonly connectionString: string;
  private readonly dataDir: string;

  constructor(config: DarwinConfig) {
    const url = config.postgresUrl ?? process.env.DARWIN_POSTGRES_URL;
    if (!url) {
      throw new Error(
        'PostgreSQL connection string required. Set DARWIN_POSTGRES_URL or config.postgresUrl.',
      );
    }
    this.connectionString = url;
    this.dataDir = config.dataDir ?? process.cwd();
  }

  // ─── Lifecycle ────────────────────────────────────

  async init(): Promise<void> {
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // Verify connection
    const client = await this.pool.connect();
    try {
      await this.createTables(client);
    } finally {
      client.release();
    }

    // Auto-migrate from SQLite if the postgres DB is empty but SQLite data exists.
    // This prevents data loss when switching from sqlite to postgres:
    // without migration, the system re-seeds v1 and loses v2→v3 history.
    await this.autoMigrateFromSqlite();
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  // ─── Experiments ──────────────────────────────────

  async saveExperiment(exp: DarwinExperiment): Promise<void> {
    const pool = this.getPool();

    await pool.query(
      `INSERT INTO darwin_experiments (
        id, agent_name, prompt_version, task, task_type,
        started_at, completed_at, success,
        quality_score, source_count, output_length, error_count, duration_ms,
        feedback_score, feedback_report, feedback_evaluator, output
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (id) DO UPDATE SET
        quality_score = EXCLUDED.quality_score,
        feedback_score = EXCLUDED.feedback_score,
        feedback_report = EXCLUDED.feedback_report,
        feedback_evaluator = EXCLUDED.feedback_evaluator,
        output = EXCLUDED.output`,
      [
        exp.id,
        exp.agentName,
        exp.promptVersion,
        exp.task,
        exp.taskType,
        exp.startedAt,
        exp.completedAt,
        exp.success,
        exp.metrics.qualityScore,
        exp.metrics.sourceCount,
        exp.metrics.outputLength,
        exp.metrics.errorCount,
        exp.metrics.durationMs,
        exp.feedback?.score ?? null,
        exp.feedback?.report ?? null,
        exp.feedback?.evaluator ?? null,
        exp.output ?? null,
      ],
    );
  }

  async loadExperiments(agentName: string, limit = 50): Promise<DarwinExperiment[]> {
    const pool = this.getPool();

    const { rows } = await pool.query(
      `SELECT * FROM darwin_experiments
       WHERE agent_name = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [agentName, limit],
    );

    return rows.map(rowToExperiment);
  }

  // ─── Prompt Versions ──────────────────────────────

  async savePromptVersion(pv: PromptVersion): Promise<void> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      if (pv.active) {
        await client.query(
          `UPDATE darwin_prompt_versions SET active = false WHERE agent_name = $1`,
          [pv.agentName],
        );
      }

      await client.query(
        `INSERT INTO darwin_prompt_versions (
          version, agent_name, prompt_text, created_at, parent_version,
          change_reason, active, total_runs, avg_quality, avg_duration,
          success_rate, avg_source_count
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (agent_name, version) DO UPDATE SET
          prompt_text = EXCLUDED.prompt_text,
          active = EXCLUDED.active,
          change_reason = EXCLUDED.change_reason,
          total_runs = EXCLUDED.total_runs,
          avg_quality = EXCLUDED.avg_quality,
          avg_duration = EXCLUDED.avg_duration,
          success_rate = EXCLUDED.success_rate,
          avg_source_count = EXCLUDED.avg_source_count`,
        [
          pv.version,
          pv.agentName,
          pv.promptText,
          pv.createdAt,
          pv.parentVersion,
          pv.changeReason,
          pv.active,
          pv.stats.totalRuns,
          pv.stats.avgQuality,
          pv.stats.avgDuration,
          pv.stats.successRate,
          pv.stats.avgSourceCount,
        ],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getActivePrompt(agentName: string): Promise<PromptVersion | null> {
    const pool = this.getPool();

    const { rows } = await pool.query(
      `SELECT * FROM darwin_prompt_versions
       WHERE active = true AND agent_name = $1`,
      [agentName],
    );

    return rows.length > 0 ? rowToPromptVersion(rows[0]) : null;
  }

  async getAllPromptVersions(agentName: string): Promise<PromptVersion[]> {
    const pool = this.getPool();

    const { rows } = await pool.query(
      `SELECT * FROM darwin_prompt_versions
       WHERE agent_name = $1
       ORDER BY created_at`,
      [agentName],
    );

    return rows.map(rowToPromptVersion);
  }

  // ─── Learnings ────────────────────────────────────

  async saveLearning(learning: Learning): Promise<void> {
    const pool = this.getPool();

    const id = learning.id ?? randomUUID();
    const tags = JSON.stringify(learning.tags);
    const confidence = learning.confidence ?? 0.8;

    await pool.query(
      `INSERT INTO darwin_learnings (id, agent_name, content, category, tags, confidence)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, learning.agentName, learning.content, learning.category, tags, confidence],
    );
  }

  async searchLearnings(query: string, limit = 20): Promise<Learning[]> {
    const pool = this.getPool();

    // PostgreSQL full-text search with ts_rank
    const { rows } = await pool.query(
      `SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
       FROM darwin_learnings
       WHERE search_vector @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`,
      [query, limit],
    );

    if (rows.length > 0) {
      return rows.map(rowToLearning);
    }

    // Fallback: ILIKE search (handles partial matches, non-English).
    // Escape LIKE-special characters to prevent query chars like % and _ from
    // acting as wildcards (not a security issue with parameterized queries,
    // but causes unexpected match behavior).
    const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
    const { rows: likeRows } = await pool.query(
      `SELECT * FROM darwin_learnings
       WHERE content ILIKE $1 ESCAPE '\\' OR tags ILIKE $1 ESCAPE '\\'
       ORDER BY created_at DESC
       LIMIT $2`,
      [`%${escapedQuery}%`, limit],
    );

    return likeRows.map(rowToLearning);
  }

  // ─── State ────────────────────────────────────────

  async getState(): Promise<DarwinState> {
    const pool = this.getPool();

    const { rows } = await pool.query(
      `SELECT value FROM darwin_state WHERE key = $1`,
      ['darwin_state'],
    );

    if (rows.length === 0) {
      return { ...DEFAULT_STATE };
    }

    return rows[0].value as DarwinState;
  }

  async saveState(state: DarwinState): Promise<void> {
    const pool = this.getPool();

    await pool.query(
      `INSERT INTO darwin_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['darwin_state', JSON.stringify(state)],
    );
  }

  /**
   * Atomically read-modify-write the Darwin state.
   * Uses SELECT FOR UPDATE to acquire a row-level lock.
   */
  async updateState(fn: (state: DarwinState) => DarwinState): Promise<DarwinState> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Lock the row for update (or get nothing if first time)
      const { rows } = await client.query(
        `SELECT value FROM darwin_state WHERE key = $1 FOR UPDATE`,
        ['darwin_state'],
      );

      const current: DarwinState = rows.length > 0
        ? (rows[0].value as DarwinState)
        : { ...DEFAULT_STATE };

      const updated = fn(current);

      await client.query(
        `INSERT INTO darwin_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        ['darwin_state', JSON.stringify(updated)],
      );

      await client.query('COMMIT');
      return updated;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Private ──────────────────────────────────────

  private getPool(): pg.Pool {
    if (!this.pool) {
      throw new Error('PostgresMemoryProvider not initialized. Call init() first.');
    }
    return this.pool;
  }

  private async createTables(client: pg.PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS darwin_experiments (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        task TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'general',
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL,
        success BOOLEAN NOT NULL DEFAULT true,
        quality_score REAL,
        source_count INTEGER DEFAULT 0,
        output_length INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        feedback_score REAL,
        feedback_report TEXT,
        feedback_evaluator TEXT,
        output TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS darwin_prompt_versions (
        version TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        parent_version TEXT,
        change_reason TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT false,
        total_runs INTEGER DEFAULT 0,
        avg_quality REAL DEFAULT 0,
        avg_duration REAL DEFAULT 0,
        success_rate REAL DEFAULT 0,
        avg_source_count REAL DEFAULT 0,
        PRIMARY KEY (agent_name, version)
      );

      CREATE TABLE IF NOT EXISTS darwin_learnings (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        confidence REAL DEFAULT 0.8,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        search_vector TSVECTOR GENERATED ALWAYS AS (
          to_tsvector('english', content || ' ' || tags)
        ) STORED
      );

      CREATE TABLE IF NOT EXISTS darwin_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_darwin_exp_agent
        ON darwin_experiments(agent_name);
      CREATE INDEX IF NOT EXISTS idx_darwin_exp_agent_version
        ON darwin_experiments(agent_name, prompt_version);
      CREATE INDEX IF NOT EXISTS idx_darwin_exp_agent_started
        ON darwin_experiments(agent_name, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_darwin_exp_task_type
        ON darwin_experiments(agent_name, task_type);
      CREATE INDEX IF NOT EXISTS idx_darwin_learnings_search
        ON darwin_learnings USING GIN(search_vector);
      CREATE INDEX IF NOT EXISTS idx_darwin_learnings_agent
        ON darwin_learnings(agent_name);
    `);
  }

  // ─── SQLite → PostgreSQL Auto-Migration ─────────────

  /**
   * Automatically migrate data from SQLite when:
   *   1. A SQLite DB file exists at {dataDir}/.darwin/darwin.db
   *   2. PostgreSQL has no prompt versions yet (fresh/empty)
   *
   * This prevents the data loss path where switching to postgres causes
   * the system to re-seed v1 and lose the v2→v3 prompt history.
   *
   * Migration is idempotent: if postgres already has data, it's a no-op.
   */
  private async autoMigrateFromSqlite(): Promise<void> {
    const sqlitePath = join(this.dataDir, '.darwin', 'darwin.db');

    // No SQLite file — nothing to migrate
    if (!existsSync(sqlitePath)) {
      return;
    }

    const pool = this.getPool();

    // Check if postgres already has prompt versions (i.e., not a fresh DB)
    const { rows: existingVersions } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM darwin_prompt_versions`,
    );
    const pgVersionCount = parseInt(existingVersions[0]?.cnt ?? '0', 10);
    if (pgVersionCount > 0) {
      return; // Postgres already has data — no migration needed
    }

    // Check if postgres already has experiments
    const { rows: existingExps } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM darwin_experiments`,
    );
    const pgExpCount = parseInt(existingExps[0]?.cnt ?? '0', 10);
    if (pgExpCount > 0) {
      return; // Postgres has experiments — partial data already present
    }

    // Dynamic import of better-sqlite3 (only needed for migration)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let DatabaseCtor: new (path: string, opts: { readonly: boolean }) => {
      prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
      close(): void;
    };
    try {
      const mod = await import('better-sqlite3') as { default: typeof DatabaseCtor };
      DatabaseCtor = mod.default;
    } catch {
      // better-sqlite3 not installed — cannot migrate
      console.warn('[darwin] SQLite DB found but better-sqlite3 not available. Skipping migration.');
      return;
    }

    console.log('[darwin] Migrating data from SQLite to PostgreSQL...');

    const sqlite = new DatabaseCtor(sqlitePath, { readonly: true });
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // ── Migrate prompt versions ────────────────────
      const promptRows = sqlite.prepare(
        `SELECT * FROM prompt_versions ORDER BY created_at`,
      ).all() as Array<{
        version: string;
        agent_name: string;
        prompt_text: string;
        created_at: string;
        parent_version: string | null;
        change_reason: string;
        active: number;
        total_runs: number;
        avg_quality: number;
        avg_duration: number;
        success_rate: number;
        avg_source_count: number;
      }>;

      for (const row of promptRows) {
        await client.query(
          `INSERT INTO darwin_prompt_versions (
            version, agent_name, prompt_text, created_at, parent_version,
            change_reason, active, total_runs, avg_quality, avg_duration,
            success_rate, avg_source_count
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (agent_name, version) DO NOTHING`,
          [
            row.version, row.agent_name, row.prompt_text, row.created_at,
            row.parent_version, row.change_reason, row.active === 1,
            row.total_runs, row.avg_quality, row.avg_duration,
            row.success_rate, row.avg_source_count,
          ],
        );
      }

      // ── Migrate experiments ────────────────────────
      const expRows = sqlite.prepare(
        `SELECT * FROM experiments ORDER BY started_at`,
      ).all() as Array<{
        id: string;
        agent_name: string;
        prompt_version: string;
        task: string;
        task_type: string;
        started_at: string;
        completed_at: string;
        success: number;
        quality_score: number | null;
        source_count: number;
        output_length: number;
        error_count: number;
        duration_ms: number;
        feedback_score: number | null;
        feedback_report: string | null;
        feedback_evaluator: string | null;
        output: string | null;
      }>;

      for (const row of expRows) {
        await client.query(
          `INSERT INTO darwin_experiments (
            id, agent_name, prompt_version, task, task_type,
            started_at, completed_at, success,
            quality_score, source_count, output_length, error_count, duration_ms,
            feedback_score, feedback_report, feedback_evaluator, output
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT (id) DO NOTHING`,
          [
            row.id, row.agent_name, row.prompt_version, row.task, row.task_type,
            row.started_at, row.completed_at, row.success === 1,
            row.quality_score, row.source_count, row.output_length,
            row.error_count, row.duration_ms,
            row.feedback_score, row.feedback_report, row.feedback_evaluator,
            row.output,
          ],
        );
      }

      // ── Migrate state ──────────────────────────────
      const stateRow = sqlite.prepare(
        `SELECT value FROM state WHERE key = ?`,
      ).get('darwin_state') as { value: string } | undefined;

      if (stateRow) {
        await client.query(
          `INSERT INTO darwin_state (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO NOTHING`,
          ['darwin_state', stateRow.value],
        );
      }

      // ── Migrate learnings ──────────────────────────
      const learningRows = sqlite.prepare(
        `SELECT * FROM learnings ORDER BY created_at`,
      ).all() as Array<{
        id: string;
        agent_name: string;
        content: string;
        category: string;
        tags: string;
        confidence: number;
        created_at: string;
      }>;

      for (const row of learningRows) {
        await client.query(
          `INSERT INTO darwin_learnings (id, agent_name, content, category, tags, confidence, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [row.id, row.agent_name, row.content, row.category, row.tags, row.confidence, row.created_at],
        );
      }

      await client.query('COMMIT');

      console.log(
        `[darwin] Migration complete: ${promptRows.length} prompt versions, ` +
        `${expRows.length} experiments, ${learningRows.length} learnings.`,
      );
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ROLLBACK can fail if connection is already broken — ignore to avoid masking the real error
      }
      console.error('[darwin] Migration from SQLite failed:', err);
      // Non-fatal: the system will still work, just without historical data
    } finally {
      client.release();
      sqlite.close();
    }
  }
}

// ─── Row → Domain Mappers ───────────────────────────

interface PgExperimentRow {
  id: string;
  agent_name: string;
  prompt_version: string;
  task: string;
  task_type: string;
  started_at: string | Date;
  completed_at: string | Date;
  success: boolean;
  quality_score: number | null;
  source_count: number;
  output_length: number;
  error_count: number;
  duration_ms: number;
  feedback_score: number | null;
  feedback_report: string | null;
  feedback_evaluator: string | null;
  output: string | null;
}

interface PgPromptVersionRow {
  version: string;
  agent_name: string;
  prompt_text: string;
  created_at: string | Date;
  parent_version: string | null;
  change_reason: string;
  active: boolean;
  total_runs: number;
  avg_quality: number;
  avg_duration: number;
  success_rate: number;
  avg_source_count: number;
}

interface PgLearningRow {
  id: string;
  agent_name: string;
  content: string;
  category: string;
  tags: string;
  confidence: number;
  created_at: string | Date;
}

function toISOString(val: string | Date): string {
  if (val instanceof Date) return val.toISOString();
  return val;
}

function rowToExperiment(row: PgExperimentRow): DarwinExperiment {
  const experiment: DarwinExperiment = {
    id: row.id,
    agentName: row.agent_name,
    promptVersion: row.prompt_version,
    task: row.task,
    taskType: row.task_type,
    startedAt: toISOString(row.started_at),
    completedAt: toISOString(row.completed_at),
    success: row.success,
    metrics: {
      qualityScore: row.quality_score,
      sourceCount: row.source_count,
      outputLength: row.output_length,
      errorCount: row.error_count,
      durationMs: row.duration_ms,
    },
  };

  if (row.feedback_score !== null && row.feedback_report !== null && row.feedback_evaluator !== null) {
    experiment.feedback = {
      score: row.feedback_score,
      report: row.feedback_report,
      evaluator: row.feedback_evaluator,
    };
  }

  if (row.output !== null) {
    experiment.output = row.output;
  }

  return experiment;
}

function rowToPromptVersion(row: PgPromptVersionRow): PromptVersion {
  const stats: PromptVersionStats = {
    totalRuns: row.total_runs,
    avgQuality: row.avg_quality,
    avgDuration: row.avg_duration,
    successRate: row.success_rate,
    avgSourceCount: row.avg_source_count,
  };

  return {
    version: row.version,
    agentName: row.agent_name,
    promptText: row.prompt_text,
    createdAt: toISOString(row.created_at),
    parentVersion: row.parent_version,
    changeReason: row.change_reason,
    active: row.active,
    stats,
  };
}

function rowToLearning(row: PgLearningRow): Learning {
  let tags: string[];
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    // Defensive: migrated or manually inserted rows may have malformed JSON
    tags = [];
  }

  return {
    id: row.id,
    agentName: row.agent_name,
    content: row.content,
    category: row.category as Learning['category'],
    tags,
    confidence: row.confidence,
    createdAt: toISOString(row.created_at),
  };
}
