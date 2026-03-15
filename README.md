<div align="center">

# darwin

**AI agents that improve themselves.**

[![npm version](https://img.shields.io/npm/v/darwin-agents?color=blue)](https://www.npmjs.com/package/darwin-agents)
[![npm downloads](https://img.shields.io/npm/dw/darwin-agents)](https://www.npmjs.com/package/darwin-agents)
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

## Built-in Agents

| Agent | What it does | Needs |
|-------|-------------|-------|
| **writer** | Content writing, explanations, copy | Nothing (zero-config) |
| **researcher** | Web research with source citations | Tavily API key |
| **critic** | Evaluates other agents' output (1-10) | Nothing |
| **analyst** | Code quality analysis | Filesystem access |

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
- **Statistical simplicity**: A/B tests use mean comparison with a 5% threshold, not formal significance tests (t-test, Mann-Whitney U). `computeDynamicMinRuns()` adjusts sample sizes based on variance, but p-values are on the roadmap.
- **No human-in-the-loop approval**: Prompt mutations go directly to A/B testing. Telegram notifications inform you, but there's no approval gate before testing starts.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — use freely, commercially or personally.

---

<div align="center">

**Your agents don't just run. They evolve.**

Built by [StudioMeyer](https://studiomeyer.io)

[AI Shield](https://github.com/studiomeyer-io/ai-shield) · [Agent Fleet](https://github.com/studiomeyer-io/agent-fleet) · [MCP Video](https://github.com/studiomeyer-io/mcp-video)

</div>
