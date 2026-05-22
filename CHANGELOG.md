# Changelog

## [0.4.8] — 2026-05-22

Hotfix on top of v0.4.7. Path resolution in the `exports` map pointed at
`./dist/*` but the v0.4.7 build emitted into `./dist/src/*` (because
`tsconfig` `rootDir` was widened to `./` so examples could compile into
`./dist/examples/`). The pre-existing entrypoints (`darwin-agents`,
`darwin-agents/providers`, `darwin-agents/memory`, `darwin-agents/agents`)
were therefore unreachable from v0.4.7 — only the new `./memory/bridge`
and `./memory/closed-loop` subpaths resolved correctly.

### Fixed

- `main`, `types`, `bin`, and every `./dist/*` entry in `exports` now
  point at `./dist/src/*` to match the actual build output layout.
- `./memory/bridge` and `./memory/closed-loop` continue to resolve to
  `./dist/examples/mcp-memory-bridge.js` / `memory-darwin-integration.js`
  unchanged — those paths were already correct.

### Recommendation

Upgrade from v0.4.7 to v0.4.8 (`npm install darwin-agents@latest`).
v0.4.7 is functional only via the two new `./memory/*` subpaths; the
core API and CLI are unreachable in that release.

## [0.4.7] — 2026-05-22

Generic MCP-Memory bridge — Darwin's closed loop now plugs into any
MCP-compliant memory server out of the box.

### Added

- **`examples/mcp-memory-bridge.ts`** — pluggable JSON-RPC 2.0 client for
  MCP-Memory servers. Two transports (`stdio` + `http`), default targets
  `@studiomeyer/local-memory-mcp` for zero-config local memory. Override
  `writeTool` / `readTool` and provide `mapWriteArgs` / `mapReadResult`
  for Mem0 / Zep / Letta / Cognee / your own server. Exposed as the
  `darwin-agents/memory/bridge` subpath export for clean consumer imports.
  Companion entry point `darwin-agents/memory/closed-loop` maps to
  `memory-darwin-integration.ts`.

  Why raw JSON-RPC instead of `@modelcontextprotocol/sdk`? Darwin's
  zero-hard-deps policy. The MCP wire for our case is three messages
  (`initialize` + `tools/list` + `tools/call`), and we keep it that
  way — no SDK dependency, no peer-dep update, fully testable.

  Implements the `FeedbackStore` interface from `closed-loop-feedback.ts`
  and extends it with `fetchRelevant(query, limit)` + `close()` via the
  new `RetrievableFeedbackStore` interface. Backward-compatible: existing
  `FeedbackStore` consumers keep working.

  Hardening: per-RPC timeout (default 10s), bounded stdio respawn on
  EPIPE/exit (default 1 attempt), SSE-tolerant HTTP body parser, defensive
  result extraction for `content[].text` JSON envelopes and
  `structuredContent` shortcuts.

  Convenience factories: `localMemory(overrides)` for the default zero-
  config wiring, `remoteMemory(url, overrides)` for any HTTP endpoint.

- **`examples/memory-darwin-integration.ts`** — closed-loop orchestration
  in three lines: fetch lessons → render as context → run the agent →
  persist critic findings. The next run sees the previous run's lessons.

  Adds `runClosedLoopTurn()` (orchestration shape) and
  `renderLessonContext()` (token-budgeted prompt rendering, default 1800
  chars with elision fallback).

### Hardening (Round-1 critic findings, fixed in-place before publish)

- F1 — removed inline-respawn path from `rpc()` that bypassed `ensureReady()`
  and could double-spawn the stdio child.
- F2 — SSE parser now splits on event boundaries (`\n\n`) and joins multi-
  line `data:` fields with `\n` per the EventSource spec §9.2.4. Returns
  the most recent well-formed event so partial streams don't override the
  final result.
- F3 — added `child.stdin.on('error', …)` to swallow EPIPE/ERR_STREAM_DESTROYED
  emitted on the dying stdin between exit-event delivery, so the host
  process doesn't crash on transient races.
- F4 — `initInFlight` is no longer auto-cleared in the catch handler.
  Concurrent callers see the same failure once; the next call after the
  failure starts a fresh attempt. Prevents the concurrent double-spawn
  race on retry-after-init-failure.
- F5 — `close()` now nulls `initInFlight` so a caller awaiting a stale
  init promise after close gets routed back through the `bridge is closed`
  guard rather than racing the dead transport.
- F7 — HTTP responses without a `jsonrpc: "2.0"` envelope are logged via
  the configured warn-logger and surface as `undefined` to the caller
  (which then yields `[]` via the result mapper) rather than throwing
  raw `SyntaxError` on malformed payloads.
- F9 — added `tsconfig.test.json` for opt-in test type-checking via
  `npm run typecheck:tests`. Main build (`npm run build`) remains
  src+examples only so pre-existing test-file type drift doesn't break
  publish.

### Robustness additions

- **HTTP retry policy** — `httpMaxRetries` config (default 2) with
  exponential backoff for 5xx and transient network errors
  (ECONNRESET/ETIMEDOUT/ENOTFOUND/EAI_AGAIN/AbortError). 4xx errors are
  surfaced immediately. Matches the lesson from running an MCP server
  behind Cloudflare/nginx where intermittent 502/503 are normal.
- **`fetchRelevant()` accepts an options bag** — call shape is
  `bridge.fetchRelevant({ query, limit, tags })`. Legacy
  `bridge.fetchRelevant('query', 5)` still works for backward-compat.
- **JSON-RPC id-mismatch** is logged but accepted (warn-not-throw) for
  servers that re-key responses.

### USP framing

- README "Memory Integration" section now spells out the differentiation
  vs. Mem0/Zep/Letta/MemPalace/agentmemory/brainctl: pluggable backends
  exist, closed-loop self-evolution exists, but Darwin v0.4.7 is the
  first MIT-licensed, TypeScript-native, MCP-native combination. The
  symmetric polarity rule (mistake/pattern, mediocre band skipped) is
  the production-ready closed-loop pattern aligned with reflective
  self-improvement work like GEPA (ICLR 2026 Oral).

- **+31 unit tests:**
  - `tests/mcp-memory-bridge.test.ts` (24 tests) — default arg mappers,
    structured-content extraction, http round-trip (initialize + tools/
    call), tool-name + arg override (Mem0-style), Authorization header
    propagation, JSON-RPC error surfacing, stdio round-trip against a
    fake MCP child, child-crash-mid-session (F1/F3 regression), reject-
    on-close-during-flight (F5 regression), 5xx retry + 4xx no-retry,
    multi-event + multi-line SSE parsing (F2), non-JSON-RPC warn (F7),
    single-flight initialize under concurrent calls (F4).
  - `tests/memory-darwin-integration.test.ts` (7 tests) —
    `renderLessonContext` boundary cases, three-turn closed-loop
    behaviour (cold → warm → mediocre band), fetch-failure resilience,
    custom `persistThresholds` honoured.

### Notes

- No production code changed. Only `examples/` and `tests/` files are
  added — `src/` and the existing CLI are untouched. Safe to upgrade.
- The bridge intentionally lives in `examples/` (not `src/`) so it stays
  copy-paste-able and doesn't impose dependencies on the core package.

## [0.4.6] — 2026-05-22

Three dedicated critic sets + two production patterns from real fleet usage.

### Added

- **Three new built-in critic sets** in `src/evolution/multi-critic.ts`:
  - `RESEARCH_PROMPTS` — for agents that synthesise external sources into
    structured research reports. Scores source quality + multi-engine
    coverage, analytical depth + synthesis, completeness + decision-value.
    Use when your agent's output is a research brief, market analysis,
    competitor scan, paper summary, or technology deep-dive.
  - `CRITIC_AGENT_PROMPTS` — for agents whose job is critiquing other work
    (devil's advocate, RFC-review, design-review). Scores fairness +
    steelmanning, counter-argument depth + blind-spot detection, actionability
    + clear verdict.
  - `ANALYST_PROMPTS` — for agents that produce code/architecture analysis
    (repository audits, refactoring proposals, tech-debt reports). Scores
    technical accuracy with file:line references, pattern recognition,
    recommendation quality with security + effort + risk estimates.

  These three previously fell back to `INVESTIGATOR_PROMPTS` — which scored
  them by the wrong criteria (e.g. code-analysis got dinged for "no URLs
  cited" because it cited file paths instead). The anti-fallback regression
  test in `tests/multi-critic.test.ts` locks the fix.

- **`examples/closed-loop-feedback.ts`** — backend-agnostic pattern for
  piping Darwin multi-critic findings into your own memory store so the
  next agent run sees them as context. Symmetric (writes both successes
  and failures), matches the Hermes Agent v0.8.0 (NousResearch, MIT)
  self-evolution pattern.

  Decision logic (`shouldPersist`):
  - `medianScore < 5` → polarity `mistake` (failure mode to watch)
  - `medianScore >= 8` → polarity `pattern` (success pattern to reproduce)
  - middle band → not persisted (mediocre runs are noise)

  Plus guards for NaN/Infinity scores, all-critics-failed, and short
  outputs (likely CLI failures). 38 unit tests in
  `tests/closed-loop-feedback.test.ts`.

- **`examples/staleness-monitor.ts`** — detect agents that stopped firing
  or were configured-but-never-fired. The latter is a silent failure mode
  many production fleets hit: agent added to `AGENT_CRITIC_MAP`, wiring
  missed on caller side, agent looks "configured" but produces zero data.

  Four statuses: `active` / `stale` / `dead` / `never-tracked`. Pure
  classifier + report builder + format helper, plus a `STALENESS_SQL`
  constant ready for your `pg` Pool. 16 unit tests in
  `tests/staleness-monitor.test.ts`.

### Changed

- `getCriticPrompts('research' | 'researcher' | 'critic' | 'analyst')` now
  returns dedicated sets instead of falling back to investigator. Adds
  `researcher` as an alias of `research` for backwards compatibility.
- `AGENT_OUTPUT_LABELS` extended for the new agent types.
- README: new "Closed-Loop & Observability" section pointing to the two
  example files.
- Examples README expanded with the two new pattern entries.

### Tests

- 12 new tests in `multi-critic.test.ts` — critic-set coverage + 3
  anti-fallback regression assertions (analyst, research, critic must NOT
  use investigator's set).
- 38 new tests in `closed-loop-feedback.test.ts` — polarity logic, content
  + tag + confidence builders, persist orchestration, store-failure
  handling.
- 16 new tests in `staleness-monitor.test.ts` — classifier boundaries,
  observed-vs-expected merging, format output.

Total: 66 new tests on top of the existing 140. All green, `tsc` clean.

## [Unreleased] — Round-4 OSS-Sweep (2026-04-24)

Triple-agent review on the v0.4.5 OSS tree surfaced two defects that had
been documented-but-unshipped in earlier internal reviews.

### Security

- **`spawn('claude')` no longer leaks user Anthropic API credentials to
  the subprocess.** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are now
  stripped from the cleaned env before the Claude CLI is invoked, matching
  the behaviour that `agent-fleet` shipped in Session 837. Without this
  strip, any Darwin user with an API key in their shell was being billed
  at full API rates for every experiment run instead of consuming their
  paid Claude Pro / Max subscription. Opt back in with
  `DARWIN_USE_API_KEY=1` for CI or server-side usage where a billed key is
  the intended credential.

### Added

- **Process-lifetime budget caps in `src/core/runner.ts`.** A runaway
  A/B-critic-convergence loop could previously fire hundreds of paid
  provider calls before anyone noticed. Two opt-out ceilings now short-
  circuit the runner **before** the next LLM call:
  - `DARWIN_MAX_RUNS_PER_PROCESS` (default `100`, `0` = disabled)
  - `DARWIN_MAX_RUN_WALL_MS` (default `3_600_000` = 1 h, `0` = disabled)
  Exceeding either throws a new `DarwinBudgetError` with the budget name.
  Test helpers `setMaxRunsPerProcess` / `setMaxRunWallMs` /
  `resetRunCounters` are exported from `src/core/runner` for wiring-tests.
- **3 new regression tests** (`tests/budget-caps.test.ts`): runs-cap trip,
  0 = disabled, wall-clock-cap trip. Total test count: 130 → 133 (all
  green).

## 1.0.0

Initial public release.
