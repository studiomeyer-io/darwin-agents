/**
 * Example: Staleness Monitor — Detect Agents That Stopped Running
 *
 * A common Darwin failure mode: an agent gets added to your AGENT_CRITIC_MAP
 * but the wiring on the caller side never sends experiments. Result: the
 * agent looks "configured" but produces zero data, evolution silently stops.
 *
 * This monitor surfaces:
 *  - active (last run within `staleDays`)
 *  - stale (last run within `staleDays * 4`)
 *  - dead (last run older than `staleDays * 4`)
 *  - never-tracked (configured in your expected list but zero DB rows)
 *
 * Backend-agnostic: you supply a query function that returns rows from
 * darwin_db.darwin_experiments (or your own experiment store). The classifier
 * is pure logic.
 *
 * Pair with your existing observability (Telegram, Slack, PagerDuty, ...) to
 * get a weekly heartbeat. Suggested cron: `0 8 * * 1` (Mon 08:00).
 *
 * Run demo: npx tsx examples/staleness-monitor.ts
 */

export type StalenessStatus = 'active' | 'stale' | 'dead' | 'never-tracked';

export interface AgentStalenessRow {
  agent_name: string;
  total_runs: number;
  last_run: string | null;
  days_since_last: number | null;
}

export interface AgentStalenessResult extends AgentStalenessRow {
  status: StalenessStatus;
}

/** Pure classifier — no I/O, easy to unit-test. */
export function classifyStaleness(
  row: AgentStalenessRow,
  staleDays: number,
): StalenessStatus {
  const days = row.days_since_last;
  if (days === null) return 'never-tracked';
  if (days <= staleDays) return 'active';
  if (days <= staleDays * 4) return 'stale';
  return 'dead';
}

/**
 * Merge DB-observed rows with an "expected" list (e.g. AGENT_CRITIC_MAP keys).
 * Expected-but-not-observed agents appear with status='never-tracked'.
 */
export function buildStalenessReport(
  observedRows: AgentStalenessRow[],
  expectedAgents: Iterable<string>,
  staleDays: number,
): AgentStalenessResult[] {
  const observed = new Map<string, AgentStalenessResult>();
  for (const r of observedRows) {
    observed.set(r.agent_name, { ...r, status: classifyStaleness(r, staleDays) });
  }
  for (const name of expectedAgents) {
    if (!observed.has(name)) {
      observed.set(name, {
        agent_name: name,
        total_runs: 0,
        last_run: null,
        days_since_last: null,
        status: 'never-tracked',
      });
    }
  }
  return Array.from(observed.values()).sort((a, b) =>
    a.agent_name.localeCompare(b.agent_name),
  );
}

/**
 * Format a human-readable summary. Use for Telegram / Slack / log output.
 */
export function formatReport(
  rows: AgentStalenessResult[],
  staleDays: number,
): string {
  const dead = rows.filter((r) => r.status === 'dead');
  const stale = rows.filter((r) => r.status === 'stale');
  const active = rows.filter((r) => r.status === 'active');
  const neverTracked = rows.filter((r) => r.status === 'never-tracked');

  const lines: string[] = [
    `Darwin Staleness Monitor (window: ${staleDays}d)`,
    '',
    `Active: ${active.length} | Stale (>${staleDays}d): ${stale.length} | ` +
      `Dead (>${staleDays * 4}d): ${dead.length} | Never: ${neverTracked.length}`,
    '',
  ];
  if (dead.length > 0) {
    lines.push('DEAD:');
    for (const r of dead) {
      lines.push(`  - ${r.agent_name} (last ${r.days_since_last}d ago, ${r.total_runs} runs total)`);
    }
    lines.push('');
  }
  if (stale.length > 0) {
    lines.push('STALE:');
    for (const r of stale) {
      lines.push(`  - ${r.agent_name} (last ${r.days_since_last}d ago, ${r.total_runs} runs total)`);
    }
    lines.push('');
  }
  if (neverTracked.length > 0) {
    lines.push('NEVER-TRACKED (configured but no DB rows):');
    for (const r of neverTracked) {
      lines.push(`  - ${r.agent_name}`);
    }
    lines.push('');
  }
  if (dead.length === 0 && stale.length === 0 && neverTracked.length === 0) {
    lines.push('All tracked agents are active.');
  }
  return lines.join('\n');
}

// ─── PostgreSQL backend (sketch) ──────────────────────
//
// If you use the bundled PostgreSQL memory provider, the rows live in
// `darwin_experiments`. Here's the query — wire it up to your `pg` Pool.

export const STALENESS_SQL = `
  SELECT
    agent_name,
    COUNT(*)::int AS total_runs,
    MAX(completed_at)::text AS last_run,
    FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(completed_at))) / 86400)::int AS days_since_last
  FROM darwin_experiments
  GROUP BY agent_name
  ORDER BY agent_name
`;

// ─── Demo ─────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  // Pretend these came from a database query.
  const observed: AgentStalenessRow[] = [
    { agent_name: 'researcher', total_runs: 47, last_run: '2026-05-21', days_since_last: 1 },
    { agent_name: 'critic', total_runs: 12, last_run: '2026-05-15', days_since_last: 7 },
    { agent_name: 'analyst', total_runs: 3, last_run: '2026-05-01', days_since_last: 21 },
    { agent_name: 'investigator', total_runs: 5, last_run: '2026-01-10', days_since_last: 132 },
  ];

  // Expected agents: keys of your AGENT_CRITIC_MAP, or any other source.
  const expected = ['researcher', 'critic', 'analyst', 'investigator', 'writer'];

  const report = buildStalenessReport(observed, expected, 7);
  console.log(formatReport(report, 7));

  const hasIssues = report.some(
    (r) => r.status === 'stale' || r.status === 'dead' || r.status === 'never-tracked',
  );
  process.exit(hasIssues ? 1 : 0);
}
