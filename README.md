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

### Real results from 300+ production runs

These are actual metrics from our development — not synthetic benchmarks.

```
Agents:      writer, researcher, marketing, blog-writer
Total Runs:  300+
Success Rate: 100%

Writer:       7.2/10  (120 runs across tech, webdesign, market)
Marketing:    7.8/10  (70 runs across LinkedIn, Instagram)
Researcher:   7.6/10  (50+ runs, web research with citations)
```

#### Multi-Model Critics in action

```
platform-compliance  ████████░░  8/10
scroll-stopping      ████████░░  8/10
conversion-intent    ████████░░  8/10
```

<!-- REAL_METRICS_END -->

## Feature Comparison

| Feature | Darwin | EvoAgentX | DSPy | CrewAI | AutoGen |
|---------|--------|-----------|------|--------|--------|
| Self-evolving prompts | **Yes** | Yes | Yes (compiler) | No | No |
| A/B testing | **Yes** | No | No | No | No |
| Safety gate + rollback | **Yes** | No | No | No | No |
| TypeScript native | **Yes** | No (Python) | No (Python) | No (Python) | No (Python) |
| Zero-config first agent | **Yes** | No | No | No | Partial |
| MCP native | **Yes** | No | No | No | No |
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

**Want semantic search, cross-agent learnings, and analytics?**
Upgrade to [Darwin Pro](#darwin-pro) for PostgreSQL + pgvector support.

## CLI Reference

```bash
darwin run <agent> "task"          # Run an agent
darwin run writer "Hello" --task-type tech   # With task categorization
darwin run analyst --path ./src    # Analyze a codebase

darwin status                      # Overview of all agents
darwin status writer               # Detailed agent stats + evolution history

darwin evolve writer --enable      # Enable self-evolution
darwin evolve writer --reset       # Reset to v1

darwin create my-agent             # Scaffold a new agent
```

## Darwin Pro

The free version uses SQLite — great for getting started, handles thousands of experiments.

For teams and production use, Darwin Pro adds:

| Feature | Free (SQLite) | Pro (PostgreSQL) |
|---------|:---:|:---:|
| Experiment tracking | ✓ | ✓ |
| Prompt versioning | ✓ | ✓ |
| A/B testing | ✓ | ✓ |
| Safety gate | ✓ | ✓ |
| Keyword search | ✓ | ✓ |
| **Semantic search** (pgvector) | — | ✓ |
| **Cross-agent learnings** | — | ✓ |
| **Analytics & time series** | — | ✓ |
| **Contradiction detection** | — | ✓ |
| **Team support** (multi-user) | — | ✓ |
| **Data export** (CSV/JSON) | — | ✓ |
| **Learning decay** | — | ✓ |

*Coming soon. Follow the repo for updates.*

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

- **LLM-as-Judge bias**: Critics use LLMs to evaluate LLM outputs. We mitigate this with multi-model critics (GPT + Claude), but inherent self-preference bias exists. [Research context](https://openreview.net/forum?id=Ns8zGZ0lmM).
- **Statistical simplicity**: A/B tests use mean comparison with a 5% threshold by default, not formal significance tests. `computeDynamicMinRuns()` adjusts sample sizes based on variance, and v0.6 adds an opt-in `requireConfidence` gate (effect-size + sample-size guard) that resists the peeking problem of evaluating after every run. A proper sequential test (mSPRT / always-valid confidence sequences) is the next step on the roadmap.
- **No human-in-the-loop approval**: Prompt mutations go directly to A/B testing. Telegram notifications inform you, but there's no approval gate before testing starts.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

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