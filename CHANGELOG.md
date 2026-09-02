# Changelog

## [Unreleased]

## [0.17.0] - 2026-09-02

The README has carried this under Known Limitations since the first release:
"Prompt mutations go directly to A/B testing. Telegram notifications inform
you, but there's no approval gate before testing starts." This release ships
the gate. It is opt-in, and with it off the loop behaves exactly as v0.16 did.

### Added

- **`evolution.requireApproval`**: hold every generated challenger for a human
  decision instead of opening an A/B test. The challenger is still generated
  and still persisted as a real `PromptVersion` (readable, diffable, judgeable);
  what does not happen is the test. A `PendingApproval` goes into
  `DarwinState.pendingApprovals` instead.

  The gate sits before the TEST, not before activation, because that is where a
  veto is worth anything: an A/B test puts the challenger on half the runs, so
  by the time a bad mutation could be caught at activation it has already been
  in front of users.

- **`darwin approve [agent] [--reject] [--reason <text>] [--force]`**: the human
  half. Bare `darwin approve` lists every proposal across all agents; with an
  agent it prints the incumbent and the challenger prompt IN FULL (no
  truncation: an elided middle is exactly where a bad mutation hides) and then
  acts. Also `DarwinLoop.approveChallenger()` / `.rejectChallenger()` for
  programmatic use, and the `PendingApproval` type from the package root.

- **`evolution.approvalTimeoutDays`**: auto-**reject** an untouched proposal
  after n days, freeing the slot. Never auto-approves, for the same reason
  `maxTestDays` never promotes on timeout (v0.13.0): absence of a decision is
  not a decision. Opt-in, and it exists for one failure mode, namely that a
  forgotten proposal otherwise stops the agent evolving forever and does it
  silently.

- **CLI flags**, persisted like the other advanced knobs:
  `--require-approval` / `--no-require-approval` and
  `--approval-timeout-days <n>` on both `darwin evolve` and `darwin run`. `0`
  is the OFF switch for the timeout, mirroring `--max-test-days 0`, because
  overrides are merged and never deleted.

- **Metrics**: `approval_requested`, `approval_granted`, `approval_rejected`
  (the last carries `expired: true` when the timeout did it). There is
  deliberately no `approval_auto_granted`: no such event can occur.

- **Telegram**: `notifyApprovalRequired` and `notifyApprovalExpired`. The first
  is worded as a request, not a status update, because with the gate on nothing
  happens until someone acts, and a message that reads like a status line would
  let an agent quietly stop evolving.

- **`darwin status`** shows a held proposal, both in the per-agent view and as
  its own icon in the overview, ahead of the A/B one. A held proposal is
  neither "running" nor "fine": it needs a person.

### Four decisions inside the feature

- **Approving starts the test that was PROPOSED, not a fresh one.** `minRuns`,
  the A/B wall-clock budget and the incumbent are snapshotted at proposal time.
  Recomputing `computeDynamicMinRuns` at approval would open a test with a
  different bar than the one the notification described. The A/B clock is the
  exception and starts at approval: time spent waiting for a human is not time
  spent collecting data.

- **A pending proposal blocks the next one**, on BOTH entry points (`afterRun`
  and `forceEvolve`). Without it the next qualifying run would generate a second
  challenger and overwrite the first, discarding exactly the thing a human was
  asked to look at. Same class of bug as v0.13.0's overwritten rejected
  challenger. `--force` means "evolve even though the automatic gates say no",
  not "throw away the proposal someone is reading".

- **A moved incumbent refuses.** If a rollback or a manual activation changed the
  active prompt since the proposal, approving would test the challenger against
  a different baseline than the one it was generated from, which answers a
  different question than the one approved. `--force` overrides and then tests
  against the live incumbent.

- **A rejected challenger stays in the version history** with `active: false`.
  `nextFreeVersion` clears the whole history rather than just the active version
  (v0.13.0), so its label is never reused and the record of what was proposed
  and turned down survives.

### The three writers pin proposal IDENTITY, not presence

`approveChallenger`, `rejectChallenger` and the timeout all read the state
once, then re-check inside the `updateState` callback. Both real providers run
that callback under a write lock (SQLite `transaction.immediate()`, Postgres
`SELECT … FOR UPDATE`), so what the callback reads is live, while the read
before it is not. Another process resolving the proposal, and the next cycle
proposing a fresh one, both land in exactly that window.

Checking presence alone would then accept a DIFFERENT proposal: approving
would start the test for the challenger read earlier while silently deleting
the new one nobody has looked at. The callbacks therefore compare `versionB`
AND `proposedAt`, and refuse otherwise.

Pinned by tests that inject the replacement in the window itself (swapping the
state before the call tests nothing: the caller then reads the new proposal as
its own and every check trivially matches), each one checked against the
presence-only mutation.

### What one adversarial round found (all fixed here)

Round 1 came back NO-GO with nine findings. The severe one and the four that
changed behaviour:

- **A typo in `--reject` used to APPROVE.** `--rejct`, `-reject` and
  `--reject=true` all parsed to `{reject: false}`, and the bare command
  approves, so a mistyped rejection put the challenger on roughly half of live
  traffic. Stopping the resulting test means `darwin evolve <agent> --reset`,
  which also throws the evolved incumbent back to v1. For a command whose whole
  purpose is informed consent, unrecognised input falling through to the
  consenting action is the wrong default. `darwin approve` now hard-fails on
  anything it does not recognise, including a second positional and the
  `--flag=value` spelling this CLI does not use, and the two argv walks (flags,
  agent name) were merged into one so they cannot disagree.

- **Claiming the slot was check-then-act across an LLM call.** The guard that
  decides "no proposal, no test" runs before the challenger is generated, which
  is seconds to minutes earlier. Two concurrent cycles both passed it and the
  second silently overwrote the first, so a human with two notifications could
  only decide on the later one. Both writers (gated and ungated) now re-check
  inside the lock and refuse; the losing challenger keeps its version row,
  because it cost a model call and its label is never reused.

- **Approving did not pin the incumbent.** The staleness check read the active
  prompt outside the transaction, so a rollback landing in that window opened
  the test against the version that had just been rolled away, and arm routing
  served it again. Pinned in the callback, the same way the proposal identity is.

- **Two sources disagree about "active", and approving now says so.**
  `activeVersions` is what run.ts routes on; the `active` flag on the version
  rows is what `getActivePrompt` reads. `--reset` wrote only the first, so after
  a reset the agent served v1 while the flag said v3, the next cycle proposed
  "v3 to v4", and approving that put half of traffic back on exactly the version
  the reset was leaving. `--reset` now moves both, and approving refuses when
  they disagree rather than picking one.

- **A test that pinned nothing.** "The timeout auto-rejects, never
  auto-approves" read `activeVersions[...] ?? 'v1'` in a scenario that never
  sets `activeVersions`, so the `??` made it vacuous: adding an
  `activateVersion(challenger)` call inside the timeout left the whole suite
  green. It now asserts BOTH sources. The timeout suite also ran only through
  `forceEvolve`, so the same branch in `afterRun` (the path a cron-driven fleet
  uses exclusively) could be mutated to `if (false)` unnoticed; covered now.

### What the second round found (all fixed here)

Round 2 confirmed all nine round-1 fixes hold, and found four more. The best of
them is an interaction between the two halves of ONE round-1 fix, which neither
half showed on its own:

- **`--force` was structurally dead in exactly the state its own error message
  advertised it for.** The pre-check chose the incumbent from the FLAG source
  while the in-lock pin compared against the ROUTING source, so in a
  disagreement (a pre-v0.17 `--reset`, or a crash between the new reset's two
  writes) `--force` could never succeed. It reported "changed while approving",
  a race diagnosis for a state with no second process in it, and the only way
  out was `--reset`, destroying both the proposal and the evolved incumbent
  that `--force` exists to preserve. Both halves read routing now, which is
  also right on the merits: `activeVersions` is what run.ts serves, arms
  resolve by version label, and the eventual winner's activation repairs the
  disagreement anyway.

- **A decision flag with no target listed instead of deciding, and exited 0.**
  `darwin approve "$AGENT" --reject` with an unset shell variable fell into the
  listing branch, so the script believed the rejection happened while the
  challenger stayed pending and approvable by anyone. The parser hard-failed on
  `--rejct` but shrugged at `--reject` with no agent, which is the same failure
  with better spelling.

- **The wiring guard stopped four hops short of the effect.** It walked
  `OVERRIDE_KEYS`, recognition, parsing and detection; the chain also runs
  through `resolveEvolutionConfig` into the loop, and that last hop was
  unpinned. Dropping the persisted `requireApproval` inside the resolver left
  all 821 tests green while, in production, `darwin evolve <agent>
  --require-approval` would confirm itself and every later run would go
  UNGATED. Same shape as the `hasAnyEvolutionFlag` hole one level deeper: a
  guard that stops before the value changes BEHAVIOUR proves only bookkeeping.
  There is now an end-to-end test, plus its negative twin so it cannot go
  vacuous.

- **The timeout budget is snapshotted, and the README did not say so.** Setting
  `--approval-timeout-days 0` to rescue a proposal that is about to lapse does
  not work: the snapshot on the proposal wins. Consistent with every other
  parameter here and fail-safe (it auto-rejects), but it was unqualified.

### What the third round found (all fixed here)

Round 3 confirmed all four round-2 fixes hold and found seven more. None of them
opens a path to traffic without a human; the three that mattered were a doc
promise that had become a lie, and two guards that stopped short of what they
claimed to prove.

- **A timeout introduced later killed a proposal made before it.** The README
  had just been corrected to promise that changing `approvalTimeoutDays`
  "applies to proposals made from then on". Measured, it did not: a proposal
  written with no budget carried no snapshot, and the resolver fell back to the
  CURRENT config, so introducing a 7-day budget auto-rejected a proposal that
  had been waiting 19 days under "waits indefinitely". The fallback was copied
  from `effectiveTestBudget`, where it exists for A/B tests written before
  v0.13.1 added the field. There is no such legacy here: the field ships in the
  same release as the proposal it lives on, so an absent snapshot means "no
  budget was configured", which is a decision. The budget is now always written
  (`0` for none) and read from the snapshot alone.

- **The wiring guard was still one hop short, and this time the hop was the
  command.** It had been fixed to reach `resolveEvolutionConfig`, but it
  rebuilt that wiring in a test helper instead of calling what the CLI calls.
  Mutating `run.ts` and `evolve.ts` to pass the UNRESOLVED agent left all 826
  tests green, which is the round-2 failure one level up. The three commands
  now share `buildResolvedEvolutionLoop`, so the step has one place to be wrong
  instead of three, and the guard calls that function.

- **A fix with no test, under a CHANGELOG line claiming otherwise.** The
  decision-flag guard from round 2 was measured live and never pinned:
  `approveCommand` was called by no test at all, so deleting the guard left the
  suite green while the regression returned. It now has hermetic tests (every
  refusal happens before any I/O), and the "checked against its mutation" claim
  is true of every fix in all three rounds rather than of most of them.

- **A lost expiry race reported a rejection that never happened.**
  `expireApproval` correctly declined to touch a proposal that had changed under
  it, then returned void, so both callers announced the rejection and emitted
  `evolution_skipped { reason: 'approval_expired' }` anyway. It returns a
  boolean now and the callers say what actually occurred.

- **A comment that stopped being true.** `recordMergeInvocation` said the cap
  counts merges "carried into an A/B test"; with a human in between it counts
  merges CREATED, which includes ones that get rejected or lose the claim race.
  The behaviour is deliberate (the reflection call was paid either way) and now
  says so, including the consequence: a cap of 5 plus five rejections turns
  merge off for the agent's life.

Two findings are documented rather than fixed, both in the README under what
the gate does not protect against: `darwin approve "$AGENT"` with an empty
variable lists instead of approving (indistinguishable from the legitimate
listing without making listing its own subcommand), and `useDemos` can
re-propose a rejected challenger verbatim, because Darwin remembers rejected
version labels and not rejected texts. The second is a piece of work in its own
right, not a line in this one.

### What the fourth round found (all fixed here)

Round 4 found no behaviour bug in any fix. It found five places where a guard
proved less than it claimed, which by now is the recognisable shape of this
whole feature: **every single round has found the hole one step further along
the same chain.**

  round 1: `hasAnyEvolutionFlag` was a hand-maintained list and went stale, so
           the flag persisted while the CLI printed it as unset.
  round 2: the new guard reached `resolveEvolutionConfig` and stopped, so
           dropping the override inside the resolver left the suite green.
  round 3: the guard called `buildResolvedEvolutionLoop`, but nothing pinned
           that the COMMANDS call it.
  round 4: the guard called that function in its FOUR-argument form, so the
           fifth parameter was dead code as far as any test knew.

- **The one-off flag lane was untested and therefore breakable in silence.**
  Dropping `cliOverride` from the shared resolver left all 833 tests green
  while `darwin run writer "task" --require-approval` opened the A/B test
  ungated and every per-run `--gepa` / `--max-test-days` was ignored. The
  README documents that lane explicitly. Guarded now, and the lesson is
  general: the most recently added parameter of a shared function is where the
  next blind spot sits.

- **Nothing pinned that the commands call the shared function.** Rewiring
  `run.ts` to `buildEvolutionLoop(agent, ...)` reproduced the round-2
  production scenario word for word, with a green suite. `darwin run` now has a
  real integration test that drives the actual command against a mock
  OpenAI-compatible server, with a negative twin so it cannot pass on an agent
  that would not have evolved anyway. `darwin evolve` and `darwin approve` are
  covered by a source guard that also fails when a FOURTH command reaches past
  the shared builder.

- **A fix with two callers had one probe.** The round-3 race fix touched
  `afterRun` and `forceEvolve`; only `forceEvolve` was pinned, so reverting the
  `afterRun` half left the suite green, on the path a cron-driven fleet uses
  exclusively. Round 1 had already found that exact two-caller trap in this
  file. The race injector now takes the call index and, more importantly,
  reports whether it fired at all: every use asserts that, because a probe that
  never fires proves nothing, and a test that proves nothing is what three
  rounds in a row have caught here.

- **A justification that was wrong even though the decision was right.** The
  asymmetry to `effectiveTestBudget` was explained as "that fallback is a
  legacy gap". Its own docblock names two purposes, and the second (budgets
  introduced after a test is already running) is a feature. The real reason for
  the asymmetry is the difference between the two things: a running A/B test
  burns live traffic every hour it stays open, so a new budget reaching it
  closes something that is costing something; a waiting proposal is inert, so
  the same reach only destroys work at no saving.

- **A README counter and a mis-filed bullet.** "Two things the gate does NOT
  protect against" had grown to four, one of which is a protection.

Every fix in all four rounds is checked against the mutation that would undo
it, including every one a round named as uncovered. That sentence has now been
false twice and corrected twice, which is the reason it is worth writing: it is
a claim someone can check.

### Fixed

- **`hasAnyEvolutionFlag` no longer drifts.** It was a hand-maintained
  disjunction and went stale the moment `--require-approval` was added: the
  flag parsed, applied and persisted correctly, but the function returned
  false, so `darwin evolve <agent> --require-approval` skipped its confirmation
  line AND fell through to the status branch, printing `requireApproval=false`
  immediately after setting it. Nothing threw; the command quietly did half its
  job. It is now derived from the object (`Object.values(...).some(...)`), so
  adding a flag needs no edit there at all. `OVERRIDE_KEYS` is exported and a
  new guard test walks it through all four wiring points, checked against two
  mutations.

- **`darwin evolve <agent> --reset` is atomic and clears a pending proposal.**
  It was `getState` + mutate + `saveState`, writing the WHOLE state blob from a
  snapshot taken before its awaits, so a write another process made in between
  was silently overwritten: `darwin evolve A --reset` could erase agent B's
  pending approval, leaving Telegram saying "approval needed" while
  `darwin approve B` said nothing was pending. Now `updateState`, under the same
  lock every other state writer uses. And it clears the proposal: Left behind,
  it would name an incumbent that no longer exists (reset points the agent back
  at v1) and would block evolution until someone decided on a challenger for a
  baseline that is gone. Freeing the slot is the same move `--reset` already
  makes for a running A/B test.

- **`darwin approve` can decide a proposal whose agent is gone.** Both commands
  checked `builtinAgents` before looking at the state, so a proposal left behind
  by a removed or renamed agent was undecidable and undeletable (`--reset`
  threw on the same check first). Rejecting needs no agent definition and now
  works; approving still refuses, because the A/B test needs an agent to run.

- **`darwin approve` refuses a proposal it cannot show you.** When a prompt row
  is missing from the version history, the command used to warn "approving would
  start a test on a prompt nobody can read" and then approve anyway. The test it
  opened would be cleared as dead by the orphan repair on the very next run.

- **`darwin evolve` reports the confidence knobs.** `--require-confidence` and
  `--confidence-method` have been persistable since v0.14 but never appeared in
  either summary, so setting one confirmed itself with `(none)`. Fixed here
  rather than left as the one hole next to the v0.17 pair.

## [0.16.0] - 2026-08-15

v0.15 measured its own two sequential methods honestly and left the
conclusion on the record: mSPRT does not hold its configured α at Darwin's
sample sizes, Hoeffding does but is too conservative to resolve realistic
gaps, and the proper fix is "an unknown-variance e-process or a t-mixture,
which is a different method, not a patch". This release ships that method.

### Added

- **`confidenceMethod: 'eb'`**: the predictable plug-in empirical Bernstein
  confidence sequence of Waudby-Smith & Ramdas (JRSS-B 2024, Theorem 2;
  arXiv:2010.09686), as `ebTwoSample` / `ebIntervalForArm` in
  `src/evolution/sequential.ts`, both exported from the package root under
  the same transparency contract as `hoeffdingHalfWidth`. Time-uniform at
  level α by a nonnegative-supermartingale argument plus Ville's inequality.
  No i.i.d. assumption; no variance plug-in inside the guarantee (the bet
  λ_t adapts to the estimated spread, and since ANY predictable bet is
  valid, the estimate can only change power, never level: the structural
  difference from mSPRT). Wired through `SafetyGate` (full α, no fallback
  needed: the regularised variance estimate exists from the first
  observation, so there is no no-spread abstention), `evolution.safety`,
  `darwin evolve --confidence-method eb`, and persisted evolution flags.
- **Measured decision points**, pinned by `tests/sequential-eb.test.ts` so
  they cannot rot (EB exact for constant arms, median over 21 seeded runs
  for noisy ones; Hoeffding columns are the exact first n at which its
  data-independent bar drops below the gap):
  constant 0.10 vs 0.95 at n=21 (Hoeffding 32); σ≈0.05 gap 0.30 at n≈59
  (Hoeffding 359); gap 0.20 at n≈89 (Hoeffding 900); judge-noise σ≈0.10 gap
  0.10 at n≈188 (Hoeffding 4216). Structural blind zone through n=17 per
  arm at defaults, surfaced via `inconclusiveByConstruction` exactly like
  Hoeffding's. The ~0.009 composite deltas our own fleet produces remain
  out of reach for every method; the README table says so.
- **The imported inequality is checked, not believed**: the supermartingale
  bound is cited from the paper rather than re-derived, so the test suite
  (a) evaluates E[exp{λ(Y−μ) − 4(Y−m̂)²ψ_E(λ)}] as an EXACT finite sum over
  a grid of discrete laws, bets and predictable means and asserts it never
  exceeds 1, (b) measures the empirical type-I error under continuous
  peeking (the production access pattern) and asserts it stays at or below
  α at every horizon tried, in contrast to mSPRT's measured drift, and
  (c) pins the implementation against an independent reference
  transcription of the paper's formulas to 1e-12. Five mutation probes run
  during development (α-split dropped, ψ_E scale dropped, samples sorted,
  structural floor removed, gate dispatch removed) each turned tests red;
  none of the new tests is vacuous.
- **Order sensitivity documented as a contract**: the bet is predictable
  from the prefix, so the same multiset in a different order legitimately
  produces a different (equally valid) interval. The docstring says why,
  the gate feeds chronological samples (`tracker.getCompositeScores`), and
  a pinned test points anyone who "fixes" it by sorting at the docstring.
- **`npm run test:coverage:lcov`**: same run as `test:coverage` plus an
  `lcov.info` for machine consumers, via the built-in `lcov` test reporter.

### Changed

- The once-per-process inert-gate warning now names the method that
  produced the verdict (`'hoeffding'` or `'eb'`) instead of hardcoding
  Hoeffding; the invalid-input warning cause classes gained `truncation`.
- README "Statistical scope" gained the `'eb'` row, and the mSPRT row now
  points at it as the shipped answer to its own caveat.

## [0.15.0] - 2026-08-12

An external technical review of this repository went through the statistics
rather than around them, and found that one of our load-bearing claims did not
hold. This release fixes the mathematics, and then goes through the rest of the
repository asking the same question everywhere: is this claim actually true?

Several were softened as a result. Nothing was quietly deleted.

### Fixed

- **The Hoeffding confidence sequence had no working proof** (`src/evolution/sequential.ts`).
  From v0.7 through v0.14 the boundary was `w(n) = R·√(ln((n+1)/α)/(2n))`,
  documented in the source as "a standard union-bound / Cramer-Chernoff
  time-uniform Hoeffding bound". That boundary allows `2α/(n+1)` of the error
  budget at every look, `Σ 2α/(n+1)` diverges, and no union bound closes over a
  divergent series, so the always-valid guarantee the code advertised was never
  established. Precisely: what is refuted is the argument, not the boundary.
  A divergent chain of upper bounds does not prove the true crossing
  probability diverges, and nobody has produced another construction that
  covers it. Gating production promotions on an unproven bound is reason enough
  to replace it. Replaced with a summable α-spending
  schedule, `α_n = α_arm/(n(n+1))`, whose sum telescopes to exactly `α_arm`:

  ```
  w(n) = R · √( ln( 2·n·(n+1) / α_arm ) / (2n) )
  ```

  The four-line proof now sits in the function's docstring instead of an
  assertion that it exists. Compare Howard, Ramdas, McAuliffe and Sekhon
  (arXiv:1810.08240), who make the same point about pointwise Hoeffding
  intervals. **This is stricter than before**, by roughly a third on the
  half-width (29.8% at n=10, 32.1% at n=30, 35.5% at n=900), so a challenger that used to clear the bar may no longer. It
  should not have cleared it.

- **Both arms were spending the full α** (`src/evolution/sequential.ts`). A
  two-arm verdict needs both confidence sequences to hold at once, so the
  budget was allocated twice over: even the nominal accounting was off by a
  factor of two. Precisely, and no further: because the per-arm boundary had no
  established level to begin with (see above), this is an allocation error, not
  a proof that the old procedure ran at 2α. Each arm
  now runs at α/2 and the union bound over the two returns the requested α.
  This is a second, independent defect in the same function, found while fixing
  the first.

- **mSPRT could decide independently of α** (`src/evolution/sequential.ts`).
  Its zero-variance shortcut returned `decisive: true` whenever both arms came
  out internally constant with a gap, on the reasoning that deterministic arms
  obviously differ. It fired **regardless of the configured significance
  level**, and at small n two arms are constant by chance under H0 often enough
  to matter: with `minSamplesPerArm: 2` and both arms drawn from the same
  Bernoulli(0.5), P(A=[0,0] and B=[1,1]) plus its mirror is 0.125, a 12.5%
  type-I error against a configured α of 0.05. At the default warmup of 5 the
  same event sits at 0.00195, which still beats a configured α of 0.001.
  **It now abstains.** Tested on constancy rather than on `variance === 0`,
  because those differ in floating point and the difference was load-bearing:
  eight samples of exactly 0.4 against eight of exactly 0.9 leave a residual
  variance near 1e-33 (0.4 is not representable), which the closed form turns
  straight back into Λ = ∞. **Behaviour change**: an A/B pair whose arms show no
  spread at all no longer promotes on mSPRT. The margin path still sees the gap
  and the `2 × minRuns` tie-break still terminates the test.
- **Hoeffding failed OPEN on a broken bound** (`src/evolution/sequential.ts`).
  An inverted range (`hi <= lo`) silently became 1, and samples outside the
  declared range were accepted, even though every line of the proof rests on the
  observations living inside it. That is reachable from configuration, not just
  in theory: `MetricWeights` accepts arbitrary numbers and the composite is not
  clamped, so weights like `{quality: 2, sourceCount: -1}` produce composites of
  0.2 and 2.0, whose gap of 1.8 clears the [0,1] bar of 1.021 and promotes a
  challenger on a guarantee that does not apply. Both cases now **abstain and
  say why**. A gate that cannot vouch for a decision should decline to make one.
- **mSPRT is not a calibrated test at Darwin's sample sizes, and now says so.**
  The plug-in Welch variance is anti-conservative: when the within-arm spread
  comes out small by chance, Λ overshoots. Measured under H0 with a coarse
  judge scoring {0, 0.1, 0.2} at probabilities {0.50, 0.05, 0.45}, at the
  default α of 0.05 and the default warmup, peeking after every run: **type-I
  error 0.059 through n=14, 0.064 through n=20, 0.069 through n=30**, checking
  after every individual run as production does. It is past α from the first
  horizon measured and keeps drifting. (Checking only on balanced pairs
  understates it by about a fifth; the unbalanced figures are the honest ones.)
  `tests/sequential-coverage.test.ts` re-measures this on every run, so the
  figures cannot rot. Nothing in the method changed for this: what changed is
  that the docs stop calling it the rigorous option and print the numbers.
  Fixing it properly needs a test that accounts for the estimated variance
  rather than plugging it in, which is a different method and a later release.
- **Explicitly invalid options are refused instead of silently replaced.**
  `alpha: 0` used to become a 5% test; `tau: Number.MAX_VALUE` used to overflow
  to Infinity and return `statistic: NaN`; a non-finite `lo`/`hi` used to become
  0 and 1. All now abstain with `invalidInput: true` and a reason naming the
  option. An ABSENT option still takes its default, which is the difference
  between a convenience and running a different test than the caller asked for.
- **The confidence gate no longer double-spends α.** Under `'msprt'` the gate
  can run two tests (mSPRT, plus Hoeffding as a fallback when mSPRT has no noise
  scale to work with). Those rejection events are disjoint but their error
  probabilities add, so running both at the full α gave a composite nominal
  level of up to 2α. Each now gets half. `'hoeffding'` runs one test and keeps
  the whole budget. Being precise about what that buys: it is a conservative
  nominal (Bonferroni) allocation, NOT a calibration proof, because mSPRT is
  not calibrated here in the first place. Measured, the split moves the real
  error from ~0.064 to ~0.046 at a configured 0.05. Note also that the
  Hoeffding figures quoted in this changelog are for calling the primitive
  directly at α; through the gate under `'msprt'` the fallback sees α/2, so the
  bar is 0.995 at n=23, 0.891 at n=30, 0.665 at n=60, and a 0.2 gap needs
  n=939 rather than 900.
- **Numeric edges that returned confident nonsense.** `hoeffdingHalfWidth`
  accepted `Infinity` (its `n >= 1` guard let it through, then `Infinity/Infinity`
  produced NaN) and non-integer sample counts; mSPRT could return
  `statistic: NaN` on overflowing aggregates while the field is documented
  NaN-free; and `fmt` rendered NaN as `-∞`, turning a numeric fault into a
  plausible-looking reason string. All four refuse or name themselves now.

### Added

- **`tests/sequential-coverage.test.ts`**, which checks the guarantee rather
  than restating it. It re-derives the per-look α-spend from Hoeffding's
  inequality and asserts that the corrected schedule converges to the budget
  over a million looks, that the pre-0.15 schedule diverges past it (still
  growing at 1e5 looks), that the two-arm split is applied, and that continuous
  monitoring under H0 produces no false positive across 200 seeded simulations.
  If a future change reintroduces an invalid boundary, these go red.
- **`SequentialVerdict.inconclusiveByConstruction`** plus a one-shot warning
  from `SafetyGate`. On the default [0, 1] composite score at α=0.05 the two
  Hoeffding half-widths sum to 1.0 or more for every n up to 21 runs per arm,
  and no gap inside [0, 1] can exceed 1.0. **Up to 21 runs per arm the method
  is therefore structurally incapable of promoting anything**, whatever the
  data. Above that it is merely very strict, and precision matters here: the
  bar first fits inside the range at n=22 (0.982, so only a near-total
  separation clears it), is still 0.865 at the `computeDynamicMinRuns` ceiling
  of 30, and a 0.2 composite gap would take n=900 per arm. That 0.2 is itself
  roughly twenty times the quality-component contribution we measured (~0.009 to
  0.011). None of that was visible: the gate simply kept returning "keep testing". The
  verdict now flags it, the reason string explains it, and the gate says so
  once instead of freezing evolution without comment. `'msprt'` is the method
  that can decide at these counts.
- **`hoeffdingHalfWidth`** is exported from the package root, so the α-spend can
  be re-derived by anyone who would rather check the guarantee than trust it.
- **A "Statistical scope" section in the README**, stating per method what is
  guaranteed, what is only approximated (mSPRT plugs in an estimated variance,
  so it is asymptotic, not exact at n=10 to 30), and what is a heuristic with no
  guarantee at all (`'effect-size'`, the default).
- **Four CI gates that were missing.** `npm run typecheck:tests` (the tests have
  their own tsconfig and nothing was ever type-checking them), an enforced
  coverage floor via `test:coverage:ci` (coverage was measured but never
  enforced, so erosion was invisible), `npm audit --audit-level=high`, and a
  `benchmark --dry` smoke so a public claim about the package cannot rot
  unnoticed. Scope of that last one, stated because the first draft of this
  entry overstated it: `--dry` returns before scoring, so it covers prompt
  loading, task parsing and config resolution, not the scoring path.
- **Compiler-enforced dead-code checks** in place of a linter: `noUnusedLocals`,
  `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch` and `useUnknownInCatchVariables`, which run in CI
  through the two existing typecheck steps. Turning them on found 16 pieces of
  dead code, including a `handleABTest` parameter that had been unused since the
  A/B accounting moved inside the atomic `updateState` callback, and five dead
  assignments in `loop.test.ts`. All removed.

  Being straight about what this is NOT: Darwin still has no ESLint/Prettier
  gate and no SAST or secret scanning, so two of the review's CI findings stay
  open rather than being quietly counted as closed. The reasoning for the part
  we did do: this package ships **zero runtime dependencies** and that is a
  claim worth protecting, so a lint stack was not worth ~100 devDependencies
  when the compiler already catches the class of defect that mattered here.
  SAST is a real gap and is on the list.

### Changed

- **`computeDynamicMinRuns` is documented as a throughput heuristic**, which is
  what it is. Its docstring previously read like a derivation ("increases
  minRuns proportionally to the inverse of variance") while running the opposite
  direction to the textbook `n ∝ σ²/Δ²` for a fixed absolute effect. The premise
  it actually encodes, that the effect worth finding scales with the spread the
  agent already shows, is now written out, along with the note that under a
  fixed standardised effect size neither direction is derivable and this is a
  product decision. **Behaviour is unchanged**: switching the direction would be
  a silent breaking change, and the honest fix for anyone wanting rigour is
  `requireConfidence` with `'msprt'`, not tuning this number.
- **Claims softened where they outran the evidence.** The README's comparison
  table, the "why this isn't a toy" summary and the Known Limitations section
  now point at the scope section instead of asserting "always-valid" flatly. The
  production metrics block carries a note that the judge and the author sit in
  the same model family, that the reported lifts (+0.23, +0.28) are smaller than
  the measured judge variance (about ±1), and that nobody independent has
  evaluated Darwin. The benchmark README says how many stored results exist
  (one committed) and that ten tasks at one run per cell is below the sample size either
  sequential test needs.
- **`CONTRIBUTING.md` names the structural debt in `loop.ts`** with measured
  numbers (1,599 lines, 31 methods, and the three that carry the weight measured
  signature to closing brace) and a
  concrete three-collaborator decomposition. Deliberately not done in this
  release: bundling a 1,600-line orchestrator refactor with a change to A/B
  decision behaviour would turn one reviewable change into two unreviewable
  ones.

### Upgrade notes

If you use `confidenceMethod: 'hoeffding'`, read the scope section, because
this is a real behaviour change and not only a documentation one. The corrected
boundary is wider, and **it is wider than the [0,1] score range at 21 or fewer
runs per arm**, so on quality margin the method can no longer promote anything
at Darwin's default run counts. That was NOT already the case in v0.14: at
n=30 the old boundary was 0.655, which a 0.75 gap cleared, and the corrected
one is 0.865, which it does not. An earlier draft of this entry claimed the
inability predated v0.15; that was wrong, and the cross-model review caught it.

Switch to `'msprt'`, or raise `minRuns` into the hundreds (n=900 per arm for a
+0.2 lift).

**`'msprt'` is NOT unchanged** (an earlier draft of this entry said it was).
Its zero-variance shortcut now abstains, which matters for one specific setup:
a deterministic or rule-based evaluator returns the same score every run, so
its arms are exactly constant, and v0.14 promoted the winner there. Now the
gate hands that case to Hoeffding, which needs no variance estimate. A large
deterministic gap still promotes (0.1 vs 0.95 clears the bar from n=60); a
small one (0.6 vs 0.8, gap 0.2) does not, because resolving 0.2
distribution-free takes n=900 and the `2 × minRuns` cap never gets there.
That is the honest answer: from constant observations alone you cannot
distinguish a deterministic scorer from a small sample that happened to come
out constant. If you want the old behaviour for such a setup, leave
`requireConfidence` off, or use `confidenceMethod: 'effect-size'`, which is a
heuristic and now says so.

The default `'effect-size'` path is unchanged.

`SequentialVerdict` gained THREE optional properties:
`inconclusiveByConstruction`, `invalidInput` and `abstainCode`. All additive
and source-compatible, but a consumer doing exact deep-equality on the verdict
object, or validating it against a JSON schema with
`additionalProperties: false`, will see them.

## [0.14.0] — 2026-08-09

Built and hardened through a seven-round cross-model review loop (built by
Claude Fable, adversarially reviewed by GPT-5.6 over rounds R1–R7 until GO):
the reviews surfaced — and this release fixes — a bug family that had made
three advertised behaviours unreachable from the CLI (the evolved prompt
never ran outside a test, failure rollback died after every promotion, and
incomplete runs never reached the reliability tracking).

### Added

- **Offline evals** (`darwin eval` + `runEval` API). The dataset-and-metric
  loop offline optimizers are built around, as a complement to the online
  gate: run stored prompt versions (or all of them) over a frozen JSON task
  set, score each output with the built-in critic — or any injected metric —
  and read per-task means plus deltas against the baseline arm. Reports land
  in `.darwin/reports/eval-*.md` (`--json` for machine-readable output),
  `--dry` validates wiring with zero LLM calls. `parseEvalTasks` /
  `runEval` / `renderEvalReport` are root exports with injectable
  runner + scorer, so tests (and custom metrics) never touch an LLM.
- **Per-agent safety thresholds** (`evolution.safety`,
  `--require-confidence`, `--confidence-method <effect-size|msprt|hoeffding>`).
  The statistical-rigor knobs shipped in v0.6/v0.7 were only reachable by
  hand-wiring a `SafetyGate`; now they merge over `DEFAULT_SAFETY` from the
  agent definition, persist via `darwin evolve`, and follow the same
  layered-override resolution as every other evolution flag. The
  `--confidence-method` parser inherits the v0.13.2 single-dash lesson: a
  following flag token (`-v`, `--force`) is a missing value, never consumed.
- **Metrics sink** (`MetricsSink`, `JsonlMetricsSink`,
  `DARWIN_METRICS_JSONL`, `examples/otel-bridge.ts`). Every evolution
  decision — run recorded, A/B started / completed / timed out, rollback —
  emits a typed event through `emitMetric`, which swallows sink errors by
  contract: observability can never break the loop. Zero hard deps; the OTel
  bridge is an example for consumer projects, mirroring
  `examples/mcp-memory-bridge.ts`.
- **CLI test coverage + `npm run test:coverage`.** The CLI layer was the
  repo's only zero-coverage code while carrying its real regressions;
  `parseRunArgs` is now exported and pinned (including the 0.13.2 `-v`
  case), `parseEvalArgs` ships tested, and the coverage script makes the
  gap measurable (`node --test --experimental-test-coverage`).

### Fixed — cross-model review findings (v0.14.0 scope)

- **A promoted winner now actually runs.** `darwin run` resolved the prompt
  from the store only while an A/B test was open; with no test running it
  always executed the STATIC v1 prompt and recorded the run against v1 —
  an evolved winner (active `v3` in state) never ran through the CLI, and
  the version stats were corrupted by mislabeled runs. The CLI now runs the
  agent's active version (`pickRunVersion`, exported + tested), with a loud
  fallback to the static prompt when a stored version label has no prompt.
- **`darwin evolve --disable` stops A/B traffic.** Routing previously
  ignored the enabled flag, so a disabled agent kept sending ~50% of runs
  through the challenger arm with frozen counters — forever. Routing is now
  gated on the resolved evolution-enabled state.
- **Failure rollback works after a promotion.** `handleABTest` promotes a
  winner by setting `activeVersions` AND `lastKnownGood` to the same label,
  which made `rollback()` conclude "already on last-known-good" from that
  moment on — the advertised failure rollback was dead exactly when a
  freshly-promoted prompt started degrading in real traffic. Rollback now
  walks one step up the version lineage (`parentVersion`) in that state,
  moving `lastKnownGood` along; v1 (no parent) is the floor. Guards from the
  second review round: the lineage walk never runs while an A/B test is open
  (the failure counter is version-agnostic — a failing CHALLENGER must not
  sink the healthy incumbent; challenger unreliability is the test's own
  auto-loss job), and a stale `lastKnownGood` naming a label with no stored
  prompt is never activated (no phantom state; the walk falls back to the
  current version's stored parent).
- **Run labels always name the prompt that ran.** When state requests a
  version whose stored prompt is missing (corrupted/foreign state), the CLI
  used to run the static v1 prompt while RECORDING the run under the missing
  label — poisoning that label's stats. `resolveRunPrompt` now relabels such
  runs to v1, prefers the SEEDED v1 prompt over the static definition (live
  runs and `darwin eval` resolve identically), and `--no-evolve` skips A/B
  routing (an unmeasured challenger run is a wasted live request).
- **Eval hardening (second review round):** paired deltas (mean per-task
  difference over tasks BOTH arms scored — asymmetric failures can no longer
  flatter an arm), `runsPerCell` clamped to finite integers with a CLI cap of
  1000 (`Number('9'.repeat(400)) === Infinity` would have looped a cell
  forever), `--tasks`/`--versions` treat a following flag token as a missing
  value, the active-version marker moved out of the canonical arm label into
  an `active` field (no collision with stored labels or JSON consumers), and
  report filenames carry a second-resolution stamp (same-day re-runs no
  longer overwrite earlier reports or strand a stale `.json`).
- **`evolution_skipped` is now emitted** (collecting_data /
  no_actionable_patterns / data_quality) — the metrics event type existed
  but never fired, leaving every skip decision invisible.
- **Fifth review round (R6):** the CLI's too-short-output early return made
  the loop's ENTIRE incomplete-run path (`afterRun` step 0 — failsA/failsB
  reliability tracking, unreliability auto-loss, mid-test expiry) dead code
  for `darwin run` users, so an unreliable challenger kept receiving live
  traffic forever (pre-existing since the check was introduced; surfaced by
  the review). Short output is now flagged instead of returned: never saved,
  never judged, but always handed to the evolution loop. Covered by a real
  CLI integration test driving `runCommand` against a local mock
  OpenAI-compatible server. Also: `darwin eval --dry` now rejects duplicate
  `--versions` arms instead of green-lighting them.
- **Fourth review round (R5):** every test-closing path (decided /
  unreliability / timeout / orphan-repair) atomically resets the
  version-agnostic `consecutiveFailures` counter — a streak filled by the
  LOSING arm no longer survives the test and tees up a lineage rollback
  against the confirmed winner; the rollback transition commits state-first
  inside one atomic `updateState` with an open-test re-check (a test started
  concurrently in the guard window survives, the rollback aborts); the
  orphan-test repair clears only the exact test it diagnosed
  (identity-checked in the callback); `runEval` rejects duplicate task ids
  at the API boundary; metrics docs now say zero-or-more/best-effort.
- **Third review round (R4):** no rollback of ANY kind while an A/B test is
  open (stage 1 could still fire mid-test on a divergent `lastKnownGood`;
  during a test, the test decides), `runEval` caps huge-but-finite
  `runsPerCell` at 10 000 in the API itself (`1e100` slipped past the
  non-finite guard), an open test referencing a version with no stored
  prompt is cleared as dead instead of mislabel-feeding it v1 runs
  (`abTestArmsResolvable`), report filenames carry ms + pid (same-second
  collisions), the paired-Δ note also renders when zero tasks paired, and
  the metrics delivery semantics are documented as zero-or-more /
  best-effort (events can be lost AND duplicated — observability, not an
  audit log).

### Changed

- README feature comparison now includes the TypeScript prompt-optimization
  packages that appeared around Darwin (gepa-ts, @currentai/dsts,
  @kamiyo-org/selfimprove) with an honest per-column comparison, instead of
  only the Python frameworks. Darwin's claim is stated precisely: the GEPA
  reflector running *online inside a production safety gate* — offline
  optimizers tune before deploy, Darwin keeps tuning safely after.

## [0.13.2] — 2026-08-01

Round two of the cross-model review upheld two of its round-one findings
against 0.13.1 — including a counterexample to 0.13.1's own
"provably collision-free" claim. Both closed:

### Fixed

- **The collision-freedom proof now holds unconditionally.** 0.13.1
  documented the parseInt-saturation corner
  (`nextVersion("v9007199254740992")` self-maps at 2^53) as theoretical —
  but a documented counterexample refutes a claimed proof: with that
  label in history the probe walk produced the same taken candidate
  forever, returned it, and the upsert would have overwritten the
  incumbent and started an A/B test with `versionA === versionB`. The
  walk now steps through `progressStep`, which falls back to the append
  strategy on any non-progressing step — every step strictly progresses,
  so the history-size bound is a real proof with no carve-out.
- **`--max-test-days -v` / `--max-merge -v` no longer swallow the
  verbose flag.** The missing-value guard only recognised `--`-prefixed
  tokens; the CLI defines single-dash `-v`, which was consumed as an
  invalid value and silently dropped. Both value-taking flags now treat
  any `-`-prefixed token as a missing value (negative numbers were never
  valid for either). The 0.13.1 rebuttal of this finding claimed the CLI
  had no single-dash flags — that was wrong, and this entry is the
  correction.

## [0.13.1] — 2026-08-01

Patch on the day of 0.13.0, from an adversarial cross-model review (built
by Claude Opus, refuted by Claude Fable over four rounds, then reviewed
by GPT-5.6 — two findings survived all of that and are fixed here).

### Fixed

- **`nextFreeVersion` is now provably collision-free.** The probe walk
  stopped after a fixed 100 iterations and returned a possibly-taken
  label — an all-non-numeric history with 101 chained rejected
  challengers would have been overwritten again. The bound is now the
  history size itself: the candidate sequence never revisits a label
  (numeric labels strictly increment, non-numeric strictly grow), so
  after `|history|` collisions the next candidate must be free. The
  documented 2^53 parseInt-saturation corner remains theoretical and
  pre-existing.
- **The wall-clock budget is snapshotted onto the A/B test at start**
  (`ABTest.maxTestDays`). Expiry previously read the *current*
  invocation's config, so a test started via a one-off
  `darwin run … --max-test-days 7` silently lost its deadline on the
  next plain invocation. Evaluation prefers the snapshot and falls back
  to the agent's current config, which keeps both pre-snapshot
  behaviours working: tests started before 0.13.1 under a persisted
  budget, and budgets added after a test was already running. All
  budget messages/notifications now report the effective budget.

### Documented

- README: the budget is enforced inside the evolution loop — a
  `darwin run` whose output is too short to record returns before the
  loop, so an agent producing only unrecordable output does not trip
  the budget until one run reaches the loop (pre-existing reachability,
  unchanged by 0.13.x; `--reset` is the immediate out).
- Reviewed and not changed, for the record: the evidence-based
  unreliability rule (>50% fails at ≥3 attempts) can still conclude an
  over-budget test and promote the challenger — that is the pre-0.13
  escape hatch for a crashing arm, fires identically on 0.12.2, and is
  deliberately evaluated before expiry. Concurrent multi-writer
  evolution remains outside the engine's guarantees (same envelope as
  every prior release); `nextFreeVersion` assumes a single writer per
  agent.

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
