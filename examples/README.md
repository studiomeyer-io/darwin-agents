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

## mcp-memory-bridge.ts (new in v0.4.7)

Generic JSON-RPC 2.0 bridge to **any MCP-compliant memory server**. Defaults to `@studiomeyer/local-memory-mcp` (zero-config, single SQLite file). Override `writeTool` / `readTool` and pass `mapWriteArgs` / `mapReadResult` to point at Mem0, Zep, Letta, Cognee, or your own self-hosted MCP server.

Importable as `darwin-agents/memory/bridge` (subpath export) — the orchestration shim is `darwin-agents/memory/closed-loop`.

```bash
# Install the default local backend (one-time)
npm install -g @studiomeyer/local-memory-mcp

# Run the bridge demo
npx tsx examples/mcp-memory-bridge.ts
```

Two transports:

- `stdio` — spawn the MCP server as a child process (default for `localMemory()`)
- `http` — POST JSON-RPC against any MCP HTTP endpoint (also accepts SSE-framed replies)

The bridge implements the `FeedbackStore` interface from `closed-loop-feedback.ts` plus `fetchRelevant()` for retrieval and `close()` for lifecycle. Zero hard dependencies — pure raw JSON-RPC, no MCP SDK pulled in.

What to learn:

- How to keep transport (stdio vs http) and provider mapping (tool names + arg shapes) orthogonal
- Per-RPC timeout + bounded respawn policy for stdio children
- Tolerant response parsing (works with raw `content[].text` envelopes, `structuredContent`, plain arrays)
- Why **zero hard deps** matters: Darwin keeps `peerDependencies` only, the bridge follows the same rule

## memory-darwin-integration.ts (new in v0.4.7)

End-to-end demo: closed-loop persistence + lesson injection in three lines.

```bash
npx tsx examples/memory-darwin-integration.ts
```

The demo runs three turns of a stub agent against the local memory bridge. Run 1 is cold (no lessons). Run 2 + 3 see lessons from earlier runs as injected context. Replace the stub runner with your real `runAgent()` call to wire it in.

What to learn:

- `runClosedLoopTurn()` — orchestration shape (fetch → run → persist)
- `renderLessonContext()` — token-budgeted lesson rendering for prompt injection
- How to swap memory backends without changing the orchestration code

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
