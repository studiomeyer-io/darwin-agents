/**
 * Darwin — SQLite Memory Provider
 *
 * Persistent storage for experiments, prompt versions, learnings, and state.
 * Uses better-sqlite3 for synchronous, fast, single-file storage.
 *
 * Database location: {dataDir}/.darwin/darwin.db
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type DatabaseCtor from 'better-sqlite3';
import type {
  DarwinConfig,
  DarwinExperiment,
  DarwinState,
  Learning,
  MemoryProvider,
  PromptVersion,
  PromptVersionStats,
} from '../types.js';

type Database = InstanceType<typeof DatabaseCtor>;

// ─── Row types for database queries ───────────────────

interface ExperimentRow {
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
}

interface PromptVersionRow {
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
}

interface LearningRow {
  id: string;
  agent_name: string;
  content: string;
  category: string;
  tags: string;
  confidence: number;
  created_at: string;
}

interface StateRow {
  key: string;
  value: string;
}

// ─── Default state for fresh installs ─────────────────

const DEFAULT_STATE: DarwinState = {
  activeVersions: {},
  abTests: {},
  lastKnownGood: {},
  consecutiveFailures: {},
  experimentCounts: {},
};

// ─── SQLite Memory Provider ───────────────────────────

export class SqliteMemoryProvider implements MemoryProvider {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(config: DarwinConfig) {
    const dataDir = config.dataDir ?? process.cwd();
    const darwinDir = join(dataDir, '.darwin');
    this.dbPath = join(darwinDir, 'darwin.db');
  }

  // ─── Lifecycle ────────────────────────────────────

  async init(): Promise<void> {
    // Ensure .darwin directory exists
    const dir = join(this.dbPath, '..');
    mkdirSync(dir, { recursive: true });

    // Dynamic import — gives helpful error if better-sqlite3 is not installed
    let DatabaseConstructor: typeof DatabaseCtor;
    try {
      const mod = await import('better-sqlite3') as { default: typeof DatabaseCtor };
      DatabaseConstructor = mod.default;
    } catch {
      throw new Error(
        '[darwin] better-sqlite3 is required for SQLite storage.\n' +
        '  Install it: npm install better-sqlite3\n' +
        '  Or use PostgreSQL: set DARWIN_POSTGRES_URL environment variable'
      );
    }

    // Open database with WAL mode for better concurrent read performance
    this.db = new DatabaseConstructor(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -20000'); // 20MB
    this.db.pragma('temp_store = MEMORY');

    this.createTables();
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ─── Experiments ──────────────────────────────────

  async saveExperiment(exp: DarwinExperiment): Promise<void> {
    const db = this.getDb();

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO experiments (
        id, agent_name, prompt_version, task, task_type,
        started_at, completed_at, success,
        quality_score, source_count, output_length, error_count, duration_ms,
        feedback_score, feedback_report, feedback_evaluator, output
      ) VALUES (
        @id, @agent_name, @prompt_version, @task, @task_type,
        @started_at, @completed_at, @success,
        @quality_score, @source_count, @output_length, @error_count, @duration_ms,
        @feedback_score, @feedback_report, @feedback_evaluator, @output
      )
    `);

    stmt.run({
      id: exp.id,
      agent_name: exp.agentName,
      prompt_version: exp.promptVersion,
      task: exp.task,
      task_type: exp.taskType,
      started_at: exp.startedAt,
      completed_at: exp.completedAt,
      success: exp.success ? 1 : 0,
      quality_score: exp.metrics.qualityScore,
      source_count: exp.metrics.sourceCount,
      output_length: exp.metrics.outputLength,
      error_count: exp.metrics.errorCount,
      duration_ms: exp.metrics.durationMs,
      feedback_score: exp.feedback?.score ?? null,
      feedback_report: exp.feedback?.report ?? null,
      feedback_evaluator: exp.feedback?.evaluator ?? null,
      output: exp.output ?? null,
    });
  }

  async loadExperiments(agentName: string, limit = 50): Promise<DarwinExperiment[]> {
    const db = this.getDb();

    const stmt = db.prepare(`
      SELECT * FROM experiments
      WHERE agent_name = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(agentName, limit) as ExperimentRow[];
    return rows.map(rowToExperiment);
  }

  // ─── Prompt Versions ──────────────────────────────

  async savePromptVersion(pv: PromptVersion): Promise<void> {
    const db = this.getDb();

    // Deactivate all other versions for this agent, then insert/replace
    const transaction = db.transaction(() => {
      if (pv.active) {
        db.prepare(`
          UPDATE prompt_versions SET active = 0 WHERE agent_name = ?
        `).run(pv.agentName);
      }

      db.prepare(`
        INSERT OR REPLACE INTO prompt_versions (
          version, agent_name, prompt_text, created_at, parent_version,
          change_reason, active, total_runs, avg_quality, avg_duration,
          success_rate, avg_source_count
        ) VALUES (
          @version, @agent_name, @prompt_text, @created_at, @parent_version,
          @change_reason, @active, @total_runs, @avg_quality, @avg_duration,
          @success_rate, @avg_source_count
        )
      `).run({
        version: pv.version,
        agent_name: pv.agentName,
        prompt_text: pv.promptText,
        created_at: pv.createdAt,
        parent_version: pv.parentVersion,
        change_reason: pv.changeReason,
        active: pv.active ? 1 : 0,
        total_runs: pv.stats.totalRuns,
        avg_quality: pv.stats.avgQuality,
        avg_duration: pv.stats.avgDuration,
        success_rate: pv.stats.successRate,
        avg_source_count: pv.stats.avgSourceCount,
      });
    });

    transaction();
  }

  async getActivePrompt(agentName: string): Promise<PromptVersion | null> {
    const db = this.getDb();

    const stmt = db.prepare(`
      SELECT * FROM prompt_versions
      WHERE active = 1 AND agent_name = ?
    `);

    const row = stmt.get(agentName) as PromptVersionRow | undefined;
    return row ? rowToPromptVersion(row) : null;
  }

  async getAllPromptVersions(agentName: string): Promise<PromptVersion[]> {
    const db = this.getDb();

    const stmt = db.prepare(`
      SELECT * FROM prompt_versions
      WHERE agent_name = ?
      ORDER BY created_at
    `);

    const rows = stmt.all(agentName) as PromptVersionRow[];
    return rows.map(rowToPromptVersion);
  }

  // ─── Learnings ────────────────────────────────────

  async saveLearning(learning: Learning): Promise<void> {
    const db = this.getDb();

    const id = learning.id ?? randomUUID();
    const tags = JSON.stringify(learning.tags);
    const confidence = learning.confidence ?? 0.8;

    db.prepare(`
      INSERT INTO learnings (id, agent_name, content, category, tags, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, learning.agentName, learning.content, learning.category, tags, confidence);

    // Sync FTS index
    db.prepare(`
      INSERT INTO learnings_fts (rowid, content, tags)
      SELECT rowid, content, tags FROM learnings WHERE id = ?
    `).run(id);
  }

  async searchLearnings(query: string, limit = 20): Promise<Learning[]> {
    const db = this.getDb();

    // Try FTS5 full-text search first
    try {
      const ftsStmt = db.prepare(`
        SELECT l.* FROM learnings l
        JOIN learnings_fts fts ON l.rowid = fts.rowid
        WHERE learnings_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);

      const rows = ftsStmt.all(query, limit) as LearningRow[];
      if (rows.length > 0) {
        return rows.map(rowToLearning);
      }
    } catch {
      // FTS query syntax error — fall through to LIKE
    }

    // Fallback: LIKE-based search
    const likeStmt = db.prepare(`
      SELECT * FROM learnings
      WHERE content LIKE ? OR tags LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const pattern = `%${query}%`;
    const rows = likeStmt.all(pattern, pattern, limit) as LearningRow[];
    return rows.map(rowToLearning);
  }

  // ─── State ────────────────────────────────────────

  async getState(): Promise<DarwinState> {
    const db = this.getDb();

    const row = db.prepare(`SELECT value FROM state WHERE key = ?`).get('darwin_state') as
      | StateRow
      | undefined;

    if (!row) {
      return { ...DEFAULT_STATE };
    }

    return JSON.parse(row.value) as DarwinState;
  }

  async saveState(state: DarwinState): Promise<void> {
    const db = this.getDb();

    db.prepare(`INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`).run(
      'darwin_state',
      JSON.stringify(state),
    );
  }

  /**
   * Atomically read-modify-write the Darwin state inside a single transaction.
   * Prevents race conditions when multiple agents update state concurrently.
   * Uses BEGIN IMMEDIATE to acquire a write lock before reading.
   */
  async updateState(fn: (state: DarwinState) => DarwinState): Promise<DarwinState> {
    const db = this.getDb();

    const transaction = db.transaction(() => {
      const row = db.prepare(`SELECT value FROM state WHERE key = ?`).get('darwin_state') as
        | StateRow
        | undefined;

      const current: DarwinState = row
        ? (JSON.parse(row.value) as DarwinState)
        : { ...DEFAULT_STATE };

      const updated = fn(current);

      db.prepare(`INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`).run(
        'darwin_state',
        JSON.stringify(updated),
      );

      return updated;
    });

    return transaction.immediate();
  }

  // ─── Private ──────────────────────────────────────

  /** Get the database connection, throw if not initialized */
  private getDb(): Database {
    if (!this.db) {
      throw new Error('SqliteMemoryProvider not initialized. Call init() first.');
    }
    return this.db;
  }

  /** Create all tables and indexes */
  private createTables(): void {
    const db = this.getDb();

    db.exec(`
      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        task TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'general',
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        quality_score REAL,
        source_count INTEGER DEFAULT 0,
        output_length INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        feedback_score REAL,
        feedback_report TEXT,
        feedback_evaluator TEXT,
        output TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS prompt_versions (
        version TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        parent_version TEXT,
        change_reason TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        total_runs INTEGER DEFAULT 0,
        avg_quality REAL DEFAULT 0,
        avg_duration REAL DEFAULT 0,
        success_rate REAL DEFAULT 0,
        avg_source_count REAL DEFAULT 0,
        PRIMARY KEY (agent_name, version)
      );

      CREATE TABLE IF NOT EXISTS learnings (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        confidence REAL DEFAULT 0.8,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
        content, tags,
        content=learnings,
        content_rowid=rowid
      );

      CREATE INDEX IF NOT EXISTS idx_experiments_agent
        ON experiments(agent_name);
      CREATE INDEX IF NOT EXISTS idx_experiments_agent_version
        ON experiments(agent_name, prompt_version);
      CREATE INDEX IF NOT EXISTS idx_experiments_agent_started
        ON experiments(agent_name, started_at DESC);
    `);
  }
}

// ─── Row → Domain Mappers ───────────────────────────

function rowToExperiment(row: ExperimentRow): DarwinExperiment {
  const experiment: DarwinExperiment = {
    id: row.id,
    agentName: row.agent_name,
    promptVersion: row.prompt_version,
    task: row.task,
    taskType: row.task_type,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    success: row.success === 1,
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

function rowToPromptVersion(row: PromptVersionRow): PromptVersion {
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
    createdAt: row.created_at,
    parentVersion: row.parent_version,
    changeReason: row.change_reason,
    active: row.active === 1,
    stats,
  };
}

function rowToLearning(row: LearningRow): Learning {
  return {
    id: row.id,
    agentName: row.agent_name,
    content: row.content,
    category: row.category as Learning['category'],
    tags: JSON.parse(row.tags) as string[],
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}
