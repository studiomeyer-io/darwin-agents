# Changelog

## [Unreleased]

## [0.13.0] — 2026-08-01

### Fixed

- **A rejected challenger is no longer overwritten by the next one.** The
  challenger's version label was derived from the *active* version
  (`nextVersion(activePrompt.version)`). That is only unique while the active
  version is also the newest: when an A/B test concludes in favour of the
  incumbent, the loser keeps its label and the incumbent stays active, so the
  next evolution cycle produced the loser's label a second time.
  `savePromptVersion` upserts on (agentName, version), so the new challenger
  overwrote the old row in place — its prompt text was destroyed, and
  `createdAt`/`parentVersion` were left describing a prompt that no longer
  existed.

  Observed on a live agent: a version row still dated to its first challenger
  while carrying text generated two weeks later, with `totalRuns` reset to 0 on
  every cycle. The damage is not limited to bookkeeping — merge-parent
  selection, Pareto candidate selection and `darwin status` all read the
  version archive through `getAllPromptVersions`, so GEPA was choosing parents
  from a history that had been silently collapsed to two entries.

  Numbering now continues above the highest version in history rather than
  above the active one. When the active version already is the highest — the
  healthy case, and the only case the previous suite constructed — the label is
  unchanged. `tests/version-collision.test.ts` asserts the contract ("generating
  a challenger must not rewrite an existing version") rather than a named
  victim.

  Note for anyone reading the old tests: `loop-integration-v07.ts` deliberately
  seeds v1/v2 as history with v3 active, commented "no name clash with the
  existing versions". The suite routed around this defect instead of covering
  it.

### Added

- **`evolution.maxTestDays` — an optional wall-clock budget per A/B test**
  (CLI `--max-test-days <n>`, persisted like the other advanced flags).
  `minRuns` is a sample budget with no notion of throughput:
  `computeDynamicMinRuns` correctly raises the bar to the 30-run ceiling when
  scores cluster tightly, but a low-frequency agent cannot pay 30 runs per arm
  in any useful timeframe — and it cannot evolve at all while its test is open.

  When the budget is exhausted without both arms reaching `minRuns`, the test
  closes as inconclusive: the incumbent stays active and the slot is freed for
  a later challenger. A timeout **never** promotes the challenger. Lowering
  `minRuns` instead would trade the deadlock for promotions on noise, which is
  worse — measured judge variance (±1 on a 10-point scale) dwarfs the real
  evolution lift (~+0.1–0.2, `benchmark/results/`).

  Unset is the default and leaves the untimed path exactly as it was. Non-
  positive, non-finite, and unparsable-`startedAt` cases never expire a test.
  `--max-test-days 0` is the explicit off switch. Overrides are merged rather
  than deleted and `--reset` does not clear them, so without an in-band "no
  budget" value a persisted budget would have been irreversible short of
  editing the state blob. (`--max-merge 0` likewise accepts an in-band zero,
  though there it means "cap at zero merges" rather than "no cap".)

  The budget is also enforced on the incomplete-run path inside
  `DarwinLoop.afterRun`, which returns before the normal A/B handling — an
  agent whose runs are consistently too short to score is precisely the
  low-throughput case the budget targets. Note this covers SDK and
  `buildEvolutionLoop` callers: the `darwin run` CLI already returns on a
  short output *before* reaching the loop at all, so that path is unchanged.

  Closing a test this way emits its own `notifyABTestTimeout` alert rather than
  reusing the completion notification, which announces a winner and a score
  delta that a timeout does not have. The elapsed time it reports is the
  configured budget; the actual close happens on the first run the loop
  processes after the budget expires, so real elapsed time is at least that.

## [0.12.2] — 2026-07-17

### Security

- **Evolution-loop optimizer/reflector subprocesses no longer run with
  `bypassPermissions`.** `buildEvolutionLoop`'s two LLM closures (legacy
  optimizer meta-prompt + GEPA reflector) are pure text mutators, but they
  passed `autonomous: true` to `runAgent`, which spawns the Claude CLI with
  `--permission-mode bypassPermissions` — and since neither agent definition
  declares tools/MCP servers, no `--allowedTools` restriction was emitted
  either. Their input quotes untrusted agent output (critic feedback reports
  can contain scraped web content), so a prompt injection could in principle
  have steered an unrestricted subprocess into tool calls. Both closures now
  run `autonomous: false` (the CLI's deny-by-default permission mode);
  legitimate runs are unaffected because the templates demand "return ONLY
  the prompt text". Found by an adversarial review of the first external
  consumer wiring `buildEvolutionLoop` (severity: plausible, low
  probability, real surface). `tests/build-loop-security.test.ts` is the
  regression tripwire.

## [0.12.1] — 2026-07-16

Export patch — no behavioural change. Completes the v0.12.0
"bring-your-own-judges" story: custom judges were usable, but an external
post-run hook still could not *drive the evolution loop* from the published
package, because the loop-composition surface was internal and the package
`exports` map (correctly) blocks deep imports from `dist/`.

### Added

- **Root exports for the loop-composition surface:** `buildEvolutionLoop`
  (wires tracker/patterns/safety/legacy-optimizer/opt-in-GEPA/notifications
  around a `DarwinLoop` exactly like the CLI run path — GEPA activates via
  `agent.evolution.useGepa`), plus the individual classes `DarwinLoop`,
  `ExperimentTracker`, `PatternDetector`, `PromptOptimizer`, `SafetyGate`
  and the types `EvolutionResult` / `AgentToolContext` for consumers
  composing custom loops. New `tests/root-exports.test.ts` locks the surface.

## [0.12.0] — 2026-07-16

Bring-your-own-judges: the multi-critic runner accepts caller-supplied critic
sets, closing the gap that forced fleets with domain agents to fork this file.
Plus a CI release-guard against the adapter peer-range breakage that has now
happened twice. Default behaviour is unchanged.

### Added

- **`RunMultiCriticOptions.criticPrompts`** — an explicit critic-prompt set
  for a single `runMultiCritic` call, bypassing the built-in
  `getCriticPrompts` name lookup. The built-in `AGENT_CRITIC_MAP` covers a
  handful of generic archetypes (investigator / writer / research / critic /
  analyst / …); any agent name outside it silently falls back to the
  investigator judges, which mis-score domain output (a game-simulation turn
  judged as an investigative report). Until now the only way to register
  domain judges was to fork `multi-critic.ts` — our own agent fleet did
  exactly that, and the fork promptly fell behind the engine. With this
  option the caller keeps critic sets in its own codebase and passes the
  right set per call. Any count ≥ 1 works (the median handles even counts).
  Entries that are not a `{ name, prompt }` pair of non-empty strings are
  dropped (a config-loaded judge list with holes degrades instead of
  crashing), and an **empty array, a non-array, or an all-invalid array falls
  back to the built-in lookup** so a misconfigured caller gets v0.11
  behaviour instead of judging with zero critics. Judge contract: each prompt
  must instruct the critic to emit `===SCORE=== N` (or an `X/10` figure) —
  outputs without either count as a failed critic.
- **`RunMultiCriticOptions.outputLabel`** — overrides the evaluation-preamble
  label ("Evaluate the following *{label}* for the task …") for agents
  outside the built-in `AGENT_OUTPUT_LABELS` map. Whitespace-only values are
  ignored. Composes with `normalizeForJudging` and `criticPrompts`.
- **Release-guard `check:adapter-compat`**
  (`scripts/check-adapter-compat.mjs`, wired into **both** the CI workflow
  and `prepublishOnly` — publish-first workflows are covered, not just
  push-first): fails the build when this package's version escapes the
  published `darwin-langgraph@latest` peer range for `darwin-agents`. Both
  0.9.0 and 0.11.0 escaped the adapter's then-current cap the day they
  shipped — explicit paired installs failed with `ERESOLVE`, unpinned
  installs silently downgraded darwin-agents. The guard turns the third
  recurrence into a red build before `npm publish`. Prerelease-aware: it
  judges the **release counterpart** (`1.0.0-alpha.1` → `1.0.0`), matching
  what the prerelease becomes — an exact-prerelease mismatch under npm's
  plain-prerelease rules is a WARN, not a FAIL (prereleases ship on a
  dist-tag and never affect default installs). Network-tolerant (registry
  hiccups warn and pass). Release ordering note: publish the adapter's
  widened-peer release (`darwin-langgraph@0.5.4`, peer `<1.0.0`) **before**
  pushing/publishing this version, or the guard fires exactly as designed.

### Notes

- No behavioural change without the new options: `criticPrompts` unset/empty
  and `outputLabel` unset/blank reproduce v0.11 byte-for-byte.
- `semver` + `@types/semver` added as devDependencies (guard script only —
  the runtime stays zero-dependency).

## [0.11.0] — 2026-07-09

Two opt-in "budget discipline" knobs adapted from GEPA (verified against the
DSPy GEPA API and the gepa-ai engine source) to Darwin's forever-online loop.
The values mirror upstream's defaults; the mechanisms are Darwin's own
adaptation. Default behaviour is unchanged with the flags off.

### Added

- **`skipPerfectFeedback`** (adapted from GEPA's `skip_perfect_score`,
  `src/evolution/feedback-filter.ts`). Upstream skips a whole reflection
  iteration when an entire sampled minibatch is perfect; Darwin generalizes it
  to per-report filtering, which it can afford because the critic scores on real
  runs are already paid for. A run that already scored a perfect critic score
  carries no improvement gradient — its "nothing to fix" report only dilutes the
  pool. When `true`, such reports are dropped from **both** the legacy optimizer
  feedback (`getRecentFeedback`) and the GEPA reflective feedback
  (`getReflectiveFeedback`); skipped items do not count toward the feedback
  window, so it fills with actionable reports. `perfectFeedbackScore` (default
  10, the critic-scale max) sets the threshold — lower it to also skip
  near-perfect runs. A non-finite score is never treated as perfect, so a
  genuinely broken run still surfaces. If every recent run is perfect the
  reflective path falls back to the legacy stats optimizer and the legacy path
  proceeds on aggregate stats (so the loop keeps exploring). With `useDemos` on,
  perfect runs are still used — harvested as demonstrations. CLI: `--skip-perfect`
  / `--no-skip-perfect`. Pure helpers (`isPerfectScore` /
  `resolvePerfectFeedbackScore` / `filterPerfectFeedback`) are exported from the
  package root.
- **`maxMergeInvocations`** (adapted from GEPA's `max_merge_invocations`, default
  5 upstream). A per-agent **lifetime** cap on merge-derived challengers,
  persisted in `DarwinState.mergeInvocations` (a process-scoped counter would
  reset every cron tick and never trigger). The GEPA paper leaves merge-budget
  allocation as open research; the reason Darwin needs a cap is its own — an
  uncapped `mergeEveryK` cadence would merge forever and crowd out reflective
  exploration late in an agent's life. The count is the number of merge
  challengers actually **created** — a merge that fails the alignment guard is
  not counted (it consumed no A/B slot) — and is written **only when a cap is
  set**, so an uncapped `useMerge` agent's persisted state is unchanged from
  v0.10. Once the cap is reached the merge branch is skipped and the loop falls
  back to the reflective path for the rest of the agent's life (the budget does
  not re-arm). Only consulted when `useMerge` is on. Left unset it is uncapped
  (v0.10 behaviour); set it to `5` to match GEPA's default. CLI: `--max-merge <n>`
  (non-negative integer; `0` disables merge).

### Notes

- Both knobs flow through the existing override machinery
  (`EvolutionConfigOverride` + `OVERRIDE_KEYS` + `resolveEvolutionConfig` +
  `describeOverride`/`describeConfig`), so they are CLI-settable, persist across
  processes, and CLI overrides win over persisted ones.
- +24 tests (610 total, 609 pass / 1 pre-existing skip). `tsc`, `typecheck:tests`
  and `build` clean. Default-path decisions unchanged; an uncapped agent writes
  no new state.

## [0.10.0] — 2026-07-03

Two research-driven, opt-in evolution surfaces — a new challenger *source*
(demo injection) and a new parent-*selection* strategy for the existing
reflective challenger — both validated against the current state of the field
(GEPA upstream docs, DSPy SIMBA) before a line was written. Default behaviour
is byte-for-byte unchanged with the flags off.

### Added

- **SIMBA-style demo injection** (`src/evolution/demos.ts` + `evolution.useDemos`).
  DSPy's SIMBA optimizer improves programs two ways: appending self-reflective
  *rules* (Darwin's reflector already covers that ground) and appending
  successful past examples as *demonstrations*. This release adapts the second
  strategy to the online loop: on every `demoEveryK`-th evolution cycle (default
  4) the loop harvests the agent's own highest-scoring past runs (score ≥
  `demoScoreThreshold`, default 8; at most one demo per task type for
  diversity; `maxDemos` cap, default 2) and appends them as a marker-delimited
  "Demonstrations" section. The demo-augmented prompt is a normal challenger —
  same alignment guard, same A/B test, same safety gate; if demos don't help
  this agent, the incumbent wins. **Zero LLM cost** (pure selection +
  rendering on data Darwin already persists), works with or without `useGepa`,
  idempotent via `<!-- darwin:demos:start/end -->` markers (a later cycle
  *refreshes* the section, never stacks a second one). Pure helpers
  (`selectDemoCandidates` / `buildDemoSection` / `applyDemoSection` /
  `stripDemoSection`) are exported from the package root. CLI: `--demos` /
  `--no-demos`.

- **Parent-selection strategies** (`src/evolution/selection.ts` +
  `evolution.candidateSelection`) — GEPA `candidate_selection_strategy` parity
  for the online loop. Historically the loop always reflected from the
  currently-active prompt (a hill-climb that can sit on a local optimum).
  Opt-in strategies pick the reflection parent from the agent's *scored
  version history* instead: `'best'` (GEPA `current_best` — highest
  scalarised composite), `'pareto'` (GEPA default — uniform sample from the
  non-dominated front, keeping lineages alive that win on different
  objectives), `'epsilon-greedy'` (explore with probability
  `explorationEpsilon`, default 0.1, exploit otherwise). The RNG is
  injectable via the new `DarwinLoopDeps.rng` for deterministic tests.
  Precedence: `useCoverage` (GEPA Algorithm 2, the more specific selector)
  wins when it finds a coverage parent. Only consulted when `useGepa` is on.
  CLI: `--candidate-selection <active|best|pareto|epsilon-greedy>`.

### Internal

- `tryMergeVariant`'s version-history scoring extracted into a shared
  `buildScoredHistory` (used by merge *and* parent selection) — behaviour
  unchanged.
- `package.json` now lists Claude (Anthropic) as a contributor — see the
  README's new **Credits** section for how this project is actually built.

## [0.9.0] — 2026-06-21

### Added

- **Validate-by-reproduce drift-detection canary** (Phase 2 A5) — new
  `src/evolution/canary.ts` + a `darwin canary <agent>` command. The A/B gate
  guards prompt *quality*; the canary guards *behaviour*. It compares an agent's
  recent execution trajectories (captured in A1) against a frozen baseline using
  tolerance-based metrics — unordered tool-set Jaccard, ordered tool-sequence
  similarity, turn-count ratio, error-rate delta — and flags drift the score can
  miss (a model update or a broken tool changing *how* the agent works while the
  quality score stays flat). Exact-hash equivalence is deliberately avoided (LLM
  runs are non-deterministic). Drift requires a *pattern* (default ≥2 of N runs),
  and the baseline is pinned to the active prompt version so an intentional
  evolution reports `insufficient-data` (re-baseline) rather than a false alarm.
  Pure and zero-dep; `--json` + `--exit-on-drift` for CI. The metrics and the
  `runCanaryOverExperiments` orchestrator are exported from the package root so
  consumers can run the same check on their own captured trajectories.

- **Cross-family critic diversity check** (`src/evolution/critic-families.ts`).
  Multi-critic evaluation spreads critics across model families to reduce
  LLM-as-judge bias — but only when more than one provider key is present.
  Otherwise all three critics collapse onto a single family (`claude-cli` and
  `anthropic-api` are the *same* family, differing only in latency) with no
  signal to the operator. The run path now warns when the critics share one
  family, and hard-fails when `DARWIN_REQUIRE_CROSS_FAMILY` is set (CI / strict
  setups). Default behaviour is unchanged apart from the new warning.

## [0.8.0] — 2026-06-21

**Evolution wired end-to-end through the CLI, plus three correctness fixes.** The
v0.7 evolution surfaces existed but the `darwin evolve` command couldn't fully
drive them; this release closes that gap and hardens score parsing. The
automatic loop is behaviour-preserving — the gated path still passes the
existing loop/GEPA suites unchanged.

### Added

- **`darwin evolve <agent> --force`** now runs the loop's real
  variant-generation + A/B-start path on demand (`DarwinLoop.forceEvolve()`),
  bypassing the automatic "enough runs / actionable patterns / data quality"
  gates while still refusing the impossible cases (no active prompt, no recorded
  experiments, an A/B test already running). It was previously a stub that
  printed "not yet available" while the help text advertised it.
- **`src/evolution/build-loop.ts`** — shared loop wiring (legacy optimizer +
  opt-in GEPA) used by both `cli/run.ts` and the new `--force` command.

### Fixed

- **`darwin evolve <agent> --enable|--disable` now persists.** The flag mutated
  only the in-memory agent singleton, so it was lost on process exit and `darwin
  run` read the static source default again. A new `DarwinState.evolutionEnabled`
  override map (round-tripped by every backend's existing JSON state blob) is set
  atomically by the evolve command and wins over the static default in the run
  path. Persisting an enable on an agent with no evolution config is a no-op, not
  a crash; the field is read defensively so pre-existing state rows keep their
  prior behaviour. New shared helper `src/evolution/enabled-state.ts`.
- **Robust critic-score parsing** via a shared `parseCriticScore` helper —
  handles `===SCORE===`, `N/10`, "N out of 10", "rating: N", "I'd rate this N", …
  (clamped 1–10). Previously only `===SCORE===` and a bare `N/10` were read,
  silently dropping every other phrasing from evolution.

## [0.7.1] — 2026-06-20

**Documentation honesty + a reproducible evolution benchmark.** No library code
changed — `src/` is byte-for-byte 0.7.0, **455 tests green**, `build` clean. This
release makes every claim in the README survive scrutiny and ships a way to
reproduce the one that matters.

### Added

- **`benchmark/`** — a reproducible evolution benchmark (`npm run benchmark`).
  Ships the baseline `writer` prompt and the prompt Darwin's own optimizer
  produced from it, a frozen held-out task set, and the exact critic-scoring
  loop, so anyone can reproduce the baseline-vs-evolved delta on their own tasks.
  `--quick` (1 task) and `--dry` (validate wiring, zero LLM calls) flags.

### Changed

- **README metrics are now real and dated.** Replaced the stale "300+ runs /
  7.2–7.8" block with actual figures from 419 runs across 19 agents
  (Mar–Jun 2026), including the measured v1→v2 evolution lift (writer +0.23,
  marketing +0.28).
- **Removed the "Darwin Pro — coming soon" tier.** PostgreSQL already ships free
  in the open-source package; the old table implied a paywall and even listed
  Postgres itself as a paid feature. Replaced with an honest "SQLite or
  PostgreSQL — both free, both MIT" section + an open roadmap for the
  genuinely-unbuilt features (pgvector semantic search, cross-agent learnings,
  analytics, contradiction detection, data export).
- **Clarified the LLM-as-judge mitigation.** Critics are multi-*dimension* by
  default; the CLI spreads them across model families (GPT + Claude) only when
  more than one provider key is present.
- **Comparison table:** "MCP native" → "MCP-native memory bridge" — the specific,
  defensible claim (other frameworks added MCP tool use during 2025).
- Surfaced the production safety gate, online GEPA, and always-valid sequential
  tests in a "why this isn't a toy" callout near the top of the README.

## [0.7.0] — 2026-06-20

**Statistical rigor + coverage sampling.** Seven additive, opt-in upgrades that
make the self-evolution loop statistically honest and bring the GEPA optimizer
to feature-parity with the paper. With the new flags off, the evolution loop,
the A/B gate, and prompt mutation are byte-for-byte identical to v0.6.0 — except
the feedback window default (see **Changed**). This is the first stable `latest`
since 0.4.9: `npm i darwin-agents` now resolves to 0.7.0. (The 0.7.0-alpha.1
preview, 2026-06-19, shipped the first six modules; 0.7.0 final adds GEPA
system-aware **merge** and promotes the line to `latest`.) Reviewed by a 3-agent
code-review round (critic + analyst + research) + an R2 verifier + a focused
merge-wiring review, plus per-fix re-verification. **456 tests green** (was 355,
+101), `tsc` + `typecheck:tests` + `build` all clean. Zero hard deps preserved —
the embedding capability is **injected** (`EmbedFn`) and the coverage RNG is
injected too, so the pure modules stay pure.

### Added

- **GEPA system-aware merge in the loop** (`EvolutionConfig.useMerge` +
  `mergeEveryK`, default cadence 3) — on every K-th evolution cycle the loop
  combines the two best Pareto-front prompt versions from the agent's history
  into one challenger via `GepaOptimizer.merge` (paper Appendix-D, ~+5% lift),
  instead of a reflective mutation. The merged challenger runs the SAME
  alignment guard and A/B + safety gate as any other variant. Falls back to the
  reflective path when fewer than two scored versions exist, the Pareto front
  has fewer than two members, or the merge errors. Only consulted when `useGepa`
  is also on. Default off — the `merge` library surface (shipped in v0.5.1) is
  now wired into the production loop, closing the same kind of "built but not
  wired" gap that v0.6.0 closed for the reflective optimizer.

- **Always-valid sequential A/B testing** (`src/evolution/sequential.ts`, new):
  `msprtTwoSample` (Mixture SPRT, Gaussian-mixture prior, Welch variance of the
  difference of means) and `hoeffdingTwoSample` (σ-free time-uniform confidence
  sequence for bounded scores). Wired into the safety gate via
  `SafetyThresholds.confidenceMethod: 'effect-size' | 'msprt' | 'hoeffding'`
  (+ `confidenceAlpha` / `confidenceTau` / `confidenceMinSamples` /
  `confidenceScoreRange`). Only consulted when `requireConfidence` is on;
  defaults to the v0.6.0 effect-size heuristic. This is the rigorous upgrade to
  the peeking-resistant gate promised in the v0.6 roadmap. The loop loads the
  per-arm composite samples (`ExperimentTracker.getCompositeScores`) only when a
  sequential method is configured.
- **ε-Pareto dominance** (`dominatesEpsilon` in `pareto.ts`) +
  `EvolutionConfig.paretoEpsilon`. A small relative tolerance (applied
  symmetrically to both the regression and the strict-better check) lets the
  `paretoGate` accept a challenger that wins big on one objective while
  regressing microscopically (≤ ε) on another — instead of rejecting it over
  noise. `paretoEpsilon: 0` (default) is exactly the strict v0.6.0 gate.
- **Instance-wise coverage sampling** (GEPA Algorithm 2) in `pareto.ts`:
  `coverageFrontier`, `coverageWeights`, `selectByCoverage` (deterministic,
  diversity-preserving survivor selection), and `sampleByCoverage`
  (coverage-proportional candidate sampling with an **injected** RNG). Opt-in in
  the GEPA loop via `GepaNextGenerationOptions.useCoverage` + a per-variant
  `perKeyScores` map. Closes the long-standing "coverage sampling = backlog for
  V0.6" deferral.
- **Semantic (embedding-distance) alignment guard**
  (`checkAlignmentPreservationSemantic` in `alignment.ts`) + injectable
  `EmbedFn`. When an embedder is wired into the loop (`DarwinLoopDeps.embed`),
  a mutation that *rewords* a safety constraint (rather than removing it) is no
  longer a false-positive rejection. Fail-closed: no embedder, an embedder
  error, or malformed output all fall back to the strict keyword check, so the
  guard never weakens.
- **Epoch-shuffled reflection minibatch** (`epochShuffledMinibatch` in
  `optimizer-gepa.ts`) + `EvolutionConfig.reflectionMinibatchSize`. Reflect on a
  focused, rotating subset of the feedback window each cycle (GEPA's
  `reflection_minibatch_size` + epoch-shuffled sampler, adapted to the online
  loop), so reflection prompts stay tight while still covering the whole window.
- **Style-bias-free judging** (`stripMarkdownForJudging` in `multi-critic.ts`) +
  `RunMultiCriticOptions.normalizeForJudging` / `EvolutionConfig.normalizeForJudging`.
  Strips markdown to plain prose before the multi-critic scores an output, so the
  judge measures content, not formatting (LLM judges carry a documented style
  bias toward markdown). Off by default; turn on for prose agents, leave off when
  the output format itself is the deliverable.

### Changed

- **`EvolutionConfig.feedbackWindow` default is 15** (was a hard-coded 5). This
  is the v0.6-roadmap "feedback window 5→15" upgrade: both the legacy optimizer
  and the GEPA reflector now see more recent critic feedback by default. This is
  the one default-path behaviour change in this release — set
  `feedbackWindow: 5` to restore the exact v0.6.0 input. A larger window is more
  information for the optimizer, not a regression, but it is called out here so
  the change is not silent.

### Notes

- The sequential-confidence gate (`requireConfidence` + `confidenceMethod`) and
  the semantic-alignment embedder (`embed`) are configured through the **library
  API** — construct `new SafetyGate({ requireConfidence, confidenceMethod })`
  and `new DarwinLoop({ ..., safety, embed })`. The bundled `darwin` CLI runs
  with safety defaults; the per-agent `EvolutionConfig` knobs (`useGepa`,
  `paretoGate`, `paretoEpsilon`, `useCoverage` via `perKeyScores`,
  `feedbackWindow`, `reflectionMinibatchSize`, `normalizeForJudging`) are honored
  by any loop constructed with the agent.
- The mSPRT closed form is expressed in estimator coordinates with the Welch
  variance of the difference of means — robust to unequal arm variances and free
  of the sample-mean form's `n` vs `n²` ambiguity.

## [0.6.0-alpha.1] — 2026-06-10

**GEPA goes online.** The GEPA-style reflective optimizer (shipped as a
standalone library surface in v0.5.x) is now wired into the production
evolution loop. Until now Darwin had two halves — a GEPA optimizer you could
call yourself, and a separate A/B + safety-gated loop — that were never
connected; the loop always used the legacy stats-meta-prompt optimizer. This
release closes that gap. Everything is **opt-in and additive** — with the new
flags off, the evolution loop, the A/B gate, and the stored `changeReason`
are byte-for-byte identical to v0.5.x. **2 review rounds (3 agents + 1 verifier)
GO**, **355 tests green** (354 pass, 1 pre-existing skip, +19 new), tsc + build clean.

### Added

- **`evolution.useGepa`** (per-agent) — opt into GEPA reflective variant
  generation inside `DarwinLoop`. When on (and a `GepaOptimizer` is wired into
  the loop), the next-prompt mutation is produced by the Reflector (rich text
  feedback → smallest-possible-edit) instead of the legacy stats-meta-prompt
  optimizer. The loop reuses the critic feedback it already collects. Falls
  back to the legacy optimizer on cold start (no critic feedback yet), on any
  reflector error (with a `console.warn` breadcrumb), or when the reflective
  mutation fails the alignment guard.
- **`evolution.reflectionModel`** — model id for the GEPA reflection LM (e.g.
  `claude-opus-4-8`). GEPA's guidance and the Decagon production ablation both
  find the reflection model is the leverage point — a weak reflector can leave
  the prompt unchanged. The CLI warns when `useGepa` is on but no
  `reflectionModel` is set.
- **`evolution.paretoGate`** — opt into a multi-objective Pareto-dominance
  guard at A/B activation. A challenger that wins the scalar composite is
  activated ONLY if it is a strict Pareto improvement over the incumbent
  across the full objective vector (quality / sources / length / duration) —
  a scalar win that regressed some objective is rejected. Uses the fixed
  `DARWIN_DEFAULT_OBJECTIVES` as an independent second opinion (not the agent's
  custom `evolution.metrics` weights — by design).
- **`SafetyThresholds.requireConfidence`** — opt into a peeking-resistant A/B
  gate. Because `evaluateABTest` runs after every run, a fixed 5%-margin rule
  under continuous monitoring inflates the false-positive rate. When on, a
  margin win must also clear an effect-size / sample-size bar (`calculateConfidence`,
  previously dead code) before a winner is declared; sub-threshold improvements
  are intentionally not adopted and the test terminates via the incumbent
  tie-break. (mSPRT / always-valid confidence sequences are the rigorous
  roadmap upgrade — this is the minimal first step.)
- **`checkAlignmentPreservation` + `SAFETY_PATTERNS`** exported from the package
  root (`src/evolution/alignment.ts`) — the shared safety-keyword guard, so
  consumers wiring their own `GepaOptimizer` can apply the same check.
- **`ExperimentTracker.getAverageMetrics(agent, version, since?)`** — averaged
  objective vector (not a scalar), feeding the Pareto activation gate.

### Changed

- **The alignment guard now covers BOTH mutation paths.** `checkAlignmentPreservation`
  moved from a private method on `PromptOptimizer` to the shared
  `src/evolution/alignment.ts`; the legacy optimizer delegates to it and the
  GEPA loop path runs it before accepting a mutation. Previously the safety-keyword
  check lived only on the legacy path — wiring GEPA in without this would have
  opened a safety-regression hole. The three redundant case-variant patterns
  (`/\bdo NOT\b/` etc.) were dropped (no-ops under the `gi` recompile); the
  accept/reject decision is unchanged.
- **Default model ids modernised** across providers + CLI: the deprecated
  `claude-sonnet-4-20250514` (Sonnet 4.0, retires 2026-06-15) → `claude-sonnet-4-6`.

### Fixed

- A/B completion logging reported the loser's composite as the winner score
  whenever the regression check (or the new Pareto gate) flipped the winner
  from B back to A — the score lookups keyed off `outcome` instead of the final
  `winner`. (Pre-existing for the regression flip; surfaced and fixed during
  v0.6.0 review.)

## [0.5.1-alpha.2] — 2026-06-06

### Fixed

- **CI green again on Node 20/22** (red since v0.5.0-alpha.2). The `better-sqlite3`
  peer dependency was pinned to `^11.0.0`, which ships no prebuilt binary for newer
  Node ABIs — `new Database()` in the test `before` hook crashed with a
  `NODE_MODULE_VERSION` mismatch (127 vs 137), which `node:test` reported as the
  whole trajectory suite being "cancelled by parent". Widened the peer range to
  `^11.0.0 || ^12.0.0` (consumers may use either major) and added
  `better-sqlite3@^12.10.0` as a devDependency so the test suite runs against the
  full Node 20–26 ABI matrix. Verified on Node 22 + 24 (336/336 tests green), tsc clean.

## [0.5.1-alpha.1] — 2026-05-29

**GEPA Polish-Welle.** Closes the three deliberate paper deviations
documented in `optimizer-gepa.ts` as V0.6 backlog from V0.5.0-alpha.2.
**Zero breaking changes** — every V0.5.0 callsite keeps working unchanged.
**R1 + R2 + R3 code-review-loop GO**, **336/337 vitest tests grün** (+29
V0.5.1 regression tests). tsc strict clean, build clean.

### Added — three new surfaces

- **`crowdingDistance(variants, objectives)`** in `src/evolution/pareto.ts` —
  pure NSGA-II Deb 2002 density-estimator. Returns one distance per
  variant: per-objective min-max-normalised neighbour gap, summed across
  objectives, with `+Infinity` for boundary variants so they always
  survive truncation. Scale-safe through per-objective normalisation
  (unlike `scalarise` which is scale-sensitive).
- **`ParetoTruncationStrategy`** type + new 4th parameter to
  `paretoSelect(variants, objectives, maxKeep, truncationStrategy)`.
  Two strategies: `"scalarised"` (V0.5.0 default, kept) and `"crowding"`
  (NSGA-II density-preserving). Backward-compatible default.
- **`GepaOptimizerOptions`** interface + new constructor option
  `reflectionRunPrompt?: RunPromptFn`. When supplied, reflection AND
  merge route through the override — matches GEPA paper guidance
  (stronger LM for reflection than for task execution). Falls back to
  the main `runPrompt` when omitted. Closes V0.5.0 R1 Research F7.
- **`GepaOptimizer.merge(parents, opts)`** — GEPA Paper Appendix F
  system-aware merge. Takes two distinct Pareto-front parents, asks the
  reflection LM to combine their strongest aspects into one mutated
  prompt. Returns `{ id: "gepa-merge-<a>+<b>", prompt }`. Validations:
  exactly 2 parents, distinct ids, non-empty prompts. Output is
  fence-stripped + sentence-boundary capped to
  `max(longerParent.length * 1.3, 3500)`. Paper reports ~5% lift when
  run every K-th generation.
- **`GepaOptimizer.nextGeneration.truncationStrategy` passthrough** —
  forwards the new `paretoSelect` parameter from `NextGenerationOptions`.
  Default `"scalarised"` matches V0.5.0 byte-for-byte.

### Fixed — R1 + R2 + R3 code-review-loop

R1 critic reported a P1 template-injection in `merge` (claimed `{SCORE_A}`
/ `{SCORE_B}` placeholders inside parent prompts were double-substituted
because they ran before `{PROMPT_A}` / `{PROMPT_B}`). On R2 verification
the V1 ordering (ID + SCORE first, PROMPT last) was confirmed CORRECT —
`String.prototype.replace` only finds matches in the current working
string, and user content does not enter the working string until the
final two replacements. **Net effect:** code unchanged, but
`tests/v0.5.1-features.test.ts` now explicitly regression-tests BOTH
`{ID_B}` AND `{SCORE_A}` + `{SCORE_B}` literals inside parent prompts —
the test coverage gap was the real R1 finding, not the substitution order.

R1 Analyst documentation-drift fixes:

- `src/evolution/optimizer-gepa.ts` header — V0.6 deferrals updated to
  reflect V0.5.1 shipping `truncationStrategy` + `merge` +
  `reflectionRunPrompt`. Instance-coverage sampling remains V0.6
  backlog.
- `src/evolution/reflector.ts` — "deferred to V0.5.1" wording replaced
  with "SHIPPED in V0.5.1".
- `src/evolution/pareto.ts` — `"coverage"` mention removed from the
  `paretoSelect` docstring; type carries only `"scalarised" | "crowding"`,
  no type/doc mismatch remains.

### Test coverage

- **336/337 vitest tests grün** (was 307/308 baseline + 29 new tests
  in `tests/v0.5.1-features.test.ts`). 1 pre-existing skip carried over.
- New tests cover: `crowdingDistance` (4 boundary + 4 three-variant
  scale-safe + non-finite defense), `paretoSelect` (default vs explicit
  scalarised parity + crowding boundary preservation), `GepaOptimizer`
  reflection-LM routing + fallback + invalid-type guard, `merge`
  (template-injection for ID + SCORE, tuple validation, same-id
  rejection, empty-prompt rejection, reflection-LM routing, fence-strip,
  length cap, rejection propagation), `nextGeneration`
  truncationStrategy passthrough + backward-compat byte-equivalence.

### V0.6 backlog (carried over from V0.5.1 deferrals)

- `"coverage"` strategy on `ParetoTruncationStrategy` (GEPA Algorithm 2
  instance-proportional sampling)
- Extract `cleanOutput` + `truncateAtSentenceBoundary` to shared
  `src/evolution/text-utils.ts` (currently byte-identical in `Reflector`
  + `GepaOptimizer`)
- Collision-safe `makeMergeId` separator (current `+` collides if
  caller-side ids contain `+` literally — unlikely with default
  `gepa-cand-${i}` ids)
- More edge tests: `merge` with non-finite metrics, `crowdingDistance`
  with all-Infinity inputs

### Migration from V0.5.0

None required. V0.5.1 is additive. Adopt new surfaces incrementally:

- Switch `nextGeneration` to `truncationStrategy: "crowding"` for
  diversity-critical workloads
- Pass a stronger Opus model as `reflectionRunPrompt` while keeping a
  cheaper Haiku as the main task LM
- Invoke `optimizer.merge([survivors[0], survivors[1]])` every K-th
  generation for the Paper Appendix F lift

## [0.5.0-alpha.2] — 2026-05-25

**GEPA-Style Reflective Optimizer (Phase 2 A2).** Multi-objective Pareto
selection + text-feedback-driven prompt mutation as a TS-native
adaptation of the GEPA framework (arxiv 2507.19457). Released under the
`alpha` npm dist-tag in parallel with v0.5.0-alpha.1 (execution-trace
capture, A1). `npm install darwin-agents@alpha` resolves to
0.5.0-alpha.2; `npm install darwin-agents` stays on 0.4.9 (latest).

### Added

- **`GepaOptimizer`** — generation-loop wrapper producing N variant
  mutations per call (default N=3, [1, 10]). Three `feedbackStrategy`
  modes: `"split"` (round-robin partition, diversity), `"replicate"`
  (every variant sees all feedback), `"single"` (one reflection).
  Separate `nextGeneration(scored, opts)` Pareto-selects survivors for
  the next generation.
- **`Reflector`** — single-shot LLM call with GEPA's "smallest possible
  targeted edit" template. Output is cleaned (fences stripped) and
  truncated at sentence boundary.
- **`pareto.ts`** — `dominates` / `nonDominatedFront` / `paretoSelect` /
  `scalarise` pure helpers + `DARWIN_DEFAULT_OBJECTIVES` constant
  (matching `DarwinMetrics` field names + existing weight scheme).
- **`RunPromptFn`** — shared injected-LLM-call type, single source of
  truth for both `PromptOptimizer` and `Reflector`.
- **A1 sync (S1184):** `createTraceCapture` + `ExecutionTrace` /
  `TraceToolCall` / `TraceTokenUsage` / `TraceTurnError` now exported
  from the OS package (were already in v0.5.0-alpha.1 on npm, OS source
  catches up this release).

### Deliberate deviations from GEPA paper (documented in source)

- N variants per `generate()` call vs GEPA Algorithm 1's 1-offspring-
  per-iteration.
- `feedbackStrategy: "split"` is our adaptation, not in the paper.
- `paretoSelect` truncation uses scalarised tie-break, not GEPA
  Algorithm 2's coverage-proportional sampling — V0.6 will add
  `truncationStrategy: "coverage" | "crowding"`.
- GEPA+Merge (paper Appendix F, ~+5% lift) NOT implemented — V0.6.
- Instance-wise coverage sampling NOT implemented — V0.6.
- Single injected `runPrompt` for both task and reflection — GEPA docs
  recommend stronger `reflection_lm`. Optional `reflectionRunPrompt`
  override deferred to V0.5.1.

### Fixed (R1 + R2 V0.5.0-alpha.2 code-review findings)

The 3-Agent code-review loop ran twice. R1 found 13 findings, R2 caught
2 must-fix that R1 missed. All addressed pre-publish.

**R1 — 6 MUST-FIX (S1185):**

1. **HIGH (Critic H1):** Template injection — `String.replace` order
   meant `currentPrompt` containing `{FEEDBACKS}` literal could trigger
   double-substitution. Fixed by substituting `{CURRENT_PROMPT}` last.
2. **HIGH (Critic H2):** `feedbackCap` accepted negative values — added
   `Math.max(1, Math.floor(...))` guard.
3. **HIGH (Analyst A5):** `ParetoObjective` JSDoc example used wrong
   `DarwinMetrics` field names. Fixed + `DARWIN_DEFAULT_OBJECTIVES`
   constant.
4. **HIGH (Analyst A1):** `RunPromptFn` was duplicated. Extracted to
   `evolution/run-prompt-fn.ts`.
5. **MED (Critic M2):** `nextGeneration` used reference-identity on
   `metrics` — switched to explicit index-based mapping (refactor-safe).
6. **MED (Critic M4):** Added scale-normalization JSDoc warning on
   `ParetoObjective.weight`.

**R2 — 2 MUST-FIX (caught what R1 missed, S1185):**

7. **CRITICAL (R2-C1):** R1's clamp `Math.max(1, Math.floor(NaN)) ===
   NaN` — silent bypass for NaN/Infinity. Hardened with
   `Number.isFinite()` + fallback to default.
8. **LOW (R2-L1):** `generate("p", [])` threw opaque internal error.
   Added GEPA-specific boundary validation pointing callers at
   `PromptOptimizer` for cold-start. Plus R2-M1 guard for shared
   metrics-object references.

### Test coverage

- **307/308 OS tests green** (1 pre-existing skip, 0 fail). Was 268 in
  v0.4.9. New test files: `pareto.test.ts` (16), `reflector.test.ts`
  (14), `optimizer-gepa.test.ts` (12), `r1-fixes.test.ts` (12 R1+R2
  regression). A1 trace + memory-trajectory tests synced from
  v0.5.0-alpha.1.
- tsc strict + build clean.

## [0.5.0-alpha.1] — 2026-05-24

**Phase 2 A1: Execution-Trace-Capture.** First pre-release of Darwin's
Phase 2 tech roadmap. Unblocks GEPA-style reflective optimizers (A2)
and validate-by-reproduce drift-detection (A5) by giving them a
structured trajectory to consume.

Industry-aligned with the 2026 agent-observability consensus (Braintrust,
Langfuse, Strands SDK, Microsoft Foundry, OTEL GenAI semantic conventions):
three span types — Tool / Reasoning / Turn-level errors — captured into a
single `ExecutionTrace` object, persisted as JSONB (Postgres) or TEXT
(SQLite), and tagged with a forward-compatible `version: 1` discriminator.

### Added

- **`ExecutionTrace` schema** (`src/types.ts`) — versioned trajectory shape:
  `toolCalls[]` (with OTEL-mappable `id` / `tool` / `args` / `resultSummary`
  (2000-char cap) / `outcome` / `durationMs` / `retryCount?` / `errorClass?` /
  `errorMessage?` / `turn`), `textBlockCount` (honest name — NOT a thinking-
  block counter, V2 will add typed `reasoningBlocks`), `turnCount`,
  `mcpInvocations`, `errors[]` (turn-level), `tokenUsage?` (OTEL `gen_ai.usage.*`
  fields: input/output/cache_read/cache_creation tokens), `capturedAt`. Plus
  optional `trajectory?: ExecutionTrace` on `DarwinExperiment` (additive —
  pre-A1 callers unaffected).

- **`createTraceCapture()` factory** (`src/core/trace-capture.ts`) — pure,
  transport-agnostic capturer. The runtime feeds tool events; the capturer
  aggregates into a typed trajectory. API:

  ```ts
  const trace = createTraceCapture();
  trace.startTurn();
  trace.recordToolUse('toolu_01AB', 'mcp__nex__search', { query: 'x' });
  trace.recordToolResult('toolu_01AB', 'success', { resultSummary: '3 hits' });
  trace.recordTextBlock();
  trace.addTokens({ inputTokens: 1200, outputTokens: 340 });
  trace.recordError('parse_error', 'invalid JSON');
  const trajectory = trace.finalize();
  ```

  Unpaired `recordToolUse` calls (no matching `recordToolResult` before
  `finalize`) surface as `outcome: 'error', errorClass: 'unpaired_call'`
  so silent SDK hangs remain visible in the trace. Customizable via
  `TraceCaptureOptions`: `now?` (clock injection for tests),
  `isMcpTool?` (predicate override for non-`mcp__`-prefixed servers).

- **`addTokens()` aggregator** — lossy-merge of per-turn LLM usage. Missing
  fields (`NaN` / `Infinity` / `undefined`) skip silently rather than
  defaulting to zero — preserves the distinction between "provider didn't
  report" and "actually zero tokens".

- **JSONB persistence** in `darwin_experiments.trajectory` column +
  `idx_darwin_exp_trajectory_gin` GIN index (Postgres) for `@>`
  containment queries from A2 / A5 consumers. SQLite stores the same
  shape as JSON-stringified TEXT.

- **`scripts/migrate-add-trajectory.ts`** — idempotent migration script.
  Pre-checks column + index existence (filtered by `current_schema()`
  for multi-schema-safe operation), runs `ALTER TABLE … ADD COLUMN IF
  NOT EXISTS trajectory JSONB` + `CREATE INDEX IF NOT EXISTS`, then
  verifies. Rollback path documented inline.

  ```bash
  DARWIN_POSTGRES_URL=postgresql://… npx tsx scripts/migrate-add-trajectory.ts
  ```

- **Defensive parsing** in both memory backends — `parseTrajectory` /
  `parseTrajectoryColumn` drop malformed values (wrong `version`,
  non-object, invalid JSON) to `undefined` instead of crashing the
  load. Future schema versions (`version !== 1`) are silently ignored
  so v0.5 consumers don't break on v0.6 trajectories.

- **39 new tests** across two suites (all green):
  - `tests/trace-capture.test.ts` (32 unit tests): basic flow,
    defensive behaviour, truncation (2000-char `resultSummary`),
    MCP-heuristic, schema invariants, tool_call_id passthrough,
    `addTokens` aggregate semantics
  - `tests/memory-trajectory.test.ts` (7 tests): SQLite roundtrip,
    backward-compat with pre-A1 rows, defensive parsing, idempotent
    migration, Postgres-gated JSONB roundtrip

### Changed

- **DDL single-source-of-truth** — the trajectory column is defined
  ONLY in the additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS` path
  (Postgres) / PRAGMA-guarded ALTER (SQLite), never inline in the
  `CREATE TABLE`. Schema-evolution lives in one place; fresh installs
  reach the same end-state as legacy installs.

- **Postgres `ON CONFLICT` preserves trajectory** on feedback-only
  re-saves via `COALESCE(EXCLUDED.trajectory, darwin_experiments.trajectory)`.
  This means a second `saveExperiment(exp)` call that omits trajectory
  doesn't zero out the previously-stored trace.

  **NOTE — SQLite asymmetry:** SQLite uses `INSERT OR REPLACE` which
  drops + re-inserts the row, so callers wanting to preserve a prior
  trajectory across re-saves MUST include it in the new payload. This
  asymmetry is documented on `MemoryProvider.saveExperiment` in the
  interface JSDoc.

### Backwards compatibility

100% backwards-compatible. The new `trajectory` field is optional, the
new column is nullable, the new methods on `MemoryProvider` are
additive. Existing v0.4.x consumers see no behavioural changes.

Verified on a live `darwin_db` with 341 experiments, 339 of which
pre-date A1 — all loaded cleanly with `trajectory: undefined`.

### Why "alpha.1"

`textBlockCount` is honest but limited — V2 will replace it with a
typed `reasoningBlocks: ReasoningBlock[]` sequence carrying the actual
text content per reasoning step, which is what GEPA reflectors need
for per-decision blame attribution. Existing `textBlockCount` will stay
as a fast aggregate. The `alpha.1` tag signals the schema is subject to
this kind of additive evolution before `0.5.0` final.

Three known minor gaps (deferred to follow-up patches):

- Per-call cost attribution (token usage per tool invocation, not just
  per-run aggregate)
- Trace-capture lazy-load flag stays permanent on transient import
  failure (low impact: Darwin is either built or not)
- Token extraction in the SDK adapter is Anthropic-shaped (`message.usage`)
  and may silently miss tokens for non-Anthropic providers — by design
  (token usage is documented optional), but a debug-level log line in a
  follow-up patch will make this easier to spot.

Install: `npm install darwin-agents@alpha`. The default `latest` tag
remains on `0.4.9` until `0.5.0` final ships.

## [0.4.9] — 2026-05-22

Polish on top of v0.4.8. Adds spec-compliance, error classification,
per-call timeouts, and a Mem0 preset — all derived from a deep read of
the MCP TypeScript SDK + MCP spec 2025-11-25 + Mem0 MCP server source
(`mem0ai/mem0-mcp`).

### Added

- **`McpBridgeError` / `McpBridgeProtocolError` / `McpBridgeTransportError`** —
  exported error classes that discriminate JSON-RPC server errors
  (`kind: 'protocol'`, numeric `code`) from local transport errors
  (`kind: 'transport'`, stable string `code` ∈ `timeout` / `closed` /
  `transient` / `child_exit` / `spawn_failed` / `http_status`). Callers
  can `instanceof`-check to decide retry vs fail-loud without parsing
  message text. Mirrors the `ProtocolError` vs `SdkError` split that
  the MCP TypeScript SDK v2 uses internally; we keep our own classes to
  preserve the zero-hard-deps policy.

- **Per-call `timeoutMs` override** on `save()` and `fetchRelevant()`.
  Mirrors `client.callTool(..., { timeout })` from the MCP SDK. Useful
  for one-off slow operations (large embedding searches) without
  cranking the bridge-wide `requestTimeoutMs`.

  ```ts
  await memory.fetchRelevant({ query: 'X', limit: 5, timeoutMs: 30_000 });
  await memory.save(record, { timeoutMs: 5_000 });
  ```

- **`mem0Preset()`** — drop-in `Partial<McpMemoryConfig>` that wires
  Darwin to the official `mem0ai/mem0-mcp` server with the right tool
  names (`add_memory` + `search_memories` — NOT the `mem0_add` /
  `mem0_search` guess from earlier docs) and arg shapes. Handles
  user/agent/run scoping, default metadata, and the `memory` field in
  result rows.

  ```ts
  const memory = remoteMemory('https://api.mem0.ai/mcp', {
    authHeader: `Bearer ${process.env.MEM0_KEY}`,
    ...mem0Preset({ userId: 'darwin-agent', defaultMetadata: { project: 'darwin' } }),
  });
  ```

### Fixed

- **MCP-Protocol-Version HTTP header** is now sent on every HTTP request,
  per MCP spec 2025-11-25 §"HTTP Protocol Versioning". Without it,
  strict servers MAY respond `400 Bad Request`. Previously the bridge
  only carried the version inside the `initialize` payload, which left
  every subsequent `tools/call` un-versioned at the transport layer.
  The version defaults to `2025-11-25` and is honored when overridden
  via `protocolVersion` in the bridge config.

- Internal raw `Error` throws in `rpcStdio` / `rpcHttp` / `onChildExit`
  / `ensureReady` / `close()` are now wrapped in the typed bridge error
  classes above. Existing message-substring regex tests still pass.

### Changed

- `McpMemoryBridge.save(record, opts?)` accepts an optional second
  argument with `{ timeoutMs }`. This is a structural super-type of
  `FeedbackStore.save(record)` — callers using the base interface keep
  working unchanged; the typed Darwin path now gets the extra knob.

### Tests

225/225 pass (was 211, +14). New coverage:
- HTTP header presence on initialize + tools/call (2 tests).
- Error-class discrimination — protocol vs http-status vs closed-bridge (3 tests).
- Per-call timeout precedence over bridge-level timeout, on both stdio
  and http transports (2 tests).
- `mem0Preset()` — tool names, write-arg shape, scope alternatives,
  read-result parsing (Mem0 `memory` field), structuredContent
  shortcut, unknown-shape tolerance, end-to-end spread integration with
  a mock Mem0 server (7 tests).

### Recommendation

Upgrade from v0.4.8 to v0.4.9 (`npm install darwin-agents@latest`). No
breaking changes to existing callers — all additions are opt-in.

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
