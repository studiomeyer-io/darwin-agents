# Changelog

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
