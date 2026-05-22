# Darwin Examples

Each example is a self-contained `.ts` file you can read top-to-bottom, run with `npx tsx`, and copy into your own codebase.

## custom-agent.ts

Defining a custom agent with evolution, metric weights, and tool access. Full pattern: `defineAgent()` → configure evolution → `runAgent()`.

```bash
npx tsx examples/custom-agent.ts
```

Requires Claude CLI installed and authenticated. No API keys or MCP servers needed.

What to learn:
- How `defineAgent()` validates and applies defaults
- How `evolution.metrics` weights control what Darwin optimizes for
- How `taskType` enables per-category performance tracking
- The full evolution cycle: run → evaluate → detect patterns → A/B test → promote or rollback

## closed-loop-feedback.ts (new in v0.4.6)

Pipe Darwin's multi-critic findings into your own memory store so the **next** agent run sees lessons from the previous one.

```bash
npx tsx examples/closed-loop-feedback.ts
```

Symmetric loop matches the Hermes Agent v0.8.0 (NousResearch, MIT) self-evolution pattern:

- score < 5  → persist as `mistake` (a failure mode the next run should watch for)
- score >= 8 → persist as `pattern` (a success pattern the next run should reproduce)
- middle band → not persisted (mediocre runs are noise)

Backend-agnostic: implement the `FeedbackStore` interface for your real store (Postgres, Mem0, Zep, Letta, Cognee, a markdown directory — anything).

What to learn:
- Decision logic for "is this run signal or noise?" (NaN guard, output-length sanity check, threshold bands)
- Polarity-aware confidence scoring (lower mistake-score = higher confidence; higher pattern-score = higher confidence)
- Tag conventions that downstream learning-injection can filter on (`darwin-feedback`, `low-quality`/`high-quality`, `agent:<name>`, `critic:<failing-one>`)

## staleness-monitor.ts (new in v0.4.6)

Detect agents that stopped running — or were configured but never fired.

```bash
npx tsx examples/staleness-monitor.ts
```

A common Darwin failure mode: an agent gets added to `AGENT_CRITIC_MAP` but the wiring on the caller side never sends experiments. The agent looks "configured" but produces zero data, evolution silently stops. This monitor surfaces it.

Four statuses:
- `active` — last run within `staleDays`
- `stale` — last run within `staleDays * 4`
- `dead` — last run older than `staleDays * 4`
- `never-tracked` — configured in your expected list but zero DB rows

Suggested usage: weekly cron, paired with Telegram / Slack / PagerDuty webhook on issues. The example ships:
- a pure `classifyStaleness()` function (no I/O)
- a `buildStalenessReport()` that merges DB rows with your expected-agents list
- a `formatReport()` formatter for chat-friendly output
- a `STALENESS_SQL` constant you can wire to your own `pg` Pool

What to learn:
- Why "observed + expected" merging catches the "configured but never fired" silent failure
- How to keep the classifier pure for easy unit-testing
- The cron + alert pattern most production agent fleets need
