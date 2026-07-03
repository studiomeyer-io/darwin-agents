<!-- studiomeyer-mcp-stack-banner:start -->
> **Part of the [StudioMeyer MCP Stack](https://studiomeyer.io)** — Built in Mallorca 🌴 · ⭐ if you use it
<!-- studiomeyer-mcp-stack-banner:end -->

<div align="center">

# darwin


<!-- badges -->
![License](https://img.shields.io/github/license/studiomeyer-io/darwin-agents?style=flat-square&color=22c55e&label=license)
![Last commit](https://img.shields.io/github/last-commit/studiomeyer-io/darwin-agents?style=flat-square&color=88c0d0&label=updated)
![GitHub stars](https://img.shields.io/github/stars/studiomeyer-io/darwin-agents?style=flat-square&color=ffd700&logo=github&label=stars)
<!-- /badges -->**AI agents that improve themselves.**

[![npm version](https://img.shields.io/npm/v/darwin-agents?color=blue)](https://www.npmjs.com/package/darwin-agents)
[![npm downloads](https://img.shields.io/npm/dw/darwin-agents)](https://www.npmjs.com/package/darwin-agents)
[![CI](https://github.com/studiomeyer-io/darwin-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/studiomeyer-io/darwin-agents/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Build AI agent teams that learn from every run.<br>Self-evolving prompts. A/B tested. Safety-gated.

[Quick Start](#quick-start) · [Agents](#built-in-agents) · [How It Works](#how-evolution-works) · [CLI](#cli-reference) · [FAQ](#faq)

</div>

```bash
npm install darwin-agents better-sqlite3
export ANTHROPIC_API_KEY=sk-ant-...  # or OPENAI_API_KEY, or use Claude CLI
npx darwin run writer "Explain quantum computing simply"
```

---

## A note from us

We have been building tools and systems for ourselves for the past two years. The fact that this repo is small and has few stars is not because it is new. It is because we only just decided to share what we have built. It is not a fresh experiment, it is a long story with a recent commit.

We love building things and sharing them. We do not love social media tactics, growth hacks, or chasing stars and followers. So this repo is small. The code is real, it gets used, issues get answered. Judge for yourself.

If it helps you, sharing, testing, and feedback help us. If it could be better, an issue is more useful. If you build something with it, tell us at hello@studiomeyer.io. That genuinely makes our day.

From a small studio in Palma de Mallorca.

## What is this?

Darwin is a TypeScript framework for building AI agents that **automatically optimize their own prompts** through experimentation, evaluation, and evolution.

Traditional AI agents use static prompts. You write them once, and they never improve. Darwin changes that:

1. Your agent runs a task
2. A Critic agent evaluates the output (quality, sources, structure)
3. After enough runs, Darwin detects patterns ("weak on technical topics")
4. It generates an improved prompt variant
5. A/B tests the new variant against the current one
6. The winner becomes the default — your agent got better, automatically

```
You run an agent
       │
       ▼
Darwin measures quality
       │
       ▼
Patterns emerge over time
       │
       ▼
New prompt variant generated
       │
       ▼
A/B tested against current
       │
       ▼
Winner becomes default
       │
Your agent got better.
You did nothing.
```

> **Why this isn't a toy.** The loop runs behind a real production **safety gate**
> — regression rollback to last-known-good, data-quality guards that pause
> evolution during a tool outage, and an alignment check on *every* mutation so a
> rewrite can't quietly erode a safety constraint. It can drive that mutation with
> a [GEPA](https://arxiv.org/abs/2507.19457) reflective optimizer running **online,
> inside the gate** (not as an offline batch step), and the A/B gate supports
> **always-valid sequential tests** (mSPRT / Hoeffding) so checking after every run
> doesn't inflate false positives. Details: [reflective evolution](#reflective-evolution--gepa-online-v06-opt-in)
> · [statistical rigor](#statistical-rigor--coverage-sampling-v07-opt-in).

## Quick Start

```bash
# Install
npm install darwin-agents better-sqlite3

# Set your API key (or use Claude CLI if installed)
export ANTHROPIC_API_KEY=sk-ant-...

# Run your first agent
npx darwin run writer "Explain the CAP theorem in simple terms"

# Enable evolution
npx darwin evolve writer --enable

# Watch it improve over time
npx darwin status writer
```

### Define your own agent in 12 lines

```typescript
import { defineAgent } from 'darwin-agents';

export default defineAgent({
  name: 'summarizer',
  role: 'Text Summarizer',
  description: 'Summarizes text into key points.',
  systemPrompt: `Summarize the given text in 3 bullet points.
Be concise. No fluff. Capture the essence.`,
  evolution: {
    enabled: true,
    evaluator: 'critic',
  },
});
```

### Reflective evolution — GEPA, online (v0.6, opt-in)

By default Darwin mutates prompts from aggregate stats. Turn on `useGepa` and
the evolution loop instead generates each challenger with a **GEPA-style
reflector** — it reads the recent critic feedback Darwin already collects and
writes the *smallest targeted edit* that fixes the failure modes, then A/B-tests
it against live traffic like any other variant. This is the part no other
TypeScript framework ships: a GEPA reflective optimizer running *inside* a
production safety gate, not as an offline batch job.

```typescript
evolution: {
  enabled: true,
  evaluator: 'multi-critic',
  useGepa: true,                       // reflective generation instead of stats-meta-prompt
  reflectionModel: 'claude-opus-4-8',  // GEPA's leverage point — use a STRONGER model here
  paretoGate: true,                    // activate a challenger only if it's a true Pareto improvement
},
```

Everything degrades safely: with no critic feedback yet (cold start), on any
reflector error, or if a mutation would erode a safety constraint, the loop
falls back to the default optimizer. The same alignment guard now runs on both
paths. Pair with `requireConfidence` on your `SafetyThresholds` for a
peeking-resistant A/B gate. All of it is off unless you opt in — existing
agents behave exactly as before.

### Statistical rigor + coverage sampling (v0.7, opt-in)

v0.7 makes the evolution loop statistically honest and brings the GEPA optimizer
closer to the paper. Every piece is additive and off by default (one exception:
the feedback window default rose from 5 to 15):

```typescript
import { SafetyGate, DarwinLoop } from 'darwin-agents';

// Always-valid sequential A/B gate — peeking-resistant after every run.
const safety = new SafetyGate({
  minDataPoints: 10,
  maxRegression: 0.2,
  failureRollbackThreshold: 3,
  requireConfidence: true,
  confidenceMethod: 'msprt',   // Mixture SPRT (or 'hoeffding' — σ-free, conservative)
});

const loop = new DarwinLoop({
  memory, tracker, optimizer, safety, patterns, agent,
  embed: myBatchEmbedder,      // opt-in semantic alignment guard (zero hard deps — injected)
});
```

- **mSPRT / Hoeffding confidence sequences** — a margin win is adopted only when
  it clears an always-valid significance bar, so monitoring after every run no
  longer inflates false positives.
- **ε-Pareto gate** (`evolution.paretoEpsilon`) — forgive a microscopic
  regression on one objective when a challenger wins decisively on another.
- **Instance-wise coverage sampling** (`useCoverage` + per-variant `perKeyScores`)
  — GEPA Algorithm 2: keep/sample the variants that excel on the most *different*
  task subsets, not N copies of the global-average winner.
- **System-aware merge** (`useMerge` + `mergeEveryK`) — every K-th cycle, merge
  the two best Pareto-front prompt versions in the agent's history into one
  challenger (paper Appendix-D, ~+5% lift), instead of a reflective mutation.
- **Semantic alignment guard** — a *reworded* safety constraint is no longer a
  false rejection; a *removed* one still is (fail-closed without an embedder).
- **Epoch-shuffled reflection minibatch** (`reflectionMinibatchSize`) + a
  configurable `feedbackWindow` (default 15).
- **Style-bias-free judging** (`normalizeForJudging`) — strip markdown before the
  critic scores, so it measures content not formatting.

### Drift detection — validate-by-reproduce canary (v0.9)

The A/B gate guards prompt *quality*. The canary guards *behaviour*: a model
update or a broken tool can change *how* an agent reaches its answer (different
tools, more turns, more errors) while the quality score stays flat. `darwin
canary` re-checks recent runs against a frozen baseline and flags that drift.

```bash
darwin canary writer                 # Stable / drift / insufficient-data report
darwin canary writer --json          # Machine-readable, for dashboards
darwin canary writer --exit-on-drift # Non-zero exit on drift, for CI
```

It compares execution *trajectories* (captured opt-in since v0.5) with
tolerance-based metrics — unordered tool-set Jaccard, ordered sequence
similarity, turn-count ratio, error-rate delta — never an exact hash (LLM runs
are non-deterministic). Drift has to be a *pattern* (≥2 of N runs), and the
baseline is pinned to the active prompt version, so an intentional evolution
reports `insufficient-data` (re-baseline), not a false alarm. The metrics and
the `runCanaryOverExperiments` orchestrator are exported for your own pipelines.

**Cross-family judging:** with more than one provider key present, Darwin
already spreads the three critics across model families to cut LLM-as-judge
bias. With only one key they collapse onto a single family (note: `claude-cli`
and `anthropic-api` are the *same* family) — Darwin now warns, and hard-fails
under `DARWIN_REQUIRE_CROSS_FAMILY=1` for strict / CI setups.

### Demo injection + parent selection (v0.10, opt-in)

Two more challenger surfaces, both borrowed from the strongest ideas in the
field and adapted to the online loop. Both are off by default.

**Demo injection** (`useDemos`) is DSPy SIMBA's `append_a_demo` strategy: on
every `demoEveryK`-th cycle (default 4) the loop harvests the agent's *own
highest-scoring past runs* (score ≥ 8, one per task type, capped at
`maxDemos`) and appends them to the prompt as a marker-delimited
"Demonstrations" section. Zero LLM cost — pure selection over data Darwin
already stores — and the demo-augmented prompt is a normal challenger: same
alignment guard, same A/B test, same rollback. If showing the agent its own
best work doesn't measurably help, the incumbent wins and nothing changes.

**Parent selection** (`candidateSelection`) is GEPA's
`candidate_selection_strategy`: instead of always mutating the currently-active
prompt (a hill-climb), reflect from `'best'` (highest composite in the version
history), `'pareto'` (uniform sample from the history's Pareto front — keeps
lineages alive that win on *different* objectives), or `'epsilon-greedy'`
(explore with probability `explorationEpsilon`). Requires `useGepa`.

```typescript
evolution: {
  enabled: true,
  useDemos: true,                    // SIMBA-style demos as a challenger source
  demoEveryK: 4,                     // cadence (offset from mergeEveryK: 3)
  maxDemos: 2,
  useGepa: true,
  candidateSelection: 'pareto',      // or 'best' | 'epsilon-greedy' | 'active'
  explorationEpsilon: 0.1,           // only for 'epsilon-greedy'
},
```

## Built-in Agents

| Agent | What it does | Needs |
|-------|-------------|-------|
| **writer** | Content writing, explanations, copy | Nothing (zero-config) |
| **researcher** | Web research with source citations | Tavily API key |
| **critic** | Evaluates other agents' output (1-10) | Nothing |
| **analyst** | Code quality analysis | Filesystem access |

Each agent ships with a dedicated **multi-critic set** that scores the output by the right criteria for that agent type (research = source quality + analytical depth + completeness, analyst = technical accuracy with file:line refs + pattern recognition + recommendation quality, etc.). Custom agents can register their own critic sets — see `examples/custom-agent.ts` and `src/evolution/multi-critic.ts`.

## Closed-Loop & Observability (v0.4.6)

Two production patterns Darwin users commonly need but had to build themselves:

- [`examples/closed-loop-feedback.ts`](examples/closed-loop-feedback.ts) — pipe critic findings into your own memory store so the next run sees them. Symmetric (writes both successes and failures), backend-agnostic. Aligned with reflective self-improvement patterns like [GEPA (ICLR 2026 Oral)](https://arxiv.org/abs/2507.19457) and NousResearch's `hermes-agent-self-evolution` loop.
- [`examples/staleness-monitor.ts`](examples/staleness-monitor.ts) — detect agents that stopped firing, or were configured but never fired. Pure classifier + format helpers + ready-made SQL. Wire to your own cron + alert webhook.

## Memory Integration (v0.4.7 — works with any MCP-compliant memory server)

Closes the loop in three lines. Defaults to zero-config local memory; one
config switch points at Mem0 / Zep / Letta / Cognee / a self-hosted MCP
server / your own.

### Why this is different

Existing self-evolving agent frameworks pick one memory backend and stay
there. Existing MCP-memory servers (Mem0, Zep, Letta, MemPalace,
agentmemory, brainctl) optimize for storage, not for closed-loop critic
feedback. Darwin v0.4.7 is the first MIT-licensed, TypeScript-native,
MCP-native combination of **pluggable memory** + **symmetric self-evolution**
(score &lt; 5 → `mistake`, score ≥ 8 → `pattern`, mediocre middle band → not
persisted). No vendor lock-in, no cloud required by default, swap-able to
Mem0/Zep/Letta with two config lines.

```typescript
import { localMemory, remoteMemory } from 'darwin-agents/memory/bridge';
import { runClosedLoopTurn } from 'darwin-agents/memory/closed-loop';

// Default: spawn @studiomeyer/local-memory-mcp via npx — zero cloud, zero keys
const memory = localMemory();

// Or any remote MCP-Memory server
// const memory = remoteMemory('https://your-mcp.example.com/mcp', { authHeader: `Bearer ${KEY}` });

// Or Mem0 with the built-in preset — handles tool names + arg shape for you
// import { mem0Preset } from 'darwin-agents/memory/bridge';
// const memory = remoteMemory('https://api.mem0.ai/mcp', {
//   authHeader: `Bearer ${process.env.MEM0_KEY}`,
//   ...mem0Preset({ userId: 'darwin-agent', defaultMetadata: { project: 'darwin' } }),
// });

const result = await runClosedLoopTurn(
  { agentName: 'analyst', topic: 'Audit module X' },
  { runner: yourAgentRunner, store: memory },
);
// Run 1 sees zero lessons. Run 2 sees Run 1's findings as context.
```

### Provider matrix

| Provider | `writeTool` | `readTool` | Notes |
|---|---|---|---|
| **`@studiomeyer/local-memory-mcp`** (default) | `memory_learn` | `memory_search` | zero-config, single SQLite file, no cloud |
| Any self-hosted MCP-Memory server | `memory_learn` | `memory_search` | same wire, remote endpoint |
| **Mem0 MCP** (`mem0ai/mem0-mcp`) | `add_memory` | `search_memories` | use `...mem0Preset({ userId })` — handles tool names + arg shape + the `memory` field in result rows |
| Zep MCP | `zep_add` | `zep_search` | optional `mapWriteArgs` for `group_id` |
| Letta MCP | `archival_insert` | `archival_search` | optional `mapReadResult` for their envelope |
| Cognee MCP | `cognee_add` | `cognee_search` | optional mappers |

Why an MCP-shaped bridge? Because the wire is the same — only tool names
and arg shapes vary. One bridge, one reconnect path, one timeout policy.
The pattern matches the [MCP Bridge proxy paper (arXiv 2504.08999)](https://arxiv.org/html/2504.08999v2)
but stays inside the Darwin process — no extra service to deploy.

### v0.4.9 polish (2026-05-22)

- **Spec-compliant transport.** Every HTTP request now carries the
  `MCP-Protocol-Version: 2025-11-25` header, per MCP spec 2025-11-25
  §"HTTP Protocol Versioning". Strict servers MAY return `400` without
  it; pre-v0.4.9 only sent the version inside the `initialize` payload.

- **Typed errors.** Bridge errors are now instances of
  `McpBridgeProtocolError` (JSON-RPC errors from the server, numeric
  `code`) or `McpBridgeTransportError` (local timeouts, EPIPE, network
  resets, child exits — stable string `code`). Branch on `instanceof`
  to decide retry vs fail-loud without parsing message text.

  ```typescript
  import {
    McpBridgeProtocolError,
    McpBridgeTransportError,
  } from 'darwin-agents/memory/bridge';

  try {
    await memory.save(record);
  } catch (err) {
    if (err instanceof McpBridgeTransportError && err.code === 'timeout') {
      // local timeout — safe to retry
    } else if (err instanceof McpBridgeProtocolError && err.code === -32602) {
      // server said our args are invalid — fail loud, don't retry
    }
  }
  ```

- **Per-call timeouts.** `save()` and `fetchRelevant()` accept a
  `timeoutMs` override that beats the bridge-level default, mirroring
  the MCP SDK's `client.callTool(..., { timeout })`. Useful for one-off
  slow embedding searches without raising `requestTimeoutMs` globally.

  ```typescript
  await memory.fetchRelevant({ query: 'audit', limit: 5, timeoutMs: 30_000 });
  await memory.save(record, { timeoutMs: 5_000 });
  ```

- **Mem0 preset.** `...mem0Preset({ userId })` wires the right tool
  names (`add_memory` + `search_memories`) and arg shapes for the
  official `mem0ai/mem0-mcp` server. See the example above.

See [`examples/memory-darwin-integration.ts`](examples/memory-darwin-integration.ts)
for the full closed-loop pattern: fetch relevant lessons → render them as
prompt context → run the agent → persist critic findings → next run sees
last run's lessons.

## How Evolution Works

<!-- REAL_METRICS_START -->

### Real results from our own production use (Mar–Jun 2026)

Actual numbers from **419 runs across 19 agents** in our internal `darwin_db` —
not synthetic benchmarks. "Success" means the run completed and produced valid
output (100% across 419 runs); "quality" is the critic's separate 1–10 score.

> Those 19 are our own internal + custom agents; the package ships **8 built-in
> agents** by default (`writer`, `researcher`, `critic`, `analyst`,
> `investigator`, `investigator-critic`, `marketing`, `blog-writer`) — the table
> below shows the four with enough runs to report.

```
Agent          Runs   Avg quality
writer          172   6.94 / 10
marketing        70   7.74 / 10
investigator     28   8.33 / 10
blog-writer       5   8.20 / 10
```

**Evolution, measured.** When the safety gate adopted an evolved prompt, the
critic score rose on the runs that followed — modest, but real and directional:

```
writer      v1  6.89 (126 runs)  →  v2  7.12 (42 runs)    +0.23
marketing   v1  7.64 (45 runs)   →  v2  7.92 (25 runs)    +0.28
```

Don't take our word for it — reproduce the v1-vs-evolved comparison on your own
tasks with [`npm run benchmark`](benchmark/).

<!-- REAL_METRICS_END -->

## Feature Comparison

| Feature | Darwin | EvoAgentX | DSPy | CrewAI | AutoGen |
|---------|--------|-----------|------|--------|--------|
| Self-evolving prompts | **Yes** | Yes | Yes (compiler) | No | No |
| A/B testing | **Yes** | No | No | No | No |
| Safety gate + rollback | **Yes** | No | No | No | No |
| TypeScript native | **Yes** | No (Python) | No (Python) | No (Python) | No (Python) |
| Zero-config first agent | **Yes** | No | No | No | Partial |
| MCP-native memory bridge | **Yes** | No | No | No | No |
| File-based (no DB required) | **Yes** | No | No | No | No |
| Built-in Critic agent | **Yes** | No | No | No | No |

## Architecture

```
darwin/
├── src/
│   ├── core/           # Agent runner, config, MCP handling
│   ├── memory/         # SQLite storage (experiments, prompts, learnings)
│   ├── evolution/      # Darwin loop, A/B testing, safety gate, patterns
│   ├── agents/         # Built-in agents (writer, researcher, critic, analyst)
│   └── cli/            # CLI commands (run, status, evolve, create)
```

### Memory System

Darwin uses SQLite by default — zero config, single file, no database to install.

```
.darwin/
├── darwin.db           # All experiments, prompts, learnings
└── reports/            # Markdown reports per run
    ├── exp-writer-2026-03-08-001.md
    └── exp-researcher-2026-03-08-002.md
```

**Want concurrent multi-process writes and richer analytics?**
PostgreSQL is supported out of the box, for free — set `DARWIN_POSTGRES_URL`.
Semantic search (pgvector), cross-agent learnings and analytics are on the
[roadmap](#storage-sqlite-or-postgresql--both-free-both-mit), not gated behind a paywall.

## CLI Reference

```bash
darwin run <agent> "task"          # Run an agent
darwin run writer "Hello" --task-type tech   # With task categorization
darwin run analyst --path ./src    # Analyze a codebase

darwin status                      # Overview of all agents
darwin status writer               # Detailed agent stats + evolution history

darwin canary writer               # Behavioural drift vs a frozen baseline (--json, --exit-on-drift)

darwin evolve writer --enable      # Enable self-evolution (persisted)
darwin evolve writer --disable     # Disable self-evolution (persisted)
darwin evolve writer --reset       # Reset to v1
darwin evolve writer --force       # Force one optimization cycle now

darwin create my-agent             # Scaffold a new agent
```

### Advanced evolution flags

The v0.6/v0.7 evolution strategies are reachable from the CLI. `darwin evolve`
**persists** them onto the agent (they survive process exit); `darwin run`
accepts the same flags as a one-off override for a single run.

```bash
# Persist: reflect with GEPA + a stronger reflection model, pick parents by coverage
darwin evolve writer --gepa --reflection-model claude-opus-4-8 --coverage

# One-off for a single run
darwin run writer "Explain consensus" --gepa --pareto-gate
```

| Flag | What it does |
|------|--------------|
| `--gepa` / `--no-gepa` | GEPA-style reflective prompt mutation (vs. the legacy stats optimizer) |
| `--merge` / `--no-merge` | GEPA system-aware merge of two Pareto-front prompts as a challenger source |
| `--pareto-gate` / `--no-pareto-gate` | Reject an A/B winner that regressed on any objective |
| `--coverage` / `--no-coverage` | Pick the reflection parent by per-task-type coverage breadth (GEPA Algorithm 2) |
| `--reflection-model <id>` | Use a stronger model for GEPA reflection (the documented leverage point) |
| `--demos` / `--no-demos` | SIMBA-style demo injection: the agent's best past runs as a challenger (v0.10) |
| `--candidate-selection <s>` | Reflection parent strategy: `active` \| `best` \| `pareto` \| `epsilon-greedy` (v0.10) |

All default to **off** — the baseline single-objective evolution loop is
unchanged unless you opt in.

## Storage: SQLite or PostgreSQL — both free, both MIT

Darwin runs on SQLite by default (zero config, single file) and on PostgreSQL
out of the box — just set `DARWIN_POSTGRES_URL`. Both backends ship in the
open-source package. There is no paywall.

| Capability | SQLite | PostgreSQL |
|---------|:---:|:---:|
| Experiment tracking | ✓ | ✓ |
| Prompt versioning | ✓ | ✓ |
| A/B testing + safety gate | ✓ | ✓ |
| Keyword search | ✓ (FTS5) | ✓ (GIN / `ts_rank`) |
| Concurrent multi-process writes | — | ✓ |

### Roadmap

Not built yet — tracked in the open, PRs welcome:

- Semantic search (pgvector embeddings)
- Cross-agent learnings
- Analytics & time series
- Contradiction detection
- Data export (CSV/JSON)

The core stays MIT. If a hosted option ever ships, the self-host path keeps
every feature.

## FAQ

**What do I need to run Darwin?**
Node.js 20+ and one of: Claude CLI (default provider), `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or a local Ollama instance. For storage, install `better-sqlite3` (default) or use PostgreSQL via `DARWIN_POSTGRES_URL`.

**Does Darwin work with models other than Claude?**
Yes! Darwin supports multiple providers: Claude CLI (default), Anthropic API, OpenAI/compatible APIs, and Ollama (local). Set `provider` in your config or use `DARWIN_PROVIDER` env var.

**How many runs until I see improvement?**
Around 10 runs. First 5 establish a baseline, then Darwin generates a variant and A/B tests it over the next 5 runs.

**Is my data safe?**
Everything stays local. SQLite file on your disk. No telemetry, no cloud, no data leaves your machine.

**Can I use this for non-English tasks?**
Yes. Agents detect language automatically. Darwin's evaluation is language-agnostic.

**What if Darwin makes my agent worse?**
The safety gate prevents regressions. If a new variant scores >20% lower, Darwin automatically rolls back to the last known-good version.

## Known Limitations

- **LLM-as-Judge bias**: Critics use LLMs to evaluate LLM outputs. Each agent is scored by a **multi-dimension critic set** (several scoring rubrics per agent type, not a single number). When more than one provider key is present, the CLI also spreads those critics across model families — e.g. GPT for one, Claude for another — to blunt single-model self-preference; with one provider they all run on it. Inherent judge bias still exists. [Research context](https://openreview.net/forum?id=Ns8zGZ0lmM).
- **Statistical simplicity (default)**: A/B tests use mean comparison with a 5% threshold by default, not formal significance tests. `computeDynamicMinRuns()` adjusts sample sizes based on variance. For rigor, v0.6 added an opt-in `requireConfidence` effect-size gate and **v0.7 ships proper always-valid sequential tests** — set `confidenceMethod: 'msprt'` (Mixture SPRT) or `'hoeffding'` (σ-free confidence sequence) on your `SafetyThresholds` to make the peeking-resistant gate statistically sound. The default path remains the simple threshold for zero-config use.
- **No human-in-the-loop approval**: Prompt mutations go directly to A/B testing. Telegram notifications inform you, but there's no approval gate before testing starts.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Darwin is pair-built by a human and an AI, and we think that should be said
plainly rather than hidden. Matthias Meyer (StudioMeyer) sets direction, makes
the calls and reviews everything; most of the code is written by
[Claude](https://www.anthropic.com/claude) — currently **Claude Fable 5** —
working from research against the primary sources (the GEPA paper and
reference implementation, DSPy, the MCP spec) and gated by multi-agent code
review plus this repo's own test suite before anything ships. Claude is listed
as a contributor in `package.json`, and the commits it co-writes carry a
`Co-Authored-By` trailer. A framework about agents that improve themselves,
built with an agent — we find that fitting.

## About StudioMeyer

[StudioMeyer](https://studiomeyer.io) is an AI and design studio based in Palma de Mallorca, working with clients worldwide. We build custom websites and AI infrastructure for small and medium businesses. Production stack on Claude Agent SDK, MCP and n8n, with Sentry, Langfuse and LangGraph for observability and an in-house guard layer.

## License

MIT — use freely, commercially or personally.

---

<div align="center">

**Your agents don't just run. They evolve.**

Built by [StudioMeyer](https://studiomeyer.io)

[AI Shield](https://github.com/studiomeyer-io/ai-shield) · [Agent Fleet](https://github.com/studiomeyer-io/agent-fleet) · [MCP Video](https://github.com/studiomeyer-io/mcp-video)

</div>