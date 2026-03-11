/**
 * Update README.md with real metrics from SQLite.
 *
 * Reads experiment data from .darwin/darwin.db and replaces
 * placeholder values in README.md between REAL_METRICS markers.
 */

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DB_PATH = join(ROOT, '.darwin', 'darwin.db');
const README_PATH = join(ROOT, 'README.md');

interface ExpRow {
  agent_name: string;
  task_type: string;
  quality_score: number | null;
  duration_ms: number;
  output_length: number;
  source_count: number;
  success: number;
}

const db = new Database(DB_PATH, { readonly: true });

// Overall stats
const allExps = db.prepare(`
  SELECT * FROM experiments WHERE agent_name = 'writer'
`).all() as ExpRow[];

const scored = allExps.filter(e => e.quality_score !== null);
const totalRuns = allExps.length;
const avgQuality = scored.length > 0
  ? (scored.reduce((s, e) => s + (e.quality_score ?? 0), 0) / scored.length).toFixed(1)
  : '0';
const avgDuration = totalRuns > 0
  ? (allExps.reduce((s, e) => s + e.duration_ms, 0) / totalRuns / 1000).toFixed(1)
  : '0';
const avgLength = totalRuns > 0
  ? Math.round(allExps.reduce((s, e) => s + e.output_length, 0) / totalRuns)
  : 0;
const successRate = totalRuns > 0
  ? (allExps.filter(e => e.success === 1).length / totalRuns * 100).toFixed(0)
  : '0';

// By task type
const types = db.prepare(`
  SELECT task_type, COUNT(*) as count, AVG(quality_score) as avg_q
  FROM experiments
  WHERE agent_name = 'writer' AND quality_score IS NOT NULL
  GROUP BY task_type
`).all() as Array<{ task_type: string; count: number; avg_q: number }>;

const typeMap: Record<string, { count: number; quality: string }> = {};
for (const t of types) {
  typeMap[t.task_type] = { count: t.count, quality: t.avg_q.toFixed(1) };
}

const techData = typeMap['tech'] ?? { count: 0, quality: '0' };
const wdData = typeMap['webdesign'] ?? { count: 0, quality: '0' };
const mktData = typeMap['market'] ?? { count: 0, quality: '0' };

// Build quality bars (10 chars wide, proportional to score out of 10)
function qualityBar(score: string): string {
  const n = Math.round(parseFloat(score));
  return '\u2588'.repeat(n) + '\u2591'.repeat(10 - n);
}

// Build the metrics block
const metricsBlock = `<!-- REAL_METRICS_START -->

### Real results from ${totalRuns} production runs

These are actual metrics from our development — not synthetic benchmarks.

\`\`\`
Agent:       writer
Runs:        ${totalRuns}
Task Types:  tech (${techData.count}), webdesign (${wdData.count}), market (${mktData.count})

Avg Quality:    ${avgQuality}/10
Avg Duration:   ${avgDuration} s
Avg Length:      ${avgLength} chars
Success Rate:   ${successRate}%
\`\`\`

#### Performance by task type

\`\`\`
tech        ${qualityBar(techData.quality)}  ${techData.quality}/10  (${techData.count} runs)
webdesign   ${qualityBar(wdData.quality)}  ${wdData.quality}/10    (${wdData.count} runs)
market      ${qualityBar(mktData.quality)}  ${mktData.quality}/10   (${mktData.count} runs)
\`\`\`

<!-- REAL_METRICS_END -->`;

// Replace in README
const readme = readFileSync(README_PATH, 'utf-8');
const updated = readme.replace(
  /<!-- REAL_METRICS_START -->[\s\S]*?<!-- REAL_METRICS_END -->/,
  metricsBlock,
);

writeFileSync(README_PATH, updated, 'utf-8');

console.log(`Updated README with real metrics from ${totalRuns} runs.`);
console.log(`  Avg Quality: ${avgQuality}/10`);
console.log(`  Avg Duration: ${avgDuration}s`);
console.log(`  Success Rate: ${successRate}%`);
console.log(`  Tech: ${techData.quality}/10 (${techData.count}), Webdesign: ${wdData.quality}/10 (${wdData.count}), Market: ${mktData.quality}/10 (${mktData.count})`);

db.close();
