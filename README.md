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
> **sequential tests built for continuous monitoring** (mSPRT / Hoeffding),
> which is a different thing from a fixed-n threshold checked repeatedly. How
> much better, measured rather than asserted: Hoeffding's boundary is proved,
> mSPRT's real type-I error still drifts from 0.059 to 0.069 as the horizon
> grows against a nominal 0.05, and the zero-config default is a plain margin
> heuristic with no calibrated α at all. What each one guarantees, what it only
> approximates, and the boundary we shipped wrong until v0.15 are all in
> [statistical scope](#statistical-scope-what-the-sequential-tests-do-and-do-not-guarantee).
> Details:
> [reflective evolution](#reflective-evolution--gepa-online-v06-opt-in)
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
paths. Pair with `requireConfidence` plus `confidenceMethod: 'msprt'` on your
`SafetyThresholds` for an A/B gate built for repeated looks. (`requireConfidence`
alone selects the `'effect-size'` heuristic, which has no calibrated α.) All of it is off unless you opt in — existing
agents behave exactly as before.

### Statistical rigor + coverage sampling (v0.7, opt-in)

v0.7 added sequential testing to the evolution loop and brought the GEPA
optimizer closer to the paper. (One of those tests was wrong until v0.15; see
[statistical scope](#statistical-scope-what-the-sequential-tests-do-and-do-not-guarantee).) Every piece is additive and off by default (one exception:
the feedback window default rose from 5 to 15):

```typescript
import { SafetyGate, DarwinLoop } from 'darwin-agents';

// Sequential A/B gate, built for peeking after every run.
// 'msprt' is the one that can resolve realistic lifts at these run counts.
// It is NOT calibrated here: see "Statistical scope" for the measured error.
const safety = new SafetyGate({
  minDataPoints: 10,
  maxRegression: 0.2,
  failureRollbackThreshold: 3,
  requireConfidence: true,
  confidenceMethod: 'msprt',   // Mixture SPRT. 'hoeffding' is σ-free but needs
                               // ~900 runs per arm even for a 0.2 composite
                               // gap, ~20x the quality component we measured.
});

const loop = new DarwinLoop({
  memory, tracker, optimizer, safety, patterns, agent,
  embed: myBatchEmbedder,      // opt-in semantic alignment guard (zero hard deps — injected)
});
```

- **mSPRT / Hoeffding confidence sequences**: a margin win is adopted only when
  it clears a significance bar designed for repeated looks, so monitoring after
  every run no longer inflates false positives the way a fixed-n threshold
  does. Read [statistical scope](#statistical-scope-what-the-sequential-tests-do-and-do-not-guarantee)
  before relying on either one. `'msprt'` is the method to reach for.
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
- **Style-bias-free judging** (`normalizeForJudging`): strip markdown before the
  critic scores, so it measures content not formatting.

### Statistical scope: what the sequential tests do and do not guarantee

Darwin is applied engineering that borrows from the sequential-testing
literature. It is not a statistics library, and this section says exactly where
the line runs, because "always-valid" is a phrase that gets thrown around and
we threw it around too loosely ourselves.

**We shipped a Hoeffding boundary whose stated proof does not work, from
v0.7 through v0.14.** It used `w(n) = R·√(ln((n+1)/α) / (2n))` and the code
called it "a standard union-bound time-uniform Hoeffding bound". That boundary
allows `2α/(n+1)` of the error budget at every look, and `Σ 2α/(n+1)` diverges,
so the union bound never closes and the justification establishes nothing.
Being exact about the scope of that, because not overclaiming is the point:
what is refuted is the argument, not the boundary. A divergent chain of upper
bounds does not prove the true crossing probability diverges. Nobody has
produced a construction that covers it either, and we are not going to gate
promotions on an unproven bound. Both arms also spent the full α rather than α/2, so even the nominal
accounting was off by a factor of two. Note the limit of that statement: since
the per-arm boundary had no established level in the first place, this is a
bookkeeping error in the allocation, not a proof that the old procedure ran at
2α. Both are fixed in v0.15, and
[`tests/sequential-coverage.test.ts`](tests/sequential-coverage.test.ts) now
re-derives the α-spend numerically instead of asserting it in a comment: the
corrected schedule converges to the budget, the old one is shown diverging past
it. Related reading: Howard, Ramdas, McAuliffe and Sekhon,
[*Time-uniform, nonparametric, nonasymptotic confidence sequences*](https://arxiv.org/abs/1810.08240),
which makes the same point about pointwise Hoeffding intervals.

Where each method stands today:

| | What is guaranteed | The honest caveat |
|---|---|---|
| **`'msprt'`** (the practical choice) | Mixture SPRT over the difference in means, prior δ ~ N(0, τ²), reject at Λ ≥ 1/α. Valid under repeated looks **given a known variance AND a Gaussian (or suitably sub-Gaussian) sampling model**. The mixture likelihood ratio is built from a Gaussian likelihood, so a known variance on its own is not enough, and Darwin has neither. | Darwin plugs in the observed Welch variance, and that is anti-conservative: when the within-arm spread comes out small by chance, Λ overshoots. **Measured under H0** (a coarse judge scoring {0, 0.1, 0.2} at {0.50, 0.05, 0.45}, default α=0.05 and warmup, checking after every individual run): type-I error **0.059 through n=14, 0.064 through n=20, 0.069 through n=30**. It is past α from the first horizon measured and keeps drifting. Through `SafetyGate` the primary test gets α/2, which brings the real error to about 0.046 rather than the 0.025 it was handed: the split narrows the gap, it does not buy calibration. **So this is not a calibrated test at Darwin's sample sizes**, it is a well-motivated stopping rule that behaves roughly like its nominal α over short horizons. v0.15 removed the worst of it (a branch that decided regardless of α); the rest needs a different method (unknown-variance e-process or t-mixture), not a patch. The numbers above are re-measured by the test suite on every run. |
| **`'hoeffding'`** | Non-asymptotic, distribution-free, and provable in four lines (the proof is in the [source](src/evolution/sequential.ts)). No variance estimate involved. **Assumes what Darwin does not enforce**: observations bounded to the declared range (v0.15 refuses out-of-range data rather than guessing), AND independent, with a stable target mean. Correlated judge scores, task drift over the life of a test, or any confounding between arm and task all break that, and a decisive verdict then is not evidence of a prompt effect. | Being σ-free costs power, and more than it looks. Exact figures on a [0, 1] score, **calling the primitive directly at α=0.05**: at n ≤ 21 per arm the two half-widths sum to ≥ 1.0, so no data at all can make it fire; the bar first fits inside the range at n=22 (0.982); at the `computeDynamicMinRuns` ceiling of 30 it is 0.865; a 0.2 composite gap needs n=900. **Through `SafetyGate` under `'msprt'` the fallback runs at α/2**, so those become n=23 (0.995), 0.891 at n=30, 0.665 at n=60, and n=939 for a 0.2 gap. Mind which path you are quoting. A stock config will not promote on quality in practice: the test tops out at 2×minRuns = 60 runs per arm, where the bar is 0.648 (0.665 through the gate). **Mind the units on the lift, because they are easy to conflate**: 0.2 above is a gap on the [0,1] COMPOSITE, while the +0.23 and +0.28 figures reported further down are quality points on a 1-to-10 scale. `tracker.ts` normalises quality as `score / 10` and weights it 0.40 by default, so those lifts contribute **0.0092 and 0.0112** to the composite. Being careful about what that is: it is the QUALITY COMPONENT's contribution, not the total composite delta, which also moves with source count, output length, duration and success, and which we did not record. What it does establish is the order of magnitude, roughly a twentieth of 0.2. Resolving a gap that size distribution-free would take on the order of 742,000 and 488,000 runs per arm. Hoeffding is not a candidate for measuring real evolution lift, and 0.2 is not a realistic composite gap either. v0.15 stopped the inability being silent: the verdict carries `inconclusiveByConstruction` and the gate warns once. |
| **`'effect-size'`** (default) | Nothing. It is a heuristic: \|Δ\| / pooled-mean ≥ 0.2 plus a sample-count floor. | Documented as a heuristic on purpose. It is what runs when you have not opted into anything. |

Two further things we would rather state than have someone discover:

- **`computeDynamicMinRuns` is a throughput heuristic, not a power
  calculation.** It asks for *more* runs when scores cluster tightly, which is
  the opposite direction to the textbook `n ∝ σ²/Δ²` for a fixed absolute
  effect. That is deliberate, and the premise it rests on (that the effect
  worth finding scales with the spread the agent already shows) is written out
  in its [docstring](src/evolution/safety.ts). If you want statistics, do not
  tune this number: turn on `requireConfidence` with `'msprt'` and let the
  sequential test decide.
- **Tighter boundaries exist and we have not implemented them.** The
  curved/stitched and conjugate-mixture constructions in the paper above are
  narrower than a union bound and would make Hoeffding usable at smaller n.
  (Their growth rates differ from one another; an earlier draft of this section
  quoted a single rate for both, which was wrong. Read the paper rather than
  our paraphrase.) Darwin uses the union-bound schedule because its validity is
  checkable by hand in four lines. Checkable beat optimal. That is a trade, and
  you should know it was made.

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

### Budget discipline (v0.11, opt-in)

Two more knobs adapted from GEPA (the values mirror upstream; upstream ships
both on, here they are off unless you turn them on).

**Skip perfect feedback** (`skipPerfectFeedback`) adapts GEPA's
`skip_perfect_score`. Upstream skips a whole reflection iteration when an entire
sampled minibatch is perfect; Darwin generalizes it to per-report filtering,
which it can afford because the critic scores on real runs are already paid for.
A run that already scored a perfect critic score carries no improvement
gradient, so its "nothing to fix" report just dilutes the pool. When on,
perfect-score reports are dropped from *both* the legacy optimizer feedback and
the GEPA reflection minibatch (lower `perfectFeedbackScore` from the default 10
to also skip near-perfect runs). With `useDemos` on, those perfect runs still
get used — harvested as demonstrations instead.

**Merge budget** (`maxMergeInvocations`) adapts GEPA's `max_merge_invocations`
(default 5 upstream): a per-agent *lifetime* cap on how many merge-derived
challengers an agent may produce. The GEPA paper leaves merge-budget allocation
as open research; the reason Darwin needs a cap is its own — an uncapped
`mergeEveryK` cadence would merge forever, so late in an agent's life merges
would crowd out the reflective exploration that finds genuinely new strategies.
Once the cap is hit the loop falls back to the reflective path for good. Left
unset it is uncapped (the v0.10 behaviour); set it to `5` to match GEPA's
protective default.

**A/B time budget** (`maxTestDays`, v0.13) bounds how long a single A/B test may
stay open. `minRuns` is a *sample* budget and knows nothing about throughput:
when scores cluster tightly the dynamic gate correctly raises the bar to 30 runs
per arm, but an agent that runs a few times a week cannot pay that inside a
year — and it cannot evolve at all while a test is open. When the budget runs
out before both arms reach `minRuns`, the test closes as inconclusive: the
incumbent keeps the slot and a later cycle is free to try a different
challenger.

A timeout never promotes the challenger. Lowering `minRuns` instead would trade
the deadlock for promotions on noise, which is the worse failure — judge
variance (±1 on a 10-point scale) is larger than the real evolution lift
(~+0.1–0.2, see `benchmark/results/`). Unset means tests run until they conclude
on their own; `0` also means "no budget", so a persisted budget can be removed.

Two mechanics worth knowing: the budget is **snapshotted onto the test when it
starts** (v0.13.1), so a test keeps its deadline even if later invocations run
without the flag; and expiry is enforced **inside the evolution loop** — a
`darwin run` whose output is too short to record returns before the loop, so an
agent producing *only* unrecordable output will not trip the budget until one
run reaches the loop (`darwin evolve <agent> --reset` clears such a test
immediately, at the cost of resetting the active version to v1).

```typescript
evolution: {
  enabled: true,
  useGepa: true,
  skipPerfectFeedback: true,         // GEPA skip_perfect_score — focus feedback on failures
  perfectFeedbackScore: 10,          // score (1-10) counted as "perfect" (default 10)
  useMerge: true,
  maxMergeInvocations: 5,            // GEPA max_merge_invocations — cap merge over the agent's life
  maxTestDays: 30,                   // close an A/B test after 30d if it cannot reach minRuns
},
```

### Offline evals + metrics sink (v0.14, opt-in)

**Offline evals** (`darwin eval`) bring the dataset-and-metric loop that offline
optimizers (DSPy's `Evaluate`, gepa-ts/dsts trainsets) are built around — as a
complement to the online loop, not a replacement. Run any stored prompt
versions over a frozen task set, score every output with the built-in critic
(or your own metric via the API), and read per-task means plus deltas against
the baseline arm:

```bash
darwin eval writer --tasks tasks.json                  # v1 vs the active version
darwin eval writer --tasks tasks.json --versions v1,v3 --runs 3
darwin eval writer --tasks tasks.json --all-versions --json
```

The task set is plain JSON (`[{"id": "t1", "type": "tech", "task": "…"}]` —
the same shape as `benchmark/seed-tasks.json`), and the programmatic API
(`runEval`) takes an injectable runner + scorer, so custom metrics
(exact-match, latency, your own rubric) plug in without touching the loop.
The intended workflow: **vet prompts offline on a frozen set, then let the
live A/B gate decide under real traffic** — offline means are directional,
the sequential gate is the significance test.

**Per-agent safety thresholds** (`evolution.safety`) open the config-level
door to the statistical-rigor knobs. Before v0.14 the sequential tests
existed but were reachable only by hand-wiring a `SafetyGate`; now any
agent definition — and the CLI — can arm them:

```typescript
evolution: {
  enabled: true,
  safety: { requireConfidence: true, confidenceMethod: 'msprt' },
},
```

```bash
darwin evolve writer --require-confidence --confidence-method msprt   # persisted
```

**Metrics sink** — every evolution decision (run recorded, evolution
skipped with its reason, A/B started / completed / timed out, rollback) is
emitted as a typed event. Zero hard deps: set
`DARWIN_METRICS_JSONL=darwin-events.jsonl` for the built-in append-only
JSONL sink, or inject your own `MetricsSink` (Prometheus, dashboards —
see `examples/otel-bridge.ts` for an OpenTelemetry bridge in ~60 lines). A
throwing sink can never break the loop; observability is fire-and-forget
and strictly best-effort — async sink errors are dropped, not retried (an
event can be LOST), and concurrent multi-process writers against the same
store can double-report a decision they race on (an event can be
DUPLICATED). Zero-or-more delivery: treat the stream as observability,
never as an audit log.

## Built-in Agents

| Agent | What it does | Needs |
|-------|-------------|-------|
| **writer** | Content writing, explanations, copy | Nothing (zero-config) |
| **researcher** | Web research with source citations | Tavily API key |
| **critic** | Evaluates other agents' output (1-10) | Nothing |
| **analyst** | Code quality analysis | Filesystem access |

Each agent ships with a dedicated **multi-critic set** that scores the output by the right criteria for that agent type (research = source quality + analytical depth + completeness, analyst = technical accuracy with file:line refs + pattern recognition + recommendation quality, etc.).

**Bring your own judges (v0.12.0):** agents outside the built-in archetypes used to silently fall back to the investigator judges — the only way to register domain critic sets was to fork `multi-critic.ts`. Now `runMultiCritic` accepts them per call, so your critic sets live in *your* codebase:

```typescript
import { runMultiCritic, type CriticPromptDef } from 'darwin-agents';

const SIMULATION_JUDGES: CriticPromptDef[] = [
  { name: 'action-quality',   prompt: 'You judge the quality of a game action… ===SCORE=== N' },
  { name: 'social-awareness', prompt: 'You judge how the actor used social context… ===SCORE=== N' },
  { name: 'game-fitness',     prompt: 'You judge fitness toward the win condition… ===SCORE=== N' },
];

const result = await runMultiCritic(turnOutput, task, runCritic, 'sim-trader', {
  criticPrompts: SIMULATION_JUDGES,      // any count ≥ 1; empty array → built-in lookup
  outputLabel: 'simulation turn',        // "Evaluate the following simulation turn for…"
});
```

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

Don't take our word for it. Reproduce the v1-vs-evolved comparison on your own
tasks with [`npm run benchmark`](benchmark/).

<!-- REAL_METRICS_END -->

> **How much these numbers are worth.** They are ours: our agents, our tasks,
> our critics. The quality score is an LLM judging an LLM, and for most of
> these runs the judge and the author sit in the same model family, which is
> the direction self-preference bias runs. The lifts above (+0.23, +0.28) are
> also smaller than the judge variance we measured on repeat scoring of
> identical output (about ±1 point), so they are directional evidence across
> many runs, not a per-run effect you could observe. Nobody independent has
> evaluated Darwin. If a number here matters to your decision, reproduce it:
> `npm run benchmark` ships the prompts, the frozen task set and the scoring
> loop for exactly that reason.
>
> (Kept outside the `REAL_METRICS` markers on purpose: everything between them
> is regenerated by `scripts/update-readme-metrics.ts`.)

## Feature Comparison

Against the Python frameworks the category grew up in:

| Feature | Darwin | EvoAgentX | DSPy | CrewAI | AutoGen |
|---------|--------|-----------|------|--------|--------|
| Self-evolving prompts | **Yes** | Yes | Yes (compiler) | No | No |
| Online A/B testing in production | **Yes** | No | No | No | No |
| Safety gate + rollback | **Yes** | No | No | No | No |
| Offline dataset evals | **Yes** (v0.14) | Yes | **Yes** (its core) | No | No |
| TypeScript native | **Yes** | No (Python) | No (Python) | No (Python) | No (Python) |
| Zero-config first agent | **Yes** | No | No | No | Partial |
| MCP-native memory bridge | **Yes** | No | No | No | No |
| File-based (no DB required) | **Yes** | No | No | No | No |
| Built-in Critic agent | **Yes** | No | No | No | No |

And against the TypeScript prompt-optimization packages that have since
appeared — worth knowing, and each good at what it does:

| | Darwin | [gepa-ts](https://github.com/tangle-network/gepa-ts) | [@currentai/dsts](https://www.npmjs.com/package/@currentai/dsts) | [@kamiyo-org/selfimprove](https://www.npmjs.com/package/@kamiyo-org/selfimprove) |
|---|---|---|---|---|
| GEPA reflective optimizer | **Online, inside the safety gate** | Offline batch (1:1 Python parity) | Offline batch (AI-SDK-native) | No (bandit + LLM judge) |
| Where optimization runs | Live traffic, A/B-gated | Offline trainset | Offline trainset | Live traffic, bandit-routed |
| Regression rollback + alignment guard | **Yes** | No | No | Canary rollback |
| Sequential stats built for continuous monitoring | **Yes** (mSPRT / Hoeffding, [scope + caveats](#statistical-scope-what-the-sequential-tests-do-and-do-not-guarantee)) | No | No | Welch's t-test |
| Offline dataset evals | Yes (v0.14) | **Yes** | **Yes** | Cold-start harness |
| Cost/latency as objectives | No (roadmap) | No | **Yes** (+ USD budget caps) | Pareto (quality/cost/latency) |
| Metrics export | JSONL + OTel bridge (v0.14) | WandB | Logger hook | **Prometheus/Grafana** |
| Zero hard deps | **Yes** | No | No | ~ (SQLite) |

The one thing none of the others ship — and Darwin's actual point — is the
**GEPA reflector running *online*, inside a production safety gate** with
regression rollback, alignment checks on every mutation, and peeking-resistant
sequential statistics. Offline optimizers tune prompts before you deploy;
Darwin keeps tuning them safely after.

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

darwin eval writer --tasks tasks.json --versions v1,v3 --runs 3   # Offline eval over a frozen task set

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
| `--skip-perfect` / `--no-skip-perfect` | Drop perfect-score runs from optimizer feedback — GEPA `skip_perfect_score` (v0.11) |
| `--max-merge <n>` | Lifetime cap on merge-derived challengers — GEPA `max_merge_invocations` (v0.11) |
| `--max-test-days <n>` | Close an A/B test after n days if it cannot reach `minRuns`; keeps the incumbent, never promotes. `0` = no budget (v0.13) |

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
Yes! Darwin supports multiple providers: Claude CLI, Anthropic API, OpenAI/compatible APIs, and Ollama (local). Set `provider` in `darwin.config.ts`, pass `--provider` per run, or rely on auto-detection (`ANTHROPIC_API_KEY` → anthropic-api, else `OPENAI_API_KEY` → openai, else claude-cli).

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
- **Statistical simplicity (default)**: A/B tests use mean comparison with a 5% threshold by default, not formal significance tests. `computeDynamicMinRuns()` adjusts sample sizes from the observed spread, as a throughput heuristic rather than a power calculation. For rigor, v0.6 added an opt-in `requireConfidence` effect-size gate and v0.7 added sequential tests (`confidenceMethod: 'msprt'` / `'hoeffding'`). Since v0.14 they are one config block away: `evolution.safety: { requireConfidence: true, confidenceMethod: 'msprt' }` or `darwin evolve <agent> --require-confidence --confidence-method msprt`, with no hand-wired `SafetyGate` needed. The default path remains the simple threshold for zero-config use. **What those tests guarantee, what they only approximate, and the boundary we shipped wrong until v0.15, are all in [statistical scope](#statistical-scope-what-the-sequential-tests-do-and-do-not-guarantee). Read it before treating a promotion as a significant result.**
- **Our numbers are our own**: the [benchmark](benchmark/) is reproducible (frozen tasks, both prompts, the scoring loop, all in the repo) but it is ten tasks scored by an LLM judge, and the production figures quoted anywhere in this README come from our own fleet with our own critics. Nobody independent has evaluated Darwin. Treat every number here as a starting point for your own measurement, not as evidence.
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