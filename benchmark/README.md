# Darwin Evolution Benchmark

A reproducible check of the one claim that matters: **does an evolved prompt
actually beat the baseline it grew from?**

We don't ask you to trust our metrics. We ship the two prompts, a frozen task
set, and the exact scoring loop, so you can reproduce the delta yourself.

## What it does

1. Loads two prompts:
   - [`prompts/writer-v1-baseline.txt`](prompts/writer-v1-baseline.txt) — the baseline `writer` prompt.
   - [`prompts/writer-v2-evolved.txt`](prompts/writer-v2-evolved.txt) — **verbatim what Darwin's optimizer produced** from v1 in our own run (change reason: *"address 1 weakness: 'market' below good threshold"*). Not hand-tuned for the tasks below.
2. Runs the `writer` agent with each prompt on every task in [`seed-tasks.json`](seed-tasks.json) — a frozen, held-out set.
3. Scores each output with the built-in `critic` (1–10), the same way the CLI does.
4. Prints a per-task table, the two averages, and the delta. Writes a dated report to `results/`.

## Run it

```bash
npm run benchmark            # all seed tasks  (~4 LLM calls per task)
npm run benchmark -- --quick # 1 task (smoke test)
npm run benchmark -- --dry   # validate wiring, zero LLM calls
```

By default this uses your configured Darwin provider. With the **Claude CLI**
provider the runs go through your Claude subscription (no per-token billing).
Set `DARWIN_USE_API_KEY=1` to bill against an `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`
instead.

This harness is an intentional batch, so for its own run it disables Darwin's
per-process budget caps (the default 100-run / 1-hour guard, sized for a single
agent session) via `setMaxRunsPerProcess(0)` / `setMaxRunWallMs(0)`. Your own
agents keep the caps.

## Honest caveats

- **Small samples are noisy.** Ten tasks averaged over a few runs each is a
  harness, not a significance test. For a rigorous comparison run the real loop
  with `confidenceMethod: 'msprt'` on a `SafetyGate` (see the main README) and
  many more runs.
- **The critic is an LLM judge.** It carries self-preference bias; that's a known
  limitation, not a benchmark artifact. Point the critic at a different model
  family for a cleaner read.
- **Your numbers will differ** from ours — different model versions, different
  tasks, sampling variance. That's the point: it's reproducible, not a fixed
  marketing figure.

## Want the full mechanism, not just a replay?

This harness replays a *known* v1→v2 pair. To watch Darwin generate its own v2
from scratch, run the live loop and let the safety gate adopt a winner:

```bash
npx darwin run writer "…a real task…" --task-type market   # repeat ~10×
npx darwin status writer                                    # watch v1 → v2
```
