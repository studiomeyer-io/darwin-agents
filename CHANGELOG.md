# Changelog

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
